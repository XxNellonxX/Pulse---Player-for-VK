//! Read only explicitly published audio URLs. No scripts, search substitutions,
//! or account credentials are used to turn a public page into an audio source.
use url::Url;

pub struct PublicAudio { pub url: Url, pub title: String, pub artist: String }

fn entities(value: &str) -> String {
    let mut output = String::new();
    let mut remaining = value;
    while let Some(at) = remaining.find('&') {
        output.push_str(&remaining[..at]);
        let candidate = &remaining[at + 1..];
        if let Some(end) = candidate.find(';').filter(|end| *end <= 12) {
            let entity = &candidate[..end];
            let decoded = match entity {
                "amp" => Some('&'), "quot" => Some('"'), "apos" | "#39" => Some('\''), "lt" => Some('<'), "gt" => Some('>'),
                _ if entity.starts_with("#x") || entity.starts_with("#X") => u32::from_str_radix(&entity[2..], 16).ok().and_then(char::from_u32),
                _ if entity.starts_with('#') => entity[1..].parse().ok().and_then(char::from_u32), _ => None,
            };
            if let Some(value) = decoded { output.push(value); remaining = &candidate[end + 1..]; continue; }
        }
        output.push('&'); remaining = candidate;
    }
    output.push_str(remaining);
    output
}

fn attributes(tag: &str) -> Vec<(String, String)> {
    let bytes = tag.as_bytes(); let mut index = 0; let mut result = Vec::new();
    while index < bytes.len() && result.len() < 32 {
        while index < bytes.len() && (bytes[index].is_ascii_whitespace() || bytes[index] == b'/') { index += 1; }
        let start = index;
        while index < bytes.len() && (bytes[index].is_ascii_alphanumeric() || matches!(bytes[index], b'-' | b'_' | b':')) { index += 1; }
        if index == start { index += 1; continue; }
        let name = tag[start..index].to_ascii_lowercase();
        while index < bytes.len() && bytes[index].is_ascii_whitespace() { index += 1; }
        if index >= bytes.len() || bytes[index] != b'=' { continue; }
        index += 1;
        while index < bytes.len() && bytes[index].is_ascii_whitespace() { index += 1; }
        if index >= bytes.len() { break; }
        let quote = bytes[index];
        let value = if quote == b'\'' || quote == b'"' {
            index += 1; let start = index;
            while index < bytes.len() && bytes[index] != quote { index += 1; }
            let value = &tag[start..index]; index += 1; value
        } else {
            let start = index;
            while index < bytes.len() && !bytes[index].is_ascii_whitespace() && bytes[index] != b'>' { index += 1; }
            &tag[start..index]
        };
        if value.len() <= 16384 { result.push((name, entities(value))); }
    }
    result
}

pub fn declared_audio(html: &str, base: &Url) -> Option<PublicAudio> {
    let lower = html.to_ascii_lowercase(); let mut cursor = 0; let mut sources = Vec::new(); let mut fallback_sources = Vec::new();
    let mut title = String::new(); let mut artist = String::new(); let mut in_audio = false;
    while let Some(at) = lower[cursor..].find('<') {
        let start = cursor + at;
        if lower[start..].starts_with("<!--") {
            let Some(end) = lower[start + 4..].find("-->") else { break; };
            cursor = start + 4 + end + 3; continue;
        }
        // A '>' inside a quoted attribute is text, not a tag boundary.
        let mut quote = None; let mut end = None;
        for (offset, byte) in lower.as_bytes()[start + 1..].iter().enumerate() {
            if let Some(current) = quote { if *byte == current { quote = None; } }
            else if matches!(*byte, b'\'' | b'"') { quote = Some(*byte); }
            else if *byte == b'>' { end = Some(offset + 1); break; }
        }
        let Some(end) = end else { break; }; cursor = start + end + 1;
        let text = &lower[start + 1..start + end];
        let name = text.split_ascii_whitespace().next().unwrap_or("").trim_end_matches('/');
        if matches!(name, "script" | "style" | "template") {
            let close = format!("</{name}");
            let Some(end) = lower[cursor..].find(&close) else { break; };
            cursor += end; continue;
        }
        if name == "/audio" { in_audio = false; continue; }
        if !matches!(name, "meta" | "audio" | "source") { continue; }
        let original = &html[start + 1..start + end];
        let attrs = attributes(&original[name.len()..]);
        let get = |key: &str| attrs.iter().find(|(name, _)| name == key).map(|(_, value)| value.as_str()).unwrap_or("");
        if name == "meta" {
            let property = if get("property").is_empty() { get("name") } else { get("property") }.to_ascii_lowercase();
            match property.as_str() {
                "og:audio" | "og:audio:url" | "og:audio:secure_url" => fallback_sources.push(get("content").to_owned()),
                "og:title" if title.is_empty() => title = get("content").chars().take(500).collect(),
                "author" | "music:artist" | "og:audio:artist" if artist.is_empty() => artist = get("content").chars().take(500).collect(),
                _ => {},
            }
        } else if name == "audio" { in_audio = true; if !get("src").is_empty() { sources.push(get("src").to_owned()); } }
        else if in_audio && (get("type").is_empty() || get("type").to_ascii_lowercase().starts_with("audio/")) { sources.push(get("src").to_owned()); }
        if sources.len() + fallback_sources.len() >= 32 { break; }
    }
    sources.extend(fallback_sources);
    let url = sources.into_iter().filter(|raw| !raw.is_empty()).find_map(|raw| base.join(&raw).ok().filter(|url| url.scheme() == "https" && url.username().is_empty() && url.password().is_none() && url.port_or_known_default() == Some(443)))?;
    Some(PublicAudio { url, title, artist })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ordinary_public_pages_can_expose_audio_without_a_vk_search() {
        let base = Url::parse("https://artist.example/music/song").unwrap();
        let value = declared_audio("<META content='Artist &amp; Song' property='og:title'><meta name=author content='Артист'><meta content='/song.mp3?x=1&amp;y=2' property='og:audio'>", &base).unwrap();
        assert_eq!(value.url.as_str(), "https://artist.example/song.mp3?x=1&y=2");
        assert_eq!(value.title, "Artist & Song"); assert_eq!(value.artist, "Артист");
        let audio = declared_audio("<video><source src='/video.mp4'></video><audio controls><source src='https://cdn.example/full.flac' type='audio/flac'></audio>", &base).unwrap();
        assert_eq!(audio.url.as_str(), "https://cdn.example/full.flac");
        assert!(declared_audio("<meta property='og:audio' content='file:///private/audio.mp3'>", &base).is_none());
        assert!(declared_audio("<script>var src='/a.mp3'</script>", &base).is_none());
        assert!(declared_audio("<script>const html=\"<audio src='/fake.mp3'>\"</script><!--<audio src='/comment.mp3'>-->", &base).is_none());
        let audio = declared_audio("<meta property='og:audio' content='/preview.mp3'><audio src='/full.mp3' title='x > y'></audio>", &base).unwrap();
        assert_eq!(audio.url.as_str(), "https://artist.example/full.mp3");
    }
}
