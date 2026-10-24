//! OS startup registration is authoritative. There is no persisted enabled flag
//! to restore over a user's later choice in Windows/macOS settings.
use serde::{Deserialize, Serialize};
use std::{fs::{self, OpenOptions}, io::Write, path::{Path, PathBuf}, sync::Mutex};
use tauri::{AppHandle, Manager};

const MARKER: &str = "autostart-migration-v1.json";
#[cfg(windows)]
const ENTRY_NAME: &str = "Pulse for VK";
const UNAVAILABLE: &str = "Автозапуск доступен в установленной версии Pulse. В тестовой сборке системные настройки не изменяются.";
const CHECK_ERROR: &str = "Не удалось прочитать системный автозапуск. Проверьте разрешения Windows или macOS и повторите проверку.";
const CHANGE_ERROR: &str = "Система не разрешила изменить автозапуск Pulse. Проверьте разрешения и повторите действие.";
const MAC_CHANGE_ERROR: &str = "macOS не разрешила автозапуск Pulse. Проверьте «Основные → Объекты входа». В неподписанной preview-сборке регистрация может быть недоступна.";

#[derive(Default)]
pub struct AutostartState { lock: Mutex<()>, notice: Mutex<Option<String>> }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutostartStatus { supported: bool, enabled: bool, requires_approval: bool, message: String }
#[derive(Default)]
struct NativeStatus { enabled: bool, registered: bool, user_disabled: bool, requires_approval: bool, stale_path: bool }
trait StartupBackend { fn status(&self) -> Result<NativeStatus, String>; fn set(&self, enabled: bool) -> Result<(), String>; }
struct NativeStartup { executable: PathBuf }

#[derive(Serialize, Deserialize, Default)]
struct Migration { schema: u32, #[serde(default)] error: Option<String> }
fn allowed_build(identifier: &str, debug: bool, dev: bool, qa: bool) -> bool {
    identifier == "ru.vkplayer.desktop" && !debug && !dev && !qa
}
fn supported(app: &AppHandle) -> bool {
    if !cfg!(any(windows, target_os = "macos")) || !allowed_build(&app.config().identifier, cfg!(debug_assertions), tauri::is_dev(), std::env::var_os("VK_PLAYER_QA_PROFILE").is_some() || std::env::var_os("VK_PLAYER_QA_FILES").is_some()) { return false; }
    #[cfg(target_os = "macos")]
    {
        let Ok(path) = std::env::current_exe() else { return false; };
        // A DMG/translocated preview is not a stable installed login target.
        return path.ancestors().any(|p| p.extension().is_some_and(|v| v == "app")) && !path.starts_with("/Volumes") && !path.to_string_lossy().contains("/AppTranslocation/");
    }
    #[cfg(not(target_os = "macos"))]
    true
}
fn backend() -> Result<NativeStartup, String> { Ok(NativeStartup { executable: std::env::current_exe().map_err(|_| CHECK_ERROR)? }) }
fn marker_error(profile: &Path) -> Option<String> {
    let path = profile.join(MARKER);
    if fs::metadata(&path).ok()?.len() > 4096 { return None; }
    let value: Migration = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    // Only our fixed user-facing messages can be restored, never arbitrary
    // text or native filesystem/registry errors from a modified marker.
    value.error.filter(|s| [CHECK_ERROR, CHANGE_ERROR, MAC_CHANGE_ERROR].contains(&s.as_str()))
}
fn reserve_migration(profile: &Path) -> Result<bool, String> {
    fs::create_dir_all(profile).map_err(|_| CHANGE_ERROR)?;
    match OpenOptions::new().write(true).create_new(true).open(profile.join(MARKER)) {
        Ok(mut file) => { file.write_all(b"{\"schema\":1}").and_then(|_| file.sync_all()).map_err(|_| CHANGE_ERROR)?; Ok(true) }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(_) => Err(CHANGE_ERROR.into()),
    }
}
fn remember_error(profile: &Path, error: Option<String>) {
    let _ = crate::write_json(&profile.join(MARKER), &Migration { schema: 1, error }, false);
}
fn initialize_once(profile: &Path, native: &impl StartupBackend) -> Option<String> {
    match reserve_migration(profile) { Ok(false) => return marker_error(profile), Err(error) => return Some(error), Ok(true) => {} }
    // The marker is durable before any native operation: crashes, failures,
    // later OS disabling and updates never cause another automatic enable.
    let result = native.status().and_then(|status| {
        if status.registered || status.user_disabled || status.requires_approval { return Ok(()); }
        native.set(true)
    });
    let error = result.err(); remember_error(profile, error.clone()); error
}
pub fn initialize(app: AppHandle) {
    if !supported(&app) { return; }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AutostartState>(); let _lock = state.lock.lock().unwrap();
        let error = match backend() { Ok(native) => initialize_once(&crate::data_dir(&app), &native), Err(error) => Some(error) };
        *state.notice.lock().unwrap() = error;
    });
}
fn describe(status: NativeStatus, notice: Option<String>) -> AutostartStatus {
    let message = if status.requires_approval { "Разрешите запуск Pulse в настройках macOS → Основные → Объекты входа.".into() }
        else if status.stale_path { "В автозапуске указан прежний путь к Pulse. Выключите и включите этот параметр, чтобы обновить запись.".into() }
        else if status.enabled { "Pulse будет открываться при входе в вашу учётную запись.".into() }
        else if let Some(error) = notice { error }
        else if status.user_disabled { "Автозапуск выключен в системных настройках. Pulse не включает его повторно самостоятельно.".into() }
        else { "Автозапуск выключен. Вы можете включить его здесь или в настройках системы.".into() };
    AutostartStatus { supported: true, enabled: status.enabled, requires_approval: status.requires_approval, message }
}
fn unavailable() -> AutostartStatus { AutostartStatus { supported: false, enabled: false, requires_approval: false, message: UNAVAILABLE.into() } }
#[tauri::command]
pub async fn get_autostart(app: AppHandle) -> Result<AutostartStatus, String> {
    if !supported(&app) { return Ok(unavailable()); }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AutostartState>(); let _lock = state.lock.lock().unwrap();
        let notice = state.notice.lock().unwrap().clone();
        Ok(describe(backend()?.status()?, notice))
    }).await.map_err(|_| CHECK_ERROR.to_string())?
}
#[tauri::command]
pub async fn set_autostart(app: AppHandle, enabled: bool) -> Result<AutostartStatus, String> {
    if !supported(&app) { return Err(UNAVAILABLE.into()); }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AutostartState>(); let _lock = state.lock.lock().unwrap();
        let profile = crate::data_dir(&app);
        reserve_migration(&profile)?;
        let native = backend()?; native.set(enabled)?; let status = native.status()?;
        if status.enabled != enabled && !status.requires_approval { return Err(CHANGE_ERROR.into()); }
        *state.notice.lock().unwrap() = None; remember_error(&profile, None);
        Ok(describe(status, None))
    }).await.map_err(|_| CHANGE_ERROR.to_string())?
}

fn windows_command(executable: &Path) -> Result<String, String> {
    let path = executable.to_str().filter(|value| !value.is_empty() && !value.contains(['"', '\r', '\n', '\0'])).ok_or(CHANGE_ERROR)?;
    Ok(format!("\"{path}\" --autostart"))
}
fn approved(bytes: &[u8]) -> Option<bool> {
    if bytes.len() != 12 || bytes[1..4].iter().any(|byte| *byte != 0) { return None; }
    match bytes[0] { 2 | 6 => Some(true), 3 | 7 => Some(false), _ => None }
}
fn enabled_approval() -> [u8; 12] { let mut value = [0; 12]; value[0] = 2; value }
#[cfg(windows)]
impl StartupBackend for NativeStartup {
    fn status(&self) -> Result<NativeStatus, String> {
        use winreg::{RegKey, enums::{HKEY_CURRENT_USER, KEY_READ}};
        let user = RegKey::predef(HKEY_CURRENT_USER);
        let optional_key = |name| match user.open_subkey_with_flags(name, KEY_READ) { Ok(key) => Ok(Some(key)), Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None), Err(_) => Err(CHECK_ERROR.to_string()) };
        let run = optional_key(r"Software\Microsoft\Windows\CurrentVersion\Run")?;
        let command = match run.map(|key| key.get_value::<String, _>(ENTRY_NAME)) { Some(Ok(command)) => Some(command), Some(Err(error)) if error.kind() != std::io::ErrorKind::NotFound => return Err(CHECK_ERROR.into()), _ => None };
        let approval = optional_key(r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run")?;
        let permission = match approval.map(|key| key.get_raw_value(ENTRY_NAME)) { Some(Ok(value)) if value.vtype == winreg::enums::REG_BINARY => approved(&value.bytes).ok_or(CHECK_ERROR)?, Some(Ok(_)) => return Err(CHECK_ERROR.into()), Some(Err(error)) if error.kind() != std::io::ErrorKind::NotFound => return Err(CHECK_ERROR.into()), _ => true };
        let stale_path = command.as_ref().is_some_and(|value| windows_command(&self.executable).is_ok_and(|expected| *value != expected));
        Ok(NativeStatus { enabled: command.is_some() && permission && !stale_path, registered: command.is_some(), user_disabled: !permission, stale_path, ..Default::default() })
    }
    fn set(&self, enabled: bool) -> Result<(), String> {
        use winreg::{RegKey, RegValue, enums::{HKEY_CURRENT_USER, REG_BINARY}};
        let user = RegKey::predef(HKEY_CURRENT_USER);
        let (run, _) = user.create_subkey(r"Software\Microsoft\Windows\CurrentVersion\Run").map_err(|_| CHANGE_ERROR)?;
        if !enabled { return match run.delete_value(ENTRY_NAME) { Ok(()) => Ok(()), Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()), Err(_) => Err(CHANGE_ERROR.into()) }; }
        let command = windows_command(&self.executable)?;
        let (approval, _) = user.create_subkey(r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run").map_err(|_| CHANGE_ERROR)?;
        let previous = match run.get_raw_value(ENTRY_NAME) { Ok(value) => Some(value), Err(error) if error.kind() == std::io::ErrorKind::NotFound => None, Err(_) => return Err(CHANGE_ERROR.into()) };
        run.set_value(ENTRY_NAME, &command).map_err(|_| CHANGE_ERROR)?;
        if approval.set_raw_value(ENTRY_NAME, &RegValue { vtype: REG_BINARY, bytes: enabled_approval().to_vec().into() }).is_err() {
            if let Some(previous) = previous { let _ = run.set_raw_value(ENTRY_NAME, &previous); } else { let _ = run.delete_value(ENTRY_NAME); }
            return Err(CHANGE_ERROR.into());
        }
        Ok(())
    }
}
#[cfg(target_os = "macos")]
impl StartupBackend for NativeStartup {
    fn status(&self) -> Result<NativeStatus, String> {
        use objc2_service_management::{SMAppService, SMAppServiceStatus};
        // Supported macOS14+ provides SMAppService (introduced in macOS13).
        let status = unsafe { SMAppService::mainAppService().status() };
        Ok(NativeStatus { enabled: status == SMAppServiceStatus::Enabled, registered: status == SMAppServiceStatus::Enabled || status == SMAppServiceStatus::RequiresApproval, requires_approval: status == SMAppServiceStatus::RequiresApproval, user_disabled: status == SMAppServiceStatus::RequiresApproval, ..Default::default() })
    }
    fn set(&self, enabled: bool) -> Result<(), String> {
        use objc2_service_management::SMAppService;
        let service = unsafe { SMAppService::mainAppService() };
        let status = self.status()?;
        if status.enabled == enabled && (!status.registered || enabled) { return Ok(()); }
        let result = if enabled { unsafe { service.registerAndReturnError() } } else { unsafe { service.unregisterAndReturnError() } };
        result.map_err(|_| MAC_CHANGE_ERROR.to_string())
    }
}
#[cfg(not(any(windows, target_os = "macos")))]
impl StartupBackend for NativeStartup { fn status(&self) -> Result<NativeStatus, String> { Err(UNAVAILABLE.into()) } fn set(&self, _: bool) -> Result<(), String> { Err(UNAVAILABLE.into()) } }

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    struct Fake { enabled: Cell<bool>, registered: Cell<bool>, blocked: Cell<bool>, calls: RefCell<Vec<bool>>, fail: bool }
    impl Fake { fn new() -> Self { Self { enabled: Cell::new(false), registered: Cell::new(false), blocked: Cell::new(false), calls: RefCell::new(vec![]), fail: false } } }
    impl StartupBackend for Fake {
        fn status(&self) -> Result<NativeStatus, String> { Ok(NativeStatus { enabled: self.enabled.get(), registered: self.registered.get(), user_disabled: self.blocked.get(), ..Default::default() }) }
        fn set(&self, enabled: bool) -> Result<(), String> { self.calls.borrow_mut().push(enabled); if self.fail { return Err(CHANGE_ERROR.into()); } self.enabled.set(enabled); self.registered.set(enabled); Ok(()) }
    }
    struct Scratch(PathBuf);
    impl Scratch { fn new() -> Self { let path = std::env::temp_dir().join(format!("pulse-autostart-policy-{}", rand::random::<u64>())); fs::create_dir(&path).unwrap(); Self(path) } }
    impl Drop for Scratch { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    #[test] fn development_qa_and_auxiliary_identifiers_never_register_startup() {
        assert!(allowed_build("ru.vkplayer.desktop", false, false, false));
        for flags in [(true,false,false),(false,true,false),(false,false,true)] { assert!(!allowed_build("ru.vkplayer.desktop", flags.0, flags.1, flags.2)); }
        assert!(!allowed_build("ru.vkplayer.qa", false, false, false));
    }
    #[test] fn first_start_enables_once_then_respects_external_disabling_and_updates() {
        let s=Scratch::new(); let native=Fake::new(); assert!(initialize_once(&s.0,&native).is_none()); assert_eq!(*native.calls.borrow(),vec![true]);
        native.enabled.set(false); native.registered.set(false); for _ in 0..3 { assert!(initialize_once(&s.0,&native).is_none()); }
        assert_eq!(*native.calls.borrow(),vec![true]); assert!(!native.enabled.get());
    }
    #[test] fn disabled_os_approval_and_preexisting_entries_are_never_reset_automatically() {
        for registered in [false,true] { let s=Scratch::new(); let native=Fake::new(); native.blocked.set(true); native.registered.set(registered); assert!(initialize_once(&s.0,&native).is_none()); assert!(native.calls.borrow().is_empty()); }
        let s=Scratch::new(); let native=Fake::new(); native.registered.set(true); initialize_once(&s.0,&native); assert!(native.calls.borrow().is_empty());
    }
    #[test] fn failed_migration_is_not_retried_at_every_start_and_retains_a_safe_error() {
        let s=Scratch::new(); let mut native=Fake::new(); native.fail=true; assert_eq!(initialize_once(&s.0,&native).as_deref(),Some(CHANGE_ERROR)); assert_eq!(initialize_once(&s.0,&native).as_deref(),Some(CHANGE_ERROR)); assert_eq!(native.calls.borrow().len(),1);
    }
    #[test] fn windows_command_quotes_spaces_and_never_accepts_injected_arguments() {
        assert_eq!(windows_command(Path::new(r"C:\Program Files\VK Player\VK Player.exe")).unwrap(),r#""C:\Program Files\VK Player\VK Player.exe" --autostart"#);
        for value in ["", "bad\" --other.exe", "bad\npath"] { assert!(windows_command(Path::new(value)).is_err()); }
    }
    #[test] fn startup_approval_uses_the_flag_even_when_disabled_timestamp_is_zero() {
        assert_eq!(approved(&enabled_approval()),Some(true));
        for flag in [2,6] { let mut value=[0;12];value[0]=flag;assert_eq!(approved(&value),Some(true)); }
        for flag in [3,7] { let mut value=[0;12];value[0]=flag;assert_eq!(approved(&value),Some(false)); }
        assert_eq!(approved(&[0;12]),None); assert_eq!(approved(&[2]),None);
    }
}
