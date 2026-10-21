//! Account-bound library writes through the signed-in official VK document.
//! A website service receipt is followed by an authoritative library read in
//! the adapter and a committed native snapshot before success reaches the UI.
use crate::{now, vk_web, AppState, Track};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Manager};

const ADAPTER: &str = include_str!("vk_library_actions.js");

fn confirmed_identity(value: &Value, operation: &str, owner: i64, original_audio: i64) -> Result<i64, String> {
    if let Some(message) = value.get("error").and_then(Value::as_str) {
        return Err(message.chars().filter(|c| !c.is_control()).take(500).collect());
    }
    let audio = value.get("audioId").and_then(Value::as_i64).filter(|id| *id > 0);
    if value.get("verified").and_then(Value::as_bool) != Some(true)
        || value.get("ownerId").and_then(Value::as_i64) != Some(owner)
        || audio.is_none()
        || (operation == "delete" && audio != Some(original_audio))
    {
        return Err("VK не подтвердил изменение библиотеки. Обновите синхронизацию перед повтором.".into());
    }
    Ok(audio.unwrap())
}

fn membership_matches(tracks: &[Track], owner: i64, audio: i64, should_exist: bool) -> bool {
    tracks.iter().any(|track| track.remote.as_ref().is_some_and(|remote| {
        remote.owner_id == owner && remote.audio_id == audio && remote.in_library && vk_web::valid_web_track(track)
    })) == should_exist
}

pub(crate) async fn change(app: AppHandle, operation: &str, id: &str) -> Result<Value, String> {
    if !matches!(operation, "add" | "delete") { return Err("Неизвестная операция библиотеки VK.".into()); }
    let shared = app.state::<AppState>();
    let _mutation = shared.vk_sync_lock.lock().await;
    let expected = vk_web::upload_guard(&app)?;
    // Accept only a native registered identity. Renderer-supplied metadata,
    // URLs, access keys and library membership never authorize a write.
    let track = shared.state.lock().unwrap().tracks.iter().find(|track| track.id == id).cloned()
        .filter(vk_web::valid_web_track).ok_or("Трек VK не найден. Повторите поиск или синхронизацию.")?;
    let remote = track.remote.as_ref().unwrap();
    if operation == "delete" && (!remote.in_library || remote.owner_id != expected.account_id) {
        return Err("Удалять можно только треки из своей музыки VK.".into());
    }
    if operation == "add" && remote.in_library { return Err("Этот трек уже есть в вашей музыке VK.".into()); }
    let window = app.get_webview_window("vk-music").ok_or("Подключите VK перед изменением библиотеки.")?;
    let key = format!("library-{}-{}", now(), rand::random::<u64>());
    let key_json = serde_json::to_string(&key).unwrap();
    let operation_json = serde_json::to_string(operation).unwrap();
    let id_json = serde_json::to_string(id).unwrap();
    let scope = format!("if(window.top!==window.self||!['https://vk.com','https://vk.ru'].includes(location.origin)||Number(window.vk?.id)!=={})return {{complete:true,error:'Аккаунт VK изменился. Обновите библиотеку.'}};", expected.account_id);
    let result = async {
        if !vk_web::check_upload_guard(&app, &expected) { return Err("Аккаунт VK изменился. Операция отменена.".to_string()); }
        let started = vk_web::evaluate(&window, format!("(()=>{{{scope}{ADAPTER};return {{accepted:window.__PULSE_VK_LIBRARY_ACTIONS__?.start({key_json},{operation_json},{id_json},{})===true}};}})()", expected.account_id)).await?;
        if started.get("accepted").and_then(Value::as_bool) != Some(true) {
            return Err("Изменение библиотеки VK пока недоступно. Дождитесь подключения аккаунта и повторите.".into());
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
        let audio = loop {
            if !vk_web::check_upload_guard(&app, &expected) { return Err("Аккаунт VK изменился. Проверьте библиотеку перед повтором операции.".into()); }
            let receipt = vk_web::evaluate(&window, format!("(()=>{{{scope}return window.__PULSE_VK_LIBRARY_ACTIONS__?.read({key_json},{})||{{complete:true,error:'Окно VK изменилось. Обновите библиотеку.'}};}})()", expected.account_id)).await?;
            if receipt.get("complete").and_then(Value::as_bool) == Some(true) {
                break confirmed_identity(&receipt, operation, expected.account_id, remote.audio_id)?;
            }
            if tokio::time::Instant::now() >= deadline { return Err("VK не подтвердил изменение вовремя. Обновите библиотеку перед повтором.".into()); }
            tokio::time::sleep(Duration::from_millis(200)).await;
        };
        // The normal account-scoped VK poll commits the adapter's verified
        // snapshot. Wait for it instead of mutating optimistic local state.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(12);
        loop {
            if !vk_web::check_upload_guard(&app, &expected) { return Err("Аккаунт VK изменился. Проверьте библиотеку перед повтором операции.".into()); }
            {
                let _storage = shared.storage_lock.lock().unwrap();
                if !vk_web::check_upload_guard(&app, &expected) { return Err("Аккаунт VK изменился. Проверьте библиотеку перед повтором операции.".into()); }
                let status = vk_web::status(&shared);
                let state = shared.state.lock().unwrap();
                if membership_matches(&state.tracks, expected.account_id, audio, operation == "add") {
                    return Ok(json!({"status":status,"tracks":state.tracks.iter().filter(|t|vk_web::valid_web_track(t)).collect::<Vec<_>>(),"playlists":state.playlists.iter().filter(|p|p.remote.is_some()).collect::<Vec<_>>(),"complete":true,"mutationConfirmed":true,"syncedAt":now(),"mode":"web","addedTrack":if operation=="add" {json!({"sourceId":id,"ownedId":format!("vk-{}-{audio}",expected.account_id)})} else {Value::Null}}));
                }
            }
            if tokio::time::Instant::now() >= deadline { return Err("VK подтвердил изменение, но плеер ещё не получил обновлённую библиотеку. Обновите синхронизацию перед повтором.".into()); }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    }.await;
    if vk_web::check_upload_guard(&app, &expected) {
        let _ = window.eval(format!("(()=>{{{scope}window.__PULSE_VK_LIBRARY_ACTIONS__?.cancel({key_json},{});}})()", expected.account_id));
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_write_receipt_requires_verified_account_and_exact_delete_identity() {
        assert_eq!(confirmed_identity(&json!({"verified":true,"ownerId":42,"audioId":7}), "delete", 42, 7).unwrap(), 7);
        assert!(confirmed_identity(&json!({"verified":true,"ownerId":43,"audioId":7}), "delete", 42, 7).is_err());
        assert!(confirmed_identity(&json!({"verified":true,"ownerId":42,"audioId":8}), "delete", 42, 7).is_err());
        assert!(confirmed_identity(&json!({"verified":false,"ownerId":42,"audioId":7}), "add", 42, 7).is_err());
        assert!(confirmed_identity(&json!({"verified":true,"ownerId":42,"audioId":0}), "add", 42, 7).is_err());
        assert_eq!(confirmed_identity(&json!({"verified":true,"ownerId":42,"audioId":88}), "add", 42, 7).unwrap(), 88);
    }
    #[test]
    fn website_errors_cannot_be_reported_as_success() {
        assert!(confirmed_identity(&json!({"verified":true,"ownerId":42,"audioId":7,"error":"failed"}), "add", 42, 7).is_err());
        assert!(confirmed_identity(&json!({}), "add", 42, 7).is_err());
    }
    #[test]
    fn deletion_is_confirmed_when_playlist_copy_remains_but_own_membership_is_gone() {
        let track: Track = serde_json::from_value(json!({"id":"vk-42-7","source":"vk","url":"vk-web://42/7","remote":{"ownerId":42,"audioId":7,"inLibrary":false}})).unwrap();
        assert!(membership_matches(&[track.clone()], 42, 7, false));
        assert!(!membership_matches(&[track.clone()], 42, 7, true));
        let mut owned = track;
        owned.remote.as_mut().unwrap().in_library = true;
        assert!(!membership_matches(&[owned.clone()], 42, 7, false));
        assert!(membership_matches(&[owned], 42, 7, true));
    }
}
