//! Read-only collection metadata adapters. Audio and playback are deliberately untouched.
//! Spotify uses the user's consent through PKCE; tokens live only in the OS keyring.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::{rngs::OsRng, RngCore};
use reqwest::{header, redirect::Policy, Client, Response};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    io::{Read, Write},
    net::{IpAddr, Ipv4Addr, TcpListener, TcpStream},
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use url::Url;

const REDIRECT: &str = "http://127.0.0.1:43823/pulse-spotify";
const MAX_JSON: usize = 12 * 1024 * 1024;
const MAX_TRACKS: usize = 20_000;
const MAX_PAGES: usize = 400;
const SCOPES: &str = "user-library-read playlist-read-private playlist-read-collaborative";
static GENERATION: AtomicU64 = AtomicU64::new(0);
static CONNECTING: AtomicBool = AtomicBool::new(false);
static TOKEN_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    source_id: String,
    title: String,
    artists: Vec<String>,
    album: String,
    duration: f64,
    position: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    isrc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    explicit: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    artwork: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    added_at: Option<i64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    service: String,
    source_id: String,
    source_url: String,
    title: String,
    description: String,
    artwork: Option<String>,
    total: Option<usize>,
    complete: bool,
    warnings: Vec<String>,
    entries: Vec<Entry>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Descriptor {
    service: String,
    source_id: String,
    source_url: String,
    title: String,
    total: Option<usize>,
    artwork: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    configured: bool,
    connected: bool,
    message: String,
    user_name: Option<String>,
}
#[derive(Serialize)]
pub struct ImportStatus {
    spotify: AccountStatus,
    yandex: AccountStatus,
}
#[derive(Clone, Serialize, Deserialize)]
struct Tokens {
    client_id: String,
    access_token: String,
    refresh_token: String,
    expires_at: u64,
}
fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}
fn configured_client() -> String {
    option_env!("PULSE_SPOTIFY_CLIENT_ID").unwrap_or("").trim().to_string()
}
fn valid_client(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}
fn keyring() -> Result<keyring::Entry, String> {
    keyring::Entry::new("ru.vkplayer.desktop.import.spotify", "session")
        .map_err(|_| "Не удалось открыть защищённое хранилище Spotify.".into())
}
fn load_tokens() -> Result<Option<Tokens>, String> {
    match keyring()?.get_password() {
        Ok(raw) if raw.len() <= 32_768 => serde_json::from_str(&raw).map(Some)
            .map_err(|_| "Сохранённый вход Spotify повреждён. Подключите аккаунт заново.".into()),
        Ok(_) => Err("Сохранённый вход Spotify повреждён.".into()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Системное хранилище не разрешило прочитать вход Spotify.".into()),
    }
}
fn assert_generation(epoch: u64) -> Result<(), String> {
    if GENERATION.load(Ordering::SeqCst) == epoch { Ok(()) } else { Err("Импорт отменён или аккаунт отключён.".into()) }
}
fn save_tokens(value: &Tokens, epoch: u64) -> Result<(), String> {
    assert_generation(epoch)?;
    let raw = serde_json::to_string(value).map_err(|_| "Не удалось сохранить вход Spotify.")?;
    keyring()?.set_password(&raw).map_err(|_| "Системное хранилище не разрешило сохранить вход Spotify.".to_string())
}
fn http() -> Result<Client, String> {
    Client::builder().redirect(Policy::none()).connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(25)).user_agent("Pulse/0.5 collection-metadata")
        .build().map_err(|_| "Не удалось подготовить соединение с музыкальным сервисом.".into())
}
async fn bounded(response: Response) -> Result<Vec<u8>, String> {
    if response.content_length().is_some_and(|size| size > MAX_JSON as u64) { return Err("Ответ сервиса слишком большой.".into()); }
    let mut response = response; let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Соединение с сервисом прервано.")? {
        if bytes.len().saturating_add(chunk.len()) > MAX_JSON { return Err("Ответ сервиса слишком большой.".into()); }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
fn status_error(code: u16) -> String {
    match code {
        401 => "Вход в сервис истёк. Подключите аккаунт заново.".into(),
        403 => "Spotify не разрешил прочитать коллекцию. В Development Mode аккаунт должен быть в списке пользователей приложения; содержимое чужих плейлистов может быть доступно только владельцу или соавтору.".into(),
        404 => "Плейлист не найден или закрыт. Для личных плейлистов сначала подключите аккаунт.".into(),
        429 => "Сервис ограничил частоту запросов. Готовая часть сохранится; повторите импорт позднее.".into(),
        451 => "Этот сервис недоступен в текущем регионе подключения.".into(),
        _ => format!("Сервис не разрешил прочитать коллекцию (HTTP {code})."),
    }
}
async fn response_json(response: Response) -> Result<Value, String> {
    if !response.status().is_success() { return Err(status_error(response.status().as_u16())); }
    serde_json::from_slice(&bounded(response).await?).map_err(|_| "Сервис вернул некорректные метаданные коллекции.".into())
}
fn spotify_api_url(input: &str) -> Result<Url, String> {
    let url = Url::parse(input).map_err(|_| "Некорректная страница Spotify.")?;
    if url.scheme() != "https" || url.host_str() != Some("api.spotify.com") || url.port_or_known_default() != Some(443)
        || !url.username().is_empty() || url.password().is_some() || !url.path().starts_with("/v1/") || url.fragment().is_some() {
        return Err("Spotify вернул недопустимый адрес следующей страницы.".into());
    }
    Ok(url)
}
fn legacy_playlist_items_url(url: &Url, status: u16) -> Option<Url> {
    if !matches!(status, 404 | 410) || spotify_api_url(url.as_str()).is_err() { return None; }
    let segments = url.path_segments()?.collect::<Vec<_>>();
    if segments.len() != 4 || segments[0] != "v1" || segments[1] != "playlists"
        || !valid_spotify_id(segments[2]) || segments[3] != "items" { return None; }
    let mut legacy = url.clone();
    legacy.set_path(&format!("/v1/playlists/{}/tracks", segments[2]));
    Some(legacy)
}
async fn access_token(epoch: u64) -> Result<String, String> {
    let _lock = TOKEN_LOCK.lock().await;
    assert_generation(epoch)?;
    let stored = load_tokens()?.ok_or("Сначала подключите Spotify. Для личной коллекции нужен вход в аккаунт.")?;
    if stored.expires_at > now() + 45 { return Ok(stored.access_token); }
    let response = http()?.post("https://accounts.spotify.com/api/token")
        .form(&[("grant_type", "refresh_token"), ("refresh_token", stored.refresh_token.as_str()), ("client_id", stored.client_id.as_str())])
        .send().await.map_err(|_| "Не удалось обновить вход Spotify. Проверьте подключение.")?;
    let value = response_json(response).await?;
    let tokens = parse_tokens(&value, stored.client_id, Some(&stored.refresh_token))?;
    save_tokens(&tokens, epoch)?;
    Ok(tokens.access_token)
}
fn parse_tokens(value: &Value, client_id: String, previous_refresh: Option<&str>) -> Result<Tokens, String> {
    let access = value["access_token"].as_str().filter(|s| !s.is_empty() && s.len() < 8192).ok_or("Spotify не выдал токен входа.")?;
    let refresh = value["refresh_token"].as_str().or(previous_refresh).filter(|s| !s.is_empty() && s.len() < 8192).ok_or("Spotify не выдал длительную сессию. Подключите аккаунт заново.")?;
    let expires = value["expires_in"].as_u64().filter(|time| *time > 0 && *time <= 86400).ok_or("Spotify вернул неверный срок сессии.")?;
    Ok(Tokens { client_id, access_token: access.into(), refresh_token: refresh.into(), expires_at: now() + expires })
}
async fn spotify_get(input: &str, epoch: u64) -> Result<Value, String> {
    assert_generation(epoch)?;
    let url = spotify_api_url(input)?; let token = access_token(epoch).await?;
    let mut auth = header::HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| "Неверный токен Spotify.")?;
    auth.set_sensitive(true);
    let client = http()?;
    let mut response = client.get(url.clone()).header(header::AUTHORIZATION, auth.clone()).send().await.map_err(|_| "Spotify не ответил. Проверьте подключение и повторите импорт.")?;
    assert_generation(epoch)?;
    // New Development Mode apps use /items. Legacy/Extended apps can still expose
    // /tracks; retry only an absent endpoint, never a permission/rate-limit denial.
    if let Some(legacy) = legacy_playlist_items_url(&url, response.status().as_u16()) {
        response = client.get(legacy).header(header::AUTHORIZATION, auth).send().await.map_err(|_| "Spotify не ответил. Проверьте подключение и повторите импорт.")?;
        assert_generation(epoch)?;
    }
    let result = response_json(response).await;
    assert_generation(epoch)?;
    result
}

#[tauri::command]
pub fn service_import_status() -> Result<ImportStatus, String> {
    let session = load_tokens()?;
    Ok(ImportStatus { spotify: AccountStatus {
        configured: session.is_some() || valid_client(&configured_client()), connected: session.is_some(),
        message: if session.is_some() { "Аккаунт подключён. Доступны любимые треки и ваши плейлисты.".into() }
            else if valid_client(&configured_client()) { "Войдите в Spotify и разрешите чтение любимых треков и плейлистов.".into() }
            else { "Вход Spotify ещё не настроен владельцем Pulse. Доступен импорт файла экспорта и публичных плейлистов, если сервис разрешает их чтение.".into() }, user_name: None,
    }, yandex: serde_json::from_value(crate::yandex_account_import::status())
        .map_err(|_| "Не удалось прочитать статус подключения Яндекс Музыки.")? })
}

fn random_text() -> String { let mut bytes = [0_u8; 32]; OsRng.fill_bytes(&mut bytes); URL_SAFE_NO_PAD.encode(bytes) }
struct ConnectingGuard;
impl Drop for ConnectingGuard { fn drop(&mut self) { CONNECTING.store(false, Ordering::SeqCst); } }

#[tauri::command]
pub async fn connect_service_import(app: AppHandle, service: String, client_id: Option<String>) -> Result<ImportStatus, String> {
    if service == "yandex" {
        crate::yandex_account_import::connect(app).await?;
        return service_import_status();
    }
    if service != "spotify" { return Err("Неизвестный музыкальный сервис.".into()); }
    if CONNECTING.swap(true, Ordering::SeqCst) { return Err("Окно входа Spotify уже открыто.".into()); }
    let _guard = ConnectingGuard;
    let client_id = client_id.unwrap_or_else(configured_client).trim().to_string();
    if !valid_client(&client_id) { return Err(format!("Укажите Client ID Spotify (32 шестнадцатеричных символа). В Dashboard зарегистрируйте Redirect URI: {REDIRECT}. Client Secret не нужен.")); }
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 43823)).map_err(|_| "Порт входа Spotify 43823 занят. Закройте другое окно входа и повторите.")?;
    listener.set_nonblocking(true).map_err(|_| "Не удалось подготовить локальный вход Spotify.")?;
    let epoch = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let verifier = random_text(); let state = random_text(); let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let mut auth = Url::parse("https://accounts.spotify.com/authorize").unwrap();
    auth.query_pairs_mut().extend_pairs([("response_type", "code"), ("client_id", client_id.as_str()), ("redirect_uri", REDIRECT),
        ("scope", SCOPES), ("state", state.as_str()), ("code_challenge_method", "S256"), ("code_challenge", challenge.as_str())]);
    app.opener().open_url(auth.to_string(), None::<String>).map_err(|_| "Не удалось открыть системный браузер для Spotify.")?;
    let code = tauri::async_runtime::spawn_blocking(move || wait_callback(listener, &state, epoch)).await
        .map_err(|_| "Окно входа Spotify завершилось с ошибкой.")??;
    assert_generation(epoch)?;
    let response = http()?.post("https://accounts.spotify.com/api/token")
        .form(&[("grant_type", "authorization_code"), ("client_id", client_id.as_str()), ("code", code.as_str()),
            ("redirect_uri", REDIRECT), ("code_verifier", verifier.as_str())])
        .send().await.map_err(|_| "Не удалось завершить вход Spotify.")?;
    let response = response_json(response).await?;
    let granted: HashSet<_> = response["scope"].as_str().unwrap_or("").split_whitespace().collect();
    if !SCOPES.split_whitespace().all(|scope| granted.contains(scope)) {
        return Err("Spotify не выдал все разрешения на любимые треки и личные плейлисты. Повторите подключение и разрешите чтение коллекции.".into());
    }
    let tokens = parse_tokens(&response, client_id, None)?;
    let _lock = TOKEN_LOCK.lock().await;
    save_tokens(&tokens, epoch)?;
    service_import_status()
}
fn callback_code(request: &str, state: &str) -> Result<Option<String>, String> {
    if request.len() > 16_384 || !request.contains("\r\n\r\n") { return Ok(None); }
    let line = request.lines().next().unwrap_or("");
    let mut words = line.split_whitespace();
    if words.next() != Some("GET") { return Ok(None); }
    let target = words.next().unwrap_or("");
    if !matches!(words.next(), Some("HTTP/1.0" | "HTTP/1.1")) || words.next().is_some() { return Ok(None); }
    if !target.starts_with('/') || target.starts_with("//") { return Ok(None); }
    let url = Url::parse(&format!("http://127.0.0.1:43823{target}")).map_err(|_| "Некорректный ответ Spotify.")?;
    let hosts: Vec<_> = request.lines().skip(1).take_while(|line|!line.is_empty()).filter_map(|line| line.split_once(':').filter(|(key, _)| key.eq_ignore_ascii_case("host")).map(|(_, value)| value.trim())).collect();
    if url.path() != "/pulse-spotify" || url.fragment().is_some() || hosts.as_slice() != ["127.0.0.1:43823"] { return Ok(None); }
    let pairs: Vec<_> = url.query_pairs().collect();
    if pairs.iter().filter(|(key, _)| key == "state").count() != 1 || pairs.iter().find(|(key, _)| key == "state").map(|(_, value)| value.as_ref()) != Some(state) { return Ok(None); }
    if pairs.iter().any(|(key, _)| key == "error") { return Err("Вход Spotify отменён или доступ не разрешён.".into()); }
    if pairs.iter().filter(|(key, _)| key == "code").count() != 1 { return Ok(None); }
    Ok(pairs.iter().find(|(key, value)| key == "code" && !value.is_empty() && value.len() < 8192 && !value.chars().any(char::is_control)).map(|(_, value)| value.to_string()))
}
fn reply(stream: &mut TcpStream, success: bool) {
    let body = if success { "Spotify connected. Return to Pulse. You can close this tab." } else { "This callback is not valid. Return to Pulse to retry." };
    let _ = write!(stream, "HTTP/1.1 {}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", if success { "200 OK" } else { "400 Bad Request" }, body.len(), body);
}
fn wait_callback(listener: TcpListener, state: &str, epoch: u64) -> Result<String, String> {
    let deadline = Instant::now() + Duration::from_secs(180);
    while Instant::now() < deadline {
        assert_generation(epoch)?;
        match listener.accept() {
            Ok((mut stream, address)) if address.ip() == IpAddr::V4(Ipv4Addr::LOCALHOST) => {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
                let mut bytes = Vec::new(); let mut buffer = [0_u8; 1024];
                let connection_deadline = Instant::now() + Duration::from_secs(2);
                while bytes.len() < 16_384 && Instant::now() < connection_deadline && Instant::now() < deadline {
                    assert_generation(epoch)?;
                    match stream.read(&mut buffer) { Ok(0) | Err(_) => break, Ok(size) => bytes.extend_from_slice(&buffer[..size]) }
                    if bytes.windows(4).any(|part| part == b"\r\n\r\n") { break; }
                }
                match callback_code(&String::from_utf8_lossy(&bytes), state) {
                    Ok(Some(code)) => { reply(&mut stream, true); return Ok(code); }
                    Err(error) => { reply(&mut stream, false); return Err(error); }
                    _ => reply(&mut stream, false),
                }
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(80)),
            Err(_) => return Err("Локальное окно входа Spotify недоступно.".into()),
        }
    }
    Err("Время входа Spotify истекло. Нажмите «Подключить» ещё раз.".into())
}
#[tauri::command]
pub fn cancel_service_import() { GENERATION.fetch_add(1, Ordering::SeqCst); crate::yandex_account_import::cancel(); }
#[tauri::command]
pub async fn disconnect_service_import(app: AppHandle, service: String) -> Result<ImportStatus, String> {
    if service == "yandex" {
        crate::yandex_account_import::disconnect(app).await?;
        return service_import_status();
    }
    if service != "spotify" { return Err("Неизвестный музыкальный сервис.".into()); }
    GENERATION.fetch_add(1, Ordering::SeqCst);
    let _lock = TOKEN_LOCK.lock().await;
    match keyring()?.delete_credential() { Ok(()) | Err(keyring::Error::NoEntry) => {}, Err(_) => return Err("Не удалось удалить вход из системного хранилища.".into()) }
    service_import_status()
}

fn string(value: &Value, key: &str) -> String { value[key].as_str().unwrap_or("").trim().chars().take(2000).collect() }
fn image(value: &Value) -> Option<String> {
    value.as_array()?.iter().find_map(|value| value["url"].as_str()).filter(|url| Url::parse(url).is_ok_and(|url| url.scheme() == "https" && url.username().is_empty() && url.password().is_none())).map(str::to_string)
}
fn spotify_entry(raw: &Value, position: usize) -> Option<Entry> {
    let value = raw.get("item").or_else(|| raw.get("track")).unwrap_or(raw);
    if value.is_null() || value["is_local"].as_bool() == Some(true) || value["type"].as_str().is_some_and(|kind| kind != "track") { return None; }
    let title = string(value, "name"); let id = string(value, "id");
    let artists: Vec<String> = value["artists"].as_array()?.iter().map(|artist| string(artist, "name")).filter(|name| !name.is_empty()).take(30).collect();
    if title.is_empty() || id.is_empty() || artists.is_empty() { return None; }
    Some(Entry { source_id: id, title, artists, album: string(&value["album"], "name"),
        duration: value["duration_ms"].as_f64().unwrap_or(0.) / 1000., position,
        isrc: value["external_ids"]["isrc"].as_str().map(str::to_string), explicit: value["explicit"].as_bool(), artwork: image(&value["album"]["images"]), added_at: None })
}
fn valid_spotify_id(value: &str) -> bool { value.len() == 22 && value.bytes().all(|byte| byte.is_ascii_alphanumeric()) }

#[tauri::command]
pub async fn list_service_playlists(app: AppHandle, service: String) -> Result<Vec<Descriptor>, String> {
    if service == "yandex" {
        return serde_json::from_value(crate::yandex_account_import::list(app).await?)
            .map_err(|_| "Яндекс вернул некорректный список коллекций.".into());
    }
    if service != "spotify" { return Err("Неизвестный музыкальный сервис.".into()); }
    let epoch = GENERATION.load(Ordering::SeqCst);
    let mut result = vec![Descriptor { service: "spotify".into(), source_id: "liked".into(), source_url: "pulse:spotify:liked".into(), title: "Любимые треки Spotify".into(), total: None, artwork: None }];
    let mut next = Some("https://api.spotify.com/v1/me/playlists?limit=50".to_string()); let mut seen = HashSet::new();
    let mut total = None; let mut received = 0; let mut playlist_ids = HashSet::new();
    for _ in 0..MAX_PAGES {
        let Some(url) = next.take() else { assert_generation(epoch)?; return Ok(result); };
        if !seen.insert(url.clone()) { return Err("Spotify повторил страницу плейлистов. Повторите подключение позднее.".into()); }
        let value = spotify_get(&url, epoch).await?;
        let rows = value["items"].as_array().filter(|rows|rows.len() <= 50).ok_or("Spotify не вернул допустимую страницу плейлистов.")?;
        let declared = check_spotify_playlist_page(&value, total, received, rows.len())?;
        total = Some(declared); received += rows.len();
        for row in rows {
            let id = string(row, "id"); if !valid_spotify_id(&id) || !playlist_ids.insert(id.clone()) { return Err("Spotify повторил плейлист или вернул неверный идентификатор. Обновите коллекцию.".into()); }
            result.push(Descriptor { service: "spotify".into(), source_url: format!("https://open.spotify.com/playlist/{id}"), source_id: id,
                title: string(row, "name"), total: row["tracks"]["total"].as_u64().or_else(|| row["items"]["total"].as_u64()).map(|n| n as usize), artwork: image(&row["images"]) });
        }
        next = value["next"].as_str().map(str::to_string);
        if next.is_none() { assert_generation(epoch)?; return Ok(result); }
    }
    Err("В аккаунте больше 20 000 плейлистов. Импортируйте нужные по отдельности.".into())
}
fn check_spotify_playlist_page(value: &Value, previous_total: Option<usize>, received: usize, rows: usize) -> Result<usize,String> {
    let total = value["total"].as_u64().and_then(|value|usize::try_from(value).ok()).ok_or("Spotify не подтвердил размер коллекции плейлистов.")?;
    let next = value.get("next").ok_or("Spotify не подтвердил конец страницы плейлистов.")?;
    if !next.is_null() && next.as_str().is_none_or(|url|url.is_empty()) || total > MAX_TRACKS
        || previous_total.is_some_and(|previous|previous != total) || value.get("offset").is_some_and(|value|value.as_u64() != Some(received as u64))
        || received.saturating_add(rows) > total || next.is_null() && received.saturating_add(rows) != total || !next.is_null() && rows == 0 {
        return Err("Spotify вернул неполный или изменившийся список плейлистов. Обновите коллекцию.".into());
    }
    Ok(total)
}

async fn spotify_collection(id: &str, epoch: u64) -> Result<Collection, String> {
    let liked = id == "liked";
    if !liked && !valid_spotify_id(id) { return Err("Некорректный ID плейлиста Spotify.".into()); }
    let metadata = if liked { json!({"name":"Любимые треки Spotify"}) } else { spotify_get(&format!("https://api.spotify.com/v1/playlists/{id}"), epoch).await? };
    let mut collection = Collection { service: "spotify".into(), source_id: id.into(), source_url: if liked { "pulse:spotify:liked".into() } else { format!("https://open.spotify.com/playlist/{id}") },
        title: string(&metadata, "name"), description: string(&metadata, "description"), artwork: image(&metadata["images"]), total: None, complete: false, warnings: vec![], entries: vec![] };
    let mut next = Some(if liked { "https://api.spotify.com/v1/me/tracks?limit=50".into() } else { format!("https://api.spotify.com/v1/playlists/{id}/items?limit=50") });
    let mut seen = HashSet::new(); let mut position = 0; let mut unavailable = 0; let mut observed_total = None;
    for _ in 0..MAX_PAGES {
        let Some(url) = next.take() else { collection.complete = true; break; };
        if !seen.insert(url.clone()) { collection.warnings.push("Spotify повторил страницу; импорт остановлен без перестановки треков.".into()); break; }
        let value = match spotify_get(&url, epoch).await {
            Ok(value) => value,
            Err(error) if !collection.entries.is_empty() => { assert_generation(epoch)?; collection.warnings.push(error); break; }
            Err(error) => return Err(error),
        };
        let page_total = value["total"].as_u64().map(|n| n as usize);
        if page_total.is_none() { collection.warnings.push("Spotify не подтвердил полный размер списка треков.".into()); }
        if observed_total.is_some() && page_total != observed_total {
            collection.warnings.push("Коллекция изменилась во время чтения. Повторите импорт, чтобы получить согласованный порядок.".into());
        }
        observed_total = page_total.or(observed_total);
        collection.total = page_total.or(collection.total);
        let Some(rows) = value["items"].as_array() else { collection.warnings.push("Spotify не вернул записи очередной страницы.".into()); break; };
        if rows.len() > 50 || value.get("offset").is_some_and(|offset|offset.as_u64() != Some(position as u64)) {
            collection.warnings.push("Spotify вернул неверный размер или порядок страницы треков. Повторите импорт.".into()); break;
        }
        if value.get("next").is_none_or(|next|!next.is_null() && next.as_str().is_none_or(|url|url.is_empty())) {
            collection.warnings.push("Spotify не подтвердил адрес следующей страницы или конец списка.".into()); break;
        }
        for raw in rows {
            if position >= MAX_TRACKS { break; }
            if let Some(entry) = spotify_entry(raw, position) { collection.entries.push(entry); } else { unavailable += 1; }
            position += 1;
        }
        next = value["next"].as_str().map(str::to_string);
        if rows.is_empty() && next.is_some() { collection.warnings.push("Spotify вернул пустую страницу до конца списка. Полученная часть сохранена.".into()); break; }
        if position >= MAX_TRACKS && next.is_some() { collection.warnings.push("За один импорт можно получить до 20 000 записей. Полученная часть сохранена.".into()); break; }
        if next.is_none() { collection.complete = true; break; }
    }
    if next.is_some() && collection.warnings.is_empty() { collection.warnings.push("Сервис достиг ограничения страниц. Получена только часть коллекции.".into()); }
    if collection.total.is_some_and(|total| position != total) { collection.complete = false; collection.warnings.push(format!("Spotify объявил {} записей, просмотрено {position}. Коллекция могла измениться во время импорта.", collection.total.unwrap())); }
    if unavailable > 0 { collection.complete = false; collection.warnings.push(format!("{unavailable} записей скрыты Spotify, являются локальными файлами или подкастами. Они не заменены похожими треками.")); }
    if !liked && metadata["snapshot_id"].as_str().is_some() {
        match spotify_get(&format!("https://api.spotify.com/v1/playlists/{id}?fields=snapshot_id"), epoch).await {
            Ok(current) if current["snapshot_id"] == metadata["snapshot_id"] => {},
            Ok(_) => collection.warnings.push("Плейлист изменился во время чтения. Импортируйте повторно, чтобы обновить порядок.".into()),
            Err(_) => collection.warnings.push("Не удалось подтвердить неизменность плейлиста после чтения. Полученный список сохранён для проверки.".into()),
        }
    }
    if !collection.warnings.is_empty() { collection.complete = false; }
    if collection.entries.is_empty() && collection.total != Some(0) { return Err("Spotify не предоставил метаданные треков. Проверьте права приложения и доступ к плейлисту.".into()); }
    finish_collection(collection, epoch)
}
fn finish_collection(collection: Collection, epoch: u64) -> Result<Collection, String> { assert_generation(epoch)?; Ok(collection) }

#[derive(Debug, PartialEq)]
enum PublicSource { Spotify(String), Yandex(String, String) }
fn public_source(input: &str) -> Result<PublicSource, String> {
    if input.len() > 4096 { return Err("Ссылка слишком длинная.".into()); }
    let url = Url::parse(input.trim()).map_err(|_| "Вставьте полную HTTPS-ссылку на плейлист.")?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() || url.port_or_known_default() != Some(443) {
        return Err("Нужна HTTPS-ссылка без пароля и нестандартного порта.".into());
    }
    let segments: Vec<_> = url.path_segments().into_iter().flatten().filter(|s| !s.is_empty()).collect();
    match url.host_str().unwrap_or("") {
        "open.spotify.com" => {
            let offset = usize::from(segments.first().is_some_and(|segment| segment.starts_with("intl-")));
            if segments.get(offset) == Some(&"playlist") && segments.len() == offset + 2 && valid_spotify_id(segments[offset + 1]) { return Ok(PublicSource::Spotify(segments[offset + 1].into())); }
        }
        "music.yandex.ru" | "music.yandex.com" | "music.yandex.kz" | "music.yandex.by" => {
            if segments.len() == 4 && segments[0] == "users" && segments[2] == "playlists"
                && !segments[1].is_empty() && segments[1].len() <= 200 && segments[1].chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '@'))
                && !segments[3].is_empty() && segments[3].len() <= 32 && segments[3].bytes().all(|b| b.is_ascii_digit()) {
                return Ok(PublicSource::Yandex(segments[1].into(), segments[3].into()));
            }
        }
        _ => {},
    }
    Err("Нужна ссылка вида open.spotify.com/playlist/… или music.yandex.ru/users/…/playlists/…. Для новых коротких ссылок Яндекса откройте плейлист и скопируйте полную ссылку либо импортируйте экспорт.".into())
}
fn embed_data(html: &str) -> Result<Value, String> {
    let start = html.find("<script id=\"__NEXT_DATA__\"").or_else(|| html.find("<script id='__NEXT_DATA__'"))
        .ok_or("Spotify изменил страницу публичного плейлиста. Подключите аккаунт или импортируйте CSV/JSON.")?;
    let body = html[start..].split_once('>').map(|(_, rest)| rest).and_then(|rest| rest.split_once("</script>").map(|(body, _)| body))
        .ok_or("Страница плейлиста Spotify повреждена.")?;
    serde_json::from_str(body).map_err(|_| "Spotify вернул некорректную страницу плейлиста.".into())
}
fn spotify_embed_collection(id: &str, html: &str) -> Result<Collection, String> {
    let value = embed_data(html)?;
    if let Some(status) = value.pointer("/props/pageProps/status").and_then(Value::as_u64) { if status >= 400 { return Err(status_error(status as u16)); } }
    let entity = value.pointer("/props/pageProps/state/data/entity").ok_or("Spotify не открыл треки плейлиста. Подключите аккаунт или импортируйте экспорт CSV/JSON.")?;
    let rows = entity["trackList"].as_array().ok_or("Публичная страница Spotify не содержит список треков.")?;
    let total = entity["tracks"]["total"].as_u64().or_else(|| entity["trackCount"].as_u64()).map(|n| n as usize);
    let entries: Vec<_> = rows.iter().take(MAX_TRACKS).enumerate().filter_map(|(position, row)| {
        let title = string(row, "title"); let artist = string(row, "subtitle"); let uri = string(row, "uri");
        if title.is_empty() || artist.is_empty() || !uri.starts_with("spotify:track:") { return None; }
        Some(Entry { source_id: uri.trim_start_matches("spotify:track:").into(), title, artists: vec![artist], album: String::new(),
            duration: row["duration"].as_f64().unwrap_or(0.) / 1000., position, isrc: None, explicit: row["isExplicit"].as_bool(), artwork: None, added_at: None })
    }).collect();
    let complete = total == Some(entries.len()) && entries.len() == rows.len();
    Ok(Collection { service: "spotify".into(), source_id: id.into(), source_url: format!("https://open.spotify.com/playlist/{id}"),
        title: string(entity, "name"), description: string(entity, "description"), artwork: None, total, complete,
        warnings: if complete { vec![] } else { vec!["Публичная страница Spotify может показывать только часть списка. Полную личную коллекцию импортируйте через вход Spotify или экспорт CSV/JSON.".into()] }, entries })
}
fn yandex_entry(raw: &Value, position: usize) -> Option<Entry> {
    let value = raw.get("track").unwrap_or(raw); let title = string(value, "title");
    let id = value["id"].as_str().map(str::to_string).or_else(|| value["id"].as_u64().map(|id| id.to_string()))?;
    let artists: Vec<_> = value["artists"].as_array()?.iter().map(|row| string(row, "name")).filter(|name| !name.is_empty()).take(30).collect();
    if title.is_empty() || artists.is_empty() { return None; }
    let version = string(value, "version"); let title = if version.is_empty() { title } else { format!("{title} ({version})") };
    let album = value["albums"].as_array().and_then(|rows| rows.first()).map(|row| string(row, "title")).unwrap_or_default();
    let artwork = yandex_artwork(value["coverUri"].as_str().or_else(|| value["albums"].as_array()?.first()?["coverUri"].as_str()));
    Some(Entry { source_id: id, title, artists, album, duration: value["durationMs"].as_f64().unwrap_or(0.) / 1000., position,
        isrc: value["isrc"].as_str().map(str::to_string), explicit: value["explicit"].as_bool().or_else(|| (value["contentWarning"].as_str() == Some("explicit")).then_some(true)),
        artwork, added_at: None })
}
fn yandex_artwork(value: Option<&str>) -> Option<String> {
    let input = value?.replace("%%", "200x200");
    let url = if input.starts_with("https://") { input } else { format!("https://{input}") };
    let parsed = Url::parse(&url).ok()?;
    if parsed.scheme() == "https" && parsed.host_str().is_some_and(|host| matches!(host, "avatars.yandex.net" | "avatars.mds.yandex.net"))
        && parsed.username().is_empty() && parsed.password().is_none() { Some(url) } else { None }
}
fn yandex_collection(owner: &str, kind: &str, value: &Value) -> Result<Collection, String> {
    let value = value.get("result").unwrap_or(value);
    if value.get("error").is_some() || value.get("title").is_none() { return Err("Яндекс не открыл плейлист. Убедитесь, что он публичный, или импортируйте экспорт CSV/JSON.".into()); }
    let total = value["trackCount"].as_u64().map(|n| n as usize);
    let rows = value["tracks"].as_array().ok_or("Яндекс не предоставил записи плейлиста.")?;
    let entries: Vec<_> = rows.iter().take(MAX_TRACKS).enumerate().filter_map(|(position, row)| yandex_entry(row, position)).collect();
    let complete = total == Some(entries.len()) && entries.len() == rows.len();
    let mut warnings = Vec::new();
    if !complete { warnings.push(format!("Яндекс предоставил метаданные {} записей из {}. Скрытые записи и недостающая часть не заменены похожими треками.", entries.len(), total.map(|n| n.to_string()).unwrap_or_else(|| "неизвестного количества".into()))); }
    Ok(Collection { service: "yandex".into(), source_id: format!("{owner}:{kind}"), source_url: format!("https://music.yandex.ru/users/{owner}/playlists/{kind}"),
        title: string(value, "title"), description: string(value, "description"), artwork: yandex_artwork(value["cover"]["uri"].as_str().or_else(|| value["ogImage"].as_str())), total, complete, warnings, entries })
}

async fn yandex_public_collection(owner: &str, kind: &str, epoch: u64) -> Result<Collection, String> {
    let mut collection: Option<Collection> = None; let mut position = 0; let mut previous_page = None;
    let mut revision: Option<Value> = None;
    for page in 0..MAX_PAGES {
        assert_generation(epoch)?;
        let url = format!("https://api.music.yandex.net/users/{owner}/playlists/{kind}?page={page}&page-size=100");
        let response = http()?.get(url).send().await.map_err(|_| "Яндекс Музыка не ответила. Проверьте подключение.");
        let value = match response {
            Ok(response) => response_json(response).await,
            Err(error) => Err(error.to_string()),
        };
        let value = match value {
            Ok(value) => value,
            Err(error) if collection.is_some() => { let current = collection.as_mut().unwrap(); current.complete = false; current.warnings.push(error); break; }
            Err(error) => return Err(error),
        };
        let value = value.get("result").unwrap_or(&value);
        let rows = value["tracks"].as_array().ok_or("Яндекс не предоставил список треков.")?;
        if collection.is_none() {
            let mut current = yandex_collection(owner, kind, value)?;
            current.entries.clear(); current.warnings.clear(); current.complete = false; collection = Some(current);
            revision = value.get("revision").cloned();
        }
        let current = collection.as_mut().unwrap();
        if revision.is_some() && value.get("revision") != revision.as_ref() { current.warnings.push("Плейлист Яндекса изменился во время чтения. Импортируйте его повторно, чтобы обновить порядок.".into()); break; }
        let current_total = value["trackCount"].as_u64().or_else(|| value["pager"]["total"].as_u64()).map(|n| n as usize);
        if current.total.is_some() && current_total != current.total { current.warnings.push("Количество треков Яндекса изменилось во время чтения.".into()); break; }
        current.total = current_total.or(current.total);
        let signature: Vec<_> = rows.iter().map(|row| row["id"].to_string()).collect();
        if page > 0 && previous_page.as_ref() == Some(&signature) && value["pager"]["page"].as_u64() != Some(page as u64) { current.warnings.push("Яндекс повторил страницу без подтверждённого номера. Полученная часть сохранена.".into()); break; }
        previous_page = Some(signature);
        if let Some(actual_page) = value["pager"]["page"].as_u64() {
            if actual_page as usize != page { current.warnings.push("Яндекс вернул другую страницу списка. Импорт остановлен без перестановки треков.".into()); break; }
        }
        for raw in rows {
            if position >= MAX_TRACKS { break; }
            if let Some(entry) = yandex_entry(raw, position) { current.entries.push(entry); }
            position += 1;
        }
        if current.total == Some(position) {
            current.complete = current.entries.len() == position;
            if !current.complete { current.warnings.push("Часть записей скрыта Яндексом или не содержит имени исполнителя. Исходные позиции остальных треков сохранены.".into()); }
            break;
        }
        if rows.is_empty() || rows.len() < 100 {
            current.warnings.push("Яндекс закончил список до заявленного количества треков. Полученная часть сохранена.".into()); break;
        }
        if position >= MAX_TRACKS { current.warnings.push("За один импорт можно получить до 20 000 записей. Полученная часть сохранена.".into()); break; }
    }
    let mut collection = collection.ok_or("Яндекс не предоставил коллекцию.")?;
    if !collection.complete && collection.warnings.is_empty() { collection.warnings.push("Получена только часть плейлиста Яндекса.".into()); }
    if collection.entries.is_empty() && collection.total != Some(0) { return Err("Яндекс не предоставил метаданные треков. Проверьте доступ к плейлисту.".into()); }
    assert_generation(epoch)?;
    Ok(collection)
}

#[tauri::command]
pub async fn read_service_playlist(app: AppHandle, url: String) -> Result<Collection, String> {
    let epoch = GENERATION.load(Ordering::SeqCst);
    if url == "pulse:spotify:liked" { return spotify_collection("liked", epoch).await; }
    if url.starts_with("pulse:yandex:") {
        return serde_json::from_value(crate::yandex_account_import::read(app, url).await?)
            .map_err(|_| "Яндекс вернул некорректные метаданные коллекции.".into());
    }
    match public_source(&url)? {
        PublicSource::Spotify(id) => {
            if load_tokens()?.is_some() { return spotify_collection(&id, epoch).await; }
            let response = http()?.get(format!("https://open.spotify.com/embed/playlist/{id}"))
                .send().await.map_err(|_| "Spotify не ответил. Подключите аккаунт или используйте экспорт CSV/JSON.")?;
            if !response.status().is_success() { return Err(status_error(response.status().as_u16())); }
            let html = String::from_utf8(bounded(response).await?).map_err(|_| "Не удалось прочитать страницу Spotify.")?;
            assert_generation(epoch)?;
            spotify_embed_collection(&id, &html)
        }
        PublicSource::Yandex(owner, kind) => {
            // Fixed HTTPS API origin; no caller-supplied URL or redirect receives credentials.
            yandex_public_collection(&owner, &kind, epoch).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_urls_cannot_escape_or_inject_paths() {
        assert_eq!(public_source("https://open.spotify.com/intl-ru/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc").unwrap(), PublicSource::Spotify("37i9dQZF1DXcBWIGoYBM5M".into()));
        assert_eq!(public_source("https://music.yandex.ru/users/test.user/playlists/123").unwrap(), PublicSource::Yandex("test.user".into(), "123".into()));
        for url in ["https://open.spotify.com.evil.test/playlist/37i9dQZF1DXcBWIGoYBM5M", "http://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M", "https://secret@open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M", "https://music.yandex.ru/users/a%2Fb/playlists/1", "https://music.yandex.ru/users/a/playlists/1/extra", "https://127.0.0.1/playlist/x"] { assert!(public_source(url).is_err(), "{url}"); }
        for url in ["https://evil.test/v1/me/tracks", "https://api.spotify.com@evil.test/v1/me/tracks", "https://api.spotify.com:444/v1/me/tracks", "https://api.spotify.com/api/token", "https://api.spotify.com/v1/me#token"] { assert!(spotify_api_url(url).is_err(), "{url}"); }
    }
    #[test]
    fn current_playlist_endpoint_falls_back_only_for_a_missing_legacy_route() {
        let current = Url::parse("https://api.spotify.com/v1/playlists/37i9dQZF1DXcBWIGoYBM5M/items?limit=50&offset=100").unwrap();
        for status in [404,410] {
            assert_eq!(legacy_playlist_items_url(&current,status).unwrap().as_str(),"https://api.spotify.com/v1/playlists/37i9dQZF1DXcBWIGoYBM5M/tracks?limit=50&offset=100");
        }
        for status in [200,301,400,401,403,408,429,500,503] { assert!(legacy_playlist_items_url(&current,status).is_none()); }
        for other in ["https://api.spotify.com/v1/me/tracks","https://api.spotify.com/v1/playlists/37i9dQZF1DXcBWIGoYBM5M/tracks","https://api.spotify.com/v1/playlists/invalid/items","https://api.spotify.com/v1/playlists/37i9dQZF1DXcBWIGoYBM5M/items/extra","https://evil.test/v1/playlists/37i9dQZF1DXcBWIGoYBM5M/items"] {
            assert!(legacy_playlist_items_url(&Url::parse(other).unwrap(),404).is_none(),"{other}");
        }
    }
    #[test]
    fn current_and_legacy_track_wrappers_keep_null_slots_unmatched() {
        let track = json!({"id":"id","name":"Song","artists":[{"name":"Artist"}],"duration_ms":183000});
        assert_eq!(spotify_entry(&json!({"item":track}),7).unwrap().position,7);
        assert_eq!(spotify_entry(&json!({"track":track}),8).unwrap().position,8);
        assert!(spotify_entry(&json!({"item":null,"track":track}),9).is_none());
        assert!(spotify_entry(&json!({"item":{"type":"episode","id":"podcast","name":"Episode","artists":[{"name":"Person"}]}}),10).is_none());
    }
    #[test]
    fn oauth_requires_exact_path_host_state_and_single_code() {
        let request = "GET /pulse-spotify?code=abc&state=xyz HTTP/1.1\r\nHost: 127.0.0.1:43823\r\n\r\n";
        assert_eq!(callback_code(request, "xyz").unwrap(), Some("abc".into()));
        for invalid in [request.replace("xyz", "other"), request.replace("/pulse-spotify?", "/other?"), request.replace("127.0.0.1:43823", "evil.test"), request.replace("code=abc", "code=abc&code=other"), request.replace("state=xyz", "state=xyz&state=xyz"), request.replace("GET /", "POST /")] { assert!(callback_code(&invalid, "xyz").unwrap().is_none()); }
        assert!(callback_code(&request.replace("code=abc", "error=access_denied"), "xyz").is_err());
    }
    #[test]
    fn pkce_verifier_has_entropy_and_uses_standard_s256() {
        let first = random_text(); let second = random_text();
        assert_eq!(first.len(), 43); assert_ne!(first, second);
        assert!(first.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')));
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(b"dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"));
        assert_eq!(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }
    #[test]
    fn track_wrappers_preserve_order_duplicates_versions_and_missing_data() {
        let rows = json!([
            {"track":{"id":"a","name":"Song","artists":[{"name":"Artist"}],"duration_ms":183000,"album":{"name":"LP"},"external_ids":{"isrc":"USABC2612345"},"explicit":true}},
            {"track":null},
            {"item":{"id":"a","name":"Song","artists":[{"name":"Artist"}],"duration_ms":183000}},
            {"track":{"id":"local","is_local":true,"name":"Local","artists":[{"name":"Artist"}]}}
        ]);
        let entries: Vec<_> = rows.as_array().unwrap().iter().enumerate().filter_map(|(i, row)| spotify_entry(row, i)).collect();
        assert_eq!(entries.len(), 2); assert_eq!(entries[0].source_id, entries[1].source_id);
        assert_eq!(entries[0].position, 0); assert_eq!(entries[1].position, 2); assert_eq!(entries[0].duration, 183.); assert_eq!(entries[0].explicit, Some(true));
        let yandex = yandex_entry(&json!({"track":{"id":123,"title":"Song","version":"Live","durationMs":123400,"artists":[{"name":"Artist"}],"albums":[{"title":"EP"}],"contentWarning":"explicit"}}), 4).unwrap();
        assert_eq!(yandex.title, "Song (Live)"); assert_eq!(yandex.position, 4); assert_eq!(yandex.duration, 123.4); assert_eq!(yandex.album, "EP");
    }
    #[test]
    fn public_partial_collections_never_claim_full_import() {
        let html = r#"<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"state":{"data":{"entity":{"name":"Test","trackCount":4,"trackList":[{"uri":"spotify:track:abc","title":"Song","subtitle":"Artist","duration":100000}]}}}}}}</script>"#;
        let source = spotify_embed_collection("37i9dQZF1DXcBWIGoYBM5M", html).unwrap();
        assert_eq!(source.total, Some(4)); assert!(!source.complete); assert!(!source.warnings.is_empty()); assert_eq!(source.entries[0].duration, 100.);
        let blocked = r#"<script id="__NEXT_DATA__">{"props":{"pageProps":{"status":451}}}</script>"#;
        assert!(spotify_embed_collection("id", blocked).is_err());
        let yandex = yandex_collection("user", "1", &json!({"result":{"title":"Test","trackCount":4,"tracks":[{"track":{"id":1,"title":"Song","artists":[{"name":"Artist"}]}}]}})).unwrap();
        assert_eq!(yandex.entries.len(), 1); assert!(!yandex.complete);
    }
    #[test]
    fn token_refresh_keeps_existing_refresh_without_exposing_it() {
        let value = json!({"access_token":"access","expires_in":3600});
        let tokens = parse_tokens(&value, "client".into(), Some("refresh")).unwrap(); assert_eq!(tokens.refresh_token, "refresh");
        assert!(parse_tokens(&value, "client".into(), None).is_err());
    }
    #[test]
    fn independent_callback_rejects_encoded_duplicate_parameters_and_non_loopback_hosts() {
        let request = |target: &str, headers: &str|format!("GET {target} HTTP/1.1\r\n{headers}\r\n\r\n");
        for target in ["/pulse-spotify?state=expected&st%61te=expected&code=abc", "/pulse-spotify?state=expected&code=abc&co%64e=abc", "//evil.test/pulse-spotify?state=expected&code=abc", "/pulse-spotify?state=expected&code=", "/pulse-spotify?state=wrong&error=denied"] {
            assert!(callback_code(&request(target,"Host: 127.0.0.1:43823"),"expected").unwrap().is_none(),"{target}");
        }
        for host in ["localhost:43823","[::1]:43823","127.0.0.1","127.0.0.1:43824","127.0.0.1:43823.evil.test"] {
            assert!(callback_code(&request("/pulse-spotify?state=expected&code=abc",&format!("Host: {host}")),"expected").unwrap().is_none());
        }
        for invalid in [
            request("/pulse-spotify?state=expected&code=abc#unexpected","Host: 127.0.0.1:43823"),
            request("/pulse-spotify?state=expected&code=abc","Host: 127.0.0.1:43823\r\nHost: evil.test"),
            request("/pulse-spotify?state=expected&code=abc","Host: 127.0.0.1:43823\r\nHost: 127.0.0.1:43823"),
            request("/pulse-spotify?state=expected&code=abc%0d%0a","Host: 127.0.0.1:43823"),
            "GET /pulse-spotify?state=expected&code=abc HTTP/1.1\r\nHost: 127.0.0.1:43823\r\n".into(),
            request("/pulse-spotify?state=expected&code=abc","Host: 127.0.0.1:43823").replace("HTTP/1.1","HTTP/1.1 extra"),
        ] { assert!(callback_code(&invalid,"expected").unwrap().is_none(),"{invalid}"); }
    }
    #[test]
    fn independent_cancelled_read_cannot_return_partial_success_or_revive_a_session() {
        let collection = yandex_collection("owner","3",&json!({"title":"Empty","trackCount":0,"tracks":[]})).unwrap();
        let stale = GENERATION.load(Ordering::SeqCst).wrapping_add(1);
        assert!(finish_collection(collection,stale).is_err());
    }
    #[test]
    fn independent_playlist_paging_cannot_silently_claim_an_incomplete_personal_list() {
        assert_eq!(check_spotify_playlist_page(&json!({"total":51,"offset":0,"next":"https://api.spotify.com/v1/me/playlists?offset=50"}),None,0,50).unwrap(),51);
        assert_eq!(check_spotify_playlist_page(&json!({"total":51,"offset":50,"next":null}),Some(51),50,1).unwrap(),51);
        for invalid in [json!({"total":51,"offset":50,"next":null}),json!({"total":50,"offset":50,"next":null}),json!({"total":51,"offset":0,"next":null}),json!({"total":51,"offset":50,"next":{}}),json!({"total":51,"offset":50})] {
            assert!(check_spotify_playlist_page(&invalid,Some(51),50,0).is_err(),"{invalid}");
        }
    }
    #[test]
    fn independent_provider_metadata_receipts_reject_missing_or_excess_tracks_as_complete() {
        for (declared, rows) in [(2,1),(1,2),(0,1)] {
            let tracks = (0..rows).map(|id|json!({"id":id+1,"title":"Song","artists":[{"name":"Artist"}]})).collect::<Vec<_>>();
            let collection = yandex_collection("owner","3",&json!({"title":"Playlist","trackCount":declared,"tracks":tracks})).unwrap();
            assert!(!collection.complete); assert!(!collection.warnings.is_empty());
        }
        let empty = yandex_collection("owner","3",&json!({"title":"Empty","trackCount":0,"tracks":[]})).unwrap(); assert!(empty.complete);
    }
    #[test]
    #[ignore = "Requires public Yandex Music network access; no account or playback required"]
    fn public_yandex_real_collection_matches_declared_count() {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
            let result = yandex_public_collection("yamusic-top", "1028", GENERATION.load(Ordering::SeqCst)).await.unwrap();
            assert!(result.complete, "{:?}", result.warnings);
            assert_eq!(Some(result.entries.len()), result.total);
            assert!(!result.entries.is_empty());
            assert!(result.entries.iter().enumerate().all(|(index, entry)| entry.position == index && !entry.title.is_empty() && !entry.artists.is_empty()));
        });
    }
}
