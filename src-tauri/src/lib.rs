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
mod desktop_security;
mod autostart;
mod service_imports;
mod yandex_account_import;
mod gateway_client;
mod catalog_watch;
mod equalizer;
mod local_audio;
mod media_prepare;
mod owned_uploads;
mod source_page;
mod updates;
mod soundcloud;
mod soundcloud_catalog;
mod soundcloud_player;
mod musicbrainz_catalog;
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub isrc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub explicit: Option<bool>,
    #[serde(rename = "artistCard", skip_serializing_if = "Option::is_none")]
    pub artist_card: Option<String>,
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
pub(crate) fn clean_track_evidence(track: &mut Track) {
    track.version = track.version.take().map(|s| s.chars().filter(|c| !c.is_control()).take(200).collect::<String>()).filter(|s| !s.trim().is_empty());
    track.isrc = track.isrc.take().map(|s| s.chars().filter(|c| !c.is_whitespace() && *c != '-').collect::<String>().to_ascii_uppercase()).filter(|s| {
        let bytes = s.as_bytes();
        bytes.len() == 12 && bytes[..2].iter().all(u8::is_ascii_uppercase)
            && bytes[2..5].iter().all(u8::is_ascii_alphanumeric) && bytes[5..].iter().all(u8::is_ascii_digit)
    });
    track.artist_card = if !track.artist_refs.is_empty() { Some("present".into()) } else {
        track.artist_card.take().filter(|s| ["present", "absent", "unknown"].contains(&s.as_str()))
    };
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
    pub equalizer: equalizer::EqualizerSettings,
    #[serde(rename = "preferSoundCloud")]
    pub prefer_soundcloud: bool,
    #[serde(rename = "preferExplicit")]
    pub prefer_explicit: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct PersistedState {
    pub version: i32,
    pub tracks: Vec<Track>,
    pub playlists: Vec<Playlist>,
    pub history: Vec<String>,
    pub queue: Vec<String>,
    #[serde(rename = "queueSource", default, skip_serializing_if = "Vec::is_empty")]
    pub queue_source: Vec<String>,
    #[serde(rename = "currentTrackId")]
    pub current_track_id: Option<String>,
    pub position: f64,
    pub settings: Settings,
    #[serde(rename = "serviceImports", default)]
    pub service_imports: Vec<serde_json::Value>,
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
        queue_source: vec![],
        current_track_id: None,
        position: 0.,
        service_imports: vec![],
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
            equalizer: equalizer::EqualizerSettings::default(),
            prefer_soundcloud: true,
            prefer_explicit: true,
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
        clean_artist_refs(&mut track.artist_refs);
        clean_track_evidence(track);
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
    let queue_ids: HashSet<_> = state.queue.iter().cloned().collect();
    let mut source_seen = HashSet::new();
    state.queue_source.retain(|id| queue_ids.contains(id) && source_seen.insert(id.clone()));
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
    state.settings.equalizer.sanitize();
    state.settings.text_scale = state.settings.text_scale.clamp(0.85, 1.3);
    if !["dark", "light", "system", "high-contrast"].contains(&state.settings.theme.as_str()) {
        state.settings.theme = "dark".into();
    }
    state.settings.palette = state.settings.palette.filter(|id| !id.is_empty() && id.len() <= 40 && id.chars().all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-'));
    if !["minimal", "compact", "soft"].contains(&state.settings.style.as_str()) {
        state.settings.style = "minimal".into();
    }
    if !["off", "all", "one"].contains(&state.settings.repeat.as_str()) {
        state.settings.repeat = "off".into();
    }
    // Imports persist bounded public metadata and native track references only.
    // Duplicate source entries are intentional; deduplicate collection identities.
    {
        use serde_json::{json, Value};
        fn text(value: Option<&Value>, max: usize) -> String {
            value.and_then(Value::as_str).unwrap_or("").chars().filter(|c| !c.is_control()).take(max).collect::<String>().trim().to_string()
        }
        fn number(value: Option<&Value>, max: u64) -> Option<u64> {
            value.and_then(Value::as_u64).filter(|n| *n <= max)
        }
        fn public_image(value: &str) -> bool {
            value.len() <= 4096 && url::Url::parse(value).is_ok_and(|url| {
                url.scheme() == "https" && url.username().is_empty() && url.password().is_none()
                    && url.port_or_known_default() == Some(443)
                    && url.host_str().is_some_and(|host| host != "localhost" && !host.ends_with(".localhost") && !host.ends_with(".local") && host.trim_matches(['[', ']']).parse::<std::net::IpAddr>().is_err())
            })
        }
        fn source_url(raw: &str, service: &str) -> String {
            if (service == "spotify" && raw == "pulse:spotify:liked") || (service == "yandex" && raw == "pulse:yandex:liked") { return raw.into(); }
            if service == "yandex" && raw.starts_with("pulse:yandex:playlist:") {
                let parts: Vec<_> = raw.split(':').collect();
                if parts.len() == 5 && parts[3..].iter().all(|part| !part.is_empty() && part.len() <= 19 && part.bytes().all(|byte| byte.is_ascii_digit())) { return raw.into(); }
            }
            let Ok(mut url) = url::Url::parse(raw) else { return String::new(); };
            let host = url.host_str().unwrap_or("");
            if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() || url.port_or_known_default() != Some(443)
                || !(service == "spotify" && host == "open.spotify.com" || service == "yandex" && ["music.yandex.ru","music.yandex.com","music.yandex.kz","music.yandex.by","music.yandex.uz"].contains(&host)) { return String::new(); }
            url.set_query(None); url.set_fragment(None); url.to_string()
        }
        let mut budget = 50_000usize;
        let mut seen_collections = HashSet::new();
        state.service_imports = std::mem::take(&mut state.service_imports).into_iter().take(100).filter_map(|record| {
            let fields = record.as_object()?;
            let service = fields.get("service")?.as_str()?;
            if !["spotify", "yandex"].contains(&service) { return None; }
            let source_id = text(fields.get("sourceId"), 300);
            if source_id.is_empty() { return None; }
            let canonical_id = format!("{service}:{source_id}");
            if !seen_collections.insert(canonical_id.clone()) { return None; }
            let source_rows = fields.get("entries")?.as_array()?;
            let limit = budget.min(20_000);
            let mut damaged = source_rows.len() > limit
                || fields.get("sourceId").and_then(Value::as_str).is_some_and(|s|s.chars().count()>300||s.chars().any(char::is_control))
                || fields.get("title").and_then(Value::as_str).map_or(true,|s|s.trim().is_empty()||s.chars().count()>500||s.chars().any(char::is_control));
            let mut rows = Vec::new();
            for raw in source_rows.iter().take(limit) {
                let Some(row) = raw.as_object() else { damaged = true; continue; };
                let title = text(row.get("title"), 500);
                let source_id = text(row.get("sourceId"), 300);
                let Some(raw_artists) = row.get("artists").and_then(Value::as_array) else { damaged = true; continue; };
                let artists: Vec<String> = raw_artists.iter().take(20).map(|v|text(Some(v),200)).filter(|v|!v.is_empty()).collect();
                let Some(position) = number(row.get("position"),100_000) else { damaged = true; continue; };
                if title.is_empty() || source_id.is_empty() || artists.is_empty() { damaged = true; continue; }
                if raw_artists.len() != artists.len() || raw_artists.iter().take(20).any(|v|v.as_str().map_or(true,|s|s.chars().count()>200||s.chars().any(char::is_control))) { damaged = true; }
                if position != rows.len() as u64 { damaged = true; }
                let duration = row.get("duration").and_then(Value::as_f64).filter(|n|n.is_finite() && (0.0..=864000.0).contains(n)).unwrap_or_else(|| { damaged = true; 0.0 });
                let mut entry = json!({"sourceId":source_id,"title":title,"artists":artists,"album":text(row.get("album"),500),"duration":duration,"position":position});
                for (key,max) in [("sourceId",300),("title",500),("album",500)] {
                    if row.get(key).is_some_and(|v|v.as_str().map_or(true,|value| value.chars().count()>max || value.chars().any(char::is_control))) { damaged = true; }
                }
                let isrc = text(row.get("isrc"),30).replace([' ','-'],"").to_ascii_uppercase();
                if !isrc.is_empty() {
                    if isrc.is_ascii() && isrc.len()==12 && isrc[..2].bytes().all(|b|b.is_ascii_uppercase()) && isrc[2..5].bytes().all(|b|b.is_ascii_alphanumeric()) && isrc[5..].bytes().all(|b|b.is_ascii_digit()) { entry["isrc"]=json!(isrc); }
                    else { damaged = true; }
                }
                if let Some(explicit) = row.get("explicit") { if explicit.is_boolean() { entry["explicit"]=explicit.clone(); } else { damaged = true; } }
                let artwork = text(row.get("artwork"),4097);
                if !artwork.is_empty() { if public_image(&artwork) { entry["artwork"]=json!(artwork); } else { damaged = true; } }
                let track_id=text(row.get("trackId"),120);
                if !track_id.is_empty() && ids.contains(&track_id) { entry["trackId"]=json!(track_id); entry["resolution"]=json!("matched"); }
                else { entry["resolution"]=json!(match row.get("resolution").and_then(Value::as_str) { Some("review") if track_id.is_empty()=>"review",Some("missing") if track_id.is_empty()=>"missing",_=>"pending" }); }
                let message=text(row.get("message"),300); if !message.is_empty() { entry["message"]=json!(message); }
                rows.push(entry);
            }
            budget-=rows.len();
            let total=number(fields.get("total"),1_000_000);
            let raw_url=text(fields.get("sourceUrl"),2049);
            let clean_url=if raw_url.len()<=2048{source_url(&raw_url,service)}else{String::new()};
            if !raw_url.is_empty() && clean_url.is_empty(){damaged=true;}
            let complete=fields.get("complete").and_then(Value::as_bool)==Some(true) && !damaged && total==Some(rows.len() as u64) && rows.len()==source_rows.len();
            let mut warnings:Vec<String>=fields.get("warnings").and_then(Value::as_array).map(|rows|rows.iter().take(29).map(|v|text(Some(v),500)).filter(|v|!v.is_empty()).collect()).unwrap_or_default();
            if damaged || fields.get("complete").and_then(Value::as_bool)==Some(true) && !complete {
                let warning="Сохранена часть метаданных: достигнут предел хранения или обнаружены повреждённые записи. Повторите чтение источника.";
                if !warnings.iter().any(|saved|saved==warning){warnings.push(warning.into());}
            }
            let mut record=json!({"id":canonical_id,"service":service,"sourceId":source_id,"sourceUrl":clean_url,"title":text(fields.get("title"),500),"total":total,"complete":complete,"warnings":warnings,"entries":rows,"importedAt":number(fields.get("importedAt"),9_007_199_254_740_991).unwrap_or(0)});
            if record["title"]=="" { record["title"]=json!("Импортированная коллекция"); }
            if let Some(account)=number(fields.get("accountId"),9_007_199_254_740_991).filter(|v|*v>0) { record["accountId"]=json!(account); }
            let playlist=text(fields.get("remotePlaylistId"),100);if !playlist.is_empty() && state.playlists.iter().any(|p|p.id==playlist) { record["remotePlaylistId"]=json!(playlist); }
            Some(record)
        }).collect();
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

// Called only after our upload adapter confirms the exact saved record. The
// existing native file registry persists the receipt binding across restarts;
// no renderer field can insert or change a native file path.
pub(crate) fn remember_uploaded_source(
    app: &AppHandle,
    expected: &vk_web::UploadGuard,
    receipt: &serde_json::Value,
    source: &Path,
) -> Result<(), String> {
    let (id, path) = owned_uploads::verified_binding(&data_dir(app), source, expected.account_id, receipt)
        .ok_or("Не удалось подтвердить локальную копию загруженного трека.")?;
    remember_owned_source(app, expected, id, path, false)
}

fn remember_owned_source(
    app: &AppHandle,
    expected: &vk_web::UploadGuard,
    id: String,
    path: PathBuf,
    require_registered_track: bool,
) -> Result<(), String> {
    let shared = app.state::<AppState>();
    let _storage = shared.storage_lock.lock().unwrap();
    if !vk_web::check_upload_guard(app, expected) {
        return Err("Аккаунт VK изменился. Локальная копия не привязана.".into());
    }
    if require_registered_track && !shared.state.lock().unwrap().tracks.iter()
        .any(|track| track.id == id && owned_uploads::own_track(expected.account_id, track)) {
        return Err("Этот трек больше не находится в вашей музыке VK. Исходник не привязан.".into());
    }
    app.asset_protocol_scope().allow_file(&path).map_err(|_| "Не удалось разрешить воспроизведение исходника.")?;
    let previous = shared.media.lock().unwrap().insert(id.clone(), path);
    if let Err(error) = save_locked(app, &shared) {
        let mut media = shared.media.lock().unwrap();
        if let Some(previous) = previous { media.insert(id, previous); } else { media.remove(&id); }
        return Err(error);
    }
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
        version: None, isrc: None, explicit: None, artist_card: None,
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
fn import_tools(app: &AppHandle) -> Result<PathBuf, String> {
    let mut tools = app.path().resource_dir().map_err(|_| "Папка инструментов импорта недоступна.")?.join("import-tools");
    if cfg!(debug_assertions) && !tools.join(youtube::import_tool_name("yt-dlp")).is_file() {
        tools = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/import-tools");
    }
    Ok(tools)
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
                .set_title("Загрузить аудио в VK")
                .add_filter("Аудио", &["mp3", "flac", "wav", "m4a", "aac", "ogg", "opus", "aiff", "aif", "webm"])
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
async fn attach_vk_source(app: AppHandle, id: String) -> Result<serde_json::Value, String> {
    let _permit = ImportPermit::acquire(&app)?;
    let expected = vk_web::upload_guard(&app)?;
    // The renderer chooses an existing record, never a native path or a
    // synthetic receipt. Native ownership is checked before opening a dialog.
    let track = app.state::<AppState>().state.lock().unwrap().tracks.iter()
        .find(|track| track.id == id && owned_uploads::own_track(expected.account_id, track)).cloned()
        .ok_or("Исходник можно подключить только к треку из вашей музыки VK.")?;
    let selected = if cfg!(debug_assertions) && std::env::var_os("VK_PLAYER_QA_FILES").is_some() {
        let paths: Vec<PathBuf> = serde_json::from_str(&std::env::var("VK_PLAYER_QA_FILES").unwrap_or_default())
            .map_err(|_| "Некорректный список тестовых файлов.")?;
        if paths.len() > 1 { return Err("Выберите один исходный аудиофайл.".into()); }
        paths.into_iter().next()
    } else {
        rfd::AsyncFileDialog::new().set_title("Подключить исходный файл к выбранному треку VK")
            .add_filter("Аудио", &["mp3", "flac", "wav", "m4a", "aac", "ogg", "opus", "aiff", "aif", "webm"])
            .pick_file().await.map(|file| file.path().to_path_buf())
    };
    let Some(selected) = selected else { return Ok(serde_json::json!({"attached":false})); };
    if !vk_web::check_upload_guard(&app, &expected) {
        return Err("Аккаунт VK изменился. Исходник не привязан.".into());
    }
    let tools = import_tools(&app)?;
    let profile = data_dir(&app);
    let imports = profile.join("imports");
    fs::create_dir_all(&imports).map_err(|_| "Не удалось создать папку подготовки аудио.")?;
    import_progress(&app, "prepare", "Проверяем исходный аудиофайл для выбранного трека VK", 1, 1);
    let prepared = media_prepare::for_vk(&selected, &tools, &imports).await?;
    let source = prepared.path.clone();
    let stage_profile = profile.clone();
    let staged = tauri::async_runtime::spawn_blocking(move || owned_uploads::stage(&stage_profile, &source))
        .await.map_err(|_| "Не удалось сохранить исходник трека.")??;
    let save_app = app.clone();
    let save_path = staged.path.clone();
    // Selection explicitly associates this file with this exact record. There
    // is no metadata match and no upload/save request to VK in this command.
    tauri::async_runtime::spawn_blocking(move || {
        let path = owned_uploads::resolve(&profile, &save_path, expected.account_id, &track)
            .ok_or("Не удалось проверить сохранённый исходник трека.")?;
        remember_owned_source(&save_app, &expected, id, path, true)
    }).await.map_err(|_| "Не удалось сохранить привязку исходника.")??;
    staged.retain();
    drop(prepared);
    import_progress(&app, "complete", "Исходный файл подключён. Библиотека VK сохранена.", 1, 1);
    Ok(serde_json::json!({"attached":true}))
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
    let tools = import_tools(&app)?;
    import_progress(&app, "download", "Скачиваем исходный аудиофайл…", 1, 1);
    let is_soundcloud = url::Url::parse(url.trim()).ok().is_some_and(|u| matches!(u.host_str(), Some("soundcloud.com" | "www.soundcloud.com" | "on.soundcloud.com")));
    let mut downloaded = if is_soundcloud {
        // Prefer the author's original file. Public listening streams are a
        // second option, explicitly described in the import form.
        match soundcloud::download_url(&url, &imports).await {
            Ok(file) => file,
            Err(_) => youtube::download_media(&url, &imports, &tools, proxy.as_deref(), destination == "vk").await?,
        }
    } else if youtube::is_extractor_url(&url) {
        youtube::download_media(
            &url,
            &imports,
            &tools,
            proxy.as_deref(),
            destination == "vk",
        )
        .await?
    } else { soundcloud::download_url(&url, &imports).await? };
    let mut path = downloaded.path.clone();
    import_progress(&app, "verify", "Проверяем полную звуковую дорожку…", 1, 1);
    let (codec, duration) = match media_prepare::verify_audio(&path, &tools, downloaded.expected_duration).await {
        Ok(value) => value,
        Err(error) => { let _ = fs::remove_file(&path); return Err(error); }
    };
    if destination == "local" {
        import_progress(&app, "prepare", "Готовим аудио для воспроизведения…", 1, 1);
        match local_audio::prepare_download(&path, &tools, &imports, &codec, duration).await {
            Ok(Some(playable)) => { let _ = fs::remove_file(&path); path = playable.clone(); downloaded.path = playable; }
            Ok(None) => {},
            Err(error) => { let _ = fs::remove_file(&path); return Err(error); }
        }
    }
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
        import_progress(&app, "prepare", "Проверяем формат для загрузки в VK…", 1, 1);
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
    // Validate the bytes and decode the whole track before it enters the
    // library. A container may retain a false header duration after truncation;
    // the same bounded decoder used for VK uploads catches that case here.
    let tools = import_tools(&app)?;
    let imports = data_dir(&app).join("imports");
    fs::create_dir_all(&imports).map_err(|_| "Не удалось создать папку подготовки аудио.")?;
    let mut candidates = Vec::<(PathBuf, PathBuf)>::new();
    let mut errors = Vec::<String>::new();
    let mut selected = HashSet::new();
    for file in files {
        let Ok(path) = fs::canonicalize(file) else {
            errors.push("Не удалось открыть выбранный файл.".into());
            continue;
        };
        if !is_audio(&path) { continue; }
        if !selected.insert(path.clone()) { continue; }
        let (codec, duration) = match media_prepare::verify_audio(&path, &tools, None).await {
            Ok(value) => value,
            Err(error) => { errors.push(error); continue; }
        };
        match local_audio::prepare_download(&path, &tools, &imports, &codec, duration).await {
            Ok(Some(playable)) => candidates.push((path, playable)),
            Ok(None) => candidates.push((path.clone(), path)),
            Err(error) => errors.push(error),
        }
    }
    let prepared: Vec<PathBuf> = candidates.iter().map(|(original, playable)| if original == playable { None } else { Some(playable.clone()) }).flatten().collect();
    let import_app = app.clone();
    let prepared_for_commit = prepared.clone();
    let result: Result<(Vec<Track>, Vec<String>), String> = tauri::async_runtime::spawn_blocking(move || {
        let shared = import_app.state::<AppState>();
        let _lock = shared.storage_lock.lock().unwrap();
        let before = shared.state.lock().unwrap().clone();
        let media_before = shared.media.lock().unwrap().clone();
        let mut added = vec![];
        for (original, path) in candidates {
            match inspect(&path) {
                Ok(mut track) => {
                    if original != path {
                        match fs::metadata(&original).map_err(|error| error.to_string()).and_then(|value| fingerprint(&original, value.len())) {
                            Ok(id) => track.id = id,
                            Err(error) => { errors.push(error); continue; }
                        }
                    }
                    if original != path && path.file_stem().is_some_and(|name| name.to_string_lossy() == track.title) {
                        track.title = original.file_stem().map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| "Без названия".into());
                    }
                    if let Err(error) = import_app.asset_protocol_scope().allow_file(&path) {
                        errors.push(error.to_string());
                        continue;
                    }
                    shared.media.lock().unwrap().insert(track.id.clone(), path);
                    added.push(track);
                }
                Err(error) => errors.push(error),
            }
        }
        {
            let mut state = shared.state.lock().unwrap();
            for track in &added {
                if let Some(existing) = state.tracks.iter_mut().find(|value| value.id == track.id) { *existing = track.clone(); }
                else { state.tracks.push(track.clone()); }
            }
        }
        if !added.is_empty() {
            if let Err(error) = save_locked(&import_app, &shared) {
                *shared.state.lock().unwrap() = before;
                *shared.media.lock().unwrap() = media_before;
                return Err(error);
            }
        }
        let media = shared.media.lock().unwrap();
        for path in prepared_for_commit { if !media.values().any(|value| *value == path) { let _ = fs::remove_file(path); } }
        for old_path in media_before.values() {
            if old_path.starts_with(&imports) && old_path.file_name().is_some_and(|name| name.to_string_lossy().starts_with("playable-")) && !media.values().any(|value| value == old_path) {
                let _ = fs::remove_file(old_path);
            }
        }
        Ok((added, errors))
    })
    .await
    .map_err(|e| e.to_string())?;
    if result.is_err() {
        for path in prepared { let _ = fs::remove_file(path); }
    }
    let (added, errors) = result?;
    if !errors.is_empty() {
        let detail: String = errors[0].chars().take(300).collect();
        let _ = app.emit_to("main", "app:notice", format!("Не удалось добавить файлов: {}. {}", errors.len(), detail));
    }
    Ok(added)
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
    if !allowed_vk(&parsed) && !updates::release_link(&url, true) && !updates::release_link(&url, false) {
        return Err("Разрешены только ссылки VK и официальных релизов Pulse.".into());
    }
    app.opener()
        .open_url(url, None::<String>)
        .map_err(|e| e.to_string())
}
fn allowed_vk(url: &url::Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
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
    let mut artist_refs = item.get("main_artists").and_then(|v| v.as_array()).into_iter().flatten()
        .chain(item.get("featured_artists").and_then(|v| v.as_array()).into_iter().flatten())
        .filter_map(|v| Some(ArtistRef { id: v.get("id").and_then(|v| v.as_str().map(str::to_string).or_else(|| v.as_u64().map(|n| n.to_string())))?, name: v.get("name")?.as_str()?.to_string() })).collect::<Vec<_>>();
    clean_artist_refs(&mut artist_refs);
    let artist_card = if !artist_refs.is_empty() { Some("present".into()) } else if item.get("main_artists").is_some_and(|v| v.as_array().is_some_and(Vec::is_empty))
        && item.get("featured_artists").is_none_or(|v| v.is_null() || v.as_array().is_some_and(Vec::is_empty)) { Some("absent".into()) } else { None };
    let mut track = Track {
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
        artist_refs,
        version: item.get("subtitle").and_then(|v| v.as_str()).map(str::to_owned),
        isrc: item.get("isrc").and_then(|v| v.as_str()).map(str::to_owned),
        explicit: item.get("is_explicit").and_then(|v| v.as_bool()),
        artist_card,
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
    };
    clean_track_evidence(&mut track);
    Some(track)
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
    // Revoke in-memory media before either logout path can return. An in-flight
    // source resolution must not refill the previous account's playback cache.
    soundcloud_player::release_soundcloud(app.state(), None);
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
            clean_track_evidence(track);
            if let Some(existing) = known.get(track.id.as_str()) {
                let fresh_artists = std::mem::take(&mut track.artist_refs);
                let evidence = (track.version.clone(), track.isrc.clone(), track.explicit, track.artist_card.clone());
                *track = (*existing).clone();
                if !fresh_artists.is_empty() { track.artist_refs = fresh_artists; }
                track.version = evidence.0.or(track.version.clone());
                track.isrc = evidence.1.or(track.isrc.clone());
                track.explicit = evidence.2.or(track.explicit);
                track.artist_card = evidence.3.or(track.artist_card.clone());
                clean_track_evidence(track);
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
    // Artist pages, imports and mixes can remain visible while another query
    // completes. Retain a bounded recent metadata window so those rows do not
    // disappear before renderer queue/playlist persistence catches up. Pinned
    // rows are outside this window and retain their existing lifetime.
    let recent_incoming = tracks.iter().filter(|track|track.remote.as_ref().is_some_and(|r|r.search_result) && !pinned.contains(&track.id)).map(|track|track.id.clone()).collect::<HashSet<_>>();
    let mut required: HashSet<_> = state.tracks.iter().filter(|track|!track.remote.as_ref().is_some_and(|r|r.search_result) || pinned.contains(&track.id)).map(|track|track.id.clone()).collect();
    required.extend(result_ids.iter().cloned());
    let recent_budget = 5_000usize.saturating_sub(recent_incoming.len()).min(100_000usize.saturating_sub(required.len()));
    let recent: HashSet<_> = state.tracks.iter().rev().filter(|track|track.remote.as_ref().is_some_and(|r|r.search_result) && !pinned.contains(&track.id) && !result_ids.contains(&track.id)).take(recent_budget).map(|track|track.id.clone()).collect();
    let retain = |track: &Track| !track.remote.as_ref().is_some_and(|r| r.search_result)
        || pinned.contains(&track.id) || result_ids.contains(&track.id) || recent.contains(&track.id);
    let mut ids: HashSet<_> = state.tracks.iter().filter(|track| retain(track)).map(|track| track.id.clone()).collect();
    let additions = tracks.iter().filter(|track| ids.insert(track.id.clone())).count();
    if state.tracks.iter().filter(|track| retain(track)).count() + additions > 100_000 {
        return Err("Библиотека достигла предела 100 000 треков. Результаты поиска не добавлены.".into());
    }
    // Refresh only transient-query recency; never reorder the VK collection.
    state.tracks.retain(|track| retain(track) && (!recent_incoming.contains(&track.id) || !track.remote.as_ref().is_some_and(|r|r.search_result)));
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
async fn resolve_vk_track(app: AppHandle, shared: State<'_, AppState>, id: String) -> Result<Track, String> {
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
        // Only an app-uploaded, verified own record can resolve to a local
        // source. A cache miss is immediate and preserves normal VK playback.
        let owned_path = shared.media.lock().unwrap().get(&id).cloned();
        if let (Some(path), Ok(expected)) = (owned_path, vk_web::upload_guard(&app)) {
            let profile = data_dir(&app);
            let candidate = track.clone();
            let account = expected.account_id;
            let local = tauri::async_runtime::spawn_blocking(move || owned_uploads::resolve(&profile, &path, account, &candidate))
                .await.map_err(|_| "Не удалось проверить сохранённый исходник трека.")?;
            if !vk_web::check_upload_guard(&app, &expected) {
                return Err("Аккаунт VK изменился. Запуск трека отменён.".into());
            }
            if !shared.state.lock().unwrap().tracks.iter().any(|current| current.id == id && current.available && vk_web::valid_web_track(current)
                && current.remote.as_ref().is_some_and(|remote| remote.owner_id == account && remote.in_library)) {
                return Err("Трек удалён во время проверки исходника.".into());
            }
            if let Some(path) = local {
                let mut resolved = track;
                resolved.url = path.to_string_lossy().into_owned();
                // This is a transient playback response only. The registry,
                // VK badge, membership and canonical vk-web URL stay intact.
                resolved.source = "local".into();
                return Ok(resolved);
            }
        }
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
        .register_asynchronous_uri_scheme_protocol("pulse-media", |context, request, responder| {
            let app = context.app_handle().clone();
            tauri::async_runtime::spawn(async move { responder.respond(soundcloud_player::serve(app, request).await); });
        })
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
        .manage(autostart::AutostartState::default())
        .manage(soundcloud_player::SourceState::default())
        .setup(|app| {
            audio_session::start();
            init_auth(&app.state::<AppState>());
            load(app.handle(), &app.state::<AppState>());
            autostart::initialize(app.handle().clone());
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
        .invoke_handler(|invoke| {
            if !desktop_security::allow_invoke(&invoke) {
                invoke.resolver.reject("Native commands are available only to the Pulse player window.");
                return true;
            }
            let handler: fn(tauri::ipc::Invoke) -> bool = tauri::generate_handler![
            autostart::get_autostart,
            autostart::set_autostart,
            service_imports::read_service_playlist,
            service_imports::service_import_status,
            service_imports::connect_service_import,
            service_imports::disconnect_service_import,
            service_imports::list_service_playlists,
            service_imports::cancel_service_import,
            get_state,
            soundcloud_player::soundcloud_status,
            soundcloud_player::configure_soundcloud,
            soundcloud_player::import_soundcloud_credentials,
            soundcloud_player::check_soundcloud_connection,
            soundcloud_player::search_soundcloud,
            soundcloud_player::resolve_soundcloud_candidate,
            soundcloud_player::bind_soundcloud,
            soundcloud_player::soundcloud_binding,
            soundcloud_player::resolve_soundcloud,
            soundcloud_player::release_soundcloud,
            musicbrainz_catalog::search_catalog_artists,
            catalog_watch::catalog_watch_status,
            catalog_watch::catalog_set_followed,
            catalog_watch::catalog_refresh,
            catalog_watch::catalog_cancel_refresh,
            musicbrainz_catalog::get_catalog_artist,
            musicbrainz_catalog::status_catalog_route,
            musicbrainz_catalog::configure_catalog_route,
            save_state,
            finish_close,
            import_files,
            upload_files_to_vk,
            upload_local_track_to_vk,
            attach_vk_source,
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
            updates::check_app_release,
            export_diagnostics
            ];
            handler(invoke)
        })
        .run(context)
        .expect("error while running VK Player");
}

#[cfg(test)]
mod storage_tests {
    use super::*;
    #[test]
    fn vk_navigation_accepts_only_secure_first_party_endpoints() {
        for value in ["https://vk.ru/audio", "https://vk.com/", "https://id.vk.ru/authorize", "https://login.vk.com/"] {
            assert!(allowed_vk(&url::Url::parse(value).unwrap()), "{value}");
        }
        for value in ["http://vk.com/", "https://vk.com:444/", "https://user:secret@vk.ru/", "https://vk.ru.example/", "https://example.com/?url=vk.com", "file:///vk.com"] {
            assert!(!allowed_vk(&url::Url::parse(value).unwrap()), "{value}");
        }
    }
    fn imported_fixture(source_id:&str, count:usize)->serde_json::Value {
        serde_json::json!({"id":"untrusted-renderer-id","service":"spotify","sourceId":source_id,"sourceUrl":"https://open.spotify.com/playlist/test?token=PRIVATE#PRIVATE","title":"Imported","total":count,"complete":true,"warnings":[],"importedAt":1700000000000_i64,"entries":(0..count).map(|position|serde_json::json!({"sourceId":"same-recording","title":"Repeated song","artists":["Artist"],"album":"Album","duration":123.4,"position":position,"trackId":"vk-1-7","resolution":"matched","isrc":"US-ABC-26-12345","explicit":false})).collect::<Vec<_>>()})
    }
    #[test]
    fn imported_collection_roundtrip_preserves_repeats_and_source_positions_but_no_credentials(){
        let mut state=defaults();state.tracks.push(search_fixture(7,true));
        let mut record=imported_fixture("liked",3);record["password"]=serde_json::json!("PRIVATE");record["accessToken"]=serde_json::json!("PRIVATE");record["entries"][0]["cookie"]=serde_json::json!("PRIVATE");
        state.service_imports=vec![record.clone(),record];let saved=sanitized(state,&HashMap::new());let serialized=serde_json::to_string(&saved).unwrap();assert!(!serialized.contains("PRIVATE"));
        let decoded:PersistedState=serde_json::from_str(&serialized).unwrap();let restored=sanitized(decoded,&HashMap::new());assert_eq!(restored.service_imports,saved.service_imports);
        let record=&restored.service_imports[0];assert_eq!(restored.service_imports.len(),1);assert_eq!(record["id"],"spotify:liked");assert_eq!(record["complete"],true);assert_eq!(record["entries"].as_array().unwrap().len(),3);
        for position in 0..3{assert_eq!(record["entries"][position]["sourceId"],"same-recording");assert_eq!(record["entries"][position]["position"],position);assert_eq!(record["entries"][position]["trackId"],"vk-1-7");}assert_eq!(record["entries"][0]["isrc"],"USABC2612345");
    }
    #[test]
    fn imported_metadata_truncation_never_keeps_a_false_complete_receipt(){
        let mut state=defaults();state.service_imports=vec![imported_fixture("a",20001),imported_fixture("b",20000),imported_fixture("c",20000)];let saved=sanitized(state,&HashMap::new());
        assert_eq!(saved.service_imports.iter().map(|r|r["entries"].as_array().unwrap().len()).collect::<Vec<_>>(),vec![20000,20000,10000]);
        assert_eq!(saved.service_imports[0]["complete"],false);assert_eq!(saved.service_imports[1]["complete"],true);assert_eq!(saved.service_imports[2]["complete"],false);
        assert!(!saved.service_imports[0]["warnings"].as_array().unwrap().is_empty());assert!(!saved.service_imports[2]["warnings"].as_array().unwrap().is_empty());
    }
    #[test]
    fn imported_corrupt_metadata_and_unknown_totals_are_partial_and_missing_links_pending(){
        let mut state=defaults();let mut record=imported_fixture("damaged",3);record["warnings"]=serde_json::json!(vec!["x".repeat(600);40]);record["entries"][0]["artists"]=serde_json::json!([]);record["entries"][1]["duration"]=serde_json::json!(-1);record["entries"][2]["artwork"]=serde_json::json!("https://user:secret@example.com/art.jpg");record["entries"][2]["isrc"]=serde_json::json!("яяяяяя");
        let mut unknown=imported_fixture("unknown",1);unknown["total"]=serde_json::Value::Null;state.service_imports=vec![record,unknown];let saved=sanitized(state,&HashMap::new());
        let record=&saved.service_imports[0];assert_eq!(record["complete"],false);assert_eq!(record["entries"].as_array().unwrap().len(),2);assert_eq!(record["entries"][0]["position"],1);assert_eq!(record["entries"][0]["duration"].as_f64(),Some(0.0));assert_eq!(record["entries"][0]["resolution"],"pending");assert!(record["entries"][0].get("trackId").is_none());assert!(record["entries"][1].get("artwork").is_none());assert!(record["entries"][1].get("isrc").is_none());assert_eq!(record["warnings"].as_array().unwrap().len(),30);assert!(record["warnings"].as_array().unwrap().iter().all(|s|s.as_str().unwrap().chars().count()<=500));assert_eq!(saved.service_imports[1]["complete"],false);
    }
    #[test]
    fn recording_evidence_survives_storage_without_promoting_unknown_artist_cards() {
        let mut state = defaults();
        state.tracks.push(Track { id: "vk-1-7".into(), source: "vk".into(), url: "vk-web://1/7".into(),
            remote: Some(RemoteTrack { owner_id: 1, audio_id: 7, access_key: None, in_library: true, search_result: false }),
            version: Some("Live\u{0000}".into()), isrc: Some("us-abc-26-12345".into()), explicit: Some(false),
            artist_card: Some("unknown".into()), ..Default::default() });
        let saved = sanitized(state, &HashMap::new());
        let restored: PersistedState = serde_json::from_str(&serde_json::to_string(&saved).unwrap()).unwrap();
        assert_eq!(restored.tracks[0].version.as_deref(), Some("Live"));
        assert_eq!(restored.tracks[0].isrc.as_deref(), Some("USABC2612345"));
        assert_eq!(restored.tracks[0].explicit, Some(false));
        assert_eq!(restored.tracks[0].artist_card.as_deref(), Some("unknown"));
        assert!(restored.settings.prefer_soundcloud);
        assert!(restored.settings.prefer_explicit);
    }
    #[test]
    fn native_vk_mapping_uses_real_artist_metadata_and_preserves_recording_version() {
        let base = serde_json::json!({ "owner_id": 1, "id": 7, "artist": "Artist", "title": "Song", "duration": 180,
            "subtitle": "Live", "isrc": "US-ABC-26-12345", "is_explicit": true });
        let unknown = map_vk_audio(&base).unwrap();
        assert!(unknown.artist_card.is_none());
        assert_eq!(unknown.version.as_deref(), Some("Live"));
        assert_eq!(unknown.isrc.as_deref(), Some("USABC2612345"));
        assert_eq!(unknown.explicit, Some(true));
        let mut empty = base.clone(); empty["main_artists"] = serde_json::json!([]);
        assert_eq!(map_vk_audio(&empty).unwrap().artist_card.as_deref(), Some("absent"));
        empty["featured_artists"] = serde_json::json!([{ "id": "../broken", "name": "Artist" }]);
        assert!(map_vk_audio(&empty).unwrap().artist_card.is_none());
        empty["featured_artists"] = serde_json::json!([{ "id": "123", "name": "Artist" }]);
        let linked = map_vk_audio(&empty).unwrap();
        assert_eq!(linked.artist_card.as_deref(), Some("present"));
        assert_eq!(linked.artist_refs[0].id, "123");
        empty["isrc"] = serde_json::json!("123456789012");
        assert!(map_vk_audio(&empty).unwrap().isrc.is_none());
    }
    fn search_fixture(id: i64, in_library: bool) -> Track {
        Track { id: format!("vk-1-{id}"), source: "vk".into(), title: format!("Track {id}"),
            remote: Some(RemoteTrack { owner_id: 1, audio_id: id, access_key: None,
                in_library, search_result: !in_library }), ..Default::default() }
    }
    #[test]
    fn next_search_keeps_recent_pages_and_registers_playlist_only_results() {
        let mut state = defaults();
        state.tracks = vec![search_fixture(1, false), search_fixture(2, false), search_fixture(3, false)];
        state.tracks[2].remote.as_mut().unwrap().search_result = false;
        state.queue = vec![state.tracks[0].id.clone()];
        let mut results = vec![search_fixture(3, false), search_fixture(4, false)];
        merge_web_search_results(&mut state, &mut results).unwrap();
        assert_eq!(state.tracks.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            vec!["vk-1-1", "vk-1-2", "vk-1-3", "vk-1-4"]);
        assert!(state.tracks[2].remote.as_ref().unwrap().search_result);
    }
    #[test]
    fn transient_registry_is_bounded_refreshes_recency_and_never_evicts_pinned_or_owned_rows() {
        let mut state = defaults();
        state.tracks = (1..=5_003).map(|id|search_fixture(id,false)).collect();
        state.queue = vec!["vk-1-1".into()]; state.history = vec!["vk-1-2".into()]; state.current_track_id = Some("vk-1-3".into());
        state.tracks.push(search_fixture(6_000,true));
        let mut refresh = vec![search_fixture(4,false)]; merge_web_search_results(&mut state,&mut refresh).unwrap();
        let mut next = vec![search_fixture(5_004,false),search_fixture(5_005,false)]; merge_web_search_results(&mut state,&mut next).unwrap();
        assert_eq!(state.tracks.iter().filter(|track|track.remote.as_ref().is_some_and(|r|r.search_result) && !["vk-1-1","vk-1-2","vk-1-3"].contains(&track.id.as_str())).count(),5_000);
        assert!(!state.tracks.iter().any(|track|track.id == "vk-1-5" || track.id == "vk-1-6"));
        for id in [1,2,3,4,6_000,5_004,5_005] { assert!(state.tracks.iter().any(|track|track.id == format!("vk-1-{id}"))); }
    }
    #[test]
    fn near_full_library_evicts_old_transient_metadata_to_register_the_latest_page() {
        let mut state = defaults(); state.tracks = (1..=99_999).map(|id|search_fixture(id,true)).collect(); state.tracks.push(search_fixture(100_000,false));
        let mut next = vec![search_fixture(100_001,false)]; merge_web_search_results(&mut state,&mut next).unwrap();
        assert_eq!(state.tracks.len(),100_000); assert!(!state.tracks.iter().any(|track|track.id == "vk-1-100000")); assert!(state.tracks.iter().any(|track|track.id == "vk-1-100001"));
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
        state.queue_source = vec!["ghost".into(), "a".into(), "a".into()];
        state.current_track_id = Some("ghost".into());
        state.history = vec!["a".into(), "ghost".into()];
        let next = sanitized(state, &media);
        assert_eq!(next.tracks[0].url, path.to_string_lossy());
        assert_eq!(next.queue, vec!["a"]);
        assert_eq!(next.queue_source, vec!["a"]);
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
