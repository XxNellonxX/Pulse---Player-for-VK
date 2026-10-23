//! Account-scoped source links and a bounded, private in-process media relay.
//! No signed provider URLs, secrets or audio files are persisted.
use crate::{
    soundcloud_catalog::{
        validate_range, Candidate, CatalogError, CatalogPage, PlaybackCacheScope, SoundCloudCatalog,
    },
    vk_web, AppState,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tauri::{
    http::{Request, Response},
    AppHandle, Manager, State,
};
use url::Url;
#[cfg(test)]
use crate::soundcloud_catalog::validate_media_url;

const MAX_BINDING_BYTES: usize = 16 * 1024 * 1024;
const MAX_BINDINGS: usize = 10_000;
const MAX_SESSION_URLS: usize = 2048;
const SESSION_TTL_MS: i64 = 60 * 60 * 1000;
const MAX_CREDENTIAL_FILE_BYTES: usize = 16 * 1024;

pub struct SourceState {
    catalog: Mutex<Option<Arc<SoundCloudCatalog>>>,
    sessions: Mutex<HashMap<String, Session>>,
    bindings_lock: Mutex<()>,
    configuration_lock: Mutex<()>,
    credential_dialog_lock: tokio::sync::Mutex<()>,
    generation: AtomicU64,
    media_slots: tokio::sync::Semaphore,
}
impl Default for SourceState {
    fn default() -> Self {
        Self {
            catalog: Mutex::new(None),
            sessions: Mutex::new(HashMap::new()),
            bindings_lock: Mutex::new(()),
            configuration_lock: Mutex::new(()),
            credential_dialog_lock: tokio::sync::Mutex::new(()),
            generation: AtomicU64::new(0),
            media_slots: tokio::sync::Semaphore::new(4),
        }
    }
}
struct Session {
    catalog: Arc<SoundCloudCatalog>,
    cache_scope: PlaybackCacheScope,
    guard: vk_web::UploadGuard,
    urls: Vec<String>,
    created_at: i64,
    generation: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Configuration {
    client_id: String,
    client_secret: String,
    proxy: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportedCredentials {
    client_id: String,
    client_secret: String,
    #[serde(default)]
    proxy: Option<String>,
}
#[derive(Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceSelection {
    #[default]
    User,
    Metadata,
}
#[derive(Serialize)]
pub struct SelectedCandidate {
    #[serde(flatten)]
    candidate: Candidate,
    selection: SourceSelection,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Binding {
    account_id: i64,
    track_id: String,
    candidate: Candidate,
    #[serde(default)]
    selection: SourceSelection,
}
#[derive(Serialize)]
pub struct Status {
    configured: bool,
    proxy: bool,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    managed: Option<bool>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    path: String,
    title: String,
    explicit: Option<bool>,
    source_id: String,
}

fn credential_entry(app: &AppHandle) -> Result<keyring::Entry, String> {
    let key = crate::data_dir(app).to_string_lossy().into_owned();
    keyring::Entry::new("ru.vkplayer.desktop.soundcloud", &key)
        .map_err(|_| "Хранилище учётных данных SoundCloud недоступно.".into())
}

fn stored_configuration(entry: &keyring::Entry) -> Result<Option<Configuration>, String> {
    match entry.get_password() {
        Ok(value) => serde_json::from_str(&value).map(Some).map_err(|_| {
            "Не удалось прочитать настройки SoundCloud. Сохранённые данные не изменены.".into()
        }),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Система не разрешила прочитать сохранённый доступ SoundCloud.".into()),
    }
}

fn environment_configuration() -> Configuration {
    Configuration {
        client_id: std::env::var("PULSE_SOUNDCLOUD_CLIENT_ID").unwrap_or_default(),
        client_secret: std::env::var("PULSE_SOUNDCLOUD_CLIENT_SECRET").unwrap_or_default(),
        proxy: std::env::var("PULSE_SOUNDCLOUD_PROXY")
            .ok()
            .filter(|value| !value.trim().is_empty()),
    }
}

/// A saved direct route is intentional and must not inherit an environment
/// proxy. Blank credential fields retain the same source as the active client.
fn merge_configuration(
    client_id: &str,
    client_secret: &str,
    proxy: Option<&str>,
    previous: Option<&Configuration>,
    environment: &Configuration,
) -> Result<Configuration, String> {
    let id = client_id.trim();
    let secret = client_secret.trim();
    let inherited = previous.unwrap_or(environment);
    let (client_id, client_secret) = if id.is_empty() && secret.is_empty() {
        if inherited.client_id.is_empty() || inherited.client_secret.is_empty() {
            return Err("Укажите Client ID и Client Secret приложения SoundCloud.".into());
        }
        (inherited.client_id.clone(), inherited.client_secret.clone())
    } else if id.is_empty() || secret.is_empty() {
        return Err("Укажите оба поля доступа SoundCloud.".into());
    } else {
        (id.to_owned(), secret.to_owned())
    };
    let proxy = match proxy {
        Some(value) => (!value.trim().is_empty()).then(|| value.trim().to_owned()),
        None => inherited.proxy.clone(),
    };
    Ok(Configuration {
        client_id,
        client_secret,
        proxy,
    })
}

fn catalog(app: &AppHandle) -> Result<Arc<SoundCloudCatalog>, String> {
    let shared = app.state::<SourceState>();
    let mut cache = shared.catalog.lock().unwrap();
    if let Some(client) = cache.as_ref() {
        return Ok(client.clone());
    }
    if let Some(gateway) = crate::gateway_client::Gateway::configured()? {
        let client = Arc::new(SoundCloudCatalog::from_gateway(gateway));
        *cache = Some(client.clone());
        return Ok(client);
    }
    let stored = stored_configuration(&credential_entry(app)?)?;
    let client = match stored {
        Some(config) => {
            SoundCloudCatalog::from_config(config.client_id, config.client_secret, config.proxy)
                .map_err(|e| e.to_string())?
        }
        None => SoundCloudCatalog::from_env()
            .map_err(|e| e.to_string())?
            .ok_or("SoundCloud ещё не подключён. Откройте настройки источников.")?,
    };
    let client = Arc::new(client);
    *cache = Some(client.clone());
    Ok(client)
}
fn bindings(app: &AppHandle) -> Result<Vec<Binding>, String> {
    read_bindings(&crate::data_dir(app).join("source-links.json"))
}
fn manual_binding_conflict(
    all: &[Binding],
    account: i64,
    track_id: &str,
    incoming: SourceSelection,
) -> bool {
    matches!(incoming, SourceSelection::Metadata)
        && all.iter().any(|binding| {
            binding.account_id == account
                && binding.track_id == track_id
                && matches!(binding.selection, SourceSelection::User)
        })
}

fn public_metadata_url(value: Option<String>, artwork: bool) -> Option<String> {
    let value = value?;
    if value.len() > 16384 || value.chars().any(char::is_control) {
        return None;
    }
    let mut url = Url::parse(&value).ok()?;
    let host = url.host_str()?;
    if url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || if artwork {
            !host.ends_with(".sndcdn.com")
        } else {
            !matches!(
                host,
                "soundcloud.com" | "www.soundcloud.com" | "on.soundcloud.com"
            )
        }
    {
        return None;
    }
    // Signed/CDN authorization parameters and private-link tokens are transient.
    url.set_query(None);
    url.set_fragment(None);
    Some(url.to_string())
}

fn sanitized_binding(mut binding: Binding) -> Result<Binding, String> {
    let candidate = &mut binding.candidate;
    if binding.account_id <= 0
        || binding.track_id.is_empty()
        || binding.track_id.len() > 512
        || binding.track_id.chars().any(char::is_control)
        || candidate.provider != "soundcloud"
        || candidate.id.is_empty()
        || candidate.id.len() > 20
        || candidate.id.starts_with('0')
        || !candidate.id.bytes().all(|byte| byte.is_ascii_digit())
        || candidate.urn != format!("soundcloud:tracks:{}", candidate.id)
        || !candidate.duration.is_finite()
        || !(0. ..=86400.).contains(&candidate.duration)
    {
        return Err("Связи источников повреждены. Файл сохранён для восстановления.".into());
    }
    candidate.title = candidate
        .title
        .chars()
        .filter(|character| !character.is_control())
        .take(300)
        .collect::<String>()
        .trim()
        .into();
    candidate.artist = candidate
        .artist
        .chars()
        .filter(|character| !character.is_control())
        .take(200)
        .collect::<String>()
        .trim()
        .into();
    if candidate.title.is_empty() || candidate.artist.is_empty() {
        return Err("Связи источников повреждены. Файл сохранён для восстановления.".into());
    }
    candidate.permalink_url = public_metadata_url(candidate.permalink_url.take(), false);
    candidate.artwork_url = public_metadata_url(candidate.artwork_url.take(), true);
    candidate.isrc = candidate
        .isrc
        .take()
        .filter(|isrc| isrc.len() == 12 && isrc.bytes().all(|byte| byte.is_ascii_alphanumeric()));
    if !matches!(
        candidate.access.as_str(),
        "playable" | "preview" | "blocked"
    ) {
        candidate.access = "blocked".into();
    }
    candidate.streamable &= candidate.access == "playable";
    Ok(binding)
}

fn read_bindings(path: &Path) -> Result<Vec<Binding>, String> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(_) => return Err("Не удалось прочитать связи источников.".into()),
    };
    let mut bytes = Vec::new();
    file.take(MAX_BINDING_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Не удалось прочитать связи источников.")?;
    if bytes.len() > MAX_BINDING_BYTES {
        return Err("Файл связей источников слишком большой.".into());
    }
    let values: Vec<Binding> = serde_json::from_slice(&bytes)
        .map_err(|_| "Связи источников повреждены. Файл сохранён для восстановления.")?;
    if values.len() > MAX_BINDINGS {
        return Err("Слишком много связей источников. Файл сохранён для восстановления.".into());
    }
    values.into_iter().map(sanitized_binding).collect()
}
fn checked_track(app: &AppHandle, id: &str) -> Result<vk_web::UploadGuard, String> {
    let guard = vk_web::upload_guard(app)?;
    if !app
        .state::<AppState>()
        .state
        .lock()
        .unwrap()
        .tracks
        .iter()
        .any(|t| t.id == id && t.source == "vk" && t.available)
    {
        return Err("Трек недоступен или удалён из библиотеки.".into());
    }
    Ok(guard)
}

#[tauri::command]
pub async fn soundcloud_status(app: AppHandle) -> Status {
    match catalog(&app) {
        Ok(client) => Status {
            configured: true,
            proxy: client.uses_proxy(),
            message: if client.is_managed() { "Подключение через Pulse настроено. Доступ проверяется при поиске и воспроизведении." } else { "SoundCloud настроен. Доступ к API проверяется при поиске." }.into(),
            managed: client.is_managed().then_some(true),
        },
        Err(message) => Status {
            configured: false,
            proxy: false,
            message,
            managed: None,
        },
    }
}
#[tauri::command]
pub async fn configure_soundcloud(
    app: AppHandle,
    client_id: String,
    client_secret: String,
    proxy: Option<String>,
) -> Result<(), String> {
    apply_configuration(&app, &client_id, &client_secret, proxy.as_deref()).map(|_| ())
}

fn apply_configuration(
    app: &AppHandle,
    client_id: &str,
    client_secret: &str,
    proxy: Option<&str>,
) -> Result<Arc<SoundCloudCatalog>, String> {
    if crate::gateway_client::Gateway::configured()?.is_some() {
        return Err("В этой сборке подключение SoundCloud обслуживает Pulse. Личные ключи не нужны.".into());
    }
    let shared = app.state::<SourceState>();
    let _lock = shared.configuration_lock.lock().unwrap();
    let entry = credential_entry(app)?;
    let previous = stored_configuration(&entry)?;
    let config = merge_configuration(
        client_id,
        client_secret,
        proxy,
        previous.as_ref(),
        &environment_configuration(),
    )?;
    let client = SoundCloudCatalog::from_config(
        config.client_id.clone(),
        config.client_secret.clone(),
        config.proxy.clone(),
    )
    .map_err(|e| e.to_string())?;
    entry
        .set_password(
            &serde_json::to_string(&config).map_err(|_| "Не удалось сохранить настройки.")?,
        )
        .map_err(|_| "Система не разрешила сохранить доступ SoundCloud. Настройки не изменены.")?;
    let revision = shared.generation.fetch_add(1, Ordering::SeqCst).wrapping_add(1);
    shared.sessions.lock().unwrap().clear();
    let client = Arc::new(client);
    let mut catalog = shared.catalog.lock().unwrap();
    if let Some(previous) = catalog.as_ref() { previous.clear_playback_cache(revision); }
    *catalog = Some(client.clone());
    Ok(client)
}

fn parse_credential_file(bytes: &[u8]) -> Result<ImportedCredentials, String> {
    if bytes.len() > MAX_CREDENTIAL_FILE_BYTES {
        return Err(
            "Файл доступа SoundCloud превышает допустимые 16 КиБ. Настройки не изменены.".into(),
        );
    }
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    let mut parsed: ImportedCredentials = serde_json::from_slice(bytes).map_err(|_| "Нужен JSON с полями clientId и clientSecret и, при необходимости, proxy. Настройки не изменены.")?;
    parsed.client_id = parsed.client_id.trim().into();
    parsed.client_secret = parsed.client_secret.trim().into();
    SoundCloudCatalog::from_config(parsed.client_id.clone(), parsed.client_secret.clone(), parsed.proxy.as_deref().filter(|value| !value.trim().is_empty()).map(|value| value.trim().to_owned()))
        .map_err(|_| "В файле должны быть настоящие Client ID и Client Secret SoundCloud. Замените поля шаблона; настройки не изменены.".to_string())?;
    Ok(parsed)
}

fn read_credential_file(path: &Path) -> Result<ImportedCredentials, String> {
    if !path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
    {
        return Err("Выберите файл JSON с доступом SoundCloud. Настройки не изменены.".into());
    }
    let file = std::fs::File::open(path).map_err(|_| {
        "Не удалось прочитать выбранный файл доступа SoundCloud. Настройки не изменены."
    })?;
    let metadata = file.metadata().map_err(|_| {
        "Не удалось прочитать выбранный файл доступа SoundCloud. Настройки не изменены."
    })?;
    if !metadata.is_file() || metadata.len() > MAX_CREDENTIAL_FILE_BYTES as u64 {
        return Err(
            "Нужен обычный JSON-файл размером не больше 16 КиБ. Настройки не изменены.".into(),
        );
    }
    let mut bytes = Vec::new();
    file.take(MAX_CREDENTIAL_FILE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| {
            "Не удалось прочитать выбранный файл доступа SoundCloud. Настройки не изменены."
        })?;
    parse_credential_file(&bytes)
}

#[cfg(debug_assertions)]
fn qa_credential_file_selection(
    identifier: &str,
    profile: Option<&Path>,
    file: Option<std::ffi::OsString>,
) -> Option<Option<PathBuf>> {
    if identifier != "ru.vkplayer.independentqa"
        || !profile.is_some_and(|path| path.is_absolute() && path.is_dir())
    {
        return None;
    }
    file.map(|path| (!path.is_empty()).then(|| PathBuf::from(path)))
}

async fn select_credential_file(app: &AppHandle) -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    {
        let profile = std::env::var_os("VK_PLAYER_QA_PROFILE").map(PathBuf::from);
        if let Some(selection) = qa_credential_file_selection(
            &app.config().identifier,
            profile.as_deref(),
            std::env::var_os("VK_PLAYER_QA_SOUNDCLOUD_FILE"),
        ) {
            return selection;
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = app;
    rfd::AsyncFileDialog::new()
        .set_title("Импорт доступа SoundCloud")
        .add_filter("SoundCloud JSON", &["json"])
        .pick_file()
        .await
        .map(|file| file.path().to_path_buf())
}

#[tauri::command]
pub async fn import_soundcloud_credentials(app: AppHandle) -> Result<Option<Status>, String> {
    let shared = app.state::<SourceState>();
    let _dialog = shared
        .credential_dialog_lock
        .try_lock()
        .map_err(|_| "Окно выбора доступа SoundCloud уже открыто.")?;
    let Some(path) = select_credential_file(&app).await else {
        return Ok(None);
    };
    let imported = tauri::async_runtime::spawn_blocking(move || read_credential_file(&path))
        .await
        .map_err(|_| "Не удалось прочитать файл доступа SoundCloud. Настройки не изменены.")??;
    let client = apply_configuration(
        &app,
        &imported.client_id,
        &imported.client_secret,
        imported.proxy.as_deref(),
    )?;
    Ok(Some(Status { configured: true, proxy: client.uses_proxy(), managed: None, message: "Ключи SoundCloud импортированы и сохранены в защищённом хранилище системы. Нажмите «Проверить доступ», чтобы проверить API.".into() }))
}

#[tauri::command]
pub async fn check_soundcloud_connection(app: AppHandle) -> Result<Status, String> {
    let shared = app.state::<SourceState>();
    let generation = shared.generation.load(Ordering::SeqCst);
    let client = catalog(&app)?;
    client
        .check_connection()
        .await
        .map_err(|error| error.to_string())?;
    if generation != shared.generation.load(Ordering::SeqCst) {
        return Err(
            "Настройки SoundCloud изменились во время проверки. Повторите проверку подключения."
                .into(),
        );
    }
    Ok(Status { configured: true, proxy: client.uses_proxy(), managed: client.is_managed().then_some(true), message: "Авторизация и публичный поиск SoundCloud проверены. Воспроизведение этой проверкой не подтверждено.".into() })
}
#[tauri::command]
pub async fn search_soundcloud(app: AppHandle, query: String) -> Result<CatalogPage, String> {
    catalog(&app)?
        .search(&query, None, 30)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn resolve_soundcloud_candidate(
    app: AppHandle,
    url: String,
) -> Result<Candidate, String> {
    catalog(&app)?
        .resolve(&url)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn soundcloud_binding(
    app: AppHandle,
    track_id: String,
) -> Result<Option<SelectedCandidate>, String> {
    let guard = checked_track(&app, &track_id)?;
    let shared = app.state::<SourceState>();
    let _lock = shared.bindings_lock.lock().unwrap();
    Ok(bindings(&app)?
        .into_iter()
        .find(|b| b.account_id == guard.account_id && b.track_id == track_id)
        .map(|b| SelectedCandidate {
            candidate: b.candidate,
            selection: b.selection,
        }))
}
#[tauri::command]
pub async fn bind_soundcloud(
    app: AppHandle,
    track_id: String,
    source_id: Option<String>,
    selection: Option<SourceSelection>,
) -> Result<(), String> {
    let guard = checked_track(&app, &track_id)?;
    let shared = app.state::<SourceState>();
    let generation = shared.generation.load(Ordering::SeqCst);
    let candidate = if let Some(id) = source_id {
        Some(catalog(&app)?.track(&id).await.map_err(|e| e.to_string())?)
    } else {
        None
    };
    let _lock = shared.bindings_lock.lock().unwrap();
    if generation != shared.generation.load(Ordering::SeqCst)
        || !vk_web::check_upload_guard(&app, &guard)
    {
        return Err("Сеанс изменился. Выбор источника отменён.".into());
    }
    checked_track(&app, &track_id)?;
    let mut all = bindings(&app)?;
    let selection = selection.unwrap_or_default();
    if manual_binding_conflict(&all, guard.account_id, &track_id, selection) {
        return Err("Источник уже выбран вами. Автоматический подбор отменён.".into());
    }
    all.retain(|b| b.account_id != guard.account_id || b.track_id != track_id);
    if let Some(candidate) = candidate {
        if !candidate.streamable {
            return Err("SoundCloud не разрешает полное воспроизведение этой записи.".into());
        }
        if all.len() >= MAX_BINDINGS {
            return Err("Достигнут предел сохранённых связей источников.".into());
        }
        all.push(sanitized_binding(Binding {
            account_id: guard.account_id,
            track_id,
            candidate,
            selection,
        })?);
    }
    crate::write_json(&crate::data_dir(&app).join("source-links.json"), &all, true)
}
#[tauri::command]
pub async fn resolve_soundcloud(app: AppHandle, track_id: String) -> Result<Prepared, String> {
    let guard = checked_track(&app, &track_id)?;
    let shared = app.state::<SourceState>();
    let generation = shared.generation.load(Ordering::SeqCst);
    let binding = {
        let _lock = shared.bindings_lock.lock().unwrap();
        bindings(&app)?
            .into_iter()
            .find(|b| b.account_id == guard.account_id && b.track_id == track_id)
            .ok_or("Для трека ещё не выбран источник SoundCloud.")?
    };
    let client = catalog(&app)?;
    let cache_generation = client.playback_context(guard.account_id, guard.window_epoch, generation)
        .map_err(|e| e.to_string())?;
    let grant = client
        .streams(&binding.candidate.id, cache_generation)
        .await
        .map_err(|e| e.to_string())?;
    if generation != shared.generation.load(Ordering::SeqCst)
        || !vk_web::check_upload_guard(&app, &guard)
    {
        return Err("Сеанс изменился. Запуск отменён.".into());
    }
    checked_track(&app, &track_id)?;
    let url = grant
        .sources
        .first()
        .ok_or("SoundCloud не вернул полный поток.")?
        .url
        .clone();
    let token = hex::encode(rand::random::<[u8; 24]>());
    let mut sessions = shared.sessions.lock().unwrap();
    sessions.retain(|_, s| session_current(s.created_at, s.generation, generation, crate::now()));
    if sessions.len() >= 4 {
        return Err("Дождитесь завершения предыдущей подготовки источника.".into());
    }
    if generation != shared.generation.load(Ordering::SeqCst) {
        return Err("Подготовка источника отменена.".into());
    }
    sessions.insert(
        token.clone(),
        Session {
            catalog: client,
            cache_scope: grant.cache_scope,
            guard,
            urls: vec![url],
            created_at: crate::now(),
            generation,
        },
    );
    Ok(Prepared {
        path: format!("{token}/0"),
        title: grant.track.title,
        explicit: grant.track.explicit,
        source_id: binding.candidate.id,
    })
}
#[tauri::command]
pub fn release_soundcloud(shared: State<'_, SourceState>, session_id: Option<String>) {
    if let Some(id) = session_id {
        shared.sessions.lock().unwrap().remove(&id);
    } else {
        let revision = shared.generation.fetch_add(1, Ordering::SeqCst).wrapping_add(1);
        shared.sessions.lock().unwrap().clear();
        if let Some(client) = shared.catalog.lock().unwrap().as_ref() {
            client.clear_playback_cache(revision);
        }
    }
}

fn media_response(
    status: u16,
    content_type: &str,
    body: Vec<u8>,
    content_range: Option<&str>,
) -> Response<Vec<u8>> {
    let mut response = Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        .header("Access-Control-Allow-Headers", "Range")
        .header(
            "Access-Control-Expose-Headers",
            "Content-Length, Content-Range, Accept-Ranges",
        )
        .header("Cache-Control", "no-store")
        .header("Content-Type", content_type)
        .header("Content-Length", body.len())
        .header("Accept-Ranges", "bytes");
    if let Some(range) = content_range {
        response = response.header("Content-Range", range);
    }
    response.body(body).unwrap()
}

fn session_current(created_at: i64, generation: u64, active_generation: u64, now: i64) -> bool {
    generation == active_generation
        && now >= created_at
        && now.saturating_sub(created_at) < SESSION_TTL_MS
}

#[cfg(test)]
fn register_media_url(
    urls: &mut Vec<String>,
    upstream: &Url,
    origin: &str,
    token: &str,
) -> Result<String, String> {
    let upstream = validate_media_url(upstream.as_str())
        .map_err(|_| "Источник вернул неподдерживаемую ссылку HLS.")?;
    register_checked_media_url(urls, upstream, origin, token)
}
fn register_checked_media_url(urls: &mut Vec<String>, upstream: String, origin: &str, token: &str) -> Result<String,String> {
    let position = match urls.iter().position(|url| url == &upstream) {
        Some(index) => index,
        None => {
            if urls.len() >= MAX_SESSION_URLS {
                return Err("Слишком большой HLS-плейлист.".into());
            }
            urls.push(upstream);
            urls.len() - 1
        }
    };
    Ok(format!("{origin}/{token}/{position}"))
}

fn resource_response(
    status: u16,
    content_type: &str,
    bytes: Vec<u8>,
    content_range: Option<&str>,
    head: bool,
) -> Response<Vec<u8>> {
    let length = bytes.len();
    let mut response = media_response(
        status,
        content_type,
        if head { vec![] } else { bytes },
        content_range,
    );
    if head {
        response
            .headers_mut()
            .insert("Content-Length", length.into());
    }
    response
}
fn media_path(path: &str) -> Option<(&str, usize)> {
    let (token, index) = path.trim_start_matches('/').split_once('/')?;
    if token.len() != 48 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    if index.is_empty() || !index.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some((token, index.parse().ok()?))
}
fn rewrite_manifest(
    input: &str,
    base: &Url,
    mut register: impl FnMut(Url) -> Result<String, String>,
) -> Result<String, String> {
    let input = input.trim_start_matches('\u{feff}').trim_start();
    if input.lines().next().map(str::trim) != Some("#EXTM3U") {
        return Err("Источник не вернул HLS.".into());
    }
    let mut lines = Vec::new();
    for line in input.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            lines.push(String::new());
        } else if !trimmed.starts_with('#') {
            lines.push(register(
                base.join(trimmed)
                    .map_err(|_| "Некорректная ссылка сегмента.")?,
            )?);
        } else {
            let mut result = String::new();
            let mut rest = line;
            while let Some(start) = rest.find("URI=\"") {
                result.push_str(&rest[..start + 5]);
                rest = &rest[start + 5..];
                let end = rest.find('"').ok_or("Некорректная ссылка HLS.")?;
                result.push_str(&register(
                    base.join(&rest[..end])
                        .map_err(|_| "Некорректная ссылка HLS.")?,
                )?);
                result.push('"');
                rest = &rest[end + 1..];
            }
            result.push_str(rest);
            lines.push(result);
        }
    }
    Ok(lines.join("\n"))
}

fn is_manifest(bytes: &[u8], content_type: &str) -> bool {
    content_type.to_ascii_lowercase().contains("mpegurl")
        || std::str::from_utf8(bytes).is_ok_and(|text| {
            text.trim_start_matches('\u{feff}')
                .trim_start()
                .starts_with("#EXTM3U")
        })
}

fn source_error_response(error: CatalogError) -> Response<Vec<u8>> {
    if matches!(error, CatalogError::Expired) {
        media_response(410, "text/plain", b"Source expired".to_vec(), None)
    } else {
        media_response(502, "text/plain", b"Source unavailable".to_vec(), None)
    }
}

pub async fn serve(app: AppHandle, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    if request.method() == "OPTIONS" {
        return media_response(204, "text/plain", vec![], None);
    }
    if request.method() != "GET" && request.method() != "HEAD" {
        return media_response(405, "text/plain", vec![], None);
    }
    let range = match request.headers().get("range") {
        Some(value) => match value
            .to_str()
            .ok()
            .filter(|value| validate_range(value).is_ok())
        {
            Some(value) => Some(value),
            None => return media_response(416, "text/plain", vec![], None),
        },
        None => None,
    };
    let Some((token, index)) = media_path(request.uri().path()) else {
        return media_response(404, "text/plain", vec![], None);
    };
    let shared = app.state::<SourceState>();
    let Ok(_permit) = shared.media_slots.try_acquire() else {
        return media_response(429, "text/plain", vec![], None);
    };
    let session = shared.sessions.lock().unwrap().get(token).and_then(|s| {
        s.urls.get(index).map(|url| {
            (
                s.catalog.clone(),
                s.guard.clone(),
                url.clone(),
                s.created_at,
                s.generation,
                s.cache_scope,
            )
        })
    });
    let Some((client, guard, url, created_at, generation, cache_scope)) = session else {
        return media_response(404, "text/plain", vec![], None);
    };
    if !session_current(
        created_at,
        generation,
        shared.generation.load(Ordering::SeqCst),
        crate::now(),
    ) || !vk_web::check_upload_guard(&app, &guard)
    {
        return media_response(410, "text/plain", vec![], None);
    }
    let resource = match client.fetch_media(&url, range, cache_scope).await {
        Ok(r) => r,
        Err(error) => return source_error_response(error),
    };
    if generation != shared.generation.load(Ordering::SeqCst)
        || !vk_web::check_upload_guard(&app, &guard)
    {
        return media_response(410, "text/plain", vec![], None);
    }
    let manifest = is_manifest(&resource.bytes, &resource.content_type);
    let bytes = if manifest {
        let Ok(text) = std::str::from_utf8(&resource.bytes) else {
            return media_response(502, "text/plain", vec![], None);
        };
        let Ok(base) = Url::parse(&resource.final_url) else {
            return media_response(502, "text/plain", vec![], None);
        };
        let origin = format!(
            "{}://{}",
            request.uri().scheme_str().unwrap_or("pulse-media"),
            request
                .uri()
                .authority()
                .map(|a| a.as_str())
                .unwrap_or("localhost")
        );
        let result = rewrite_manifest(text, &base, |upstream| {
            let mut sessions = shared.sessions.lock().unwrap();
            let session = sessions.get_mut(token).ok_or("Сеанс завершён.")?;
            if session.generation != shared.generation.load(Ordering::SeqCst) {
                return Err("Сеанс завершён.".into());
            }
            let checked = client.validate_source(upstream.as_str()).map_err(|_|"Неподдерживаемый медиаканал.")?;
            register_checked_media_url(&mut session.urls, checked, &origin, token)
        });
        match result {
            Ok(text) => text.into_bytes(),
            Err(_) => return media_response(502, "text/plain", vec![], None),
        }
    } else {
        resource.bytes
    };
    if generation != shared.generation.load(Ordering::SeqCst)
        || !shared.sessions.lock().unwrap().contains_key(token)
    {
        return media_response(410, "text/plain", vec![], None);
    }
    resource_response(
        resource.status,
        if manifest {
            "application/vnd.apple.mpegurl"
        } else {
            &resource.content_type
        },
        bytes,
        resource.content_range.as_deref(),
        request.method() == "HEAD",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expired_source_returns_renewable_410_while_other_failures_keep_502() {
        let expired = source_error_response(CatalogError::Expired);
        assert_eq!(expired.status().as_u16(), 410);
        assert_eq!(expired.body().as_slice(), b"Source expired");
        assert_eq!(expired.headers().get("cache-control").unwrap(), "no-store");
        for error in [
            CatalogError::Network,
            CatalogError::Unauthorized,
            CatalogError::Forbidden,
            CatalogError::NotFound,
            CatalogError::RateLimited { retry_after_seconds: Some(60) },
            CatalogError::Unavailable,
            CatalogError::InvalidResponse,
        ] {
            let response = source_error_response(error);
            assert_eq!(response.status().as_u16(), 502);
            assert_eq!(response.body().as_slice(), b"Source unavailable");
        }
    }

    fn config(id: &str, proxy: Option<&str>) -> Configuration {
        Configuration {
            client_id: id.into(),
            client_secret: format!("{id}-secret"),
            proxy: proxy.map(str::to_owned),
        }
    }

    #[test]
    fn credential_json_is_strict_and_never_returns_parser_or_secret_details() {
        let imported = parse_credential_file(
            br#"{"clientId":"fixture-id","clientSecret":"fixture-private-secret"}"#,
        )
        .unwrap();
        assert_eq!(imported.client_id, "fixture-id");
        assert!(imported.proxy.is_none());
        for invalid in [
            br#"{"clientId":"PASTE_CLIENT_ID_HERE","clientSecret":"PASTE_CLIENT_SECRET_HERE"}"#.as_slice(),
            br#"{"client_id":"fixture-id","client_secret":"fixture-private-secret"}"#,
            br#"{"clientId":"fixture-id","clientSecret":"fixture-private-secret","accessToken":"do-not-store"}"#,
            br#"{"clientId":"one","clientId":"two","clientSecret":"fixture-private-secret"}"#,
            br#"{"clientId":123,"clientSecret":"fixture-private-secret"}"#,
            br#"{"clientId":"fixture-id","clientSecret":"fixture-private-secret","proxy":"file:///private"}"#,
            b"not json: fixture-private-secret",
        ] {
            let error = parse_credential_file(invalid).err().unwrap();
            assert!(!error.contains("fixture-private-secret") && !error.contains("do-not-store") && !error.contains("file:///private"));
        }
        assert!(parse_credential_file(&vec![b' '; MAX_CREDENTIAL_FILE_BYTES + 1]).is_err());
        let mut bom = vec![0xef, 0xbb, 0xbf];
        bom.extend_from_slice(
            br#"{"clientId":"fixture-id","clientSecret":"fixture-private-secret"}"#,
        );
        assert!(parse_credential_file(&bom).is_ok());
    }

    #[test]
    fn importing_keys_preserves_an_omitted_route_and_honors_explicit_direct_route() {
        let saved = config("saved", Some("http://localhost:8888"));
        let environment = config("env", Some("http://localhost:9999"));
        let imported =
            parse_credential_file(br#"{"clientId":"new-id","clientSecret":"new-secret"}"#).unwrap();
        let merged = merge_configuration(
            &imported.client_id,
            &imported.client_secret,
            imported.proxy.as_deref(),
            Some(&saved),
            &environment,
        )
        .unwrap();
        assert_eq!(merged.client_id, "new-id");
        assert_eq!(merged.proxy.as_deref(), Some("http://localhost:8888"));
        let direct = parse_credential_file(
            br#"{"clientId":"new-id","clientSecret":"new-secret","proxy":""}"#,
        )
        .unwrap();
        let merged = merge_configuration(
            &direct.client_id,
            &direct.client_secret,
            direct.proxy.as_deref(),
            Some(&saved),
            &environment,
        )
        .unwrap();
        assert!(merged.proxy.is_none());
        let status = serde_json::to_string(&Status {
            managed: None,
            configured: true,
            proxy: false,
            message: "Импорт завершён".into(),
        })
        .unwrap();
        assert!(
            !status.contains("new-id")
                && !status.contains("new-secret")
                && !status.contains("clientId")
        );
    }

    #[test]
    fn selected_credential_file_is_bounded_and_left_untouched() {
        let path = std::env::temp_dir().join(format!(
            "pulse-sc-credentials-test-{}.json",
            hex::encode(rand::random::<[u8; 8]>())
        ));
        let bytes = br#"{"clientId":"fixture-id","clientSecret":"fixture-private-secret"}"#;
        std::fs::write(&path, bytes).unwrap();
        let imported = read_credential_file(&path).unwrap();
        assert_eq!(imported.client_id, "fixture-id");
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_CREDENTIAL_FILE_BYTES as u64 + 1).unwrap();
        drop(file);
        assert!(read_credential_file(&path).is_err());
        std::fs::remove_file(&path).unwrap();
        assert!(read_credential_file(&path.with_extension("txt")).is_err());
    }

    #[cfg(debug_assertions)]
    #[test]
    fn credential_picker_fixture_requires_an_independent_existing_profile() {
        let profile = std::env::temp_dir();
        let file = profile.join("soundcloud-qa-credentials.json");
        let choice = Some(file.clone().into_os_string());
        assert!(qa_credential_file_selection(
            "ru.vkplayer.desktop",
            Some(&profile),
            choice.clone()
        )
        .is_none());
        assert!(qa_credential_file_selection(
            "ru.vkplayer.independentqa",
            None,
            choice.clone()
        )
        .is_none());
        assert!(qa_credential_file_selection(
            "ru.vkplayer.independentqa",
            Some(Path::new("relative-qa-profile")),
            choice.clone()
        )
        .is_none());
        assert_eq!(
            qa_credential_file_selection("ru.vkplayer.independentqa", Some(&profile), None),
            None
        );
        assert_eq!(
            qa_credential_file_selection(
                "ru.vkplayer.independentqa",
                Some(&profile),
                Some(std::ffi::OsString::new())
            ),
            Some(None)
        );
        assert_eq!(
            qa_credential_file_selection("ru.vkplayer.independentqa", Some(&profile), choice),
            Some(Some(file))
        );
    }

    fn binding(account: i64) -> Binding {
        Binding {
            account_id: account,
            track_id: "vk:10:20".into(),
            selection: SourceSelection::User,
            candidate: Candidate {
                provider: "soundcloud".into(),
                urn: "soundcloud:tracks:123".into(),
                id: "123".into(),
                title: "Song".into(),
                artist: "Artist".into(),
                duration: 180.,
                isrc: Some("USABC2412345".into()),
                explicit: Some(true),
                access: "playable".into(),
                streamable: true,
                permalink_url: Some(
                    "https://soundcloud.com/artist/song?secret_token=private-test-capability"
                        .into(),
                ),
                artwork_url: Some(
                    "https://i1.sndcdn.com/art.jpg?token=private-test-capability".into(),
                ),
            },
        }
    }

    #[test]
    fn route_only_edit_keeps_saved_credentials_and_intentional_direct_route() {
        let saved = config("saved", None);
        let environment = config("environment", Some("http://127.0.0.1:8888"));
        let merged = merge_configuration("", "", None, Some(&saved), &environment).unwrap();
        assert_eq!(merged.client_id, "saved");
        assert_eq!(merged.client_secret, "saved-secret");
        assert!(merged.proxy.is_none());
        let routed = merge_configuration(
            "",
            "",
            Some(" socks5h://localhost:1080 "),
            Some(&saved),
            &environment,
        )
        .unwrap();
        assert_eq!(routed.client_id, "saved");
        assert_eq!(routed.proxy.as_deref(), Some("socks5h://localhost:1080"));
    }

    #[test]
    fn explicit_direct_route_clears_proxy_and_survives_serialized_restart() {
        let saved = config(
            "saved",
            Some("http://user:private-test-password@localhost:8888"),
        );
        let environment = config("environment", Some("http://localhost:9999"));
        let direct = merge_configuration("", "", Some("  "), Some(&saved), &environment).unwrap();
        assert!(direct.proxy.is_none());
        let restored: Configuration =
            serde_json::from_str(&serde_json::to_string(&direct).unwrap()).unwrap();
        let after_restart =
            merge_configuration("", "", None, Some(&restored), &environment).unwrap();
        assert!(after_restart.proxy.is_none());
        assert_eq!(after_restart.client_id, "saved");
    }

    #[test]
    fn credentials_are_changed_only_as_a_pair_and_env_is_first_use_fallback() {
        let environment = config("environment", Some("http://localhost:9999"));
        let first = merge_configuration("", "", None, None, &environment).unwrap();
        assert_eq!(first.client_id, "environment");
        assert_eq!(first.proxy.as_deref(), Some("http://localhost:9999"));
        let replaced = merge_configuration(
            " next ",
            " next-secret ",
            None,
            Some(&first),
            &config("other", None),
        )
        .unwrap();
        assert_eq!(replaced.client_id, "next");
        assert_eq!(replaced.client_secret, "next-secret");
        assert_eq!(replaced.proxy, first.proxy);
        assert!(merge_configuration("next", "", None, Some(&first), &environment).is_err());
        assert!(merge_configuration("", "next-secret", None, Some(&first), &environment).is_err());
        assert!(merge_configuration(
            "",
            "",
            None,
            None,
            &Configuration {
                client_id: String::new(),
                client_secret: String::new(),
                proxy: None
            }
        )
        .is_err());
    }

    #[test]
    fn persisted_bindings_keep_metadata_but_remove_transient_url_tokens() {
        let row = sanitized_binding(binding(10)).unwrap();
        let encoded = serde_json::to_string(&row).unwrap();
        assert!(!encoded.contains("private-test-capability"));
        assert!(!encoded.contains("secret_token") && !encoded.contains("?token"));
        assert_eq!(
            row.candidate.permalink_url.as_deref(),
            Some("https://soundcloud.com/artist/song")
        );
        assert_eq!(
            row.candidate.artwork_url.as_deref(),
            Some("https://i1.sndcdn.com/art.jpg")
        );
        assert_eq!(row.candidate.explicit, Some(true));
        assert_eq!(row.candidate.isrc.as_deref(), Some("USABC2412345"));
        let mut malicious = binding(10);
        malicious.candidate.urn = "soundcloud:tracks:999".into();
        assert!(sanitized_binding(malicious).is_err());
        let mut malicious = binding(10);
        malicious.candidate.artwork_url = Some("https://evil.example/track.mp3".into());
        assert!(sanitized_binding(malicious)
            .unwrap()
            .candidate
            .artwork_url
            .is_none());
        assert!(sanitized_binding(binding(0)).is_err());
    }

    #[test]
    fn legacy_user_choices_and_automatic_metadata_proposals_remain_distinct() {
        let row = binding(10);
        let mut legacy = serde_json::to_value(&row).unwrap();
        legacy.as_object_mut().unwrap().remove("selection");
        let legacy: Binding = serde_json::from_value(legacy).unwrap();
        assert!(matches!(legacy.selection, SourceSelection::User));
        let automatic = Binding {
            selection: SourceSelection::Metadata,
            ..row
        };
        let restored: Binding =
            serde_json::from_str(&serde_json::to_string(&automatic).unwrap()).unwrap();
        assert!(matches!(restored.selection, SourceSelection::Metadata));
        let public = serde_json::to_value(SelectedCandidate {
            candidate: restored.candidate,
            selection: restored.selection,
        })
        .unwrap();
        assert_eq!(public["selection"], "metadata");
        assert_eq!(public["id"], "123");
    }
    #[test]
    fn automatic_proposals_never_overwrite_a_concurrent_explicit_account_choice() {
        let rows = vec![binding(10)];
        assert!(manual_binding_conflict(
            &rows,
            10,
            "vk:10:20",
            SourceSelection::Metadata
        ));
        assert!(!manual_binding_conflict(
            &rows,
            10,
            "vk:10:20",
            SourceSelection::User
        ));
        assert!(!manual_binding_conflict(
            &rows,
            20,
            "vk:10:20",
            SourceSelection::Metadata
        ));
        assert!(!manual_binding_conflict(
            &rows,
            10,
            "vk:10:21",
            SourceSelection::Metadata
        ));
        let rows = vec![Binding {
            selection: SourceSelection::Metadata,
            ..binding(10)
        }];
        assert!(!manual_binding_conflict(
            &rows,
            10,
            "vk:10:20",
            SourceSelection::Metadata
        ));
    }

    #[test]
    fn binding_file_roundtrip_preserves_accounts_and_leaves_corruption_for_recovery() {
        let directory = std::env::temp_dir().join(format!(
            "pulse-source-binding-test-{}",
            hex::encode(rand::random::<[u8; 8]>())
        ));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("source-links.json");
        assert!(read_bindings(&path).unwrap().is_empty());
        let rows = vec![
            sanitized_binding(binding(10)).unwrap(),
            sanitized_binding(binding(20)).unwrap(),
        ];
        crate::write_json(&path, &rows, true).unwrap();
        let restored = read_bindings(&path).unwrap();
        assert_eq!(restored.len(), 2);
        assert_eq!(restored[0].account_id, 10);
        assert_eq!(restored[1].account_id, 20);
        assert_eq!(restored[0].candidate.id, "123");
        std::fs::write(&path, b"{damaged json").unwrap();
        assert!(read_bindings(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"{damaged json");
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(&directory).unwrap();
    }

    #[test]
    fn session_generations_and_expiry_never_reactivate_old_sources() {
        assert!(session_current(100, 2, 2, 101));
        assert!(!session_current(100, 2, 3, 101));
        assert!(!session_current(100, 2, 2, 99));
        assert!(!session_current(100, 2, 2, 100 + SESSION_TTL_MS));
        assert!(!session_current(i64::MIN, 2, 2, i64::MAX));
        let shared = SourceState::default();
        let captured = shared.generation.load(Ordering::SeqCst);
        shared.generation.fetch_add(1, Ordering::SeqCst);
        assert!(!session_current(
            100,
            captured,
            shared.generation.load(Ordering::SeqCst),
            101
        ));
    }

    #[test]
    fn range_and_head_responses_have_consistent_lengths_and_private_cache_policy() {
        for head in [false, true] {
            let response = resource_response(
                206,
                "audio/mpeg",
                vec![1, 2, 3],
                Some("bytes 10-12/100"),
                head,
            );
            assert_eq!(response.status(), 206);
            assert_eq!(response.headers()["Content-Length"], "3");
            assert_eq!(response.headers()["Content-Range"], "bytes 10-12/100");
            assert_eq!(response.headers()["Accept-Ranges"], "bytes");
            assert_eq!(response.headers()["Cache-Control"], "no-store");
            assert_eq!(response.headers()["Access-Control-Allow-Origin"], "*");
            assert_eq!(response.body().len(), if head { 0 } else { 3 });
        }
    }

    #[test]
    fn redirected_manifest_variants_keys_maps_and_byte_ranges_stay_local() {
        let base = Url::parse("https://cf-hls-media.sndcdn.com/redirected/path/master.m3u8?token=private-test-capability").unwrap();
        let token = "a".repeat(48);
        let fixture = "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",URI=\"audio/index.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=160000,AUDIO=\"a\"\naudio/index.m3u8\n#EXT-X-KEY:METHOD=AES-128,URI=\"../key\"\n#EXT-X-MAP:URI=\"https://cf-hls-media.sndcdn.com/init.mp4?token=fixture\"\n#EXT-X-BYTERANGE:100@10\n#EXTINF:6.0,\nsegment.m4a\n#EXT-X-ENDLIST";
        let mut urls = vec![];
        let output = rewrite_manifest(fixture, &base, |url| {
            register_media_url(&mut urls, &url, "http://pulse-media.localhost", &token)
        })
        .unwrap();
        assert_eq!(urls.len(), 4);
        assert_eq!(
            urls[0],
            "https://cf-hls-media.sndcdn.com/redirected/path/audio/index.m3u8"
        );
        assert_eq!(urls[1], "https://cf-hls-media.sndcdn.com/redirected/key");
        assert!(output.contains("#EXT-X-BYTERANGE:100@10"));
        assert!(output.contains(&format!("URI=\"http://pulse-media.localhost/{token}/0\"")));
        assert!(output.contains(&format!("\nhttp://pulse-media.localhost/{token}/0\n")));
        assert!(!output.contains("sndcdn.com") && !output.contains("private-test-capability"));
        assert!(output.ends_with("#EXT-X-ENDLIST"));
    }

    #[test]
    fn manifests_reject_external_targets_and_respect_registered_url_budget() {
        let base = Url::parse("https://cf-hls-media.sndcdn.com/index.m3u8").unwrap();
        let token = "a".repeat(48);
        for fixture in [
            "#EXTM3U\nhttps://evil.example/segment.ts",
            "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"http://127.0.0.1/key\"",
            "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"unterminated",
        ] {
            let mut urls = vec![];
            assert!(rewrite_manifest(fixture, &base, |url| register_media_url(
                &mut urls,
                &url,
                "pulse-media://localhost",
                &token
            ))
            .is_err());
        }
        let full = (0..MAX_SESSION_URLS)
            .map(|index| format!("https://cf-hls-media.sndcdn.com/{index}.ts"))
            .collect::<Vec<_>>();
        let mut urls = full;
        assert!(register_media_url(
            &mut urls,
            &Url::parse("https://cf-hls-media.sndcdn.com/0.ts").unwrap(),
            "pulse-media://localhost",
            &token
        )
        .is_ok());
        assert!(register_media_url(
            &mut urls,
            &Url::parse("https://cf-hls-media.sndcdn.com/new.ts").unwrap(),
            "pulse-media://localhost",
            &token
        )
        .is_err());
        assert_eq!(urls.len(), MAX_SESSION_URLS);
    }

    #[test]
    fn manifest_content_type_and_bom_never_bypass_uri_rewriting() {
        let base = Url::parse("https://cf-hls-media.sndcdn.com/index.m3u8").unwrap();
        let text = "\u{feff}  \n#EXTM3U\nseg.ts\n";
        assert!(is_manifest(text.as_bytes(), "application/octet-stream"));
        let output = rewrite_manifest(text, &base, |_| {
            Ok("pulse-media://localhost/private/0".into())
        })
        .unwrap();
        assert!(output.starts_with("#EXTM3U\n"));
        assert!(!output.contains("seg.ts"));
        assert!(is_manifest(
            b"not HLS",
            "application/vnd.apple.mpegurl; charset=UTF-8"
        ));
        assert!(rewrite_manifest("#EXTM3Uevil\nseg.ts", &base, |_| Ok("local".into())).is_err());
        assert!(!is_manifest(&[0xff, 0x00], "audio/mpeg"));
    }

    #[test]
    fn tokens_do_not_accept_paths_or_queries() {
        assert!(media_path("/../../0").is_none());
        assert!(media_path("/abc/0").is_none());
        for suffix in ["+1", "1/2", "1?x=2", "-1", "184467440737095516160"] {
            assert!(media_path(&format!("/{}/{suffix}", "a".repeat(48))).is_none());
        }
        assert_eq!(
            media_path(&format!("/{}/12", "a".repeat(48))).unwrap().1,
            12
        );
    }
    #[test]
    fn hls_rewrites_keys_variants_and_segments_without_losing_tags() {
        let base =
            Url::parse("https://cf-hls-media.sndcdn.com/path/index.m3u8?secret=hidden").unwrap();
        let mut urls = Vec::new();
        let output = rewrite_manifest(
            "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key\"\n#EXTINF:10,\nseg.ts\n#EXT-X-ENDLIST",
            &base,
            |u| {
                urls.push(u);
                Ok(format!("local/{}", urls.len()))
            },
        )
        .unwrap();
        assert!(output.contains("URI=\"local/1\""));
        assert!(output.contains("\nlocal/2\n"));
        assert!(output.ends_with("#EXT-X-ENDLIST"));
        assert_eq!(
            urls[1].as_str(),
            "https://cf-hls-media.sndcdn.com/path/seg.ts"
        );
        assert!(!output.contains("secret="));
    }
}
