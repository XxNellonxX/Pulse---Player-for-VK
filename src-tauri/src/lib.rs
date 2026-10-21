use base64::Engine;
use lofty::{
    prelude::{Accessor, AudioFile, TaggedFileExt},
    probe::Probe,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
mod audio_session;
mod soundcloud;
mod vk_auth;
mod vk_sync;
mod vk_library_actions;
mod vk_playlist_actions;
mod vk_artist;
mod vk_upload;
mod vk_web;
mod youtube;
use std::sync::Arc;
use vk_auth::VkAuthManager;

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Track {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration: f64,
    pub artwork: Option<String>,
    pub url: String,
    pub source: String,
    #[serde(rename = "addedAt")]
    pub added_at: i64,
    pub available: bool,
    pub remote: Option<RemoteTrack>,
    #[serde(rename = "artistRefs", default, skip_serializing_if = "Vec::is_empty")]
    pub artist_refs: Vec<ArtistRef>,
}
#[derive(Clone, Serialize, Deserialize, Default)]
pub struct ArtistRef {
    pub id: String,
    pub name: String,
}
pub(crate) fn clean_artist_refs(refs: &mut Vec<ArtistRef>) {
    let mut ids = HashSet::new();
    refs.retain(|artist| !artist.id.is_empty() && artist.id.len() <= 100
        && artist.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        && ids.insert(artist.id.clone()));
    refs.truncate(20);
    for artist in refs { artist.name = artist.name.chars().filter(|c| !c.is_control()).take(200).collect(); }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct RemoteTrack {
    #[serde(rename = "ownerId")]
    pub owner_id: i64,
    #[serde(rename = "audioId")]
    pub audio_id: i64,
    #[serde(rename = "accessKey", default, skip_serializing_if = "Option::is_none")]
    pub access_key: Option<String>,
    #[serde(rename = "inLibrary", default)]
    pub in_library: bool,
    #[serde(rename = "searchResult", default, skip_serializing_if = "std::ops::Not::not")]
    pub search_result: bool,
}
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Playlist {
    pub id: String,
    pub title: String,
    #[serde(rename = "trackIds")]
    pub track_ids: Vec<String>,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    pub remote: Option<RemotePlaylist>,
    pub description: String,
    pub artwork: Option<String>,
    #[serde(rename = "syncedAt")]
    pub synced_at: Option<i64>,
    #[serde(
        rename = "contentUnavailable",
        skip_serializing_if = "std::ops::Not::not"
    )]
    pub content_unavailable: bool,
    #[serde(rename = "remoteTrackCount", skip_serializing_if = "Option::is_none")]
    pub remote_track_count: Option<u64>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct RemotePlaylist {
    #[serde(rename = "ownerId")]
    pub owner_id: i64,
    #[serde(rename = "playlistId")]
    pub playlist_id: i64,
    #[serde(rename = "accessKey", default, skip_serializing_if = "Option::is_none")]
    pub access_key: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub theme: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub palette: Option<String>,
    pub style: String,
    pub accent: String,
    pub density: String,
    #[serde(rename = "textScale")]
    pub text_scale: f64,
    #[serde(rename = "reducedMotion")]
    pub reduced_motion: bool,
    pub volume: f64,
    pub repeat: String,
    pub shuffle: bool,
    #[serde(rename = "closeToTray")]
    pub close_to_tray: bool,
    pub autoplay: bool,
    #[serde(rename = "autoSkip")]
    pub auto_skip: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct PersistedState {
    pub version: i32,
    pub tracks: Vec<Track>,
    pub playlists: Vec<Playlist>,
    pub history: Vec<String>,
    pub queue: Vec<String>,
    #[serde(rename = "currentTrackId")]
    pub current_track_id: Option<String>,
    pub position: f64,
    pub settings: Settings,
}
impl Default for PersistedState {
    fn default() -> Self {
        defaults()
    }
}
impl Default for Settings {
    fn default() -> Self {
        defaults().settings
    }
}
#[derive(Serialize)]
pub struct Capability {
    pub id: String,
    pub label: String,
    pub status: String,
    pub detail: String,
}
#[derive(Serialize)]
pub struct VkStatus {
    pub state: String,
    pub message: String,
    pub capabilities: Vec<Capability>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(rename = "syncProgress", skip_serializing_if = "Option::is_none")]
    pub sync_progress: Option<serde_json::Value>,
}
#[derive(Default)]
pub struct AppState {
    import_busy: Arc<AtomicBool>,
    pub state: Mutex<PersistedState>,
    pub media: Mutex<HashMap<String, PathBuf>>,
    storage_lock: Mutex<()>,
    recovered: AtomicBool,
    quitting: AtomicBool,
    pub auth: Mutex<Option<Arc<VkAuthManager>>>,
    pub vk_sync_lock: tokio::sync::Mutex<()>,
    pub vk_web: Mutex<vk_web::WebSession>,
    pub vk_web_open_lock: tokio::sync::Mutex<()>,
    vk_search_generation: AtomicU64,
}
#[derive(Serialize, Deserialize)]
struct Envelope {
    schema: u32,
    files: Vec<(String, PathBuf)>,
    state: PersistedState,
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
fn defaults() -> PersistedState {
    PersistedState {
        version: 1,
        tracks: vec![],
        playlists: vec![],
        history: vec![],
        queue: vec![],
        current_track_id: None,
        position: 0.,
        settings: Settings {
            theme: "dark".into(),
            palette: None,
            style: "minimal".into(),
            accent: "#b6f36a".into(),
            density: "comfortable".into(),
            text_scale: 1.,
            reduced_motion: false,
            volume: 0.7,
            repeat: "off".into(),
            shuffle: false,
            close_to_tray: false,
            autoplay: false,
            auto_skip: true,
        },
    }
}
fn data_dir(app: &AppHandle) -> PathBuf {
    if cfg!(debug_assertions) {
        if let Some(profile) = std::env::var_os("VK_PLAYER_QA_PROFILE") {
            return PathBuf::from(profile);
        }
    }
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("vk-player"))
}
fn state_file(app: &AppHandle) -> PathBuf {
    data_dir(app).join("library.json")
}
fn write_json<T: Serialize>(path: &Path, value: &T, backup: bool) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec(value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    if backup && path.exists() {
        fs::copy(path, path.with_extension("json.bak")).map_err(|e| e.to_string())?;
    }
    fs::rename(tmp, path).map_err(|e| e.to_string())
}

fn read_envelope(path: &Path) -> Option<Envelope> {
    let bytes = fs::read(path).ok()?;
    let value: Envelope = serde_json::from_slice(&bytes).ok()?;
    (value.schema == 1 && value.state.version == 1).then_some(value)
}
fn sanitized(mut state: PersistedState, media: &HashMap<String, PathBuf>) -> PersistedState {
    state.version = 1;
    state.tracks.truncate(100_000);
    let mut seen = HashSet::new();
    state
        .tracks
        .retain(|t| !t.id.is_empty() && seen.insert(t.id.clone()));
    for track in &mut state.tracks {
        track.title = track.title.chars().take(500).collect();
        track.artist = track.artist.chars().take(500).collect();
        track.album = track.album.chars().take(500).collect();
        track.duration = track.duration.clamp(0., 864000.);
        if track.source != "vk" {
            track.source = "local".into();
            track.remote = None;
            track.url = media
                .get(&track.id)
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();
            track.available = media.contains_key(&track.id);
        } else if !(track.url.starts_with("https://")
            || track.url.starts_with("vk-audio://")
            || vk_web::valid_web_track(track))
        {
            track.url.clear();
            track.available = false;
        }
    }
    let ids: HashSet<String> = state.tracks.iter().map(|t| t.id.clone()).collect();
    state.queue.retain(|id| ids.contains(id));
    let mut seen = HashSet::new();
    state.queue.retain(|id| seen.insert(id.clone()));
    state.history.retain(|id| ids.contains(id));
    state.history.truncate(1000);
    // VK synchronization accepts up to MAX_ITEMS records. Keep the same
    // native bound here so a successful full sync is not silently truncated
    // when the renderer saves playback state afterwards.
    state.playlists.truncate(100_000);
    for playlist in &mut state.playlists {
        playlist.track_ids.retain(|id| ids.contains(id));
    }
    if !state
        .current_track_id
        .as_ref()
        .is_some_and(|id| ids.contains(id))
    {
        state.current_track_id = None;
        state.position = 0.;
    }
    state.position = state.position.clamp(0., 864000.);
    state.settings.volume = state.settings.volume.clamp(0., 1.);
    state.settings.text_scale = state.settings.text_scale.clamp(0.85, 1.3);
    if !["dark", "light", "system", "high-contrast"].contains(&state.settings.theme.as_str()) {
        state.settings.theme = "dark".into();
    }
    state.settings.palette = state.settings.palette.filter(|id| !id.is_empty() && id.len() <= 40 && id.chars().all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-'));
    if !["minimal", "compact", "album", "soft"].contains(&state.settings.style.as_str()) {
        state.settings.style = "minimal".into();
    }
    if !["off", "all", "one"].contains(&state.settings.repeat.as_str()) {
        state.settings.repeat = "off".into();
    }
    state
}

fn merge_renderer_state(current: &PersistedState, mut incoming: PersistedState) -> PersistedState {
    // Native import/remove/sync/search commands own the registry. A UI save
    // only changes preferences, references and local playlists, so stale
    // payloads cannot undo an import, resurrect a deletion or cross accounts.
    incoming.tracks = current.tracks.clone();
    incoming.playlists.retain(|p| p.remote.is_none());
    incoming.playlists.extend(
        current
            .playlists
            .iter()
            .filter(|p| p.remote.is_some())
            .cloned(),
    );
    incoming
}
fn load(app: &AppHandle, shared: &AppState) {
    let path = state_file(app);
    // Read the old Electron profile once. Tauri writes its own copy and never
    // modifies the original profile, so switching back remains possible.
    let migration = if !path.exists() && !path.with_extension("json.bak").exists() {
        legacy_profile(app)
    } else {
        None
    };
    for (index, candidate) in [
        Some(path.clone()),
        Some(path.with_extension("json.bak")),
        migration,
    ]
    .iter()
    .filter_map(|p| p.as_ref())
    .enumerate()
    {
        if candidate.exists() {
            if let Some(value) = read_envelope(candidate) {
                let mut media = HashMap::new();
                for (id, path) in value.files {
                    if let Ok(path) = fs::canonicalize(path) {
                        if is_audio(&path) {
                            let _ = app.asset_protocol_scope().allow_file(&path);
                            media.insert(id, path);
                        }
                    }
                }
                *shared.state.lock().unwrap() = sanitized(value.state, &media);
                *shared.media.lock().unwrap() = media;
                shared.recovered.store(index != 0, Ordering::SeqCst);
                return;
            }
            shared.recovered.store(true, Ordering::SeqCst);
        }
    }
}

fn legacy_profile(app: &AppHandle) -> Option<PathBuf> {
    if cfg!(debug_assertions) && std::env::var_os("VK_PLAYER_QA_PROFILE").is_some() {
        return None;
    }
    let root = app.path().config_dir().ok()?;
    let old = root.join("vk-player-desktop").join("library.json");
    if read_envelope(&old).is_some() {
        return Some(old);
    }
    let backup = old.with_extension("json.bak");
    read_envelope(&backup).map(|_| backup)
}
fn save_locked(app: &AppHandle, shared: &AppState) -> Result<(), String> {
    let state = shared.state.lock().unwrap().clone();
    let media = shared
        .media
        .lock()
        .unwrap()
        .iter()
        .map(|(id, path)| (id.clone(), path.clone()))
        .collect();
    write_json(
        &state_file(app),
        &Envelope {
            schema: 1,
            files: media,
            state,
        },
        !shared.recovered.load(Ordering::SeqCst),
    )?;
    shared.recovered.store(false, Ordering::SeqCst);
    Ok(())
}
fn is_audio(p: &Path) -> bool {
    matches!(
        p.extension()
            .and_then(|x| x.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "mp3" | "m4a" | "aac" | "flac" | "ogg" | "opus" | "wav" | "weba" | "webm" | "aiff" | "aif"
    )
}
fn fingerprint(path: &Path, size: u64) -> Result<String, String> {
    let mut h = Sha256::new();
    h.update(size.to_string().as_bytes());
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 64 * 1024];
    if size <= 256 * 1024 * 1024 {
        loop {
            let n = file.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            h.update(&buf[..n]);
        }
    } else {
        for offset in [0, size.saturating_sub(1024 * 1024)] {
            file.seek(SeekFrom::Start(offset))
                .map_err(|e| e.to_string())?;
            let mut remain = 1024 * 1024;
            while remain > 0 {
                let n = file
                    .read(&mut buf[..remain.min(64 * 1024)])
                    .map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                h.update(&buf[..n]);
                remain -= n;
            }
        }
    }
    Ok(format!("local-{}", &hex::encode(h.finalize())[..24]))
}
fn inspect(path: &Path) -> Result<Track, String> {
    let info = fs::metadata(path).map_err(|e| e.to_string())?;
    if !info.is_file() || info.len() == 0 || info.len() > 4 * 1024 * 1024 * 1024 {
        return Err("Файл пуст или превышает 4 ГБ".into());
    }
    let metadata = Probe::open(path)
        .and_then(|p| Ok(p.guess_file_type()?))
        .and_then(|p| p.read())
        .map_err(|_| "Не удалось прочитать аудиофайл".to_string())?;
    let tag = metadata.primary_tag().or_else(|| metadata.first_tag());
    let title = tag
        .and_then(|t| t.title())
        .map(|x| x.to_string())
        .filter(|x| !x.is_empty())
        .unwrap_or_else(|| {
            path.file_stem()
                .and_then(|x| x.to_str())
                .unwrap_or("Без названия")
                .into()
        });
    let artist = tag
        .and_then(|t| t.artist())
        .map(|x| x.to_string())
        .unwrap_or_else(|| "Неизвестный исполнитель".into());
    let album = tag
        .and_then(|t| t.album())
        .map(|x| x.to_string())
        .unwrap_or_default();
    let artwork = tag
        .and_then(|t| t.pictures().iter().find(|p| p.data().len() < 1024 * 1024))
        .and_then(|p| {
            p.mime_type().map(|mime| {
                format!(
                    "data:{};base64,{}",
                    mime,
                    base64::engine::general_purpose::STANDARD.encode(p.data())
                )
            })
        });
    Ok(Track {
        id: fingerprint(path, info.len())?,
        title,
        artist,
        album,
        duration: metadata.properties().duration().as_secs_f64(),
        artwork,
        url: path.to_string_lossy().into_owned(),
        source: "local".into(),
        added_at: now(),
        available: true,
        remote: None,
        artist_refs: Vec::new(),
    })
}
#[tauri::command]
async fn get_state(app: AppHandle) -> Result<PersistedState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let shared = app.state::<AppState>();
        let _lock = shared.storage_lock.lock().unwrap();
        let state = shared.state.lock().unwrap().clone();
        let media = shared.media.lock().unwrap();
        sanitized(state, &media)
    })
    .await
    .map_err(|e| e.to_string())
}
#[tauri::command]
async fn save_state(app: AppHandle, state: PersistedState) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let shared = app.state::<AppState>();
        let _lock = shared.storage_lock.lock().unwrap();
        let incoming = {
            let current = shared.state.lock().unwrap();
            // VK data is authoritative in native code. A delayed renderer save
            // must not resurrect remote deletions or roll back server changes.
            merge_renderer_state(&current, state)
        };
        *shared.state.lock().unwrap() = sanitized(incoming, &shared.media.lock().unwrap());
        save_locked(&app, &shared)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn finish_close(app: AppHandle, shared: State<'_, AppState>) {
    shared.quitting.store(true, Ordering::SeqCst);
    app.exit(0);
}
struct ImportPermit(Arc<AtomicBool>);
impl ImportPermit {
    fn acquire(app: &AppHandle) -> Result<Self, String> {
        let busy = app.state::<AppState>().import_busy.clone();
        busy.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| "Дождитесь завершения текущего добавления треков.".to_string())?;
        Ok(Self(busy))
    }
}
impl Drop for ImportPermit {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
fn import_progress(app: &AppHandle, phase: &str, message: &str, current: usize, total: usize) {
    let _ = app.emit_to(
        "main",
        "import:progress",
        serde_json::json!({"phase":phase,"message":message,"current":current,"total":total}),
    );
}
#[tauri::command]
async fn upload_files_to_vk(app: AppHandle) -> Result<serde_json::Value, String> {
    let _permit = ImportPermit::acquire(&app)?;
    let guard = vk_web::upload_guard(&app)?;
    let paths: Vec<PathBuf> =
        if cfg!(debug_assertions) && std::env::var_os("VK_PLAYER_QA_FILES").is_some() {
            serde_json::from_str(&std::env::var("VK_PLAYER_QA_FILES").unwrap_or_default())
                .map_err(|_| "Некорректный список тестовых файлов.")?
        } else {
            rfd::AsyncFileDialog::new()
                .set_title("Загрузить MP3 в VK")
                .add_filter("MP3", &["mp3"])
                .pick_files()
                .await
                .unwrap_or_default()
                .iter()
                .map(|file| file.path().to_path_buf())
                .collect()
        };
    if paths.is_empty() {
        return Ok(serde_json::json!({"items":[],"cancelled":true,"accountId":guard.account_id}));
    }
    let sources = paths
        .into_iter()
        .map(|path| vk_upload::UploadSource {
            path,
            title: None,
            artist: None,
        })
        .collect();
    vk_upload::upload_files(app, sources, guard).await
}
fn youtube_url(input: &str) -> bool {
    url::Url::parse(input).ok().is_some_and(|url| {
        matches!(
            url.host_str(),
            Some(
                "youtube.com"
                    | "www.youtube.com"
                    | "m.youtube.com"
                    | "music.youtube.com"
                    | "youtu.be"
            )
        )
    })
}
#[tauri::command]
async fn upload_local_track_to_vk(app: AppHandle, id: String) -> Result<serde_json::Value, String> {
    let _permit = ImportPermit::acquire(&app)?;
    let guard = vk_web::upload_guard(&app)?;
    let source = {
        let shared = app.state::<AppState>();
        let track = shared
            .state
            .lock()
            .unwrap()
            .tracks
            .iter()
            .find(|track| track.id == id && track.source == "local")
            .cloned()
            .ok_or("Локальный трек не найден.")?;
        let path = shared
            .media
            .lock()
            .unwrap()
            .get(&id)
            .cloned()
            .ok_or("Файл трека больше недоступен. Добавьте его заново.")?;
        // Re-read tags when the displayed title may have come from the filename.
        // An artist tag alone does not establish that a title tag was present.
        let filename_fallback = path
            .file_stem()
            .is_some_and(|name| name.to_string_lossy() == track.title);
        vk_upload::UploadSource {
            path,
            title: (!track.title.is_empty() && !filename_fallback).then_some(track.title),
            artist: (track.artist != "Неизвестный исполнитель" && !track.artist.is_empty())
                .then_some(track.artist),
        }
    };
    vk_upload::upload_files(app, vec![source], guard).await
}
#[tauri::command]
async fn import_from_url(
    app: AppHandle,
    url: String,
    destination: String,
    proxy: Option<String>,
) -> Result<serde_json::Value, String> {
    let _permit = ImportPermit::acquire(&app)?;
    if !matches!(destination.as_str(), "vk" | "local") {
        return Err("Неизвестное место добавления трека.".into());
    }
    let guard = if destination == "vk" {
        Some(vk_web::upload_guard(&app)?)
    } else {
        None
    };
    let imports = data_dir(&app).join("imports");
    fs::create_dir_all(&imports).map_err(|_| "Не удалось создать папку загрузок.")?;
    import_progress(&app, "download", "Скачиваем исходный аудиофайл…", 1, 1);
    let downloaded = if youtube_url(&url) {
        let mut tools = app
            .path()
            .resource_dir()
            .map_err(|_| "Папка инструментов импорта недоступна.")?
            .join("import-tools");
        if cfg!(debug_assertions) && !tools.join("yt-dlp.exe").is_file() {
            tools = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/import-tools");
        }
        youtube::download_youtube(
            &url,
            &imports,
            &tools,
            proxy.as_deref(),
            destination == "vk",
        )
        .await?
    } else {
        soundcloud::download_url(&url, &imports).await?
    };
    let path = downloaded.path.clone();
    let tags = Probe::open(&path).and_then(|probe| probe.read()).ok();
    let tag = tags
        .as_ref()
        .and_then(|file| file.primary_tag().or_else(|| file.first_tag()));
    let title = tag
        .and_then(|tag| tag.title().map(|value| value.into_owned()))
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(downloaded.title);
    let artist = tag
        .and_then(|tag| tag.artist().map(|value| value.into_owned()))
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(downloaded.artist);
    if let Some(guard) = guard {
        let source = vk_upload::UploadSource {
            path: path.clone(),
            title: (!title.is_empty()).then_some(title),
            artist: (!artist.is_empty()).then_some(artist),
        };
        let result = vk_upload::upload_files(app, vec![source], guard).await;
        let _ = fs::remove_file(path);
        result
    } else {
        let result = tauri::async_runtime::spawn_blocking(move || {
            let mut track = inspect(&downloaded.path)?;
            if !title.is_empty() { track.title = title; }
            if !artist.is_empty() { track.artist = artist; }
            let shared = app.state::<AppState>();
            let _storage = shared.storage_lock.lock().unwrap();
            let before = shared.state.lock().unwrap().clone();
            let existing_file_present = shared.media.lock().unwrap().get(&track.id).is_some_and(|path| path.is_file());
            if let Some(existing) = before.tracks.iter().find(|item| item.id == track.id && existing_file_present) {
                let _ = fs::remove_file(&downloaded.path);
                return Ok(serde_json::json!({"items":[{"name":existing.title,"status":"local","message":"Этот файл уже есть в локальной библиотеке.","track":existing}],"cancelled":false}));
            }
            let old_path = shared.media.lock().unwrap().get(&track.id).cloned();
            app.asset_protocol_scope().allow_file(&downloaded.path).map_err(|_| "Не удалось разрешить воспроизведение файла.")?;
            shared.media.lock().unwrap().insert(track.id.clone(), downloaded.path);
            {
                let mut state = shared.state.lock().unwrap();
                if let Some(existing) = state.tracks.iter_mut().find(|item| item.id == track.id) { *existing = track.clone(); }
                else { state.tracks.push(track.clone()); }
            }
            if let Err(error) = save_locked(&app, &shared) {
                *shared.state.lock().unwrap() = before;
                let mut media = shared.media.lock().unwrap();
                if let Some(old) = old_path { media.insert(track.id.clone(), old); } else { media.remove(&track.id); }
                return Err(error);
            }
            Ok(serde_json::json!({"items":[{"name":track.title,"status":"local","message":"Исходный файл добавлен на этот компьютер без перекодирования.","track":track}],"cancelled":false}))
        }).await.map_err(|error| error.to_string()).and_then(|result: Result<serde_json::Value, String>| result);
        if result.is_err() {
            let _ = fs::remove_file(path);
        }
        result
    }
}
#[tauri::command]
async fn import_files(app: AppHandle) -> Result<Vec<Track>, String> {
    let _permit = ImportPermit::acquire(&app)?;
    let files = if cfg!(debug_assertions) && std::env::var_os("VK_PLAYER_QA_FILES").is_some() {
        serde_json::from_str::<Vec<PathBuf>>(
            &std::env::var("VK_PLAYER_QA_FILES").unwrap_or_default(),
        )
        .map_err(|e| e.to_string())?
    } else {
        rfd::AsyncFileDialog::new()
            .set_title("Добавить аудиофайлы")
            .add_filter(
                "Аудио",
                &[
                    "mp3", "m4a", "aac", "flac", "ogg", "opus", "wav", "weba", "webm", "aiff",
                    "aif",
                ],
            )
            .pick_files()
            .await
            .unwrap_or_default()
            .iter()
            .map(|f| f.path().to_path_buf())
            .collect()
    };
    tauri::async_runtime::spawn_blocking(move || {
        let shared = app.state::<AppState>();
        let _lock = shared.storage_lock.lock().unwrap();
        let mut added = vec![];
        let mut errors = vec![];
        for file in files {
            if let Ok(path) = fs::canonicalize(file) {
                if !is_audio(&path) {
                    continue;
                }
                match inspect(&path) {
                    Ok(track) => {
                        app.asset_protocol_scope()
                            .allow_file(&path)
                            .map_err(|e| e.to_string())?;
                        shared.media.lock().unwrap().insert(track.id.clone(), path);
                        added.push(track);
                    }
                    Err(error) => errors.push(error),
                }
            }
        }
        {
            let mut state = shared.state.lock().unwrap();
            for track in &added {
                if !state.tracks.iter().any(|t| t.id == track.id) {
                    state.tracks.push(track.clone());
                }
            }
        }
        if !added.is_empty() {
            save_locked(&app, &shared)?;
        }
        if !errors.is_empty() {
            let _ = app.emit_to(
                "main",
                "app:notice",
                format!("Не удалось добавить файлов: {}", errors.len()),
            );
        }
        Ok(added)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn remove_track(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let shared = app.state::<AppState>();
        let _lock = shared.storage_lock.lock().unwrap();
        shared.media.lock().unwrap().remove(&id);
        let mut state = shared.state.lock().unwrap().clone();
        state.tracks.retain(|t| t.id != id);
        let media = shared.media.lock().unwrap();
        *shared.state.lock().unwrap() = sanitized(state, &media);
        drop(media);
        save_locked(&app, &shared)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|_| "Некорректный URL")?;
    if !allowed_vk(&parsed) {
        return Err("Разрешены только ссылки VK".into());
    }
    app.opener()
        .open_url(url, None::<String>)
        .map_err(|e| e.to_string())
}
fn allowed_vk(url: &url::Url) -> bool {
    url.scheme() == "https"
        && url.host_str().is_some_and(|host| {
            ["vk.com", "vk.ru", "id.vk.ru"]
                .iter()
                .any(|root| host == *root || host.ends_with(&format!(".{root}")))
        })
}
#[tauri::command]
async fn open_vk_music(app: AppHandle) -> Result<(), String> {
    vk_web::open_manual(app).await?;
    Ok(())
}
fn vk_status(state: &str, message: &str) -> VkStatus {
    VkStatus {
        state: state.into(),
        message: message.into(),
        user: None,
        mode: Some("api".into()),
        sync_progress: None,
        capabilities: vec![
            Capability {
                id: "auth".into(),
                label: "Авторизация VK".into(),
                status: "unknown".into(),
                detail: "VK ID OAuth будет подключён после настройки public client.".into(),
            },
            Capability {
                id: "library".into(),
                label: "Моя музыка".into(),
                status: "unknown".into(),
                detail: "Доступ к audio API зависит от разрешений VK.".into(),
            },
            Capability {
                id: "search".into(),
                label: "Поиск музыки VK".into(),
                status: "unknown".into(),
                detail: "Доступ к audio API зависит от разрешений VK.".into(),
            },
            Capability {
                id: "playlists".into(),
                label: "Плейлисты VK".into(),
                status: "unknown".into(),
                detail: "Проверяется полным чтением плейлистов и их треков из VK API.".into(),
            },
            Capability {
                id: "upload".into(),
                label: "Загрузка файлов в VK".into(),
                status: "unsupported".into(),
                detail: "Upload API для этого клиента не подтверждён. Импорт файлов сохраняет их локально.".into(),
            },
        ],
    }
}
fn status_from_auth(auth: &VkAuthManager) -> VkStatus {
    let value = auth.status();
    let mut status = vk_status(&value.state, &value.message);
    status.user = value
        .user_id
        .map(|id| serde_json::json!({ "id": id, "name": "VK ID" }));
    status.capabilities[0].status = if value.configured {
        if value.state == "connected" {
            "verified"
        } else {
            "unknown"
        }
    } else {
        "unknown"
    }
    .into();
    status.capabilities[0].detail = if value.configured {
        "VK ID public client настроен; музыкальные разрешения проверяются запросом API.".into()
    } else {
        "Укажите VK_CLIENT_ID и зарегистрированный redirect URI.".into()
    };
    status
}
fn map_vk_audio(item: &serde_json::Value) -> Option<Track> {
    let owner = item
        .get("owner_id")
        .and_then(|v| v.as_i64())
        .filter(|id| *id != 0)?;
    let audio = item
        .get("id")
        .and_then(|v| v.as_i64())
        .filter(|id| *id > 0)?;
    let title = item
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("Без названия")
        .to_string();
    let artist = item
        .get("artist")
        .and_then(|v| v.as_str())
        .unwrap_or("Неизвестный исполнитель")
        .to_string();
    let album = item
        .get("album")
        .and_then(|v| v.get("title"))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let url = item
        .get("url")
        .and_then(|v| v.as_str())
        .filter(|value| {
            url::Url::parse(value)
                .ok()
                .is_some_and(|u| u.scheme() == "https" && u.host_str().is_some())
        })
        .unwrap_or("")
        .to_string();
    let artwork = item
        .get("album")
        .and_then(|v| v.get("thumb"))
        .and_then(|v| v.get("photo_300"))
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    Some(Track {
        id: format!("vk-{owner}-{audio}"),
        title,
        artist,
        album,
        duration: item.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.),
        artwork,
        url: if url.is_empty() {
            format!("vk-audio://{owner}/{audio}")
        } else {
            url.clone()
        },
        source: "vk".into(),
        added_at: now(),
        available: !url.is_empty(),
        artist_refs: Vec::new(),
        remote: Some(RemoteTrack {
            search_result: false,
            owner_id: owner,
            audio_id: audio,
            access_key: item
                .get("access_key")
                .and_then(|v| v.as_str())
                .map(str::to_owned),
            in_library: false,
        }),
    })
}
fn auth_for(shared: &State<'_, AppState>) -> Result<Arc<VkAuthManager>, String> {
    shared
        .auth
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "VK ID не настроен. Укажите VK_CLIENT_ID и redirect URI.".into())
}
#[tauri::command]
async fn get_vk_status(app: AppHandle, shared: State<'_, AppState>) -> Result<VkStatus, String> {
    if vk_web::uses_web(&shared) {
        return vk_web::restore_status(app).await;
    }
    let auth = shared.auth.lock().unwrap().clone();
    if let Some(auth) = auth {
        // A stored session may have an expired access token while its refresh
        // token is still valid. Restore it before deciding whether sync is
        // available, otherwise startup leaves the UI in a disabled state.
        let status = auth.status();
        if status.user_id.is_some() && !status.requires_reauth {
            let _ = auth.refresh_if_needed().await;
        }
        Ok(status_from_auth(&auth))
    } else {
        Ok(vk_status(
            "not-configured",
            "Настройка VK ID требуется один раз перед первым входом.",
        ))
    }
}
#[tauri::command]
async fn connect_vk(app: AppHandle, shared: State<'_, AppState>) -> Result<VkStatus, String> {
    if vk_web::uses_web(&shared) {
        return vk_web::open(app, true).await;
    }
    let Ok(auth) = auth_for(&shared) else {
        return Ok(vk_status(
            "not-configured",
            "Укажите VK_CLIENT_ID и redirect URI в настройках приложения.",
        ));
    };
    let previous_user = auth.status().user_id;
    let opener_app = app.clone();
    Ok(
        match auth
            .connect(move |url| {
                opener_app
                    .opener()
                    .open_url(url, None::<String>)
                    .map_err(|e| e.to_string())
            })
            .await
        {
            Ok(_) => {
                if previous_user != auth.status().user_id {
                    let _lock = shared.storage_lock.lock().unwrap();
                    {
                        let mut state = shared.state.lock().unwrap();
                        state.tracks.retain(|t| t.source != "vk");
                        state.playlists.retain(|p| p.remote.is_none());
                        *state = sanitized(state.clone(), &shared.media.lock().unwrap());
                    }
                    save_locked(&app, &shared)?;
                }
                status_from_auth(&auth)
            }
            Err(error) => vk_status(
                if error.code == "not_configured" {
                    "not-configured"
                } else {
                    "error"
                },
                &error.message,
            ),
        },
    )
}
#[tauri::command]
async fn disconnect_vk(app: AppHandle) -> VkStatus {
    let shared = app.state::<AppState>();
    if vk_web::uses_web(&shared) {
        return vk_web::disconnect(app.clone())
            .await
            .unwrap_or_else(|error| vk_status("error", &error));
    }
    let auth = shared.auth.lock().unwrap().clone();
    // Serialize logout with the final cache commit so a completed logout can
    // never be followed by an in-flight synchronization restoring VK data.
    let _lock = shared.storage_lock.lock().unwrap();
    let status = auth
        .as_ref()
        .map(|a| {
            a.disconnect();
            status_from_auth(a)
        })
        .unwrap_or_else(|| vk_status("disconnected", "Локальная сессия VK ID удалена."));
    {
        let mut state = shared.state.lock().unwrap();
        state.tracks.retain(|t| t.source != "vk");
        state.playlists.retain(|p| p.remote.is_none());
        let media = shared.media.lock().unwrap();
        *state = sanitized(state.clone(), &media);
    }
    if let Err(error) = save_locked(&app, &shared) {
        return vk_status(
            "error",
            &format!("Сессия удалена, но не удалось очистить дисковый кэш: {error}"),
        );
    }
    status
}
#[tauri::command]
async fn refresh_vk(
    app: AppHandle,
    shared: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    if vk_web::uses_web(&shared) {
        return vk_web::refresh(app).await;
    }
    vk_sync::sync_snapshot(app, shared).await
}
#[tauri::command]
async fn search_vk(app: AppHandle, shared: State<'_, AppState>, query: String) -> Result<Vec<Track>, String> {
    if vk_web::uses_web(&shared) {
        return search_web_music(app, query).await;
    }
    let Ok(auth) = auth_for(&shared) else {
        return Ok(vec![]);
    };
    let query = query.trim().chars().take(200).collect::<String>();
    if query.is_empty() {
        return Ok(vec![]);
    }
    let epoch = auth.session_epoch();
    let value = auth
        .api_request_at_epoch(
            "audio.search",
            &[
                ("q".into(), query),
                ("count".into(), "50".into()),
                ("extended".into(), "1".into()),
            ],
            epoch,
        )
        .await
        .map_err(|e| e.message)?;
    let tracks: Vec<Track> = value
        .get("items")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "VK вернул некорректные результаты поиска".to_string())?
        .iter()
        .filter_map(map_vk_audio)
        .collect();
    let _lock = shared.storage_lock.lock().unwrap();
    if auth.session_epoch() != epoch || auth.status().state != "connected" {
        return Err("Сеанс VK изменился. Результаты поиска отменены.".into());
    }
    let mut state = shared.state.lock().unwrap();
    // Only native API results can enter the track registry. Never replace
    // in-library metadata with the unowned search variant of the same track.
    let mut ids: HashSet<String> = state.tracks.iter().map(|t| t.id.clone()).collect();
    for track in &tracks {
        if state.tracks.len() < 100_000 && ids.insert(track.id.clone()) {
            state.tracks.push(track.clone());
        }
    }
    Ok(tracks)
}
async fn search_web_music(app: AppHandle, query: String) -> Result<Vec<Track>, String> {
    let query = query.trim().chars().take(200).collect::<String>();
    if query.is_empty() { return Ok(vec![]); }
    let generation = app.state::<AppState>().vk_search_generation.fetch_add(1, Ordering::SeqCst).wrapping_add(1);
    let expected = vk_web::upload_guard(&app)?;
    let window = app.get_webview_window("vk-music").ok_or("Подключите VK перед поиском.")?;
    let key = format!("search-{}-{}", now(), rand::random::<u64>());
    let key_json = serde_json::to_string(&key).unwrap();
    let query_json = serde_json::to_string(&query).unwrap();
    let script = format!("(()=>{{{};return {{accepted:window.__PULSE_VK_SEARCH__?.start({key_json},{query_json},{})===true}};}})()", include_str!("vk_web_search.js"), expected.account_id);
    let started = vk_web::evaluate(&window, script).await?;
    if started.get("accepted").and_then(serde_json::Value::as_bool) != Some(true) {
        return Err("Глобальный поиск VK ещё не готов. Дождитесь подключения аккаунта.".into());
    }
    for _ in 0..110 {
        if app.state::<AppState>().vk_search_generation.load(Ordering::SeqCst) != generation { return Err("Поисковый запрос изменился.".into()); }
        if !vk_web::check_upload_guard(&app, &expected) { return Err("Аккаунт VK изменился. Повторите поиск.".into()); }
        let result = vk_web::evaluate(&window, format!("(()=>{{if(window.top!==window.self||!['https://vk.com','https://vk.ru'].includes(location.origin))return {{complete:true,error:'Страница VK изменилась.'}};return window.__PULSE_VK_SEARCH__?.read({key_json},{})||{{complete:true,error:'Поиск VK недоступен.'}};}})()", expected.account_id)).await?;
        if result.get("complete").and_then(serde_json::Value::as_bool) != Some(true) {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            continue;
        }
        if let Some(error) = result.get("error").and_then(serde_json::Value::as_str) {
            return Err(error.chars().take(500).collect());
        }
        let raw = result.get("tracks").and_then(serde_json::Value::as_array).filter(|rows| rows.len() <= 100).ok_or("VK вернул некорректные результаты поиска.")?;
        let mut tracks = Vec::with_capacity(raw.len());
        let mut seen = HashSet::new();
        for row in raw {
            let mut track: Track = serde_json::from_value(row.clone()).map_err(|_| "VK изменил формат результатов поиска.")?;
            if !vk_web::valid_web_track(&track) || !track.duration.is_finite() || !(0.0..=864000.0).contains(&track.duration) { return Err("VK вернул некорректный трек поиска.".into()); }
            if !seen.insert(track.id.clone()) { continue; }
            track.title = track.title.chars().filter(|c| !c.is_control()).take(500).collect();
            track.artist = track.artist.chars().filter(|c| !c.is_control()).take(500).collect();
            track.album = track.album.chars().filter(|c| !c.is_control()).take(500).collect();
            track.artwork = track.artwork.filter(|url| url::Url::parse(url).ok().is_some_and(|url| url.scheme() == "https" && url.username().is_empty() && url.password().is_none()));
            if let Some(remote) = track.remote.as_mut() { remote.access_key = None; remote.in_library = false; remote.search_result = true; }
            track.added_at = now();
            tracks.push(track);
        }
        let shared = app.state::<AppState>();
        let _storage = shared.storage_lock.lock().unwrap();
        // Check under the same storage lock that serializes logout/cache commits.
        if shared.vk_search_generation.load(Ordering::SeqCst) != generation { return Err("Поисковый запрос изменился.".into()); }
        if !vk_web::check_upload_guard(&app, &expected) { return Err("Аккаунт VK изменился. Повторите поиск.".into()); }
        let mut state = shared.state.lock().unwrap();
        merge_web_search_results(&mut state, &mut tracks)?;
        return Ok(tracks);
    }
    Err("Поиск VK не ответил вовремя. Повторите запрос.".into())
}

pub(crate) fn merge_web_search_results(state: &mut PersistedState, tracks: &mut [Track]) -> Result<(), String> {
    // A large cached catalog is read by reference; clone only matching results.
    {
        let known: HashMap<_, _> = state.tracks.iter().map(|track| (track.id.as_str(), track)).collect();
        for track in tracks.iter_mut() {
            clean_artist_refs(&mut track.artist_refs);
            if let Some(existing) = known.get(track.id.as_str()) {
                let fresh_artists = std::mem::take(&mut track.artist_refs);
                *track = (*existing).clone();
                if !fresh_artists.is_empty() { track.artist_refs = fresh_artists; }
                if let Some(remote) = track.remote.as_mut() {
                    // A playlist-only result must remain playable if that playlist
                    // disappears while the search results are still displayed.
                    if !remote.in_library { remote.search_result = true; }
                }
            }
        }
    }
    let pinned: HashSet<_> = state.queue.iter().chain(state.history.iter())
        .chain(state.current_track_id.iter())
        .chain(state.playlists.iter().filter(|p| p.remote.is_none()).flat_map(|p| p.track_ids.iter()))
        .cloned().collect();
    let result_ids: HashSet<_> = tracks.iter().map(|track| track.id.clone()).collect();
    let retain = |track: &Track| !track.remote.as_ref().is_some_and(|r| r.search_result)
        || pinned.contains(&track.id) || result_ids.contains(&track.id);
    let mut ids: HashSet<_> = state.tracks.iter().filter(|track| retain(track)).map(|track| track.id.clone()).collect();
    let additions = tracks.iter().filter(|track| ids.insert(track.id.clone())).count();
    if state.tracks.iter().filter(|track| retain(track)).count() + additions > 100_000 {
        return Err("Библиотека достигла предела 100 000 треков. Результаты поиска не добавлены.".into());
    }
    // Keep the latest result set until the next search; background sync also
    // retains it so rows already on screen cannot lose their native registry.
    state.tracks.retain(|track| retain(track));
    let mut positions: HashMap<_, _> = state.tracks.iter().enumerate().map(|(index, track)| (track.id.clone(), index)).collect();
    for track in tracks {
        if let Some(index) = positions.get(&track.id) {
            state.tracks[*index] = track.clone();
        } else {
            positions.insert(track.id.clone(), state.tracks.len());
            state.tracks.push(track.clone());
        }
    }
    Ok(())
}
#[tauri::command]
async fn resolve_vk_track(shared: State<'_, AppState>, id: String) -> Result<Track, String> {
    let track = shared
        .state
        .lock()
        .unwrap()
        .tracks
        .iter()
        .find(|x| x.id == id)
        .cloned()
        .ok_or_else(|| "Трек не найден".to_string())?;
    if track.source != "vk" {
        return Ok(track);
    }
    if vk_web::valid_web_track(&track) {
        return Ok(track);
    }
    let Some(remote) = track.remote.clone() else {
        return Ok(track);
    };
    let auth = auth_for(&shared)?;
    let epoch = auth.session_epoch();
    let audio = match &remote.access_key {
        Some(key) => format!("{}_{}_{}", remote.owner_id, remote.audio_id, key),
        None => format!("{}_{}", remote.owner_id, remote.audio_id),
    };
    let value = auth
        .api_request_at_epoch("audio.getById", &[("audios".into(), audio)], epoch)
        .await
        .map_err(|e| e.message)?;
    let mut refreshed = value
        .as_array()
        .and_then(|items| items.first())
        .and_then(map_vk_audio)
        .filter(|t| t.id == track.id)
        .ok_or_else(|| "VK не подтвердил запрошенный трек. Повторите синхронизацию.".to_string())?;
    refreshed.added_at = track.added_at;
    if let Some(r) = &mut refreshed.remote {
        r.in_library = remote.in_library;
        r.access_key = r.access_key.take().or(remote.access_key);
    }
    let _lock = shared.storage_lock.lock().unwrap();
    if auth.session_epoch() != epoch || auth.status().state != "connected" {
        return Err("Сеанс VK изменился. Обновление трека отменено.".into());
    }
    let mut state = shared.state.lock().unwrap();
    if let Some(current) = state.tracks.iter_mut().find(|t| t.id == refreshed.id) {
        // Keep membership from the latest authoritative snapshot if a sync
        // committed while the URL request was in flight.
        refreshed.remote.as_mut().unwrap().in_library =
            current.remote.as_ref().is_some_and(|r| r.in_library);
        *current = refreshed.clone();
    } else {
        return Err("Трек удалён во время обновления. Повторите поиск.".into());
    }
    Ok(refreshed)
}
#[tauri::command]
fn get_version() -> String {
    env!("CARGO_PKG_VERSION").into()
}
#[tauri::command]
fn export_diagnostics(
    app: AppHandle,
    shared: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let path = data_dir(&app).join("VK Player diagnostics.json");
    let value = serde_json::json!({ "app": env!("CARGO_PKG_VERSION"), "runtime": "tauri-webview2", "platform": std::env::consts::OS, "tracks": shared.state.lock().unwrap().tracks.len() });
    write_json(&path, &value, false)?;
    Ok(Some(path.to_string_lossy().into()))
}
fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    };
    let open = MenuItem::with_id(app, "open", "Открыть VK Player", true, None::<&str>)?;
    let play = MenuItem::with_id(
        app,
        "play-pause",
        "Воспроизведение / пауза",
        true,
        None::<&str>,
    )?;
    let next = MenuItem::with_id(app, "next", "Следующий трек", true, None::<&str>)?;
    let import = MenuItem::with_id(app, "import", "Добавить аудиофайлы", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &play, &next, &import, &quit])?;
    TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("VK Player")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }
            "quit" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                    let _ = app.emit_to("main", "app:close-requested", ());
                } else {
                    app.state::<AppState>()
                        .quitting
                        .store(true, Ordering::SeqCst);
                    app.exit(0);
                }
            }
            id => {
                let _ = app.emit_to("main", "player:command", id);
            }
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                if let Some(w) = tray.app_handle().get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        })
        .build(app)?;
    Ok(())
}

fn init_auth(shared: &AppState) {
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../vk-config.json")).unwrap_or_default();
    let client_id = std::env::var("VK_CLIENT_ID")
        .ok()
        .or_else(|| {
            config
                .get("clientId")
                .and_then(|v| v.as_str())
                .map(str::to_owned)
        })
        .unwrap_or_default();
    let redirect = std::env::var("VK_REDIRECT_URI")
        .ok()
        .or_else(|| {
            config
                .get("redirectUri")
                .and_then(|v| v.as_str())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "http://localhost/".into());
    let scopes = std::env::var("VK_SCOPES")
        .ok()
        .or_else(|| {
            config
                .get("scopes")
                .and_then(|v| v.as_str())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "vkid.personal_info".into());
    if let Ok(auth) = VkAuthManager::new(client_id, redirect, scopes) {
        *shared.auth.lock().unwrap() = Some(Arc::new(auth));
    }
}

pub fn run() {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
    let context = tauri::generate_context!();
    audio_session::prepare_process(&context.config().identifier);
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        let command = match shortcut.key {
                            tauri_plugin_global_shortcut::Code::MediaPlayPause => "play-pause",
                            tauri_plugin_global_shortcut::Code::MediaTrackNext => "next",
                            tauri_plugin_global_shortcut::Code::MediaTrackPrevious => "previous",
                            _ => return,
                        };
                        let _ = app.emit_to("main", "player:command", command);
                    }
                })
                .build(),
        )
        .manage(AppState::default())
        .setup(|app| {
            audio_session::start();
            init_auth(&app.state::<AppState>());
            load(app.handle(), &app.state::<AppState>());
            setup_tray(app.handle())?;
            for key in ["MediaPlayPause", "MediaTrackNext", "MediaTrackPrevious"] {
                let _ = app.global_shortcut().register(key);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "vk-music" && vk_web::is_active(&window.state::<AppState>()) {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let shared = window.state::<AppState>();
                    if shared.state.lock().unwrap().settings.close_to_tray
                        && !shared.quitting.load(Ordering::SeqCst)
                    {
                        api.prevent_close();
                        let _ = window.hide();
                    } else if !shared.quitting.load(Ordering::SeqCst) {
                        // The renderer drains its debounced save queue before
                        // acknowledging finish_close. Failed saves leave the
                        // window open so edits are not silently discarded.
                        api.prevent_close();
                        let _ = window.emit("app:close-requested", ());
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            save_state,
            finish_close,
            import_files,
            upload_files_to_vk,
            upload_local_track_to_vk,
            import_from_url,
            remove_track,
            open_external,
            open_vk_music,
            vk_web::vk_web_control,
            get_vk_status,
            connect_vk,
            disconnect_vk,
            refresh_vk,
            vk_sync::sync_vk,
            vk_sync::add_vk_track,
            vk_sync::delete_vk_track,
            vk_sync::vk_playlist_change,
            vk_artist::vk_artist_music,
            search_vk,
            resolve_vk_track,
            get_version,
            export_diagnostics
        ])
        .run(context)
        .expect("error while running VK Player");
}

#[cfg(test)]
mod storage_tests {
    use super::*;
    fn search_fixture(id: i64, in_library: bool) -> Track {
        Track { id: format!("vk-1-{id}"), source: "vk".into(), title: format!("Track {id}"),
            remote: Some(RemoteTrack { owner_id: 1, audio_id: id, access_key: None,
                in_library, search_result: !in_library }), ..Default::default() }
    }
    #[test]
    fn next_search_expires_only_unpinned_old_results_and_registers_playlist_only_results() {
        let mut state = defaults();
        state.tracks = vec![search_fixture(1, false), search_fixture(2, false), search_fixture(3, false)];
        state.tracks[2].remote.as_mut().unwrap().search_result = false;
        state.queue = vec![state.tracks[0].id.clone()];
        let mut results = vec![search_fixture(3, false), search_fixture(4, false)];
        merge_web_search_results(&mut state, &mut results).unwrap();
        assert_eq!(state.tracks.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            vec!["vk-1-1", "vk-1-3", "vk-1-4"]);
        assert!(state.tracks[1].remote.as_ref().unwrap().search_result);
    }
    #[test]
    fn full_catalog_search_never_returns_an_unregistered_playable_result() {
        let mut state = defaults();
        state.tracks = (1..=100_000).map(|id| search_fixture(id, true)).collect();
        let mut results = vec![search_fixture(100_001, false)];
        assert!(merge_web_search_results(&mut state, &mut results).is_err());
        assert_eq!(state.tracks.len(), 100_000);
        assert!(!state.tracks.iter().any(|track| track.id == "vk-1-100001"));
    }
    #[test]
    fn stale_renderer_save_cannot_remove_native_import_or_restore_deleted_track() {
        let mut native = defaults();
        native.tracks.push(Track {
            id: "local-imported".into(),
            source: "local".into(),
            ..Default::default()
        });
        let mut delayed = defaults();
        delayed.tracks.push(Track {
            id: "local-deleted".into(),
            source: "local".into(),
            ..Default::default()
        });
        let saved = merge_renderer_state(&native, delayed);
        assert_eq!(saved.tracks.len(), 1);
        assert_eq!(saved.tracks[0].id, "local-imported");
    }
    #[test]
    fn renderer_cannot_insert_old_account_search_result_after_relogin() {
        let mut delayed = defaults();
        delayed.tracks.push(Track {
            id: "vk-1-2".into(),
            source: "vk".into(),
            remote: Some(RemoteTrack {
                owner_id: 1,
                audio_id: 2,
                access_key: None,
                in_library: false,
                search_result: true,
            }),
            ..Default::default()
        });
        assert!(merge_renderer_state(&defaults(), delayed).tracks.is_empty());
    }
    #[test]
    fn synchronized_playlists_are_not_silently_truncated_on_renderer_save() {
        let mut state = defaults();
        state.playlists = (1..=5001)
            .map(|id| Playlist {
                id: format!("vk-playlist-1-{id}"),
                remote: Some(RemotePlaylist {
                    owner_id: 1,
                    playlist_id: id,
                    access_key: None,
                }),
                ..Default::default()
            })
            .collect();
        assert_eq!(sanitized(state, &HashMap::new()).playlists.len(), 5001);
    }
    fn scratch(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "vk-player-rust-test-{name}-{}-{}",
            std::process::id(),
            now()
        ))
    }
    #[test]
    fn browser_asset_urls_are_never_persisted_as_native_paths() {
        let path = PathBuf::from(r"C:\Music\real.wav");
        let mut media = HashMap::new();
        media.insert("a".into(), path.clone());
        let mut state = defaults();
        state.tracks.push(Track {
            id: "a".into(),
            source: "local".into(),
            url: "http://asset.localhost/C%3A%5CMusic%5Creal.wav".into(),
            ..Track::default()
        });
        state.queue = vec!["a".into(), "a".into(), "ghost".into()];
        state.current_track_id = Some("ghost".into());
        state.history = vec!["a".into(), "ghost".into()];
        let next = sanitized(state, &media);
        assert_eq!(next.tracks[0].url, path.to_string_lossy());
        assert_eq!(next.queue, vec!["a"]);
        assert_eq!(next.history, vec!["a"]);
        assert_eq!(next.current_track_id, None);
    }
    #[test]
    fn replacing_storage_keeps_previous_valid_backup() {
        let dir = scratch("backup");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("library.json");
        let envelope = Envelope {
            schema: 1,
            files: vec![],
            state: defaults(),
        };
        write_json(&file, &envelope, false).unwrap();
        let mut changed = envelope;
        changed.state.settings.theme = "light".into();
        write_json(&file, &changed, true).unwrap();
        assert_eq!(read_envelope(&file).unwrap().state.settings.theme, "light");
        assert_eq!(
            read_envelope(&file.with_extension("json.bak"))
                .unwrap()
                .state
                .settings
                .theme,
            "dark"
        );
        fs::write(&file, b"corrupted").unwrap();
        assert!(read_envelope(&file).is_none());
        assert!(read_envelope(&file.with_extension("json.bak")).is_some());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn schema_mismatch_is_not_used_as_a_backup() {
        let dir = scratch("schema");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("library.json");
        write_json(
            &file,
            &Envelope {
                schema: 2,
                files: vec![],
                state: defaults(),
            },
            false,
        )
        .unwrap();
        assert!(read_envelope(&file).is_none());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn content_fingerprint_distinguishes_audio_after_first_megabyte() {
        let dir = scratch("fingerprint");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("test.wav");
        let mut content = vec![0u8; 2 * 1024 * 1024];
        fs::write(&file, &content).unwrap();
        let before = fingerprint(&file, content.len() as u64).unwrap();
        content[1500000] = 1;
        fs::write(&file, &content).unwrap();
        assert_ne!(before, fingerprint(&file, content.len() as u64).unwrap());
        fs::remove_dir_all(dir).unwrap();
    }
}
