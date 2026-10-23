//! Independent behavioral regressions for the real manifest rewriter.
//! Fixtures contain fake CDN URLs only; no network, account or application
//! profile is used. Physical platform custom-protocol behavior is separate QA.
use super::{media_path, register_media_url, rewrite_manifest, Url, MAX_SESSION_URLS};

fn references(manifest: &str) -> Vec<&str> {
    let mut values = Vec::new();
    for line in manifest.lines() {
        if !line.starts_with('#') && !line.trim().is_empty() {
            values.push(line.trim());
        } else {
            let mut rest = line;
            while let Some((_, after)) = rest.split_once("URI=\"") {
                let (value, tail) = after.split_once('"').expect("rewritten URI closes");
                values.push(value);
                rest = tail;
            }
        }
    }
    values
}

#[test]
fn independent_nested_master_keys_maps_and_byte_ranges_resolve_in_the_browser_origin() {
    let upstream = Url::parse("https://cf-hls-media.sndcdn.com/path/master.m3u8?Signature=master-fixture").unwrap();
    let mut registry = vec![upstream.to_string()];
    let master = "#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=AES-128,URI=\"keys/key.bin?Signature=key-fixture\"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",URI=\"alt/media.m3u8?token=alt-fixture\"\n#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=32000,URI=\"iframe.m3u8?token=i-fixture\"\n#EXT-X-STREAM-INF:BANDWIDTH=128000,AUDIO=\"a\"\nlevel/playlist.m3u8?token=main-fixture";
    let rewritten_master = rewrite_manifest(master, &upstream, |target| register_media_url(&mut registry, &target)).unwrap();
    assert_eq!(references(&rewritten_master), vec!["1", "2", "3", "4"]);

    let nested_upstream = Url::parse(&registry[4]).unwrap();
    let nested = "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:10\n#EXT-X-KEY:METHOD=AES-128,URI=\"../keys/key.bin?Signature=key-fixture\"\n#EXT-X-MAP:URI=\"../init.mp4?token=init-fixture\",BYTERANGE=\"1000@0\"\n#EXTINF:10,\n#EXT-X-BYTERANGE:4096@0\n../segment.m4s?token=segment-fixture\n#EXTINF:10,\n#EXT-X-BYTERANGE:4096@4096\n../segment.m4s?token=segment-fixture\n#EXT-X-PRELOAD-HINT:TYPE=PART,URI=\"../part.m4s?token=part-fixture\"\n#EXT-X-RENDITION-REPORT:URI=\"../alt/media.m3u8?token=alt-fixture\"\n#EXT-X-ENDLIST";
    let rewritten_nested = rewrite_manifest(nested, &nested_upstream, |target| register_media_url(&mut registry, &target)).unwrap();
    assert_eq!(references(&rewritten_nested), vec!["1", "5", "6", "6", "7", "2"]);
    assert_eq!(registry.len(), 8, "repeated keys, ranges and rendition URLs must reuse their resource index");
    assert_eq!(registry[1], "https://cf-hls-media.sndcdn.com/path/keys/key.bin?Signature=key-fixture");
    assert_eq!(registry[6], "https://cf-hls-media.sndcdn.com/path/segment.m4s?token=segment-fixture");
    for tag in ["BYTERANGE=\"1000@0\"", "#EXT-X-BYTERANGE:4096@0", "#EXT-X-BYTERANGE:4096@4096", "#EXT-X-ENDLIST"] {
        assert!(rewritten_nested.contains(tag));
    }
    for text in [&rewritten_master, &rewritten_nested] {
        for private in ["sndcdn", "Signature", "token=", "fixture", "http:", "https:", "pulse-media:"] {
            assert!(!text.contains(private), "manifest exposed an upstream URL or reconstructed native origin");
        }
    }

    let capability = "0123456789abcdef".repeat(3);
    for origin in ["http://pulse-media.localhost", "https://pulse-media.localhost", "pulse-media://localhost"] {
        let master_url = Url::parse(&format!("{origin}/{capability}/0")).unwrap();
        let media_url = master_url.join(references(&rewritten_master)[3]).unwrap();
        assert_eq!(media_url.path(), format!("/{capability}/4"));
        for (parent, text) in [(&master_url, &rewritten_master), (&media_url, &rewritten_nested)] {
            for reference in references(text) {
                let child = parent.join(reference).unwrap();
                assert_eq!(child.scheme(), master_url.scheme());
                assert_eq!(child.host_str(), master_url.host_str());
                assert_eq!(child.port(), master_url.port());
                assert_eq!(child.query(), None);
                assert_eq!(child.fragment(), None);
                let (token, index) = media_path(child.path()).expect("child is routable by the real native path parser");
                assert_eq!(token, capability);
                assert_eq!(index.to_string(), reference);
                assert!(index < registry.len());
            }
        }
    }
}

#[test]
fn independent_revocation_during_key_registration_never_returns_a_partial_manifest() {
    let base = Url::parse("https://cf-hls-media.sndcdn.com/path/index.m3u8?token=fixture").unwrap();
    let fixture = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin?token=key-fixture\"\n#EXT-X-MAP:URI=\"init.mp4?token=init-fixture\"\n#EXTINF:10,\nsegment.m4s?token=segment-fixture";
    let mut registry = vec![base.to_string()];
    let mut registration_calls = 0;
    let result = rewrite_manifest(fixture, &base, |target| {
        registration_calls += 1;
        if registration_calls == 2 {
            return Err("Session was removed or its account generation changed".into());
        }
        register_media_url(&mut registry, &target)
    });
    assert!(result.is_err(), "a failed session guard must not produce a partially rewritten response");
    assert_eq!(registration_calls, 2, "revocation must stop before registering later segments");
    assert_eq!(registry.len(), 2);
    // The callback represents serve() rejecting a removed/account-changed
    // session. Real AppHandle/upload-guard integration is intentionally not
    // claimed by this isolated rewriter test.
}

#[test]
fn independent_bad_encryption_key_or_full_registry_cannot_emit_an_upstream_escape() {
    let base = Url::parse("https://cf-hls-media.sndcdn.com/path/index.m3u8").unwrap();
    for key in ["https://evil.example/key", "http://127.0.0.1/key", "file:///private/key", "https://user:pass@cf-hls-media.sndcdn.com/key"] {
        let mut registry = vec![base.to_string()];
        let manifest = format!("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"{key}\"\n#EXTINF:10,\nsegment.m4s");
        assert!(rewrite_manifest(&manifest, &base, |target| register_media_url(&mut registry, &target)).is_err());
        assert_eq!(registry.len(), 1);
    }
    let mut full = (0..MAX_SESSION_URLS).map(|n| format!("https://cf-hls-media.sndcdn.com/{n}.bin")).collect::<Vec<_>>();
    let manifest = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"https://cf-hls-media.sndcdn.com/0.bin\"\n#EXT-X-MAP:URI=\"new-map.mp4\"\nsegment.m4s";
    assert!(rewrite_manifest(manifest, &base, |target| register_media_url(&mut full, &target)).is_err());
    assert_eq!(full.len(), MAX_SESSION_URLS);
}
