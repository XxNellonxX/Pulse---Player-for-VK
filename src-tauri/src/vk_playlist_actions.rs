//! Writes through VK's own page client, then verifies the complete native
//! playlist composition committed by the account-bound website collector.
use crate::{now, vk_web, AppState, Track};
use serde_json::{json, Value};
use std::{collections::HashSet, time::Duration};
use tauri::{AppHandle, Manager};
const SCRIPT: &str = include_str!("vk_playlist_actions.js");
const MAX_SELECTION: usize = 5000;

fn text(value: Option<String>, limit: usize) -> String {
    value.unwrap_or_default().chars().filter(|c| !c.is_control() || *c == '\n').take(limit).collect::<String>().trim().to_owned()
}
fn receipt_matches(state: &crate::PersistedState, receipt: &Value) -> bool {
    let Some(id) = receipt.get("playlistKey").and_then(Value::as_str) else { return false; };
    let target = state.playlists.iter().find(|playlist| playlist.id == id && playlist.remote.is_some());
    if receipt.get("deleted").and_then(Value::as_bool) == Some(true) { return target.is_none(); }
    let Some(target) = target else { return false; };
    target.title == receipt.get("title").and_then(Value::as_str).unwrap_or("")
        && target.description.as_str() == receipt.get("description").and_then(Value::as_str).unwrap_or("")
        && receipt.get("trackIds").and_then(Value::as_array).is_some_and(|ids| ids.len() == target.track_ids.len() && ids.iter().zip(&target.track_ids).all(|(id, expected)| id.as_str() == Some(expected)))
}

pub(crate) async fn change(app: AppHandle, operation: String, playlist_id: Option<String>, title: Option<String>, description: Option<String>, track: Option<Track>, track_ids: Option<Vec<String>>) -> Result<Value, String> {
    if !matches!(operation.as_str(), "create" | "edit" | "rename" | "delete" | "add-track" | "remove-track") { return Err("Неизвестная операция плейлиста VK.".into()); }
    let shared = app.state::<AppState>();
    let _mutation = shared.vk_sync_lock.lock().await;
    let expected = vk_web::upload_guard(&app)?;
    let title = text(title, 200);
    let description = text(description, 2000);
    if matches!(operation.as_str(), "create" | "edit" | "rename") && title.is_empty() { return Err("Введите название плейлиста.".into()); }
    let ids = if matches!(operation.as_str(), "add-track" | "remove-track") {
        vec![track.ok_or("Выберите трек для плейлиста.")?.id]
    } else if matches!(operation.as_str(), "create" | "edit") { track_ids.unwrap_or_default() } else { vec![] };
    if ids.len() > MAX_SELECTION { return Err("За одно сохранение можно выбрать не больше 5000 треков.".into()); }
    let mut seen = HashSet::new();
    if ids.iter().any(|id| !seen.insert(id)) { return Err("Удалите повторы из выбранных треков.".into()); }
    {
        let state = shared.state.lock().unwrap();
        let previous = playlist_id.as_ref().and_then(|id| state.playlists.iter().find(|p| &p.id == id));
        if operation != "create" && !previous.is_some_and(|playlist| !playlist.content_unavailable && playlist.remote.as_ref().is_some_and(|remote| remote.owner_id == expected.account_id)) { return Err("Изменять можно только свои доступные плейлисты VK.".into()); }
        for id in &ids {
            let native = state.tracks.iter().find(|t| &t.id == id).filter(|t| vk_web::valid_web_track(t)).ok_or("Трек не найден. Обновите музыку VK.")?;
            if matches!(operation.as_str(), "create" | "edit") && !native.remote.as_ref().is_some_and(|r| (r.owner_id == expected.account_id && r.in_library) || previous.is_some_and(|p| p.track_ids.contains(id))) {
                return Err("Сначала добавьте выбранный трек в свою музыку VK, затем сохраните плейлист.".into());
            }
        }
    }
    let window = app.get_webview_window("vk-music").ok_or("Подключите VK перед сохранением плейлиста.")?;
    let key = format!("playlist-{}-{}", now(), rand::random::<u64>());
    let key_json = serde_json::to_string(&key).unwrap();
    let input = json!({"operation":operation,"playlistId":playlist_id,"title":title,"description":description,"trackIds":ids});
    let scope = format!("if(window.top!==window.self||!['https://vk.com','https://vk.ru'].includes(location.origin)||Number(window.vk?.id)!=={})return {{complete:true,error:'Аккаунт VK изменился. Проверьте плейлист.'}};", expected.account_id);
    let result = async {
        if !vk_web::check_upload_guard(&app, &expected) { return Err("Сеанс VK изменился. Сохранение отменено.".to_string()); }
        let started = vk_web::evaluate(&window, format!("(()=>{{{scope}{SCRIPT};return {{accepted:window.__PULSE_VK_PLAYLIST_ACTIONS__?.start({key_json},{input},{})===true}};}})()", expected.account_id)).await?;
        if started.get("accepted").and_then(Value::as_bool) != Some(true) { return Err("Плейлисты VK пока не готовы к сохранению. Дождитесь подключения аккаунта.".into()); }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
        let receipt = loop {
            if !vk_web::check_upload_guard(&app, &expected) { return Err("Сеанс VK изменился. Проверьте плейлист перед повтором.".to_string()); }
            let receipt = vk_web::evaluate(&window, format!("(()=>{{{scope}return window.__PULSE_VK_PLAYLIST_ACTIONS__?.read({key_json},{})||{{complete:true,error:'Страница VK изменилась. Проверьте плейлист.'}};}})()", expected.account_id)).await?;
            if receipt.get("complete").and_then(Value::as_bool) == Some(true) {
                if let Some(error) = receipt.get("error").and_then(Value::as_str) { return Err(error.chars().filter(|c| !c.is_control()).take(500).collect()); }
                if receipt.get("verified").and_then(Value::as_bool) != Some(true) || receipt.get("ownerId").and_then(Value::as_i64) != Some(expected.account_id) { return Err("VK не подтвердил сохранение плейлиста.".into()); }
                break receipt;
            }
            if tokio::time::Instant::now() >= deadline { return Err("VK не подтвердил сохранение вовремя. Проверьте плейлист перед повтором.".into()); }
            tokio::time::sleep(Duration::from_millis(200)).await;
        };
        let deadline = tokio::time::Instant::now() + Duration::from_secs(12);
        loop {
            if !vk_web::check_upload_guard(&app, &expected) { return Err("Сеанс VK изменился. Проверьте плейлист перед повтором.".into()); }
            {
                let _storage = shared.storage_lock.lock().unwrap();
                if !vk_web::check_upload_guard(&app, &expected) { return Err("Сеанс VK изменился. Проверьте плейлист перед повтором.".into()); }
                let status = vk_web::status(&shared);
                let state = shared.state.lock().unwrap();
                if receipt_matches(&state, &receipt) {
                    return Ok(json!({"status":status,"tracks":state.tracks.iter().filter(|t|vk_web::valid_web_track(t)).collect::<Vec<_>>(),"playlists":state.playlists.iter().filter(|p|p.remote.is_some()).collect::<Vec<_>>(),"complete":true,"mutationConfirmed":true,"syncedAt":now(),"mode":"web","createdPlaylistId":if operation=="create" {receipt.get("playlistKey").cloned().unwrap_or(Value::Null)} else {Value::Null}}));
                }
            }
            if tokio::time::Instant::now() >= deadline { return Err("VK сохранил плейлист, но плеер ещё не получил подтверждённый состав. Обновите синхронизацию.".into()); }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    }.await;
    if vk_web::check_upload_guard(&app, &expected) { let _ = window.eval(format!("(()=>{{{scope}window.__PULSE_VK_PLAYLIST_ACTIONS__?.cancel({key_json},{});}})()", expected.account_id)); }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn success_requires_exact_order_and_metadata() {
        let mut state = crate::defaults();
        state.playlists.push(serde_json::from_value(json!({"id":"vk-playlist-42-7","title":"Mix","description":"Evening","trackIds":["vk-42-1","vk-42-2"],"remote":{"ownerId":42,"playlistId":7}})).unwrap());
        let receipt = json!({"playlistKey":"vk-playlist-42-7","title":"Mix","description":"Evening","trackIds":["vk-42-1","vk-42-2"]});
        assert!(receipt_matches(&state, &receipt));
        let mut wrong = receipt.clone(); wrong["trackIds"] = json!(["vk-42-2","vk-42-1"]); assert!(!receipt_matches(&state, &wrong));
        wrong = receipt.clone(); wrong["description"] = json!("old"); assert!(!receipt_matches(&state, &wrong));
        assert!(!receipt_matches(&state, &json!({"playlistKey":"vk-playlist-42-7","deleted":true})));
        state.playlists.clear(); assert!(receipt_matches(&state, &json!({"playlistKey":"vk-playlist-42-7","deleted":true})));
    }
}
