//! Native application commands belong to the bundled player document only.
//! Tauri already rejects remote IPC; this additionally excludes auxiliary
//! windows and other locally registered protocols (assets and audio).
use tauri::Manager;
use url::Url;

fn trusted_player_url(url: &Url, dev_url: Option<&Url>) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let bundled = match url.scheme() {
        "tauri" => url.host_str() == Some("localhost") && url.port().is_none(),
        "http" | "https" => url.host_str() == Some("tauri.localhost")
            && url.port_or_known_default() == Some(if url.scheme() == "https" { 443 } else { 80 }),
        _ => false,
    };
    bundled || dev_url.is_some_and(|dev| {
        // Only the configured development origin, never arbitrary loopback
        // servers. The caller supplies this exception only in Tauri dev mode.
        matches!(dev.scheme(), "http" | "https") && url.origin() == dev.origin()
    })
}

pub(crate) fn allow_invoke<R: tauri::Runtime>(invoke: &tauri::ipc::Invoke<R>) -> bool {
    let webview = invoke.message.webview_ref();
    let dev_url = if tauri::is_dev() {
        webview.app_handle().config().build.dev_url.as_ref()
    } else {
        None
    };
    webview.url().is_ok_and(|url| trusted_context(webview.label(), webview.window().label(), &url, dev_url))
}

fn trusted_context(webview: &str, window: &str, url: &Url, dev_url: Option<&Url>) -> bool {
    webview == "main" && window == "main" && trusted_player_url(url, dev_url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packaged_player_origins_work_on_windows_and_macos() {
        for value in ["tauri://localhost/", "tauri://localhost/index.html", "http://tauri.localhost/", "https://tauri.localhost/index.html"] {
            assert!(trusted_player_url(&Url::parse(value).unwrap(), None), "{value}");
        }
    }

    #[test]
    fn assets_media_remote_documents_and_lookalike_origins_never_gain_native_commands() {
        for value in ["asset://localhost/song.mp3", "http://asset.localhost/song.mp3", "pulse-media://localhost/a/0", "http://pulse-media.localhost/a/0", "https://vk.ru/audio", "https://music.yandex.ru/collection", "https://tauri.localhost.example/", "https://tauri.localhost:444/", "tauri://other/", "tauri://localhost:443/", "tauri://user:secret@localhost/", "http://user:secret@tauri.localhost/", "file:///C:/index.html", "http://127.0.0.1:5173/"] {
            assert!(!trusted_player_url(&Url::parse(value).unwrap(), None), "{value}");
        }
    }

    #[test]
    fn development_exception_uses_only_its_exact_configured_origin() {
        let dev = Url::parse("http://127.0.0.1:5193/").unwrap();
        assert!(trusted_player_url(&Url::parse("http://127.0.0.1:5193/index.html").unwrap(), Some(&dev)));
        for value in ["http://127.0.0.1:5194/", "http://localhost:5193/", "https://127.0.0.1:5193/", "http://user:secret@127.0.0.1:5193/", "https://evil.example/"] {
            assert!(!trusted_player_url(&Url::parse(value).unwrap(), Some(&dev)), "{value}");
        }
    }

    #[test]
    fn auxiliary_windows_cannot_gain_commands_even_after_local_navigation() {
        let url = Url::parse("tauri://localhost/").unwrap();
        assert!(trusted_context("main", "main", &url, None));
        for label in ["vk-music", "yandex-import", "popup", "", "Main"] {
            assert!(!trusted_context(label, "main", &url, None));
            assert!(!trusted_context("main", label, &url, None));
            assert!(!trusted_context(label, label, &url, None));
        }
    }
}
