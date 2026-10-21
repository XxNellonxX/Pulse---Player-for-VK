//! Authoritative official-API sync. A failed page never replaces the saved cache.
use crate::vk_auth::VkAuthManager;
use crate::{
    map_vk_audio, now, save_locked, status_from_auth, AppState, Playlist, RemotePlaylist, Track,
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, State};

const PAGE: usize = 100;
const MAX_ITEMS: usize = 100_000;

fn auth_for(shared: &State<'_, AppState>) -> Result<Arc<VkAuthManager>, String> {
    shared.auth.lock().unwrap().clone().ok_or_else(|| {
        "VK ID не настроен. Для входа разработчик должен зарегистрировать приложение VK ID.".into()
    })
}

fn error_snapshot(auth: &VkAuthManager, message: &str) -> Value {
    let mut status = status_from_auth(auth);
    status.message = message.into();
    // A music permission failure does not erase an otherwise valid VK ID session.
    for cap in &mut status.capabilities {
        if cap.id != "auth" {
            cap.detail = message.into();
        }
    }
    json!({"status": status, "tracks": [], "playlists": [], "complete": false, "syncedAt": Value::Null, "error": message})
}

fn playlist_remote(v: &Value) -> Option<RemotePlaylist> {
    let owner = v.get("owner_id")?.as_i64().filter(|id| *id != 0)?;
    let id = v.get("id")?.as_i64().filter(|id| *id > 0)?;
    Some(RemotePlaylist {
        owner_id: owner,
        playlist_id: id,
        access_key: v
            .get("access_key")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

fn map_playlist(v: &Value) -> Option<Playlist> {
    let remote = playlist_remote(v)?;
    Some(Playlist {
        id: format!("vk-playlist-{}-{}", remote.owner_id, remote.playlist_id),
        title: v
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("Без названия")
            .chars()
            .take(500)
            .collect(),
        track_ids: vec![],
        created_at: v.get("create_time").and_then(Value::as_i64).unwrap_or(0) * 1000,
        remote: Some(remote),
        description: v
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .chars()
            .take(2000)
            .collect(),
        artwork: v
            .get("photo")
            .or_else(|| v.get("thumb"))
            .and_then(|x| x.get("photo_300"))
            .and_then(Value::as_str)
            .filter(|url| url.starts_with("https://"))
            .map(str::to_owned),
        synced_at: Some(now()),
        content_unavailable: false,
        remote_track_count: None,
    })
}

fn page_parts(value: &Value) -> Result<(usize, &Vec<Value>), String> {
    let count = value
        .get("count")
        .and_then(Value::as_u64)
        .filter(|n| *n <= MAX_ITEMS as u64)
        .ok_or_else(|| {
            "VK вернул некорректный размер коллекции или превышен предел 100 000 элементов"
                .to_string()
        })? as usize;
    let items = value
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(|| "VK вернул коллекцию без items".to_string())?;
    Ok((count, items))
}

async fn fetch_all(
    auth: &VkAuthManager,
    method: &str,
    base: &[(String, String)],
    epoch: u64,
) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    let mut expected = None;
    loop {
        let mut params = base.to_vec();
        params.extend([
            ("count".into(), PAGE.to_string()),
            ("offset".into(), out.len().to_string()),
        ]);
        let response = auth
            .api_request_at_epoch(method, &params, epoch)
            .await
            .map_err(|e| e.message)?;
        let (count, items) = page_parts(&response)?;
        if expected.is_some_and(|old| old != count) {
            return Err("Коллекция VK изменилась во время чтения. Повторите синхронизацию.".into());
        }
        expected = Some(count);
        if items.is_empty() && out.len() < count {
            return Err("VK вернул неполную коллекцию. Кэш сохранён.".into());
        }
        if out.len() + items.len() > count {
            return Err("VK вернул противоречивую длину коллекции.".into());
        }
        out.extend(items.iter().cloned());
        if out.len() == count {
            return Ok(out);
        }
        // Serial requests keep normal sync below the public API request limit.
        tokio::time::sleep(Duration::from_millis(350)).await;
    }
}

fn map_tracks(items: &[Value], in_library: bool) -> Result<Vec<Track>, String> {
    let mut seen = HashSet::new();
    items
        .iter()
        .map(|item| {
            let mut track = map_vk_audio(item)
                .ok_or_else(|| "VK вернул трек без идентификатора".to_string())?;
            if !seen.insert(track.id.clone()) {
                return Err("В коллекции VK повторились страницы. Повторите синхронизацию.".into());
            }
            if let Some(remote) = &mut track.remote {
                remote.in_library = in_library;
            }
            Ok(track)
        })
        .collect()
}

async fn fetch_snapshot(
    auth: &VkAuthManager,
    epoch: u64,
) -> Result<(Vec<Track>, Vec<Playlist>), String> {
    auth.refresh_at_epoch(epoch).await.map_err(|e| e.message)?;
    let user_id =
        auth.status().user_id.filter(|id| *id > 0).ok_or_else(|| {
            "VK не подтвердил идентификатор аккаунта. Войдите заново.".to_string()
        })?;
    let library = fetch_all(
        auth,
        "audio.get",
        &[("owner_id".into(), user_id.to_string())],
        epoch,
    )
    .await?;
    let mut tracks = map_tracks(&library, true)?;
    tokio::time::sleep(Duration::from_millis(350)).await;
    let items = fetch_all(
        auth,
        "audio.getPlaylists",
        &[("owner_id".into(), user_id.to_string())],
        epoch,
    )
    .await?;
    let mut playlists = Vec::new();
    let mut playlist_ids = HashSet::new();
    let mut track_ids: HashSet<String> = tracks.iter().map(|t| t.id.clone()).collect();
    for item in &items {
        let mut playlist = map_playlist(item)
            .ok_or_else(|| "VK вернул плейлист без идентификатора".to_string())?;
        if !playlist_ids.insert(playlist.id.clone()) {
            return Err("В ответе VK повторились плейлисты".into());
        }
        let remote = playlist.remote.as_ref().unwrap();
        // Verify playlist metadata separately. Song collections use paginated
        // audio.get(album_id); metadata is never mistaken for an empty list.
        let mut params = vec![
            ("owner_id".into(), remote.owner_id.to_string()),
            ("playlist_id".into(), remote.playlist_id.to_string()),
            ("extended".into(), "1".into()),
        ];
        if let Some(key) = &remote.access_key {
            params.push(("access_key".into(), key.clone()));
        }
        tokio::time::sleep(Duration::from_millis(350)).await;
        let detail = auth
            .api_request_at_epoch("audio.getPlaylistById", &params, epoch)
            .await
            .map_err(|e| e.message)?;
        let detail = detail.as_array().and_then(|a| a.first()).unwrap_or(&detail);
        if playlist_remote(detail).as_ref().map_or(true, |p| {
            p.owner_id != remote.owner_id || p.playlist_id != remote.playlist_id
        }) {
            return Err("VK не подтвердил идентификатор плейлиста при повторном чтении".into());
        }
        let mut song_params = vec![
            ("owner_id".into(), remote.owner_id.to_string()),
            ("album_id".into(), remote.playlist_id.to_string()),
            ("extended".into(), "1".into()),
        ];
        if let Some(key) = &remote.access_key {
            song_params.push(("access_key".into(), key.clone()));
        }
        tokio::time::sleep(Duration::from_millis(350)).await;
        let songs = map_tracks(
            &fetch_all(auth, "audio.get", &song_params, epoch).await?,
            false,
        )?;
        for song in songs {
            playlist.track_ids.push(song.id.clone());
            if track_ids.insert(song.id.clone()) {
                if tracks.len() >= MAX_ITEMS {
                    return Err("Общее число уникальных треков VK превышает 100 000. Кэш сохранён без усечения.".into());
                }
                tracks.push(song);
            }
        }
        playlists.push(playlist);
    }
    Ok((tracks, playlists))
}

fn merge_snapshot(
    state: &mut crate::PersistedState,
    tracks: &[Track],
    playlists: &[Playlist],
) -> Result<(), String> {
    let incoming_ids: HashSet<String> = tracks.iter().map(|t| t.id.clone()).collect();
    // Search results and tracks resolved from a playlist may be playable but
    // absent from the account library. Keep those native records while they
    // are still referenced by playback state; otherwise a periodic refresh
    // makes the current track disappear and interrupts playback.
    let mut pinned = HashSet::new();
    pinned.extend(state.queue.iter().cloned());
    pinned.extend(state.history.iter().cloned());
    if let Some(id) = &state.current_track_id {
        pinned.insert(id.clone());
    }
    for playlist in state.playlists.iter().filter(|p| p.remote.is_none()) {
        pinned.extend(playlist.track_ids.iter().cloned());
    }
    let preserved: Vec<Track> = state
        .tracks
        .iter()
        .filter(|t| {
            t.source == "vk"
                && t.remote.as_ref().is_some_and(|r| !r.in_library)
                && pinned.contains(&t.id)
                && !incoming_ids.contains(&t.id)
        })
        .cloned()
        .collect();
    let local_tracks = state.tracks.iter().filter(|t| t.source != "vk").count();
    let local_playlists = state
        .playlists
        .iter()
        .filter(|p| p.remote.is_none())
        .count();
    if local_tracks + tracks.len() + preserved.len() > MAX_ITEMS
        || local_playlists + playlists.len() > MAX_ITEMS
    {
        return Err("Общая библиотека превышает предел 100 000 треков или плейлистов. Кэш сохранён без усечения.".into());
    }
    let previous: HashMap<String, i64> = state
        .tracks
        .iter()
        .map(|t| (t.id.clone(), t.added_at))
        .collect();
    state.tracks.retain(|t| t.source != "vk");
    state.tracks.extend(tracks.iter().cloned().map(|mut t| {
        if let Some(date) = previous.get(&t.id) {
            t.added_at = *date;
        }
        t
    }));
    state.tracks.extend(preserved);
    state.playlists.retain(|p| p.remote.is_none());
    state.playlists.extend(playlists.iter().cloned());
    let ids: HashSet<_> = state.tracks.iter().map(|t| t.id.clone()).collect();
    state.queue.retain(|id| ids.contains(id));
    state.history.retain(|id| ids.contains(id));
    for p in &mut state.playlists {
        p.track_ids.retain(|id| ids.contains(id));
    }
    if state
        .current_track_id
        .as_ref()
        .is_some_and(|id| !ids.contains(id))
    {
        state.current_track_id = None;
        state.position = 0.;
    }
    Ok(())
}

async fn sync_locked(
    app: &AppHandle,
    shared: &State<'_, AppState>,
    auth: &VkAuthManager,
    epoch: u64,
) -> Result<Value, String> {
    if auth.session_epoch() != epoch {
        return Err("Сеанс VK изменился. Синхронизация отменена.".into());
    }
    let (tracks, playlists) = fetch_snapshot(auth, epoch).await?;
    if auth.session_epoch() != epoch || auth.status().state != "connected" {
        return Err("Сеанс VK изменился во время синхронизации. Кэш сохранён.".into());
    }
    let synced = now();
    let mut status = status_from_auth(auth);
    status.message = format!(
        "Синхронизировано: {} треков и {} плейлистов.",
        tracks.len(),
        playlists.len()
    );
    for cap in &mut status.capabilities {
        if cap.id == "library" || cap.id == "playlists" {
            cap.status = "verified".into();
            cap.detail = status.message.clone();
        }
    }
    let _lock = shared.storage_lock.lock().unwrap();
    if auth.session_epoch() != epoch || auth.status().state != "connected" {
        return Err("Сеанс VK завершён. Синхронизация отменена.".into());
    }
    let previous = shared.state.lock().unwrap().clone();
    merge_snapshot(&mut shared.state.lock().unwrap(), &tracks, &playlists)?;
    if let Err(e) = save_locked(app, shared) {
        *shared.state.lock().unwrap() = previous;
        return Err(e);
    }
    Ok(
        json!({"status":status,"tracks":tracks,"playlists":playlists,"complete":true,"syncedAt":synced}),
    )
}

pub async fn sync_snapshot(app: AppHandle, shared: State<'_, AppState>) -> Result<Value, String> {
    let auth = auth_for(&shared)?;
    let epoch = auth.session_epoch();
    let _guard = shared.vk_sync_lock.lock().await;
    Ok(sync_locked(&app, &shared, &auth, epoch)
        .await
        .unwrap_or_else(|e| error_snapshot(&auth, &e)))
}
#[tauri::command]
pub async fn sync_vk(app: AppHandle, shared: State<'_, AppState>) -> Result<Value, String> {
    sync_snapshot(app, shared).await
}

fn ensure_success(value: &Value) -> Result<(), String> {
    if value.as_i64().is_some_and(|n| n > 0)
        || value.as_bool() == Some(true)
        || value.as_array().is_some_and(|a| !a.is_empty())
        || value.as_object().is_some_and(|o| !o.is_empty())
    {
        Ok(())
    } else {
        Err("VK не подтвердил изменение. Локальная коллекция сохранена.".into())
    }
}

async fn write(
    auth: &VkAuthManager,
    method: &str,
    params: &[(String, String)],
    epoch: u64,
) -> Result<Value, String> {
    let result = auth
        .api_request_at_epoch(method, params, epoch)
        .await
        .map_err(|e| e.message)?;
    ensure_success(&result)?;
    tokio::time::sleep(Duration::from_millis(350)).await;
    Ok(result)
}

fn readback_failure() -> String {
    "VK принял запрос, но повторное чтение не подтвердило изменение. Обновите синхронизацию перед повтором операции.".into()
}

fn mutation_confirmed(mut snapshot: Value) -> Value {
    if let Some(object) = snapshot.as_object_mut() {
        object.insert("mutationConfirmed".into(), Value::Bool(true));
    }
    snapshot
}

#[tauri::command]
pub async fn add_vk_track(
    app: AppHandle,
    shared: State<'_, AppState>,
    track: Track,
) -> Result<Value, String> {
    if crate::vk_web::uses_web(&shared) {
        return crate::vk_library_actions::change(app, "add", &track.id).await;
    }
    let auth = auth_for(&shared)?;
    let epoch = auth.session_epoch();
    let account = auth.status().user_id;
    let r = track.remote.ok_or_else(|| {
        "Для загрузки локального файла нужен отдельно подтверждённый upload API VK.".to_string()
    })?;
    let _guard = shared.vk_sync_lock.lock().await;
    let result = write(
        &auth,
        "audio.add",
        &[
            ("owner_id".into(), r.owner_id.to_string()),
            ("audio_id".into(), r.audio_id.to_string()),
        ],
        epoch,
    )
    .await?;
    if auth.session_epoch() != epoch || auth.status().user_id != account {
        return Err("Сеанс VK изменился во время добавления. Повторите операцию.".into());
    }
    let new_id = result
        .as_i64()
        .filter(|id| *id > 0)
        .ok_or_else(readback_failure)?;
    let snapshot = sync_locked(&app, &shared, &auth, epoch)
        .await
        .map_err(|_| readback_failure())?;
    let user = auth.status().user_id.unwrap_or(0);
    if !shared.state.lock().unwrap().tracks.iter().any(|t| {
        t.remote
            .as_ref()
            .is_some_and(|r| r.owner_id == user && r.audio_id == new_id && r.in_library)
    }) {
        return Err(readback_failure());
    }
    let mut snapshot = mutation_confirmed(snapshot);
    snapshot["addedTrack"] = json!({"sourceId":format!("vk-{}-{}",r.owner_id,r.audio_id),"ownedId":format!("vk-{user}-{new_id}")});
    Ok(snapshot)
}

#[tauri::command]
pub async fn delete_vk_track(
    app: AppHandle,
    shared: State<'_, AppState>,
    id: String,
) -> Result<Value, String> {
    if crate::vk_web::uses_web(&shared) {
        return crate::vk_library_actions::change(app, "delete", &id).await;
    }
    let auth = auth_for(&shared)?;
    let epoch = auth.session_epoch();
    let account = auth.status().user_id;
    let r = shared
        .state
        .lock()
        .unwrap()
        .tracks
        .iter()
        .find(|t| t.id == id)
        .and_then(|t| t.remote.clone())
        .ok_or_else(|| "Трек VK не найден".to_string())?;
    if auth.status().user_id != Some(r.owner_id) || !r.in_library {
        return Err("Удалять можно только треки из своей музыки VK".into());
    }
    let _guard = shared.vk_sync_lock.lock().await;
    write(
        &auth,
        "audio.delete",
        &[
            ("owner_id".into(), r.owner_id.to_string()),
            ("audio_id".into(), r.audio_id.to_string()),
        ],
        epoch,
    )
    .await?;
    if auth.session_epoch() != epoch || auth.status().user_id != account {
        return Err("Сеанс VK изменился во время удаления. Повторите операцию.".into());
    }
    let snapshot = sync_locked(&app, &shared, &auth, epoch)
        .await
        .map_err(|_| readback_failure())?;
    if shared
        .state
        .lock()
        .unwrap()
        .tracks
        .iter()
        .any(|t| t.id == id && t.remote.as_ref().is_some_and(|r| r.in_library))
    {
        return Err(readback_failure());
    }
    Ok(mutation_confirmed(snapshot))
}

#[tauri::command]
pub async fn vk_playlist_change(
    app: AppHandle,
    shared: State<'_, AppState>,
    operation: String,
    playlist_id: Option<String>,
    title: Option<String>,
    description: Option<String>,
    track: Option<Track>,
    track_ids: Option<Vec<String>>,
) -> Result<Value, String> {
    if crate::vk_web::uses_web(&shared) {
        return crate::vk_playlist_actions::change(app, operation, playlist_id, title, description, track, track_ids).await;
    }
    let auth = auth_for(&shared)?;
    let epoch = auth.session_epoch();
    let account = auth.status().user_id;
    let _guard = shared.vk_sync_lock.lock().await;
    let playlist = playlist_id.as_ref().and_then(|id| {
        shared
            .state
            .lock()
            .unwrap()
            .playlists
            .iter()
            .find(|p| &p.id == id)
            .cloned()
    });
    let mut params = Vec::new();
    if operation != "create" {
        let r = playlist
            .as_ref()
            .and_then(|p| p.remote.as_ref())
            .ok_or_else(|| "Плейлист VK не найден".to_string())?;
        if Some(r.owner_id) != auth.status().user_id {
            return Err("Этот плейлист принадлежит другому аккаунту VK".into());
        }
        params.extend([
            ("owner_id".into(), r.owner_id.to_string()),
            ("playlist_id".into(), r.playlist_id.to_string()),
        ]);
    }
    let title = title.map(|s| s.trim().chars().take(200).collect::<String>());
    let track_remote = track.as_ref().and_then(|t| t.remote.as_ref());
    let method = match operation.as_str() {
        "create" | "rename" => {
            let name = title
                .as_ref()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "Введите название плейлиста".to_string())?;
            params.push(("title".into(), name.clone()));
            if operation == "create" {
                "audio.createPlaylist"
            } else {
                "audio.editPlaylist"
            }
        }
        "delete" => "audio.deletePlaylist",
        "add-track" | "remove-track" => {
            let r = track_remote.ok_or_else(|| {
                "Локальные файлы нельзя добавить в плейлист VK без загрузки на сервер".to_string()
            })?;
            let mut audio = format!("{}_{}", r.owner_id, r.audio_id);
            if let Some(key) = &r.access_key {
                audio.push('_');
                audio.push_str(key);
            }
            params.push(("audio_ids".into(), audio));
            if operation == "add-track" {
                "audio.addToPlaylist"
            } else {
                "audio.deleteFromPlaylist"
            }
        }
        _ => return Err("Неизвестная операция плейлиста".into()),
    };
    let response = write(&auth, method, &params, epoch).await?;
    if auth.session_epoch() != epoch || auth.status().user_id != account {
        return Err("Сеанс VK изменился во время изменения плейлиста. Повторите операцию.".into());
    }
    let created = if operation == "create" {
        playlist_remote(&response).map(|r| format!("vk-playlist-{}-{}", r.owner_id, r.playlist_id))
    } else {
        None
    };
    let snapshot = sync_locked(&app, &shared, &auth, epoch)
        .await
        .map_err(|_| readback_failure())?;
    let state = shared.state.lock().unwrap();
    let p = state
        .playlists
        .iter()
        .find(|p| Some(&p.id) == playlist_id.as_ref());
    let verified = match operation.as_str() {
        "create" => created.is_some_and(|id| {
            state
                .playlists
                .iter()
                .any(|p| p.id == id && Some(&p.title) == title.as_ref())
        }),
        "rename" => p.is_some_and(|p| Some(&p.title) == title.as_ref()),
        "delete" => p.is_none(),
        "add-track" => {
            p.is_some_and(|p| track.as_ref().is_some_and(|t| p.track_ids.contains(&t.id)))
        }
        "remove-track" => {
            p.is_some_and(|p| track.as_ref().is_some_and(|t| !p.track_ids.contains(&t.id)))
        }
        _ => false,
    };
    if !verified {
        return Err(readback_failure());
    }
    Ok(mutation_confirmed(snapshot))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maps_playlist_remote_ids_and_preserves_empty_title() {
        let p = map_playlist(&json!({"id":3,"owner_id":7,"title":"Mix"})).unwrap();
        assert_eq!(p.id, "vk-playlist-7-3");
        assert_eq!(p.remote.unwrap().playlist_id, 3);
    }
    #[test]
    fn malformed_responses_never_become_empty_success() {
        assert!(map_playlist(&json!({"title":"x"})).is_none());
        assert!(page_parts(&json!({"count":3})).is_err());
        assert!(page_parts(&json!({"items":[]})).is_err());
        assert!(ensure_success(&json!(0)).is_err());
        assert!(ensure_success(&Value::Null).is_err());
    }
    #[test]
    fn pagination_rejects_oversized_collection() {
        assert!(page_parts(&json!({"count":100001,"items":[]})).is_err());
    }
    #[test]
    fn track_mapping_marks_playlist_tracks_and_rejects_duplicates() {
        let x = json!({"owner_id":1,"id":2,"title":"x","url":"https://example.com/x.mp3"});
        assert!(
            !map_tracks(&[x.clone()], false).unwrap()[0]
                .remote
                .as_ref()
                .unwrap()
                .in_library
        );
        assert!(map_tracks(&[x.clone(), x], true).is_err());
    }
    #[test]
    fn merge_removes_remote_deletions_and_keeps_local_data() {
        let mut s = crate::defaults();
        s.tracks.push(Track {
            id: "local".into(),
            source: "local".into(),
            ..Default::default()
        });
        s.tracks.push(Track {
            id: "vk-old".into(),
            source: "vk".into(),
            ..Default::default()
        });
        s.playlists.push(Playlist {
            id: "local-list".into(),
            track_ids: vec!["local".into(), "vk-old".into()],
            ..Default::default()
        });
        s.queue = vec!["vk-old".into()];
        s.current_track_id = Some("vk-old".into());
        merge_snapshot(&mut s, &[], &[]).unwrap();
        assert_eq!(s.tracks.len(), 1);
        assert_eq!(s.playlists[0].track_ids, vec!["local"]);
        assert!(s.queue.is_empty());
        assert!(s.current_track_id.is_none());
    }
    #[test]
    fn sync_rejects_combined_registry_larger_than_storage_capacity_without_mutation() {
        let mut state = crate::defaults();
        state.tracks.push(Track {
            id: "local-keep".into(),
            source: "local".into(),
            ..Default::default()
        });
        let tracks: Vec<Track> = (1..=MAX_ITEMS)
            .map(|id| Track {
                id: format!("vk-1-{id}"),
                source: "vk".into(),
                ..Default::default()
            })
            .collect();
        assert!(merge_snapshot(&mut state, &tracks, &[]).is_err());
        assert_eq!(state.tracks.len(), 1);
        assert_eq!(state.tracks[0].id, "local-keep");
    }
    #[test]
    fn current_searched_song_survives_sync_but_deleted_library_song_does_not() {
        let mut state = crate::defaults();
        let searched = map_tracks(&[json!({"owner_id":2,"id":7,"title":"search"})], false)
            .unwrap()
            .remove(0);
        let deleted = map_tracks(&[json!({"owner_id":1,"id":8,"title":"deleted"})], true)
            .unwrap()
            .remove(0);
        state.tracks = vec![searched.clone(), deleted.clone()];
        state.current_track_id = Some(searched.id.clone());
        state.queue = vec![searched.id.clone(), deleted.id.clone()];
        state.position = 12.0;
        merge_snapshot(&mut state, &[], &[]).unwrap();
        assert_eq!(state.tracks.len(), 1);
        assert_eq!(state.queue, vec![searched.id.clone()]);
        assert_eq!(state.current_track_id, Some(searched.id));
        assert_eq!(state.position, 12.0);
    }
}
