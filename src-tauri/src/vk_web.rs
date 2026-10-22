//! Bridge to the user's signed-in official VK Music window.
//!
//! Remote content receives no Tauri permissions. Native code only evaluates
//! our fixed collector and reads bounded metadata; cookies and tokens remain
//! in WebView2. Every response is scoped to a window, navigation and account.
use crate::{now, save_locked, AppState, Capability, PersistedState, Playlist, Track, VkStatus};
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{webview::PageLoadEvent, AppHandle, Emitter, Manager, WebviewWindow};

const LABEL: &str = "vk-music";
const MAX_ITEMS: usize = 100_000;
const MAX_PAYLOAD: usize = 64 * 1024 * 1024;
const ADAPTER: &str = include_str!("vk_web_adapter.js");
const DIRECT_AUDIO: &str = include_str!("vk_direct_audio.js");
const EQUALIZER: &str = include_str!("../../src/shared/audioEqualizer.js");
const HLS: &str = include_str!("../resources/vk_hls.js");

#[derive(Clone, Copy, Default, PartialEq)]
enum WindowPolicy {
    #[default]
    LoginOnly,
    Manual,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum WindowVisibility {
    Show,
    Hide { focus_player: bool },
}

struct VisibilityUpdate {
    window_epoch: u64,
    revision: u64,
    visibility: WindowVisibility,
}

#[derive(Default)]
pub struct WebSession {
    active: bool,
    window_epoch: u64,
    navigation_revision: u64,
    generation: u64,
    run_id: String,
    stage: String,
    message: String,
    user: Option<Value>,
    progress: Option<Value>,
    committed: bool,
    run_committed: bool,
    synced_at: Option<i64>,
    last_event: String,
    window_policy: WindowPolicy,
    login_window_visible: bool,
    visibility_revision: u64,
    force_full: bool,
}

#[derive(Deserialize)]
struct StoredSession {
    enabled: bool,
    #[serde(rename = "profileId", default)]
    profile_id: Option<String>,
    #[serde(rename = "accountId", default)]
    account_id: Option<i64>,
}

fn random_id() -> String {
    let mut bytes = [0u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

pub fn uses_web(shared: &AppState) -> bool {
    !shared
        .auth
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|auth| auth.status().configured)
}

pub fn allowed_origin(url: &url::Url) -> bool {
    url.scheme() == "https"
        && matches!(url.host_str(), Some("vk.com" | "vk.ru"))
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
}

fn session_path(app: &AppHandle) -> std::path::PathBuf {
    crate::data_dir(app).join("vk-web-session.json")
}

fn remember_enabled(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let previous = stored_session(app);
    let account = previous.as_ref().and_then(|session| session.account_id);
    let profile = previous.and_then(|session| session.profile_id);
    crate::write_json(
        &session_path(app),
        &json!({"enabled": enabled, "profileId":profile,"accountId":account}),
        false,
    )
}

fn remember_account(app: &AppHandle, account: Option<i64>) {
    let previous = stored_session(app);
    let enabled = previous.as_ref().is_some_and(|session| session.enabled);
    let profile = previous.and_then(|session| session.profile_id);
    let _ = crate::write_json(
        &session_path(app),
        &json!({"enabled":enabled,"profileId":profile,"accountId":account}),
        false,
    );
}

fn stored_session(app: &AppHandle) -> Option<StoredSession> {
    serde_json::from_slice(&std::fs::read(session_path(app)).ok()?).ok()
}

fn cache_index_path(app: &AppHandle) -> std::path::PathBuf {
    crate::data_dir(app).join("vk-web-cache-index.json")
}

// This is bounded metadata only. Signed sources, raw tuples, cookies and
// resource hashes are never persisted with the music cache.
fn cache_seed(app: &AppHandle) -> Value {
    let Some(owner) = stored_session(app).filter(|s| s.enabled).and_then(|s| s.account_id) else {
        return Value::Null;
    };
    let shared = app.state::<AppState>();
    let state = shared.state.lock().unwrap();
    let tracks: Vec<_> = state.tracks.iter().filter(|t| valid_web_track(t)).collect();
    let playlists: Vec<_> = state.playlists.iter().filter(|p| p.remote.is_some()).collect();
    if tracks.is_empty() && playlists.is_empty() { return Value::Null; }
    let index = std::fs::read(cache_index_path(app)).ok()
        .filter(|bytes| bytes.len() <= 16 * 1024 * 1024)
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .filter(|value| value.get("accountId").and_then(Value::as_i64) == Some(owner))
        .and_then(|value| value.get("playlists").cloned()).unwrap_or_else(|| json!({}));
    json!({"accountId":owner,"tracks":tracks,"playlists":playlists,"index":index})
}

fn clean_cache_index(value: Option<&Value>, account: i64) -> Value {
    let mut entries = serde_json::Map::new();
    if let Some(items) = value.and_then(Value::as_object) {
        for (id, item) in items.iter().take(MAX_ITEMS) {
            if id.len() > 100 || !id.starts_with("vk-playlist-") { continue; }
            let Some(fingerprint) = item.get("fingerprint").and_then(Value::as_str)
                .filter(|s| s.len() <= 4000) else { continue; };
            let Some(checked) = item.get("checkedAt").and_then(web_integer)
                .filter(|n| *n > 0 && *n <= now() + 60_000) else { continue; };
            entries.insert(id.clone(), json!({"fingerprint":fingerprint,"checkedAt":checked}));
        }
    }
    json!({"accountId":account,"playlists":entries})
}

fn profile_dir(app: &AppHandle) -> std::path::PathBuf {
    let profile = stored_session(app)
        .and_then(|session| session.profile_id)
        .filter(|id| id.len() == 48 && id.chars().all(|ch| ch.is_ascii_hexdigit()));
    crate::data_dir(app).join(
        profile
            .map(|id| format!("vk-webview-{id}"))
            .unwrap_or_else(|| "vk-webview".into()),
    )
}

// WKWebView has no custom directory support. A stable store identifier keeps
// the VK login between launches; rotating profileId on logout also rotates it.
#[cfg(any(target_os = "macos", test))]
fn profile_store_identifier(profile: &std::path::Path) -> [u8; 16] {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(profile.to_string_lossy().as_bytes());
    let mut identifier = [0u8; 16];
    identifier.copy_from_slice(&hash[..16]);
    identifier
}

fn should_restore(app: &AppHandle) -> bool {
    match std::fs::read(session_path(app)) {
        Ok(bytes) => serde_json::from_slice::<StoredSession>(&bytes)
            .map(|value| value.enabled)
            .unwrap_or(false),
        Err(_) => crate::data_dir(app).join("vk-webview").is_dir(),
    }
}

fn web_status(session: &WebSession) -> VkStatus {
    let connected = session.active && session.committed;
    let has_user = session.user.is_some();
    let state = if !session.active {
        "disconnected"
    } else if session.stage == "error" {
        "error"
    } else if session.stage == "waiting-login" {
        "waiting-login"
    } else if connected {
        "connected"
    } else {
        "connecting"
    };
    let message = if session.message.is_empty() {
        "Войдите в VK: музыка и плейлисты появятся автоматически."
    } else {
        &session.message
    };
    let mut status = VkStatus {
        state: state.into(),
        message: message.into(),
        user: session.user.clone(),
        mode: Some("web".into()),
        sync_progress: session.progress.clone(),
        capabilities: Vec::new(),
    };
    for (id, label, verified, detail) in [
        ("auth", "Вход через VK", has_user, "Вход выполняется на официальном сайте VK. Пароль и сессия остаются в его окне."),
        ("library", "Моя музыка", connected, "Вся коллекция читается из вашей сессии VK без экспорта токенов."),
        ("playlists", "Плейлисты VK", connected, "Плейлисты и их состав появляются после полного чтения VK."),
        ("playback", "Воспроизведение VK", connected, "Доступные аккаунту аудиоисточники воспроизводятся отдельным плеером Pulse без рекламной очереди сайта."),
        ("search", "Поиск музыки VK", connected, "Поиск по своей библиотеке и глобальному каталогу VK."),
        ("upload", "Загрузка файлов в VK", connected, "MP3 загружается через вашу сессию VK с проверкой сохранения в библиотеке."),
        ("track-mutations", "Добавление и удаление треков VK", connected, "Треки добавляются и удаляются через вашу сессию VK. Результат подтверждается повторным чтением библиотеки."),
        ("mutations", "Плейлисты VK", connected, "Создание и изменения собственных плейлистов подтверждаются повторным чтением VK."),
    ] {
        status.capabilities.push(Capability {
            id: id.into(), label: label.into(),
            status: if verified { "verified" } else if matches!(id, "search" | "mutations") { "unsupported" } else { "unknown" }.into(),
            detail: detail.into(),
        });
    }
    status
}

pub fn status(shared: &AppState) -> VkStatus {
    web_status(&shared.vk_web.lock().unwrap())
}

pub fn is_active(shared: &AppState) -> bool {
    shared.vk_web.lock().unwrap().active
}

fn update_value(session: &WebSession, error: Option<&str>) -> Value {
    let mut value = json!({
        "status": web_status(session), "tracks": [], "playlists": [],
        "complete": false, "syncedAt": session.synced_at, "mode": "web",
        "progress": session.progress,
    });
    if let Some(error) = error {
        value["error"] = json!(error);
    }
    value
}

fn emit_update(app: &AppHandle, shared: &AppState, force: bool) {
    let value = {
        let mut session = shared.vk_web.lock().unwrap();
        let value = update_value(
            &session,
            (session.stage == "error").then_some(session.message.as_str()),
        );
        let signature = value.to_string();
        if !force && session.last_event == signature {
            return;
        }
        session.last_event = signature;
        value
    };
    let _ = app.emit_to("main", "vk:web-update", value);
}

fn begin_run(session: &mut WebSession) {
    session.generation = session.generation.wrapping_add(1);
    session.run_id = random_id();
    session.active = true;
    session.stage = "syncing".into();
    session.message = "Подключаем вашу сессию VK и читаем музыкальную коллекцию…".into();
    session.progress = None;
    session.run_committed = false;
}

fn should_start_poll(was_active: bool, started_run: bool) -> bool {
    !was_active && started_run
}

fn inject(window: &WebviewWindow, run_id: &str) -> Result<(), String> {
    if window.label() != LABEL || !window.url().ok().is_some_and(|url| allowed_origin(&url)) {
        return Ok(());
    }
    let run_json = serde_json::to_string(run_id).unwrap();
    let app = window.app_handle();
    let seed = cache_seed(app);
    let force = app.state::<AppState>().vk_web.lock().unwrap().force_full;
    let script = format!(
        "(()=>{{if(window.top!==window.self||!['https://vk.com','https://vk.ru'].includes(location.origin))return;window.__PULSE_VK_WEB_RUN_ID={run_json};window.__PULSE_VK_WEB_CACHE={seed};window.__PULSE_VK_WEB_FULL_REFRESH={force};if(!window.__PULSE_HLS__){{{HLS}}}if(!window.__PULSE_CREATE_EQUALIZER__){{{EQUALIZER}}}if(!window.__PULSE_CREATE_DIRECT_AUDIO__){{{DIRECT_AUDIO}}}{ADAPTER}\nwindow.__PULSE_VK_WEB__?.start({run_json},window.__PULSE_VK_WEB_CACHE,{{full:{force}}});delete window.__PULSE_VK_WEB_CACHE;}})();"
    );
    window.eval(script).map_err(|e| e.to_string())
}

fn plan_visibility(session: &mut WebSession, visibility: WindowVisibility) -> VisibilityUpdate {
    session.visibility_revision = session.visibility_revision.wrapping_add(1);
    VisibilityUpdate {
        window_epoch: session.window_epoch,
        revision: session.visibility_revision,
        visibility,
    }
}

fn login_visibility(
    session: &mut WebSession,
    authenticated: bool,
    waiting_login: bool,
) -> Option<VisibilityUpdate> {
    if authenticated {
        if session.window_policy == WindowPolicy::LoginOnly && session.login_window_visible {
            session.login_window_visible = false;
            return Some(plan_visibility(
                session,
                WindowVisibility::Hide { focus_player: true },
            ));
        }
    } else if waiting_login {
        // A manually opened page becomes a login window if its session expires.
        session.window_policy = WindowPolicy::LoginOnly;
        if !session.login_window_visible {
            session.login_window_visible = true;
            return Some(plan_visibility(session, WindowVisibility::Show));
        }
    }
    None
}

fn visibility_is_current(session: &WebSession, update: &VisibilityUpdate) -> bool {
    session.active
        && session.window_epoch == update.window_epoch
        && session.visibility_revision == update.revision
}

fn apply_visibility(app: &AppHandle, update: VisibilityUpdate) {
    let handle = app.clone();
    // Serialize the native operations on the UI thread. A delayed import must
    // never hide a window the user has explicitly opened in the meantime.
    let _ = app.run_on_main_thread(move || {
        let shared = handle.state::<AppState>();
        let current = {
            let session = shared.vk_web.lock().unwrap();
            visibility_is_current(&session, &update)
        };
        if !current {
            return;
        }
        let Some(window) = handle.get_webview_window(LABEL) else {
            return;
        };
        match update.visibility {
            WindowVisibility::Show => {
                let _ = window.show();
                let _ = window.set_focus();
            }
            WindowVisibility::Hide { focus_player } => {
                let _ = window.hide();
                if focus_player {
                    if let Some(player) = handle.get_webview_window("main") {
                        let _ = player.show();
                        let _ = player.unminimize();
                        let _ = player.set_focus();
                    }
                }
            }
        }
    });
}

fn navigation_started(app: &AppHandle, window_epoch: u64, needs_login: bool) {
    let shared = app.state::<AppState>();
    let mut session = shared.vk_web.lock().unwrap();
    if !session.active || session.window_epoch != window_epoch {
        return;
    }
    session.navigation_revision = session.navigation_revision.wrapping_add(1);
    begin_run(&mut session);
    let visibility = if needs_login {
        session.stage = "waiting-login".into();
        session.message =
            "Завершите вход в официальном окне VK. Музыка загрузится автоматически.".into();
        login_visibility(&mut session, false, true)
    } else {
        None
    };
    drop(session);
    if let Some(visibility) = visibility {
        apply_visibility(app, visibility);
    }
    emit_update(app, &shared, false);
}

pub async fn open(app: AppHandle, refresh: bool) -> Result<VkStatus, String> {
    open_with_policy(app, WindowPolicy::LoginOnly, refresh).await
}

pub async fn open_manual(app: AppHandle) -> Result<VkStatus, String> {
    open_with_policy(app, WindowPolicy::Manual, false).await
}

async fn open_with_policy(
    app: AppHandle,
    policy: WindowPolicy,
    refresh: bool,
) -> Result<VkStatus, String> {
    let shared = app.state::<AppState>();
    let _opening = shared.vk_web_open_lock.lock().await;
    remember_enabled(&app, true)?;
    if let Some(window) = app.get_webview_window(LABEL) {
        let (run, visibility, poll_epoch) = {
            let mut session = shared.vk_web.lock().unwrap();
            let was_active = session.active;
            let run = if refresh || !session.active {
                begin_run(&mut session);
                session.force_full = refresh;
                Some(session.run_id.clone())
            } else {
                None
            };
            let visibility = if policy == WindowPolicy::Manual {
                session.window_policy = policy;
                session.login_window_visible = false;
                Some(plan_visibility(&mut session, WindowVisibility::Show))
            } else if session.window_policy == WindowPolicy::Manual {
                // A background refresh does not close a page the user chose
                // to open explicitly for managing their VK collection.
                None
            } else if session.stage == "waiting-login" {
                login_visibility(&mut session, false, true)
            } else {
                None
            };
            let poll_epoch = should_start_poll(was_active, run.is_some()).then_some(session.window_epoch);
            (run, visibility, poll_epoch)
        };
        if let Some(visibility) = visibility {
            apply_visibility(&app, visibility);
        }
        if let Some(run) = run {
            inject(&window, &run)?;
        }
        if let Some(epoch) = poll_epoch {
            start_poll(app.clone(), epoch);
        }
        emit_update(&app, &shared, true);
        return Ok(status(&shared));
    }
    let window_epoch = {
        let mut session = shared.vk_web.lock().unwrap();
        begin_run(&mut session);
        session.force_full = refresh;
        session.window_epoch = session.window_epoch.wrapping_add(1);
        session.window_policy = policy;
        session.login_window_visible = false;
        session.visibility_revision = session.visibility_revision.wrapping_add(1);
        session.window_epoch
    };
    let builder = tauri::WebviewWindowBuilder::new(
        &app,
        LABEL,
        tauri::WebviewUrl::External("https://vk.com/audio".parse().unwrap()),
    )
    .title("VK Музыка · подключение к Pulse")
    .inner_size(1280., 850.)
    // Connecting and restoring stay in the background until VK actually
    // requests login. An existing signed-in session never flashes a VK tab.
    .visible(policy == WindowPolicy::Manual);
    #[cfg(not(target_os = "macos"))]
    let builder = builder
    // A click in Pulse cannot carry its transient browser activation into
    // the separate VK document. Pulse's explicit playback intent owns starts.
    // The audio document is intentionally hidden, even when Pulse is open.
    // Its HLS timers and source renewals must not become background work or
    // wait for the minute-long timer batches of a silent hidden renderer.
    // Extend the existing explicit autoplay arguments only for this separate
    // VK profile; leave the main renderer and browser security policies alone.
    .additional_browser_args("--autoplay-policy=no-user-gesture-required --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows")
    .data_directory(profile_dir(&app));
    #[cfg(target_os = "macos")]
    let builder = builder
        .data_store_identifier(profile_store_identifier(&profile_dir(&app)))
        // macOS 14+ supports an explicit native policy for hidden WKWebViews.
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled);
    let result = builder.on_navigation(crate::allowed_vk)
    .on_page_load(move |window, payload| {
        let app = window.app_handle();
        match payload.event() {
            PageLoadEvent::Started => navigation_started(app, window_epoch, !allowed_origin(payload.url())),
            PageLoadEvent::Finished => {
                let shared = app.state::<AppState>();
                let (run, visibility) = {
                    let mut session = shared.vk_web.lock().unwrap();
                    if !session.active || session.window_epoch != window_epoch {
                        return;
                    }
                    let visibility = if !allowed_origin(payload.url()) {
                        session.stage = "waiting-login".into();
                        session.message = "Завершите вход в официальном окне VK. Музыка загрузится автоматически.".into();
                        login_visibility(&mut session, false, true)
                    } else { None };
                    (Some(session.run_id.clone()), visibility)
                };
                if let Some(visibility) = visibility { apply_visibility(app, visibility); }
                if let Some(run) = run {
                    let _ = inject(&window, &run);
                }
                emit_update(app, &shared, false);
            }
        }
    })
    .build();
    if let Err(error) = result {
        let mut session = shared.vk_web.lock().unwrap();
        session.active = false;
        session.stage = "error".into();
        session.message = error.to_string();
        return Err(error.to_string());
    }
    start_poll(app.clone(), window_epoch);
    emit_update(&app, &shared, true);
    Ok(status(&shared))
}

pub async fn restore_status(app: AppHandle) -> Result<VkStatus, String> {
    let active = app.state::<AppState>().vk_web.lock().unwrap().active;
    if !active && should_restore(&app) {
        return open(app, false).await;
    }
    Ok(status(&app.state::<AppState>()))
}

pub async fn refresh(app: AppHandle) -> Result<Value, String> {
    open(app.clone(), true).await?;
    Ok(update_value(
        &app.state::<AppState>().vk_web.lock().unwrap(),
        None,
    ))
}

pub(crate) async fn evaluate(window: &WebviewWindow, script: String) -> Result<Value, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let sender = Arc::new(Mutex::new(Some(sender)));
    window
        .eval_with_callback(script, move |value| {
            if let Some(sender) = sender.lock().unwrap().take() {
                let _ = sender.send(value);
            }
        })
        .map_err(|error| error.to_string())?;
    let value = tokio::time::timeout(Duration::from_secs(8), receiver)
        .await
        .map_err(|_| "Окно VK не ответило вовремя. Повторите подключение.".to_string())?
        .map_err(|_| "Окно VK закрылось до ответа.".to_string())?;
    if value.len() > MAX_PAYLOAD {
        return Err("Коллекция VK превышает допустимый размер ответа.".into());
    }
    serde_json::from_str(&value).map_err(|_| "Окно VK вернуло некорректные данные.".into())
}

#[derive(Clone, Debug)]
pub(crate) struct UploadGuard {
    pub account_id: i64,
    pub window_epoch: u64,
    navigation_revision: u64,
}

pub(crate) fn upload_guard(app: &AppHandle) -> Result<UploadGuard, String> {
    let shared = app.state::<AppState>();
    if !uses_web(&shared) {
        return Err("Для загрузки файлов подключите аккаунт через окно VK.".into());
    }
    let session = shared.vk_web.lock().unwrap();
    let account_id = user_id(session.user.as_ref())
        .filter(|id| *id > 0)
        .ok_or("Войдите в VK перед загрузкой файлов.")?;
    if !session.active {
        return Err("Войдите в VK перед загрузкой файлов.".into());
    }
    let guard = UploadGuard {
        account_id,
        window_epoch: session.window_epoch,
        navigation_revision: session.navigation_revision,
    };
    drop(session);
    let window = app.get_webview_window(LABEL).ok_or("Окно VK закрыто.")?;
    if !window.url().ok().is_some_and(|url| allowed_origin(&url)) {
        return Err("Завершите вход в официальном окне VK.".into());
    }
    Ok(guard)
}

pub(crate) fn check_upload_guard(app: &AppHandle, guard: &UploadGuard) -> bool {
    upload_guard(app).is_ok_and(|current| {
        current.account_id == guard.account_id
            && current.window_epoch == guard.window_epoch
            && current.navigation_revision == guard.navigation_revision
    })
}

/// A mutation invalidates an in-flight pre-upload snapshot. A normal manual
/// refresh coalesces with that run, so uploads need a new generation instead.
pub(crate) async fn refresh_after_upload(
    app: &AppHandle,
    guard: &UploadGuard,
) -> Result<(), String> {
    let shared = app.state::<AppState>();
    let _opening = shared.vk_web_open_lock.lock().await;
    if !check_upload_guard(app, guard) {
        return Err("Аккаунт VK изменился. Синхронизация загрузки отменена.".into());
    }
    let window = app.get_webview_window(LABEL).ok_or("Окно VK закрыто.")?;
    let run = {
        let mut session = shared.vk_web.lock().unwrap();
        if !session.active
            || session.window_epoch != guard.window_epoch
            || session.navigation_revision != guard.navigation_revision
            || user_id(session.user.as_ref()) != Some(guard.account_id)
        {
            return Err("Аккаунт VK изменился. Синхронизация загрузки отменена.".into());
        }
        begin_run(&mut session);
        session.force_full = true;
        session.run_id.clone()
    };
    inject(&window, &run)?;
    emit_update(app, &shared, true);
    Ok(())
}

fn matching_run(session: &WebSession, epoch: u64, generation: u64, run: &str) -> bool {
    session.active
        && session.window_epoch == epoch
        && session.generation == generation
        && session.run_id == run
}

fn start_poll(app: AppHandle, window_epoch: u64) {
    tauri::async_runtime::spawn(async move {
        let mut absent = 0u32;
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let (generation, run, force) = {
                let shared = app.state::<AppState>();
                let session = shared.vk_web.lock().unwrap();
                if !session.active || session.window_epoch != window_epoch {
                    break;
                }
                (
                    session.generation,
                    session.run_id.clone(),
                    !session.run_committed,
                )
            };
            let Some(window) = app.get_webview_window(LABEL) else {
                break;
            };
            if !window.url().ok().is_some_and(|url| allowed_origin(&url)) {
                continue;
            }
            let run_json = serde_json::to_string(&run).unwrap();
            let script = format!("(()=>{{if(window.top!==window.self||!['https://vk.com','https://vk.ru'].includes(location.origin))return null;const a=window.__PULSE_VK_WEB__;if(!a)return null;return {{snapshot:a.read({force}),playback:a.playback(),command:a.lastCommand,bridgeRunId:{run_json}}};}})()");
            match evaluate(&window, script).await {
                Ok(value) if value.is_object() => {
                    absent = 0;
                    if !window.url().ok().is_some_and(|url| allowed_origin(&url)) {
                        continue;
                    }
                    let shared = app.state::<AppState>();
                    if !matching_run(
                        &shared.vk_web.lock().unwrap(),
                        window_epoch,
                        generation,
                        &run,
                    ) {
                        continue;
                    }
                    if let Err(error) =
                        accept_poll(&app, &shared, window_epoch, generation, &run, &value)
                    {
                        let mut session = shared.vk_web.lock().unwrap();
                        if matching_run(&session, window_epoch, generation, &run) {
                            session.stage = "error".into();
                            session.message = error;
                        }
                    }
                    emit_update(&app, &shared, false);
                }
                _ => {
                    absent = absent.saturating_add(1);
                    if absent % 10 == 0 {
                        let _ = inject(&window, &run);
                    }
                    if absent >= 60 {
                        let shared = app.state::<AppState>();
                        let mut session = shared.vk_web.lock().unwrap();
                        if matching_run(&session, window_epoch, generation, &run) {
                            session.stage = "error".into();
                            session.message = "Не удалось связаться с музыкальной страницей VK. Откройте окно VK и повторите синхронизацию.".into();
                        }
                        drop(session);
                        emit_update(&app, &shared, false);
                    }
                }
            }
        }
    });
}

fn clean_text(value: &str, limit: usize) -> String {
    value
        .chars()
        .filter(|c| !c.is_control())
        .take(limit)
        .collect()
}

fn safe_artwork(value: Option<String>) -> Option<String> {
    value.filter(|text| {
        text.len() <= 4096
            && url::Url::parse(text).ok().is_some_and(|url| {
                url.scheme() == "https"
                    && url.host_str().is_some_and(|host| {
                        host != "localhost"
                            && !host.ends_with(".localhost")
                            && !host.ends_with(".local")
                            && host
                                .trim_matches(['[', ']'])
                                .parse::<std::net::IpAddr>()
                                .is_err()
                    })
                    && url.port_or_known_default() == Some(443)
                    && url.username().is_empty()
                    && url.password().is_none()
            })
    })
}

fn clean_user(value: Option<&Value>) -> Option<Value> {
    let value = value?;
    let id = web_integer(value.get("id")?).filter(|id| *id > 0)?;
    let name = clean_text(
        value.get("name").and_then(Value::as_str).unwrap_or("VK"),
        200,
    );
    let mut user = json!({"id":id, "name": name});
    if let Some(avatar) = safe_artwork(
        value
            .get("avatar")
            .and_then(Value::as_str)
            .map(str::to_owned),
    ) {
        user["avatar"] = json!(avatar);
    }
    Some(user)
}

fn user_id(user: Option<&Value>) -> Option<i64> {
    user.and_then(|user| user.get("id")).and_then(Value::as_i64)
}

// WebView2 can return integral JavaScript numbers above i32 as JSON floats.
// Preserve exact safe integers; do not round malformed identities or dates.
fn web_integer(value: &Value) -> Option<i64> {
    let number = value.as_f64()?;
    (number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0)
        .then_some(number as i64)
}

fn normalize_web_record(raw: &Value, playlist: bool) -> Value {
    let mut value = raw.clone();
    if let Some(object) = value.as_object_mut() {
        if playlist {
            let created = object
                .get("createdAt")
                .and_then(web_integer)
                .filter(|date| (0..=4_102_444_800_000).contains(date))
                .unwrap_or(0);
            object.insert("createdAt".into(), json!(created));
            object.remove("syncedAt");
            if let Some(number) = object
                .get("remoteTrackCount")
                .and_then(web_integer)
                .filter(|number| *number >= 0)
            {
                object.insert("remoteTrackCount".into(), json!(number));
            }
        } else {
            object.remove("addedAt");
        }
        if let Some(remote) = object.get_mut("remote").and_then(Value::as_object_mut) {
            for key in ["ownerId", if playlist { "playlistId" } else { "audioId" }] {
                if let Some(number) = remote.get(key).and_then(web_integer) {
                    remote.insert(key.into(), json!(number));
                }
            }
        }
    }
    value
}

fn validate_snapshot(value: &Value) -> Result<(Vec<Track>, Vec<Playlist>), String> {
    let raw_tracks = value
        .get("tracks")
        .and_then(Value::as_array)
        .filter(|items| items.len() <= MAX_ITEMS)
        .ok_or("VK вернул некорректную коллекцию треков.")?;
    let raw_playlists = value
        .get("playlists")
        .and_then(Value::as_array)
        .filter(|items| items.len() <= MAX_ITEMS)
        .ok_or("VK вернул некорректную коллекцию плейлистов.")?;
    let mut ids = HashSet::new();
    let mut tracks = Vec::with_capacity(raw_tracks.len());
    for raw in raw_tracks {
        let mut track: Track = serde_json::from_value(normalize_web_record(raw, false))
            .map_err(|_| "VK вернул некорректный трек.")?;
        let remote = track
            .remote
            .as_mut()
            .filter(|remote| remote.owner_id != 0 && remote.audio_id > 0)
            .ok_or("У трека VK отсутствует идентификатор.")?;
        let expected_id = format!("vk-{}-{}", remote.owner_id, remote.audio_id);
        let expected_url = format!("vk-web://{}/{}", remote.owner_id, remote.audio_id);
        if track.source != "vk"
            || track.id != expected_id
            || track.url != expected_url
            || !ids.insert(track.id.clone())
        {
            return Err(
                "Коллекция VK содержит повтор или некорректный идентификатор трека.".into(),
            );
        }
        if !track.duration.is_finite() || !(0.0..=864000.0).contains(&track.duration) {
            return Err("VK вернул некорректную длительность трека.".into());
        }
        remote.access_key = None;
        track.title = clean_text(&track.title, 500);
        track.artist = clean_text(&track.artist, 500);
        crate::clean_artist_refs(&mut track.artist_refs);
        crate::clean_track_evidence(&mut track);
        track.album = clean_text(&track.album, 500);
        track.artwork = safe_artwork(track.artwork);
        track.added_at = now();
        tracks.push(track);
    }
    let mut playlists = Vec::with_capacity(raw_playlists.len());
    let mut playlist_ids = HashSet::new();
    for raw in raw_playlists {
        let mut playlist: Playlist = serde_json::from_value(normalize_web_record(raw, true))
            .map_err(|_| "VK вернул некорректный плейлист.")?;
        let remote = playlist
            .remote
            .as_mut()
            .filter(|remote| remote.owner_id != 0 && remote.playlist_id >= 0)
            .ok_or("У плейлиста VK отсутствует идентификатор.")?;
        if playlist.id != format!("vk-playlist-{}-{}", remote.owner_id, remote.playlist_id)
            || !playlist_ids.insert(playlist.id.clone())
            || playlist.track_ids.len() > MAX_ITEMS
        {
            return Err("VK вернул повтор или некорректный идентификатор плейлиста.".into());
        }
        if playlist.track_ids.iter().any(|id| !ids.contains(id)) {
            return Err(
                "Состав плейлиста VK прочитан не полностью. Предыдущая коллекция сохранена.".into(),
            );
        }
        remote.access_key = None;
        playlist.title = clean_text(&playlist.title, 500);
        playlist.description = clean_text(&playlist.description, 2000);
        playlist.artwork = safe_artwork(playlist.artwork);
        playlist.synced_at = Some(now());
        if playlist.content_unavailable {
            if !playlist.track_ids.is_empty()
                || playlist
                    .remote_track_count
                    .is_some_and(|count| count > MAX_ITEMS as u64)
            {
                return Err("VK вернул противоречивые данные недоступного плейлиста.".into());
            }
        } else {
            playlist.remote_track_count = None;
        }
        playlists.push(playlist);
    }
    Ok((tracks, playlists))
}

fn merge_snapshot(
    state: &mut PersistedState,
    tracks: &[Track],
    playlists: &[Playlist],
) -> Result<(), String> {
    let local_count = state
        .tracks
        .iter()
        .filter(|track| track.source != "vk")
        .count();
    let local_playlists = state
        .playlists
        .iter()
        .filter(|playlist| playlist.remote.is_none())
        .count();
    if local_count + tracks.len() > MAX_ITEMS || local_playlists + playlists.len() > MAX_ITEMS {
        return Err(
            "Библиотека превышает 100 000 элементов. Предыдущая коллекция сохранена.".into(),
        );
    }
    let added: HashMap<_, _> = state
        .tracks
        .iter()
        .map(|track| (track.id.clone(), track.added_at))
        .collect();
    let incoming: HashSet<_> = tracks.iter().map(|track| track.id.as_str()).collect();
    let searched: HashSet<_> = state.tracks.iter()
        .filter(|track| track.remote.as_ref().is_some_and(|r| r.search_result && !r.in_library))
        .map(|track| track.id.clone()).collect();
    // The latest search remains visible independently of this snapshot. Keep
    // its native registry until the next search, which expires unpinned rows.
    let retained_search_count = state.tracks.iter().filter(|track|
        track.source == "vk" && track.remote.as_ref().is_some_and(|r| r.search_result && !r.in_library)
            && !incoming.contains(track.id.as_str())).count();
    if local_count + tracks.len() + retained_search_count > MAX_ITEMS {
        return Err("Библиотека превышает 100 000 элементов. Предыдущая коллекция сохранена.".into());
    }
    state.tracks.retain(|track| track.source != "vk"
        || (track.remote.as_ref().is_some_and(|r| r.search_result && !r.in_library) && !incoming.contains(track.id.as_str())));
    state.tracks.extend(tracks.iter().cloned().map(|mut track| {
        if let Some(date) = added.get(&track.id) {
            track.added_at = *date;
        }
        if let Some(remote) = track.remote.as_mut() {
            if !remote.in_library && searched.contains(&track.id) { remote.search_result = true; }
        }
        track
    }));
    state.playlists.retain(|playlist| playlist.remote.is_none());
    state.playlists.extend_from_slice(playlists);
    prune_references(state);
    Ok(())
}

fn prune_references(state: &mut PersistedState) {
    let ids: HashSet<_> = state.tracks.iter().map(|track| track.id.clone()).collect();
    state.queue.retain(|id| ids.contains(id));
    state.history.retain(|id| ids.contains(id));
    for playlist in &mut state.playlists {
        playlist.track_ids.retain(|id| ids.contains(id));
    }
    if state
        .current_track_id
        .as_ref()
        .is_some_and(|id| !ids.contains(id))
    {
        state.current_track_id = None;
        state.position = 0.0;
    }
}

fn purge_vk(shared: &AppState, app: &AppHandle) -> Result<(), String> {
    let previous = shared.state.lock().unwrap().clone();
    {
        let mut state = shared.state.lock().unwrap();
        state.tracks.retain(|track| track.source != "vk");
        state.playlists.retain(|playlist| playlist.remote.is_none());
        prune_references(&mut state);
    }
    if let Err(error) = save_locked(app, shared) {
        *shared.state.lock().unwrap() = previous;
        return Err(error);
    }
    Ok(())
}

fn substantive_state(value: &PersistedState) -> Value {
    let mut value = serde_json::to_value(value).unwrap_or(Value::Null);
    if let Some(playlists) = value.get_mut("playlists").and_then(Value::as_array_mut) {
        for playlist in playlists {
            if let Some(item) = playlist.as_object_mut() { item.remove("syncedAt"); }
        }
    }
    value
}

fn accept_poll(
    app: &AppHandle,
    shared: &AppState,
    epoch: u64,
    generation: u64,
    run: &str,
    value: &Value,
) -> Result<(), String> {
    let snapshot = value
        .get("snapshot")
        .filter(|snapshot| snapshot.is_object())
        .ok_or("Состояние импорта VK не получено.")?;
    if snapshot.get("runId").and_then(Value::as_str) != Some(run) {
        return Ok(());
    }
    let stage = snapshot
        .get("status")
        .and_then(Value::as_str)
        .filter(|stage| matches!(*stage, "waiting-login" | "syncing" | "complete" | "error"))
        .ok_or("VK вернул неизвестное состояние импорта.")?;
    let user = clean_user(snapshot.get("user"));
    let new_user = user_id(user.as_ref());
    if matches!(stage, "syncing" | "complete") && new_user.is_none() {
        return Err("VK не подтвердил аккаунт. Откройте окно входа.".into());
    }
    let complete = stage == "complete" && snapshot.get("complete") == Some(&Value::Bool(true));
    let visibility = {
        let mut session = shared.vk_web.lock().unwrap();
        if !matching_run(&session, epoch, generation, run) {
            return Ok(());
        }
        // Authentication is independent of import success. Once VK confirms
        // the account, close login UI even if a playlist fails or loads slowly.
        login_visibility(&mut session, new_user.is_some(), stage == "waiting-login")
    };
    if let Some(visibility) = visibility {
        apply_visibility(app, visibility);
    }
    let _storage = shared.storage_lock.lock().unwrap();
    let mut session = shared.vk_web.lock().unwrap();
    if !matching_run(&session, epoch, generation, run) {
        return Ok(());
    }
    let has_remote_cache = {
        let state = shared.state.lock().unwrap();
        state.tracks.iter().any(|track| track.source == "vk")
            || state
                .playlists
                .iter()
                .any(|playlist| playlist.remote.is_some())
    };
    let previous_user = user_id(session.user.as_ref())
        .or_else(|| stored_session(app).and_then(|session| session.account_id));
    if account_requires_clear(previous_user, new_user, has_remote_cache) {
        // An account switch must not leave the previous user's metadata or
        // playback references visible, even if the next full import fails.
        purge_vk(shared, app)?;
        remember_account(app, None);
        session.user = user.clone();
        session.committed = false;
        session.run_committed = false;
        session.synced_at = None;
        let mut cleared = update_value(&session, None);
        cleared["clearRemote"] = json!(true);
        let _ = app.emit_to("main", "vk:web-update", cleared);
    }
    if new_user.is_some() { session.user = user; }
    else { session.user = None; session.committed = false; }
    // A warm catalog is immediately usable once the same live account is
    // confirmed. Importing changed playlists does not gate authentication or
    // erase the last successful on-disk library.
    if new_user.is_some() && previous_user == new_user && has_remote_cache {
        session.committed = true;
    }
    let data = if complete {
        Some(validate_snapshot(snapshot)?)
    } else {
        None
    };
    session.stage = stage.into();
    session.message = clean_text(
        snapshot
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Читаем музыку VK…"),
        2000,
    );
    session.progress = snapshot.get("progress").and_then(|progress| {
        Some(json!({
            "phase": clean_text(progress.get("phase")?.as_str()?, 80),
            "tracks": progress.get("tracks")?.as_u64()?.min(MAX_ITEMS as u64),
            "playlists": progress.get("playlists")?.as_u64()?.min(MAX_ITEMS as u64),
            "completedPlaylists": progress.get("completedPlaylists")?.as_u64()?.min(MAX_ITEMS as u64),
        }))
    });
    if let Some((tracks, playlists)) = data {
        let previous = shared.state.lock().unwrap().clone();
        merge_snapshot(&mut shared.state.lock().unwrap(), &tracks, &playlists)?;
        let changed = substantive_state(&previous) != substantive_state(&shared.state.lock().unwrap());
        if changed {
            if let Err(error) = save_locked(app, shared) {
                *shared.state.lock().unwrap() = previous;
                return Err(error);
            }
        }
        session.committed = true;
        session.run_committed = true;
        session.synced_at = Some(now());
        remember_account(app, user_id(session.user.as_ref()));
        let index = clean_cache_index(snapshot.get("cacheIndex"), new_user.unwrap());
        let _ = crate::write_json(&cache_index_path(app), &index, false);
        session.message = format!(
            "Синхронизировано: {} треков и {} плейлистов.",
            tracks.len(),
            playlists.len()
        );
        let unavailable = playlists
            .iter()
            .filter(|playlist| playlist.content_unavailable)
            .count();
        if unavailable > 0 {
            session.message = format!("Импортировано: {} доступных треков и {} плейлистов. VK ограничил содержимое плейлистов: {}.", tracks.len(), playlists.len(), unavailable);
        }
        let event = if changed {
            json!({"status":web_status(&session),"tracks":tracks,"playlists":playlists,"complete":true,"syncedAt":session.synced_at,"progress":session.progress,"mode":"web"})
        } else {
            json!({"status":web_status(&session),"tracks":[],"playlists":[],"complete":false,"unchanged":true,"syncedAt":session.synced_at,"mode":"web"})
        };
        let _ = app.emit_to("main", "vk:web-update", event);
    }
    let playback = validate_playback(value.get("playback"), run, &shared.state.lock().unwrap());
    drop(session);
    drop(_storage);
    if let Some(playback) = playback {
        let _ = app.emit_to("main", "vk:web-playback", playback);
    }
    Ok(())
}

fn account_requires_clear(previous: Option<i64>, current: Option<i64>, has_cache: bool) -> bool {
    // No identity can mean page readiness or a temporary offline login check.
    // Keep the last catalog browsable, but never enable account controls until
    // the live account is confirmed. Explicit Disconnect purges separately.
    current.is_some() && has_cache && previous != current
}

fn sanitized_buffered_ranges(value: Option<&Value>, duration: f64) -> Vec<[f64; 2]> {
    let mut ranges: Vec<[f64; 2]> = value.and_then(Value::as_array).into_iter().flatten().take(64)
        .filter_map(|range| {
            let range = range.as_array()?;
            let start = range.first()?.as_f64()?;
            let end = range.get(1)?.as_f64()?;
            if !start.is_finite() || !end.is_finite() { return None; }
            let start = start.clamp(0.0, duration);
            let end = end.clamp(0.0, duration);
            (end > start).then_some([start, end])
        }).collect();
    ranges.sort_by(|left, right| left[0].total_cmp(&right[0]));
    let mut result: Vec<[f64; 2]> = Vec::with_capacity(ranges.len());
    for range in ranges {
        if let Some(last) = result.last_mut().filter(|last| range[0] <= last[1]) {
            last[1] = last[1].max(range[1]);
        } else { result.push(range); }
    }
    result
}

fn validate_playback(value: Option<&Value>, run: &str, state: &PersistedState) -> Option<Value> {
    let value = value?;
    if value.get("runId")?.as_str()? != run {
        return None;
    }
    let id = value.get("id").and_then(Value::as_str).filter(|id| {
        state
            .tracks
            .iter()
            .any(|track| track.id == *id && track.source == "vk" && valid_web_track(track))
    });
    let requested_id = value
        .get("requestedId")
        .and_then(Value::as_str)
        .filter(|id| {
            state
                .tracks
                .iter()
                .any(|track| track.id == *id && valid_web_track(track))
        });
    let position = value
        .get("position")?
        .as_f64()
        .filter(|n| n.is_finite() && (0.0..=864000.0).contains(n))?;
    let duration = value
        .get("duration")?
        .as_f64()
        .filter(|n| n.is_finite() && (0.0..=864000.0).contains(n))?;
    let buffered = sanitized_buffered_ranges(value.get("buffered"), duration);
    let buffered_ahead = buffered.iter().find(|range| range[0] <= position + 0.05 && range[1] > position)
        .map_or(0.0, |range| (range[1] - position).max(0.0));
    let network = value.get("network").and_then(Value::as_str)
        .filter(|value| matches!(*value, "idle" | "loading" | "ready" | "stalled" | "offline" | "recovering" | "error"))
        .unwrap_or("idle");
    Some(
        json!({"id":id,"requestedId":requested_id,"playing":id.is_some() && value.get("playing")?.as_bool()?,"buffering":value.get("buffering")?.as_bool()?,"recovering":value.get("recovering").and_then(Value::as_bool).unwrap_or(false),"seeking":value.get("seeking").and_then(Value::as_bool).unwrap_or(false),"advertising":value.get("advertising").and_then(Value::as_bool).unwrap_or(false),"position":position,"duration":duration,"buffered":buffered,"bufferedAhead":buffered_ahead,"network":network,"error":value.get("error").and_then(Value::as_str).map(|error| clean_text(error, 2000)),"ended":value.get("ended")?.as_bool()?,"runId":run,"equalizerEnabled":value.get("equalizerEnabled").and_then(Value::as_bool).unwrap_or(false),"equalizerError":value.get("equalizerError").and_then(Value::as_str).map(|error| clean_text(error, 500))}),
    )
}

pub fn valid_web_track(track: &Track) -> bool {
    track.source == "vk"
        && track.remote.as_ref().is_some_and(|remote| {
            remote.owner_id != 0
                && remote.audio_id > 0
                && track.id == format!("vk-{}-{}", remote.owner_id, remote.audio_id)
                && track.url == format!("vk-web://{}/{}", remote.owner_id, remote.audio_id)
        })
}

#[tauri::command]
pub async fn vk_web_control(
    app: AppHandle,
    operation: String,
    id: Option<String>,
    position: Option<f64>,
    volume: Option<f64>,
    equalizer: Option<crate::equalizer::EqualizerSettings>,
) -> Result<Value, String> {
    if !matches!(
        operation.as_str(),
        "play" | "pause" | "resume" | "seek" | "volume" | "stop" | "equalizer"
    ) {
        return Err("Неизвестная команда плеера VK.".into());
    }
    if position.is_some_and(|n| !n.is_finite() || !(0.0..=864000.0).contains(&n))
        || volume.is_some_and(|n| !n.is_finite() || !(0.0..=1.0).contains(&n))
    {
        return Err("Некорректный параметр воспроизведения VK.".into());
    }
    let equalizer = if operation == "equalizer" {
        let mut value = equalizer.ok_or("Не заданы настройки эквалайзера.")?;
        value.sanitize();
        Some(value)
    } else { None };
    let shared = app.state::<AppState>();
    let (epoch, navigation_revision, account) = {
        let session = shared.vk_web.lock().unwrap();
        if !session.active || session.user.is_none() {
            return Err("Подключите аккаунт VK для воспроизведения.".into());
        }
        (
            session.window_epoch,
            session.navigation_revision,
            user_id(session.user.as_ref()).unwrap(),
        )
    };
    let cached_track = if operation == "play" {
        let found = shared.state.lock().unwrap().tracks.iter().find(|track| {
            Some(track.id.as_str()) == id.as_deref() && track.available && valid_web_track(track)
        }).cloned().ok_or("Трек не принадлежит синхронизированной коллекции VK.")?;
        // A bounded website search cache may evict an older queued result.
        // Send only the native validated record so its exact identity can be
        // resolved again without keeping every search tuple for the session.
        Some(found)
    } else { None };
    let window = app
        .get_webview_window(LABEL)
        .ok_or("Окно VK закрыто. Подключите аккаунт ещё раз.")?;
    if !window.url().ok().is_some_and(|url| allowed_origin(&url)) {
        return Err("Завершите вход в VK в официальном окне.".into());
    }
    let request_id = random_id();
    let request = json!({"operation":operation,"id":id,"position":position,"volume":volume,"equalizer":equalizer,"requestId":request_id,"cachedTrack":cached_track});
    // Keep the individual receipt: another volume/seek command can replace
    // lastCommand while a previous play() promise is still resolving.
    let receipt_key = serde_json::to_string(&format!("__PULSE_RECEIPT_{request_id}")).unwrap();
    let check = format!("if(window.top!==window.self||!['https://vk.com','https://vk.ru'].includes(location.origin))return {{accepted:false,error:'Страница VK изменилась.'}};const a=window.__PULSE_VK_WEB__;if(!a)return {{accepted:false,error:'Плеер VK недоступен.'}};if(a.accountId!=={account})return {{accepted:false,error:'Аккаунт VK изменился.'}};");
    let script = format!("(()=>{{{check}return window[{receipt_key}]=a.command({request});}})()");
    let outcome = async {
        let mut result = evaluate(&window, script).await?;
        // Direct transport bounds resolver (20s), load (25s), play (25s)
        // sequentially. Keep the receipt alive until those stages can finish.
        let timeout = if matches!(operation.as_str(), "play" | "resume") { 75 } else { 15 };
        let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout);
        loop {
            let valid_session = {
                let session = shared.vk_web.lock().unwrap();
                session.active && session.window_epoch == epoch && session.navigation_revision == navigation_revision
                    && user_id(session.user.as_ref()) == Some(account)
            };
            if !valid_session || !window.url().ok().is_some_and(|url| allowed_origin(&url)) {
                return Err("Сеанс VK изменился. Команда отменена.".to_string());
            }
            if result.get("accepted") != Some(&Value::Bool(true)) {
                return Err(clean_text(result.get("error").and_then(Value::as_str).unwrap_or("VK не подтвердил команду воспроизведения."), 2000));
            }
            if result.get("pending") != Some(&Value::Bool(true)) { return Ok(result); }
            if tokio::time::Instant::now() >= deadline {
                if matches!(operation.as_str(), "play" | "resume") {
                    let _ = window.eval(format!("(()=>{{{check}a.command({{operation:'pause'}});}})()"));
                }
                return Err("VK не подтвердил команду воспроизведения. Повторите попытку.".into());
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
            result = evaluate(&window, format!("(()=>{{{check}return window[{receipt_key}]||{{accepted:false,error:'Команда отменена.'}};}})()")).await?;
        }
    }.await;
    let _ = window.eval(format!("delete window[{receipt_key}];"));
    outcome
}

pub async fn disconnect(app: AppHandle) -> Result<VkStatus, String> {
    let shared = app.state::<AppState>();
    let _opening = shared.vk_web_open_lock.lock().await;
    {
        let _storage = shared.storage_lock.lock().unwrap();
        let mut session = shared.vk_web.lock().unwrap();
        session.active = false;
        session.generation = session.generation.wrapping_add(1);
        session.window_epoch = session.window_epoch.wrapping_add(1);
        session.run_id.clear();
        session.user = None;
        session.progress = None;
        session.committed = false;
        session.run_committed = false;
        session.synced_at = None;
        session.stage = "disconnected".into();
        session.message = "Аккаунт VK отключён, его музыкальный кэш удалён.".into();
        // Start the next login with a separate profile even if WebView2's
        // asynchronous clear operation fails or is interrupted at shutdown.
        crate::write_json(
            &session_path(&app),
            &json!({"enabled":false,"profileId":random_id()}),
            false,
        )?;
        purge_vk(&shared, &app)?;
    }
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.eval("window.__PULSE_VK_WEB__?.command({operation:'stop'});");
        // Best effort cleanup. The rotated profile above is the guarantee
        // that a later Connect cannot silently reuse the disconnected user.
        let _ = window.clear_all_browsing_data();
        let _ = window.destroy();
    }
    emit_update(&app, &shared, true);
    Ok(status(&shared))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn buffered_ranges_keep_gaps_and_reject_unbounded_or_malformed_values() {
        assert_eq!(sanitized_buffered_ranges(Some(&json!([[60,80],[-10,20],[18,25],[95,200],[4,3],["x",40]])), 100.0), vec![[0.0,25.0],[60.0,80.0],[95.0,100.0]]);
        assert!(sanitized_buffered_ranges(Some(&json!([[0,20]])), 0.0).is_empty());
        assert!(sanitized_buffered_ranges(None, 20.0).is_empty());
    }
    fn track(owner: i64, audio: i64) -> Value {
        json!({"id":format!("vk-{owner}-{audio}"),"source":"vk","url":format!("vk-web://{owner}/{audio}"),"title":"Song","duration":12,"remote":{"ownerId":owner,"audioId":audio,"inLibrary":true}})
    }
    #[test]
    fn wkwebview_store_identity_is_stable_and_rotates_with_the_vk_profile() {
        let profile = std::path::Path::new("profile/vk-webview-aabbcc");
        assert_eq!(profile_store_identifier(profile), profile_store_identifier(profile));
        assert_ne!(profile_store_identifier(profile), profile_store_identifier(std::path::Path::new("profile/vk-webview-dd1122")));
    }
    #[test]
    fn bridge_origin_excludes_auth_subdomains_ports_and_lookalikes() {
        for url in ["https://vk.com/audio", "https://vk.ru/audio"] {
            assert!(allowed_origin(&url.parse().unwrap()));
        }
        for url in [
            "http://vk.com/audio",
            "https://id.vk.ru/",
            "https://m.vk.com/",
            "https://vk.com.evil.test/",
            "https://vk.com:444/",
            "https://user@vk.com/",
        ] {
            assert!(!allowed_origin(&url.parse().unwrap()), "{url}");
        }
    }
    #[test]
    fn snapshot_rejects_forged_urls_duplicates_and_missing_playlist_tracks() {
        let mut value = json!({"tracks":[track(1,2)],"playlists":[]});
        assert!(validate_snapshot(&value).is_ok());
        value["tracks"][0]["url"] = json!("file:///C:/private.mp3");
        assert!(validate_snapshot(&value).is_err());
        value["tracks"] = json!([track(1, 2), track(1, 2)]);
        assert!(validate_snapshot(&value).is_err());
        value["tracks"] = json!([track(1, 2)]);
        value["playlists"] = json!([{"id":"vk-playlist-1-3","remote":{"ownerId":1,"playlistId":3},"trackIds":["vk-1-999"]}]);
        assert!(validate_snapshot(&value).is_err());
    }
    #[test]
    fn webview_integral_float_timestamps_and_large_owner_ids_are_accepted() {
        let owner = 3_123_456_789i64;
        let mut raw = track(owner, 2);
        raw["addedAt"] = json!(1_792_500_000_000.0);
        raw["remote"]["ownerId"] = json!(owner as f64);
        let value = json!({"tracks":[raw],"playlists":[{
            "id":format!("vk-playlist-{owner}-3"), "remote":{"ownerId":owner as f64,"playlistId":3},
            "trackIds":[format!("vk-{owner}-2")], "createdAt":1_700_000_000_000.0, "syncedAt":1_792_500_000_000.0
        }]});
        let (tracks, playlists) = validate_snapshot(&value).unwrap();
        assert_eq!(tracks[0].remote.as_ref().unwrap().owner_id, owner);
        assert_eq!(playlists[0].created_at, 1_700_000_000_000);
        assert!(playlists[0].synced_at.is_some());
        assert_eq!(
            clean_user(Some(&json!({"id":owner as f64}))).unwrap()["id"],
            owner
        );
        assert_eq!(web_integer(&json!(1.5)), None);
    }
    #[test]
    fn native_registry_validator_requires_matching_remote_identity() {
        let (tracks, _) =
            validate_snapshot(&json!({"tracks":[track(-123,4)],"playlists":[]})).unwrap();
        assert!(valid_web_track(&tracks[0]));
        let mut forged = tracks[0].clone();
        forged.id = "vk-5-6".into();
        assert!(!valid_web_track(&forged));
        forged = tracks[0].clone();
        forged.remote = None;
        assert!(!valid_web_track(&forged));
    }
    #[test]
    fn restricted_playlist_is_explicit_and_cannot_hide_a_nonempty_composition() {
        let mut value = json!({"tracks":[track(1,2)],"playlists":[{
            "id":"vk-playlist-1-3", "remote":{"ownerId":1,"playlistId":3},
            "trackIds":[], "contentUnavailable":true,"remoteTrackCount":159
        }]});
        let (_, playlists) = validate_snapshot(&value).unwrap();
        assert!(playlists[0].content_unavailable);
        assert_eq!(playlists[0].remote_track_count, Some(159));
        value["playlists"][0]["trackIds"] = json!(["vk-1-2"]);
        assert!(validate_snapshot(&value).is_err());
        value["playlists"][0]["contentUnavailable"] = json!(false);
        let (_, playlists) = validate_snapshot(&value).unwrap();
        assert!(playlists[0].remote_track_count.is_none());
    }
    #[test]
    fn logout_and_navigation_invalidate_delayed_callback() {
        let mut session = WebSession::default();
        begin_run(&mut session);
        session.window_epoch = 1;
        let generation = session.generation;
        let run = session.run_id.clone();
        assert!(matching_run(&session, 1, generation, &run));
        begin_run(&mut session);
        assert!(!matching_run(&session, 1, generation, &run));
        let generation = session.generation;
        let run = session.run_id.clone();
        session.active = false;
        assert!(!matching_run(&session, 1, generation, &run));
    }
    #[test]
    fn login_window_only_appears_when_needed_and_hides_before_import_finishes() {
        let mut session = WebSession::default();
        begin_run(&mut session);
        assert!(login_visibility(&mut session, true, false).is_none());
        assert!(login_visibility(&mut session, false, false).is_none());
        let show = login_visibility(&mut session, false, true).unwrap();
        assert_eq!(show.visibility, WindowVisibility::Show);
        assert!(session.login_window_visible);
        assert!(login_visibility(&mut session, false, true).is_none());
        // The first authenticated snapshot is syncing, not complete.
        let hide = login_visibility(&mut session, true, false).unwrap();
        assert_eq!(
            hide.visibility,
            WindowVisibility::Hide { focus_player: true }
        );
        assert!(!session.login_window_visible);
        assert!(!session.committed);
        // Later errors or progress must not reopen an authenticated window.
        assert!(login_visibility(&mut session, true, false).is_none());
        assert!(login_visibility(&mut session, false, false).is_none());
    }
    #[test]
    fn manually_opened_vk_stays_visible_until_it_needs_login() {
        let mut session = WebSession {
            window_policy: WindowPolicy::Manual,
            ..Default::default()
        };
        begin_run(&mut session);
        assert!(login_visibility(&mut session, true, false).is_none());
        let show = login_visibility(&mut session, false, true).unwrap();
        assert_eq!(show.visibility, WindowVisibility::Show);
        assert!(session.window_policy == WindowPolicy::LoginOnly);
        assert_eq!(
            login_visibility(&mut session, true, false)
                .unwrap()
                .visibility,
            WindowVisibility::Hide { focus_player: true }
        );
    }
    #[test]
    fn delayed_hide_cannot_close_a_newly_opened_or_replaced_vk_window() {
        let mut session = WebSession::default();
        begin_run(&mut session);
        session.window_epoch = 3;
        login_visibility(&mut session, false, true).unwrap();
        let hide = login_visibility(&mut session, true, false).unwrap();
        assert!(visibility_is_current(&session, &hide));
        session.window_policy = WindowPolicy::Manual;
        let show = plan_visibility(&mut session, WindowVisibility::Show);
        assert!(!visibility_is_current(&session, &hide));
        assert!(visibility_is_current(&session, &show));
        session.window_epoch += 1;
        assert!(!visibility_is_current(&session, &show));
        session.window_epoch = show.window_epoch;
        session.active = false;
        assert!(!visibility_is_current(&session, &show));
    }
    #[test]
    fn account_change_or_unconfirmed_restored_account_requires_cache_clear() {
        assert!(account_requires_clear(Some(1), Some(2), true));
        assert!(!account_requires_clear(Some(1), None, true));
        assert!(!account_requires_clear(None, None, true));
        assert!(!account_requires_clear(Some(1), Some(1), true));
        assert!(!account_requires_clear(None, None, false));
        assert!(account_requires_clear(None, Some(2), true));
    }

    #[test]
    fn restored_existing_vk_window_restarts_polling_when_a_new_run_begins() {
        assert!(should_start_poll(false, true), "restored idle window must get a poller");
        assert!(!should_start_poll(true, true), "an active window already has a poller");
        assert!(!should_start_poll(false, false), "a run that did not start must not spawn polling");
    }
    #[test]
    fn refresh_keeps_connected_status_but_reads_full_new_snapshot() {
        let mut session = WebSession {
            active: true,
            committed: true,
            run_committed: true,
            stage: "complete".into(),
            user: Some(json!({"id":1})),
            ..Default::default()
        };
        begin_run(&mut session);
        assert!(session.committed);
        assert!(!session.run_committed);
        assert_eq!(web_status(&session).state, "connected");
    }
    #[test]
    fn cache_index_only_retains_bounded_public_revision_metadata() {
        let index = clean_cache_index(Some(&json!({
            "vk-playlist-1-2":{"fingerprint":"[2,123]","checkedAt":now(),"accessHash":"private"},
            "bad":{"fingerprint":"x","checkedAt":now()},
            "vk-playlist-1-3":{"fingerprint":"x","checkedAt":now()+120_000}
        })), 1);
        assert_eq!(index["accountId"], 1);
        assert_eq!(index["playlists"].as_object().unwrap().len(), 1);
        assert!(index.to_string().find("private").is_none());
    }
    #[test]
    fn playlist_check_time_alone_is_not_a_catalog_change() {
        let mut before = crate::defaults();
        before.playlists.push(Playlist { id:"p".into(), synced_at:Some(1), ..Default::default() });
        let mut after = before.clone();
        after.playlists[0].synced_at = Some(2);
        assert_eq!(substantive_state(&before), substantive_state(&after));
        after.playlists[0].title = "Renamed".into();
        assert_ne!(substantive_state(&before), substantive_state(&after));
    }
    #[test]
    fn background_sync_keeps_visible_search_results_but_does_not_resurrect_deleted_library_tracks() {
        let (mut tracks, _) = validate_snapshot(&json!({"tracks":[track(1,2),track(1,3),track(1,4)],"playlists":[]})).unwrap();
        for item in &mut tracks { item.remote.as_mut().unwrap().search_result = true; }
        tracks[2].remote.as_mut().unwrap().in_library = true;
        tracks[0].remote.as_mut().unwrap().in_library = false;
        tracks[1].remote.as_mut().unwrap().in_library = false;
        let mut state = crate::defaults();
        state.tracks = tracks;
        state.current_track_id = Some("vk-1-2".into());
        // vk-1-3 is displayed in global search but not yet queued or played.
        merge_snapshot(&mut state, &[], &[]).unwrap();
        assert_eq!(state.tracks.iter().map(|t|t.id.as_str()).collect::<Vec<_>>(), vec!["vk-1-2","vk-1-3"]);
        let (mut playlist_only, _) = validate_snapshot(&json!({"tracks":[track(1,3)],"playlists":[]})).unwrap();
        playlist_only[0].remote.as_mut().unwrap().in_library = false;
        merge_snapshot(&mut state, &playlist_only, &[]).unwrap();
        merge_snapshot(&mut state, &[], &[]).unwrap();
        assert!(state.tracks.iter().any(|t| t.id == "vk-1-3"), "A playlist-only result must survive a later removal of its source playlist");
    }
    #[test]
    fn restricted_tracks_remain_unavailable_and_secrets_are_discarded() {
        let mut raw = track(1, 2);
        raw["available"] = json!(false);
        raw["remote"]["accessKey"] = json!("opaque-site-key");
        let (tracks, _) = validate_snapshot(&json!({"tracks":[raw],"playlists":[]})).unwrap();
        assert!(!tracks[0].available);
        assert!(tracks[0].remote.as_ref().unwrap().access_key.is_none());
    }
    #[test]
    fn authoritative_merge_preserves_local_data_and_prunes_deleted_references() {
        let mut state = crate::defaults();
        let mut local = Track::default();
        local.id = "local-one".into();
        local.source = "local".into();
        let (remote, _) =
            validate_snapshot(&json!({"tracks":[track(1,2)],"playlists":[]})).unwrap();
        state.tracks = vec![local, remote[0].clone()];
        state.queue = vec!["local-one".into(), "vk-1-2".into()];
        state.current_track_id = Some("vk-1-2".into());
        state.playlists.push(Playlist {
            id: "local-list".into(),
            track_ids: state.queue.clone(),
            ..Default::default()
        });
        merge_snapshot(&mut state, &[], &[]).unwrap();
        assert_eq!(state.tracks.len(), 1);
        assert_eq!(state.playlists[0].track_ids, vec!["local-one"]);
        assert!(state.current_track_id.is_none());
    }
    #[test]
    fn playback_event_cannot_reference_unregistered_track_or_infinite_positions() {
        let (tracks, _) =
            validate_snapshot(&json!({"tracks":[track(1,2)],"playlists":[]})).unwrap();
        let mut state = crate::defaults();
        state.tracks = tracks;
        let mut value = json!({"runId":"r","id":"vk-1-2","playing":true,"buffering":false,"position":1,"duration":12,"ended":false});
        assert_eq!(
            validate_playback(Some(&value), "r", &state).unwrap()["id"],
            "vk-1-2"
        );
        assert!(validate_playback(Some(&value), "old", &state).is_none());
        value["id"] = json!("local-one");
        assert!(validate_playback(Some(&value), "r", &state).unwrap()["id"].is_null());
        value["position"] = json!(-1);
        assert!(validate_playback(Some(&value), "r", &state).is_none());
    }
}
