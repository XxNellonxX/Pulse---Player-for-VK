//! Single-video import using the bundled, version-pinned media tools.
//! YouTube streams are already compressed; MP3 conversion is explicit for VK.
use crate::soundcloud::DownloadedUrl;
use serde_json::Value;
use std::{
    fs, io,
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, Instant},
};
use tokio::io::{AsyncRead, AsyncReadExt};
use url::Url;

const MAX_AUDIO: u64 = 200 * 1024 * 1024;
const MAX_DURATION: f64 = 3. * 60. * 60.;
const MAX_LOG: usize = 64 * 1024;

/// Original best available audio for local playback; MP3 320k for a VK upload.
/// No browser cookies, account credentials, or player identity are supplied.
pub async fn download_youtube(
    url: &str,
    directory: &Path,
    tools: &Path,
    proxy: Option<&str>,
    for_vk: bool,
) -> Result<DownloadedUrl, String> {
    let url = normalize_youtube_url(url)?;
    let proxy = proxy.map(validate_proxy).transpose()?;
    let ytdlp = tools.join("yt-dlp.exe");
    let ffmpeg = tools.join("ffmpeg.exe");
    let ffprobe = tools.join("ffprobe.exe");
    let deno = tools.join("deno.exe");
    if [&ytdlp, &ffmpeg, &ffprobe, &deno]
        .iter()
        .any(|path| !path.is_file())
    {
        return Err(
            "Компоненты импорта YouTube не установлены. Переустановите полную сборку плеера."
                .into(),
        );
    }
    fs::create_dir_all(directory)
        .map_err(|_| "Не удалось создать папку для загрузки YouTube.".to_string())?;
    let random: [u8; 16] = rand::random();
    let working = directory.join(format!("youtube-{}", hex::encode(random)));
    fs::create_dir(&working)
        .map_err(|_| "Не удалось подготовить папку импорта YouTube.".to_string())?;
    let _temporary = WorkingDirectory(working.clone());
    let mut command = tokio::process::Command::new(&ytdlp);
    command
        .current_dir(&working)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .args([
            "--ignore-config",
            "--no-playlist",
            "--no-cache-dir",
            "--no-progress",
            "--no-warnings",
            "--no-colors",
            "--no-cookies",
            "--no-cookies-from-browser",
            "--socket-timeout",
            "20",
            "--retries",
            "2",
            "--fragment-retries",
            "2",
            "--max-filesize",
            "200M",
            "--match-filters",
            "!is_live & duration <= 10800",
            "--write-info-json",
            "--no-write-thumbnail",
            "--no-write-subs",
            "--no-write-auto-subs",
            "--no-overwrites",
            "--restrict-filenames",
            "-f",
            "bestaudio/best",
            "-o",
            "source.%(ext)s",
        ])
        .arg("--js-runtimes")
        .arg(format!("deno:{}", deno.to_string_lossy()))
        .arg("--ffmpeg-location")
        .arg(tools);
    if let Some(proxy) = proxy {
        command.arg("--proxy").arg(proxy);
    }
    if for_vk {
        command.args([
            "--extract-audio",
            "--audio-format",
            "mp3",
            "--audio-quality",
            "320K",
        ]);
    } else {
        // yt-dlp's "best" extraction keeps Opus/AAC packets and only remuxes
        // their container where needed, so Lofty can read the local audio.
        command.args(["--extract-audio", "--audio-format", "best"]);
    }
    command.arg("--").arg(url);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let mut child = command
        .spawn()
        .map_err(|_| "Не удалось запустить компонент импорта YouTube.".to_string())?;
    let mut process_tree = ProcessTree::new(child.id());
    let stdout = child
        .stdout
        .take()
        .ok_or("Не удалось прочитать ответ YouTube.")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Не удалось прочитать ответ YouTube.")?;
    let mut stdout_reader = tokio::spawn(drain_bounded(stdout));
    let mut stderr_reader = tokio::spawn(drain_bounded(stderr));
    let started = Instant::now();
    let status = loop {
        match tokio::time::timeout(Duration::from_millis(500), child.wait()).await {
            Ok(Ok(status)) => break status,
            Ok(Err(_)) => {
                stdout_reader.abort();
                stderr_reader.abort();
                return Err("Не удалось дождаться завершения импорта YouTube.".into());
            }
            Err(_) => {
                if started.elapsed() >= Duration::from_secs(300) {
                    stdout_reader.abort();
                    stderr_reader.abort();
                    return Err("Импорт YouTube превысил 5 минут. Загрузка остановлена; проверьте подключение или VPN.".into());
                }
                if !working_size_allowed(&working) {
                    stdout_reader.abort();
                    stderr_reader.abort();
                    return Err("Аудио YouTube превышает 200 МБ. Загрузка остановлена.".into());
                }
            }
        }
    };
    let pipes_complete = tokio::time::timeout(Duration::from_secs(5), async {
        let _ = (&mut stdout_reader).await;
        (&mut stderr_reader)
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default()
    })
    .await;
    let error_output = match pipes_complete {
        Ok(output) => output,
        Err(_) => {
            stdout_reader.abort();
            stderr_reader.abort();
            return Err("Компонент импорта YouTube не завершил работу. Попробуйте ещё раз.".into());
        }
    };
    process_tree.disarm();
    if !status.success() {
        return Err(friendly_tool_error(&error_output));
    }
    let info_path = working.join("source.info.json");
    let info_metadata = fs::symlink_metadata(&info_path).map_err(|_| {
        "YouTube не вернул файл: эфиры и записи длиннее 3 часов не поддерживаются.".to_string()
    })?;
    if !info_metadata.is_file() || info_metadata.len() > 2 * 1024 * 1024 {
        return Err("Некорректные данные импортированного трека YouTube.".into());
    }
    let info: Value = serde_json::from_slice(
        &fs::read(&info_path).map_err(|_| "Не удалось прочитать данные YouTube.")?,
    )
    .map_err(|_| "YouTube вернул некорректные данные трека.".to_string())?;
    if info
        .get("_type")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind != "video")
        || info.get("is_live").and_then(Value::as_bool) == Some(true)
        || info
            .get("duration")
            .and_then(Value::as_f64)
            .is_some_and(|duration| {
                !duration.is_finite() || duration <= 0. || duration > MAX_DURATION
            })
    {
        return Err("Нужна отдельная запись YouTube длительностью до 3 часов. Эфиры и плейлисты не поддерживаются.".into());
    }
    let source = find_audio(&working, for_vk)?;
    let metadata = fs::symlink_metadata(&source)
        .map_err(|_| "Не удалось проверить загруженное аудио.".to_string())?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_AUDIO {
        return Err("Аудиофайл пуст или превышает 200 МБ. Импорт отменён.".into());
    }
    let title = metadata_text(&info, &["track", "title"], "YouTube");
    let artist = metadata_text(&info, &["artist", "creator", "uploader", "channel"], "");
    let extension = source
        .extension()
        .and_then(|extension| extension.to_str())
        .ok_or("Не удалось определить формат YouTube-аудио.")?;
    let destination = directory.join(format!("import-{}.{}", hex::encode(random), extension));
    fs::rename(&source, &destination)
        .map_err(|_| "Не удалось завершить сохранение аудио YouTube.".to_string())?;
    Ok(DownloadedUrl {
        path: destination,
        title,
        artist,
    })
}

pub fn normalize_youtube_url(input: &str) -> Result<String, String> {
    let url = Url::parse(input.trim())
        .map_err(|_| "Нужна полная HTTPS-ссылка на отдельное видео YouTube.".to_string())?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
        || input.len() > 8192
        || url.query_pairs().any(|(key, _)| key == "list")
    {
        return Err("Нужна HTTPS-ссылка на одно видео YouTube без плейлиста и пароля.".into());
    }
    let id = match url.host_str() {
        Some("youtu.be" | "www.youtu.be") => {
            let segments: Vec<_> = url.path_segments().into_iter().flatten().collect();
            if segments.len() != 1 { None } else { Some(segments[0].to_string()) }
        }
        Some("youtube.com" | "www.youtube.com" | "m.youtube.com" | "music.youtube.com") => {
            if url.path() == "/watch" {
                let ids: Vec<_> = url.query_pairs().filter(|(key, _)| key == "v").map(|(_, value)| value.into_owned()).collect();
                if ids.len() == 1 { Some(ids[0].clone()) } else { None }
            } else if let Some(id) = url.path().strip_prefix("/shorts/") {
                Some(id.trim_end_matches('/').to_string())
            } else { None }
        }
        _ => None,
    }.filter(|id| id.len() == 11 && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-'))
        .ok_or("Поддерживаются ссылки youtube.com/watch, youtube.com/shorts и youtu.be на отдельное видео.")?;
    Ok(format!("https://www.youtube.com/watch?v={id}"))
}

fn validate_proxy(input: &str) -> Result<String, String> {
    let proxy = Url::parse(input.trim()).map_err(|_| {
        "Некорректный адрес прокси. Нужен http://, https:// или socks5://сервер:порт.".to_string()
    })?;
    if !matches!(proxy.scheme(), "http" | "https" | "socks5" | "socks5h")
        || proxy.host_str().is_none()
        || proxy.port_or_known_default().is_none()
        || !matches!(proxy.path(), "" | "/")
        || proxy.query().is_some()
        || proxy.fragment().is_some()
        || input.len() > 2048
    {
        return Err("Прокси должен содержать только протокол, сервер, порт и при необходимости логин с паролем.".into());
    }
    Ok(proxy.to_string())
}

async fn drain_bounded(mut reader: impl AsyncRead + Unpin) -> io::Result<Vec<u8>> {
    let mut buffer = [0u8; 8192];
    let mut output = Vec::new();
    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        // Always keep draining pipes so the child never blocks on its output.
        let remaining = MAX_LOG.saturating_sub(output.len());
        output.extend_from_slice(&buffer[..read.min(remaining)]);
    }
    Ok(output)
}

fn metadata_text(info: &Value, keys: &[&str], fallback: &str) -> String {
    keys.iter()
        .find_map(|key| {
            info.get(*key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .unwrap_or(fallback)
        .chars()
        .filter(|c| !c.is_control())
        .take(512)
        .collect()
}

fn find_audio(directory: &Path, for_vk: bool) -> Result<PathBuf, String> {
    let mut files = Vec::new();
    for entry in fs::read_dir(directory)
        .map_err(|_| "Не удалось прочитать загруженные файлы YouTube.".to_string())?
    {
        let path = entry
            .map_err(|_| "Не удалось проверить файл YouTube.".to_string())?
            .path();
        let extension = path
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or_default();
        let allowed = if for_vk {
            extension == "mp3"
        } else {
            matches!(
                extension,
                "m4a" | "mp4" | "webm" | "opus" | "ogg" | "aac" | "mp3" | "wav" | "flac"
            )
        };
        if allowed {
            files.push(path);
        }
    }
    if files.len() != 1 {
        return Err("YouTube не вернул один готовый аудиофайл. Попробуйте другую запись.".into());
    }
    Ok(files.remove(0))
}

fn working_size_allowed(directory: &Path) -> bool {
    let Ok(entries) = fs::read_dir(directory) else {
        return false;
    };
    let mut total = 0u64;
    for entry in entries {
        let Ok(entry) = entry else { return false };
        let Ok(metadata) = entry.metadata() else {
            return false;
        };
        // Allow a source and its MP3 output to coexist during conversion.
        if metadata.is_file() {
            if metadata.len() > MAX_AUDIO {
                return false;
            }
            total = total.saturating_add(metadata.len());
        } else {
            return false;
        }
        if total > MAX_AUDIO * 2 + 4 * 1024 * 1024 {
            return false;
        }
    }
    true
}

fn friendly_tool_error(output: &[u8]) -> String {
    let text = String::from_utf8_lossy(output).to_ascii_lowercase();
    if text.contains("sign in")
        || text.contains("age-restricted")
        || text.contains("private video")
        || text.contains("members-only")
    {
        "YouTube требует вход или ограничил доступ к записи. Выберите публичное видео; пароли и cookies браузера плеер не запрашивает.".into()
    } else if text.contains("proxy")
        || text.contains("timed out")
        || text.contains("unable to download")
        || text.contains("network is unreachable")
        || text.contains("http error 403")
        || text.contains("http error 429")
    {
        "YouTube недоступен по текущему маршруту или временно ограничил загрузку. Включите свой VPN либо укажите доверенный зарубежный прокси в форме импорта.".into()
    } else if text.contains("filesize") || text.contains("larger than") {
        "Аудио YouTube превышает ограничение 200 МБ.".into()
    } else {
        "Не удалось импортировать аудио YouTube. Запись может быть удалена, ограничена или временно недоступна; попробуйте другую публичную ссылку.".into()
    }
}

struct WorkingDirectory(PathBuf);
impl Drop for WorkingDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct ProcessTree {
    id: Option<u32>,
}
impl ProcessTree {
    fn new(id: Option<u32>) -> Self {
        Self { id }
    }
    fn disarm(&mut self) {
        self.id = None;
    }
}
impl Drop for ProcessTree {
    fn drop(&mut self) {
        #[cfg(windows)]
        if let Some(id) = self.id {
            use std::os::windows::process::CommandExt;
            // Numeric process ID only; no user content is passed to a shell.
            let _ = std::process::Command::new("taskkill.exe")
                .creation_flags(0x08000000)
                .args(["/PID", &id.to_string(), "/T", "/F"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonicalizes_only_single_youtube_videos() {
        for url in [
            "https://youtu.be/AbC_1234-xy?t=9",
            "https://youtube.com/watch?v=AbC_1234-xy",
            "https://m.youtube.com/shorts/AbC_1234-xy/",
            "https://music.youtube.com/watch?v=AbC_1234-xy",
        ] {
            assert_eq!(
                normalize_youtube_url(url).unwrap(),
                "https://www.youtube.com/watch?v=AbC_1234-xy"
            );
        }
        for url in [
            "http://youtu.be/AbC_1234-xy",
            "https://youtube.com.evil.test/watch?v=AbC_1234-xy",
            "https://youtube.com/watch?v=AbC_1234-xy&list=123",
            "https://youtube.com/playlist?list=123",
            "https://user:pass@youtube.com/watch?v=AbC_1234-xy",
            "https://youtu.be/AbC_1234-xy/extra",
            "https://youtube.com/watch?v=AbC_1234-xy&v=12345678901",
            "https://youtube.com:444/watch?v=AbC_1234-xy",
            "https://youtu.be/invalid",
        ] {
            assert!(normalize_youtube_url(url).is_err(), "{url}");
        }
    }
    #[test]
    fn proxy_is_a_single_explicit_address() {
        for proxy in [
            "http://127.0.0.1:1080",
            "socks5://user:password@example.com:1080",
            "https://example.com:8443",
        ] {
            assert!(validate_proxy(proxy).is_ok());
        }
        for proxy in [
            "file:///tmp/proxy",
            "https://example.com/command",
            "http://example.com?url=secret",
            "socks5://example.com",
        ] {
            assert!(validate_proxy(proxy).is_err());
        }
    }
    #[test]
    fn tool_errors_do_not_expose_proxy_credentials() {
        let result =
            friendly_tool_error(b"ERROR: proxy socks5://private:secret@example.com:1080 timed out");
        assert!(!result.contains("private"));
        assert!(!result.contains("secret"));
        assert!(result.contains("VPN"));
    }
    #[test]
    fn metadata_prefers_music_tags_and_is_bounded() {
        let info = serde_json::json!({"track":" Song\n", "title":"Video", "artist":"Artist", "uploader":"User"});
        assert_eq!(
            metadata_text(&info, &["track", "title"], "fallback"),
            "Song"
        );
        assert_eq!(
            metadata_text(&info, &["artist", "uploader"], "fallback"),
            "Artist"
        );
    }
}
