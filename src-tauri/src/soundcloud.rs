//! Imports original audio bytes, never a lower quality SoundCloud stream.
//! Network requests use public, pinned addresses and validate every redirect.
use reqwest::{header, redirect::Policy, Client, Response};
use serde_json::Value;
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    time::Duration,
};
use url::Url;

const MAX_AUDIO: usize = 200 * 1024 * 1024;
const MAX_HTML: usize = 8 * 1024 * 1024;
const MAX_SCRIPT: usize = 4 * 1024 * 1024;
const MAX_JSON: usize = 256 * 1024;
const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "flac", "wav", "m4a", "aac", "aiff", "aif", "ogg", "opus", "webm",
];

#[derive(Debug)]
pub struct DownloadedUrl {
    pub path: PathBuf,
    pub title: String,
    pub artist: String,
    pub expected_duration: Option<f64>,
}

/// The caller owns the completed file and must remove it after use or failure.
/// Dropping/cancelling this future removes any incomplete download.
pub async fn download_url(url: &str, directory: &Path) -> Result<DownloadedUrl, String> {
    tokio::time::timeout(Duration::from_secs(180), download_inner(url, directory))
        .await
        .map_err(|_| {
            "Загрузка по ссылке заняла слишком много времени. Попробуйте ещё раз.".to_string()
        })?
}

async fn download_inner(input: &str, directory: &Path) -> Result<DownloadedUrl, String> {
    let url = validate_url(input)?;
    let host = url.host_str().unwrap_or_default();
    if ["spotify.com", "spotify.link", "music.apple.com", "deezer.com", "tidal.com"].iter().any(|domain| host == *domain || host.ends_with(&format!(".{domain}"))) {
        return Err("Этот сервис не предоставляет полный исходный аудиофайл по обычной ссылке на песню. Pulse не скачивает превью и не подменяет трек поиском VK. Добавьте доступный полный аудиофайл или прямую ссылку на него.".into());
    }
    if matches!(
        host,
        "soundcloud.com" | "www.soundcloud.com" | "on.soundcloud.com"
    ) {
        return download_soundcloud(url, directory).await;
    }
    let response = get_public(url).await?;
    let content_type = response.headers().get(header::CONTENT_TYPE).and_then(|value| value.to_str().ok()).unwrap_or("").to_ascii_lowercase();
    if content_type.contains("html") {
        let page = response.url().clone();
        if page.host_str().is_some_and(|host| ["spotify.com", "spotify.link", "music.apple.com", "deezer.com", "tidal.com"].iter().any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))) {
            return Err("Spotify не предоставляет полный исходный аудиофайл по обычной ссылке на песню. Pulse не скачивает превью и не подменяет трек поиском VK. Добавьте доступный полный аудиофайл или прямую ссылку на него.".into());
        }
        let html = String::from_utf8(bounded_bytes(response, MAX_HTML).await?).map_err(|_| "Не удалось прочитать страницу с аудио.")?;
        let audio = crate::source_page::declared_audio(&html, &page).ok_or("Страница не содержит публичной ссылки на полный аудиофайл. Нужна ссылка на доступное аудио; трек не заменяется результатом поиска VK.")?;
        let response = get_public(audio.url).await?;
        return save_audio(response, directory, None, if audio.title.is_empty() { "Аудио по ссылке".into() } else { audio.title }, audio.artist).await;
    }
    let title = response_filename(&response)
        .or_else(|| url_filename(response.url()))
        .and_then(|name| {
            Path::new(&name)
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
        })
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Трек по ссылке".into());
    let (artist, title) = filename_metadata(&title);
    save_audio(response, directory, None, title, artist).await
}

fn filename_metadata(stem: &str) -> (String, String) {
    if let Some((artist, title)) = stem.split_once(" - ") {
        let artist = artist.trim();
        let title = title.trim();
        if !artist.is_empty() && !title.is_empty() {
            return (artist.into(), title.into());
        }
    }
    (String::new(), stem.into())
}

fn validate_url(input: &str) -> Result<Url, String> {
    let mut url = Url::parse(input.trim())
        .map_err(|_| "Введите полную HTTPS-ссылку на трек или аудиофайл.".to_string())?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
        || url.port_or_known_default() != Some(443)
        || input.len() > 8192
    {
        return Err("Нужна HTTPS-ссылка без логина, пароля и нестандартного порта.".into());
    }
    url.set_fragment(None);
    Ok(url)
}

fn public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0
        || a == 10
        || a == 127
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192
            && (b == 168 || (b == 0 && c == 0) || (b == 0 && c == 2) || (b == 88 && c == 99)))
        || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
        || (a == 203 && b == 0 && c == 113)
        || a >= 224)
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => public_v4(ip),
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                return public_v4(v4);
            }
            let s = ip.segments();
            // Public unicast only; exclude documentation and transition ranges.
            (s[0] & 0xe000) == 0x2000
                && !(s[0] == 0x2001 && (s[1] <= 0x01ff || s[1] == 0xdb8))
                && s[0] != 0x2002
        }
    }
}

async fn pinned_client(url: &Url) -> Result<Client, String> {
    let host = url
        .host_str()
        .ok_or("В ссылке отсутствует адрес сервера.")?;
    let addresses: Vec<SocketAddr> = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::net::lookup_host((host.trim_matches(['[', ']']), 443)),
    )
    .await
    .map_err(|_| "Сервер не ответил на запрос адреса.".to_string())?
    .map_err(|_| "Не удалось найти сервер. Проверьте ссылку и подключение.".to_string())?
    .collect();
    if addresses.is_empty() || addresses.iter().any(|address| !public_ip(address.ip())) {
        return Err("Ссылки на локальные и служебные сетевые адреса запрещены.".into());
    }
    Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .resolve_to_addrs(host, &addresses)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(90))
        .user_agent("VKPlayer/0.1 (original audio import)")
        .build()
        .map_err(|_| "Не удалось подготовить защищённое соединение.".into())
}

async fn get_public(mut url: Url) -> Result<Response, String> {
    for redirects in 0..=5 {
        url = validate_url(url.as_str())?;
        let client = pinned_client(&url).await?;
        let response = client.get(url.clone()).send().await.map_err(|_| {
            "Не удалось загрузить ссылку. Проверьте подключение или доступность сайта.".to_string()
        })?;
        if response.status().is_redirection() {
            if redirects == 5 {
                return Err("Сайт перенаправляет слишком много раз.".into());
            }
            let location = response
                .headers()
                .get(header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or("Некорректное перенаправление сайта.")?;
            url = url
                .join(location)
                .map_err(|_| "Некорректный адрес перенаправления.".to_string())?;
            continue;
        }
        if !response.status().is_success() {
            return Err(format!("Сайт не разрешил загрузку (HTTP {}). Откройте оригинальную ссылку и проверьте доступ.", response.status().as_u16()));
        }
        return Ok(response);
    }
    Err("Не удалось получить файл.".into())
}

async fn bounded_bytes(mut response: Response, limit: usize) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .map(|len| len > limit as u64)
        .unwrap_or(false)
    {
        return Err("Ответ сайта превышает допустимый размер.".into());
    }
    let mut output = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Соединение прервано во время загрузки.".to_string())?
    {
        if output.len().saturating_add(chunk.len()) > limit {
            return Err("Ответ сайта превышает допустимый размер.".into());
        }
        output.extend_from_slice(&chunk);
    }
    Ok(output)
}

fn hydration_track(html: &str) -> Result<Value, String> {
    let marker = "window.__sc_hydration";
    let source = html
        .find(marker)
        .and_then(|start| {
            html[start + marker.len()..]
                .split_once('=')
                .map(|(_, value)| value)
        })
        .ok_or("SoundCloud изменил страницу. Не удалось прочитать данные трека.")?;
    let hydration: Value = serde_json::Deserializer::from_str(source.trim_start())
        .into_iter::<Value>()
        .next()
        .ok_or("На странице нет данных SoundCloud.")?
        .map_err(|_| "Не удалось прочитать данные SoundCloud.".to_string())?;
    hydration
        .as_array()
        .and_then(|entries| {
            entries
                .iter()
                .find(|entry| entry.get("hydratable").and_then(Value::as_str) == Some("sound"))
        })
        .and_then(|entry| entry.get("data"))
        .cloned()
        .filter(|track| track.get("id").and_then(Value::as_u64).is_some())
        .ok_or_else(|| {
            "Нужна ссылка на отдельный трек SoundCloud, а не профиль или плейлист.".into()
        })
}

fn asset_scripts(html: &str) -> Vec<Url> {
    let mut scripts = Vec::new();
    for fragment in html.split("<script").skip(1) {
        let tag = fragment.split('>').next().unwrap_or_default();
        let Some(rest) = tag.split_once("src=").map(|(_, rest)| rest) else {
            continue;
        };
        let Some(quote) = rest.chars().next().filter(|c| *c == '\'' || *c == '"') else {
            continue;
        };
        let raw = rest[1..].split(quote).next().unwrap_or_default();
        let Ok(url) = Url::parse(raw) else { continue };
        if url.scheme() == "https"
            && url.host_str() == Some("a-v2.sndcdn.com")
            && url.path().ends_with(".js")
        {
            scripts.push(url);
        }
    }
    scripts.into_iter().rev().take(4).collect()
}

fn public_client_id(script: &str) -> Option<String> {
    for marker in ["client_id:", "client_id=", "\"client_id\":", "clientId:"] {
        for fragment in script.split(marker).skip(1) {
            let candidate = fragment.trim_start().trim_start_matches(['\'', '"']);
            let candidate: String = candidate
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric())
                .take(65)
                .collect();
            if candidate.len() == 32 {
                return Some(candidate);
            }
        }
    }
    None
}

async fn download_soundcloud(url: Url, directory: &Path) -> Result<DownloadedUrl, String> {
    let response = get_public(url).await?;
    if !matches!(
        response.url().host_str(),
        Some("soundcloud.com" | "www.soundcloud.com")
    ) {
        return Err("Ссылка SoundCloud не ведёт на страницу трека.".into());
    }
    let html = String::from_utf8(bounded_bytes(response, MAX_HTML).await?)
        .map_err(|_| "Не удалось прочитать страницу SoundCloud.".to_string())?;
    let track = hydration_track(&html)?;
    if track.get("downloadable").and_then(Value::as_bool) != Some(true) {
        return Err("Автор SoundCloud не разрешил скачивать оригинал этого трека. Добавление без потери качества недоступно; выберите разрешённый оригинальный файл или прямую ссылку на него.".into());
    }
    if track.get("has_downloads_left").and_then(Value::as_bool) == Some(false) {
        return Err(
            "У этого трека закончился разрешённый SoundCloud лимит скачивания оригинала.".into(),
        );
    }
    let title = track
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("SoundCloud")
        .to_string();
    let artist = track
        .pointer("/user/username")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let extension = track
        .get("original_format")
        .and_then(Value::as_str)
        .map(str::to_ascii_lowercase);
    let mut client_id = public_client_id(&html);
    if client_id.is_none() {
        for script in asset_scripts(&html) {
            let Ok(response) = get_public(script).await else {
                continue;
            };
            let Ok(bytes) = bounded_bytes(response, MAX_SCRIPT).await else {
                continue;
            };
            client_id = public_client_id(&String::from_utf8_lossy(&bytes));
            if client_id.is_some() {
                break;
            }
        }
    }
    let client_id = client_id.ok_or("SoundCloud сейчас не предоставил доступ к оригинальному файлу. Можно использовать прямую ссылку из кнопки Download file на странице автора.")?;
    let id = track
        .get("id")
        .and_then(Value::as_u64)
        .ok_or("Не удалось определить трек SoundCloud.")?;
    let mut download = Url::parse(&format!(
        "https://api-v2.soundcloud.com/tracks/{id}/download"
    ))
    .map_err(|_| "Не удалось подготовить ссылку SoundCloud.")?;
    download
        .query_pairs_mut()
        .append_pair("client_id", &client_id);
    let response = get_public(download).await.map_err(|_| "SoundCloud не разрешил получить оригинальный файл. Попробуйте кнопку Download file на странице автора; защищённые файлы и прослушивание не заменяют оригинал.".to_string())?;
    let value: Value =
        serde_json::from_slice(&bounded_bytes(response, MAX_JSON).await?).map_err(|_| {
            "SoundCloud вернул неподдерживаемый ответ при загрузке оригинала.".to_string()
        })?;
    let original = value
        .get("redirectUri")
        .or_else(|| value.get("redirect_uri"))
        .and_then(Value::as_str)
        .ok_or("SoundCloud не вернул ссылку на оригинальный файл.")?;
    let original = validate_url(original)?;
    let response = get_public(original).await?;
    save_audio(response, directory, extension.as_deref(), title, artist).await
}

fn decoded_name(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    out.push(byte);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).replace(['/', '\\', '\0'], "_")
}

fn response_filename(response: &Response) -> Option<String> {
    let disposition = response
        .headers()
        .get(header::CONTENT_DISPOSITION)?
        .to_str()
        .ok()?;
    disposition_filename(disposition)
}

fn disposition_value(input: &str) -> Option<String> {
    let input = input.trim();
    let Some(quoted) = input.strip_prefix('"') else {
        return (!input.is_empty() && !input.contains('"')).then(|| input.into());
    };
    let mut chars = quoted.chars();
    let mut value = String::new();
    while let Some(character) = chars.next() {
        match character {
            '\\' => value.push(chars.next()?),
            '"' => return chars.as_str().trim().is_empty().then_some(value),
            _ => value.push(character),
        }
    }
    None
}

fn disposition_filename(disposition: &str) -> Option<String> {
    let mut fallback = None;
    let mut quoted = false;
    let mut escaped = false;
    let parameters = disposition.split(|character| {
        if escaped {
            escaped = false;
        } else if quoted && character == '\\' {
            escaped = true;
        } else if character == '"' {
            quoted = !quoted;
        } else if character == ';' && !quoted {
            return true;
        }
        false
    });
    for item in parameters.skip(1) {
        let Some((key, value)) = item.trim().split_once('=') else {
            continue;
        };
        let Some(value) = disposition_value(value).filter(|value| !value.is_empty()) else {
            continue;
        };
        let key = key.trim();
        if key.eq_ignore_ascii_case("filename*") {
            let mut parts = value.splitn(3, '\'');
            if let (Some(charset), Some(_language), Some(encoded)) =
                (parts.next(), parts.next(), parts.next())
            {
                if charset.eq_ignore_ascii_case("utf-8") && !encoded.is_empty() {
                    return Some(decoded_name(encoded));
                }
            }
        } else if key.eq_ignore_ascii_case("filename") {
            fallback = Some(decoded_name(&value));
        }
    }
    fallback
}

fn url_filename(url: &Url) -> Option<String> {
    url.path_segments()?
        .next_back()
        .filter(|name| !name.is_empty())
        .map(decoded_name)
}

fn extension_from_name(name: &str) -> Option<String> {
    Path::new(name)
        .extension()
        .and_then(|s| s.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|extension| AUDIO_EXTENSIONS.contains(&extension.as_str()))
}

fn audio_extension(response: &Response, hint: Option<&str>) -> Option<String> {
    response_filename(response)
        .and_then(|name| extension_from_name(&name))
        .or_else(|| url_filename(response.url()).and_then(|name| extension_from_name(&name)))
        .or_else(|| {
            let mime = response
                .headers()
                .get(header::CONTENT_TYPE)?
                .to_str()
                .ok()?
                .split(';')
                .next()?
                .trim();
            Some(
                match mime {
                    "audio/mpeg" | "audio/mp3" => "mp3",
                    "audio/flac" | "audio/x-flac" => "flac",
                    "audio/wav" | "audio/x-wav" | "audio/wave" => "wav",
                    "audio/aac" => "aac",
                    "audio/mp4" | "audio/x-m4a" => "m4a",
                    "audio/aiff" | "audio/x-aiff" => "aiff",
                    "audio/ogg" | "application/ogg" => "ogg",
                    "audio/opus" => "opus",
                    "audio/webm" => "webm",
                    _ => return None,
                }
                .into(),
            )
        })
        .or_else(|| {
            hint.filter(|extension| AUDIO_EXTENSIONS.contains(extension))
                .map(str::to_owned)
        })
}

struct PartialFile {
    path: PathBuf,
    committed: bool,
}
impl Drop for PartialFile {
    fn drop(&mut self) {
        if !self.committed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

async fn save_audio(
    mut response: Response,
    directory: &Path,
    hint: Option<&str>,
    title: String,
    artist: String,
) -> Result<DownloadedUrl, String> {
    let mime = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    if mime.starts_with("text/") || mime.contains("json") || mime.contains("html") {
        return Err("Это страница сайта, а не аудиофайл. Вставьте прямую ссылку на MP3/FLAC/WAV или ссылку на трек поддерживаемого сервиса.".into());
    }
    let extension = audio_extension(&response, hint).ok_or(
        "По ссылке нет распознанного оригинального аудиофайла. Нужна прямая ссылка на аудио.",
    )?;
    if response
        .content_length()
        .map(|len| len > MAX_AUDIO as u64)
        .unwrap_or(false)
    {
        return Err("Файл превышает 200 МБ. Выберите оригинал меньшего размера.".into());
    }
    fs::create_dir_all(directory)
        .map_err(|_| "Не удалось создать папку для загрузки.".to_string())?;
    let random: [u8; 16] = rand::random();
    let base = format!("import-{}", hex::encode(random));
    let partial_path = directory.join(format!("{base}.partial"));
    let final_path = directory.join(format!("{base}.{extension}"));
    // Declare the guard before the open file so Windows closes the file first.
    let mut partial = PartialFile {
        path: partial_path.clone(),
        committed: false,
    };
    let mut file: File = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&partial_path)
        .map_err(|_| "Не удалось создать файл загрузки.".to_string())?;
    let mut received = 0usize;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Загрузка прервана. Неполный файл удалён, повторите попытку.".to_string())?
    {
        received = received.saturating_add(chunk.len());
        if received > MAX_AUDIO {
            return Err("Файл превышает 200 МБ. Неполная загрузка удалена.".into());
        }
        file.write_all(&chunk)
            .map_err(|_| "Не удалось сохранить файл. Проверьте свободное место.".to_string())?;
    }
    if received == 0 {
        return Err("Сайт вернул пустой файл.".into());
    }
    file.sync_all()
        .map_err(|_| "Не удалось завершить сохранение файла.".to_string())?;
    drop(file);
    fs::rename(&partial_path, &final_path)
        .map_err(|_| "Не удалось завершить сохранение файла.".to_string())?;
    partial.committed = true;
    Ok(DownloadedUrl {
        path: final_path,
        title,
        artist,
        expected_duration: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    fn temporary_directory() -> PathBuf {
        std::env::temp_dir().join(format!("vk-url-import-qa-{}", rand::random::<u64>()))
    }

    async fn fixture_response(headers: &str, body: &[u8]) -> Response {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let raw = [
            format!("HTTP/1.1 200 OK\r\nConnection: close\r\n{headers}\r\n").as_bytes(),
            body,
        ]
        .concat();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            let _ = stream.read(&mut request);
            stream.write_all(&raw).unwrap();
        });
        // Test only: directly exercise the private writer with a synthetic
        // response. Production always reaches it through pinned get_public.
        Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(format!("http://{address}/source.mp3"))
            .send()
            .await
            .unwrap()
    }
    #[test]
    fn unsafe_url_forms_are_rejected() {
        for url in [
            "http://example.com/a.mp3",
            "file:///tmp/a.mp3",
            "https://me:password@example.com/a.mp3",
            "https://example.com:444/a.mp3",
            "ftp://example.com/a",
        ] {
            assert!(validate_url(url).is_err(), "{url}");
        }
        assert!(validate_url("https://example.com/a.mp3?download=1").is_ok());
    }
    #[test]
    fn special_network_ranges_are_rejected() {
        for ip in [
            "127.0.0.1",
            "10.0.1.2",
            "192.168.1.1",
            "172.31.255.255",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "198.18.1.1",
            "203.0.113.1",
            "::1",
            "::ffff:127.0.0.1",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
            "2001:2::1",
            "2001:10::1",
            "2002:7f00:1::",
        ] {
            assert!(!public_ip(ip.parse().unwrap()), "{ip}");
        }
        for ip in [
            "1.1.1.1",
            "8.8.8.8",
            "93.184.216.34",
            "2606:4700:4700::1111",
        ] {
            assert!(public_ip(ip.parse().unwrap()), "{ip}");
        }
    }
    #[test]
    fn hydration_keeps_only_the_single_track() {
        let html = r#"<script>window.__sc_hydration = [{"hydratable":"user","data":{"id":3}},{"hydratable":"sound","data":{"id":42,"downloadable":true,"title":"Original"}}];</script>"#;
        let track = hydration_track(html).unwrap();
        assert_eq!(track["id"], 42);
        assert_eq!(track["title"], "Original");
        assert!(hydration_track("<html>no player</html>").is_err());
        assert!(hydration_track(
            r#"window.__sc_hydration = [{"hydratable":"playlist","data":{"id":1}}];"#
        )
        .is_err());
    }
    #[test]
    fn discovers_only_public_official_scripts_and_client_identifier() {
        let html = r#"<script src="https://evil.example/x.js"></script><script src="https://a-v2.sndcdn.com/assets/1.js"></script><script src='https://a-v2.sndcdn.com/assets/2.js'></script>"#;
        let scripts = asset_scripts(html);
        assert_eq!(scripts.len(), 2);
        assert!(scripts[0].path().ends_with("2.js"));
        assert_eq!(
            public_client_id(r#"const a={client_id:"0123456789ABCDEFGHIJKLMNOPQRSTUV"};"#)
                .unwrap()
                .len(),
            32
        );
        assert!(public_client_id("client_id:\"short\"").is_none());
    }
    #[test]
    fn filename_cannot_escape_download_directory() {
        assert_eq!(
            decoded_name("..%2F..%5Ctrack%20name.mp3"),
            ".._.._track name.mp3"
        );
        assert_eq!(extension_from_name("song.MP3"), Some("mp3".into()));
        assert!(extension_from_name("script.exe").is_none());
    }

    #[test]
    fn content_disposition_keeps_quoted_semicolons_and_prefers_extended_filename() {
        assert_eq!(
            disposition_filename(r#"attachment; filename="Artist - Song; Remix.mp3""#),
            Some("Artist - Song; Remix.mp3".into())
        );
        assert_eq!(
            disposition_filename(r#"attachment; filename="Artist - \"Song; Remix\".mp3""#),
            Some("Artist - \"Song; Remix\".mp3".into())
        );
        for header in [
            r#"attachment; filename="Artist - Song; Remix.mp3"; filename*=UTF-8'en'Extended%20Title.mp3"#,
            r#"attachment; filename*=UTF-8'en'Extended%20Title.mp3; filename="Artist - Song; Remix.mp3""#,
        ] {
            assert_eq!(
                disposition_filename(header),
                Some("Extended Title.mp3".into())
            );
        }
        assert!(disposition_filename(r#"attachment; filename="unclosed.mp3"#).is_none());
    }

    #[test]
    fn filename_metadata_splits_only_two_nonempty_parts() {
        assert_eq!(
            filename_metadata("Artist - Song; Remix"),
            ("Artist".into(), "Song; Remix".into())
        );
        for stem in ["Artist - ", " - Song", "  -  ", "Artist - \t"] {
            assert_eq!(filename_metadata(stem), (String::new(), stem.into()));
        }
    }

    #[test]
    fn incomplete_file_guard_cleans_up() {
        let path =
            std::env::temp_dir().join(format!("vk-import-qa-{}.partial", rand::random::<u64>()));
        fs::write(&path, b"partial").unwrap();
        {
            let _guard = PartialFile {
                path: path.clone(),
                committed: false,
            };
        }
        assert!(!path.exists());
    }

    #[test]
    fn original_audio_bytes_are_saved_without_reencoding() {
        runtime().block_on(async {
            let directory = temporary_directory();
            let original = [b"ID3\x04\0\0\0\0\0\0".as_slice(), &[0xff; 1024]].concat();
            let response = fixture_response(&format!("Content-Type: audio/mpeg\r\nContent-Length: {}\r\nContent-Disposition: attachment; filename*=UTF-8''Artist%20-%20Song.mp3\r\n", original.len()), &original).await;
            let downloaded = save_audio(response, &directory, None, "Song".into(), "Artist".into()).await.unwrap();
            assert_eq!(fs::read(&downloaded.path).unwrap(), original);
            assert_eq!(downloaded.path.extension().unwrap(), "mp3");
            assert_eq!(downloaded.title, "Song");
            assert_eq!(downloaded.artist, "Artist");
            assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
            fs::remove_dir_all(directory).unwrap();
        });
    }

    #[test]
    fn webpage_disguised_as_mp3_never_creates_an_audio_file() {
        runtime().block_on(async {
            let directory = temporary_directory();
            let response = fixture_response(
                "Content-Type: text/html\r\nContent-Length: 13\r\n",
                b"<html></html>",
            )
            .await;
            assert!(
                save_audio(response, &directory, None, "Song".into(), String::new())
                    .await
                    .unwrap_err()
                    .contains("страница")
            );
            assert!(!directory.exists());
        });
    }

    #[test]
    fn truncated_network_download_removes_partial_file() {
        runtime().block_on(async {
            let directory = temporary_directory();
            let response = fixture_response(
                "Content-Type: audio/mpeg\r\nContent-Length: 4096\r\n",
                b"ID3not-complete",
            )
            .await;
            assert!(
                save_audio(response, &directory, None, "Song".into(), String::new())
                    .await
                    .is_err()
            );
            assert_eq!(fs::read_dir(&directory).unwrap().count(), 0);
            fs::remove_dir_all(directory).unwrap();
        });
    }

    #[test]
    fn cancellation_removes_open_partial_file_on_windows() {
        runtime().block_on(async {
            let directory = temporary_directory();
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let (finished, waiting) = std::sync::mpsc::channel();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0u8; 4096];
                let _ = stream.read(&mut request);
                stream.write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: audio/mpeg\r\nContent-Length: 100000\r\n\r\nID3partial").unwrap();
                let _ = waiting.recv_timeout(Duration::from_secs(2));
            });
            let response = Client::builder().no_proxy().build().unwrap()
                .get(format!("http://{address}/source.mp3")).send().await.unwrap();
            assert!(tokio::time::timeout(Duration::from_millis(50), save_audio(response, &directory, None, "Song".into(), String::new())).await.is_err());
            assert_eq!(fs::read_dir(&directory).unwrap().count(), 0);
            let _ = finished.send(());
            server.join().unwrap();
            fs::remove_dir_all(directory).unwrap();
        });
    }

    #[test]
    fn declared_oversized_download_never_creates_a_partial_file() {
        runtime().block_on(async {
            let directory = temporary_directory();
            let response = fixture_response(
                "Content-Type: audio/mpeg\r\nContent-Length: 209715201\r\n",
                b"",
            )
            .await;
            assert!(
                save_audio(response, &directory, None, "Song".into(), String::new())
                    .await
                    .is_err()
            );
            assert!(!directory.exists());
        });
    }
}
