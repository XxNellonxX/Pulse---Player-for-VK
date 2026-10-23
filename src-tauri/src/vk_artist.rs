//! Read-only public artist metadata. Credentials and media stay in the VK page.
use crate::{data_dir, merge_web_search_results, now, vk_web, write_json, AppState, Track};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, time::Duration};
use tauri::{AppHandle, Manager};

const ADAPTER: &str = include_str!("vk_artist.js");
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Artist { id: String, name: String, photo: Option<String>, followed: Option<bool>, can_follow: Option<bool>, bio: Option<String>, listeners: Option<u64>, followers: Option<u64>, tracks: Vec<Track>, releases: Vec<Release>, checked_at: i64 }
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Release { id: String, owner_id: i64, playlist_id: i64, title: String, artist: String, artist_refs: Vec<Artist>, artwork: Option<String>, kind: String, year: Option<u32>, track_count: u64, plays: Option<u64>, released_at: Option<i64> }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Clip { track_id: String, from: f64, to: f64 }
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct ResultData { artists: Option<Vec<Artist>>, artist: Option<Artist>, releases: Option<Vec<Release>>, release: Option<Release>, tracks: Option<Vec<Track>>, artist_id: Option<String>, next_cursor: Option<String>, total_tracks: Option<u64>, clip: Option<Clip>, checked_at: i64, cached: bool, has_more: bool, message: Option<String> }
#[derive(Serialize, Deserialize, Default)]
struct Cache { account: i64, entries: BTreeMap<String, ResultData> }

fn text(value: &str, max: usize) -> String { value.chars().filter(|c| !c.is_control()).take(max).collect() }
fn artist_id(value: &str) -> bool { !value.is_empty() && value.len() <= 30 && value.bytes().all(|c| c.is_ascii_digit()) }
fn page_cursor(value: &str) -> bool { value.starts_with("at-") && (13..=103).contains(&value.len()) && value.bytes().all(|c|c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-') }
fn image(value: Option<String>) -> Option<String> { value.filter(|s| s.len() <= 4096 && url::Url::parse(s).ok().is_some_and(|u| u.scheme() == "https" && u.username().is_empty() && u.password().is_none() && u.port_or_known_default() == Some(443) && u.host_str().is_some_and(|h| h != "localhost" && !h.ends_with(".localhost") && !h.ends_with(".local") && h.trim_matches(['[', ']']).parse::<std::net::IpAddr>().is_err()))) }
fn clean_artist(a: &mut Artist) -> Result<(), String> {
    if !artist_id(&a.id) || a.name.is_empty() || a.tracks.len() > 500 || a.releases.len() > 200 { return Err("VK вернул некорректную карточку артиста.".into()); }
    a.name = text(&a.name, 200); a.photo = image(a.photo.take()); a.bio = a.bio.take().map(|s|text(&s, 3000));
    for t in &mut a.tracks { clean_track(t)?; } for r in &mut a.releases { clean_release(r)?; } Ok(())
}
fn clean_release(r: &mut Release) -> Result<(), String> {
    if r.owner_id == 0 || r.owner_id.unsigned_abs() > 9_007_199_254_740_991 || r.playlist_id <= 0 || r.playlist_id > 9_007_199_254_740_991 || r.id != format!("vk-playlist-{}-{}", r.owner_id, r.playlist_id) || r.track_count > 100_000 || r.artist_refs.len() > 20 || !matches!(r.kind.as_str(), "album"|"ep"|"single"|"compilation"|"release") { return Err("VK вернул некорректный релиз.".into()); }
    r.title = text(&r.title, 500); r.artist = text(&r.artist, 500); r.artwork = image(r.artwork.take()); for a in &mut r.artist_refs { clean_artist(a)?; } Ok(())
}
fn clean_track(t: &mut Track) -> Result<(), String> {
    if !vk_web::valid_web_track(t) || !t.duration.is_finite() || !(0.0..=864000.0).contains(&t.duration) || t.artist_refs.len() > 20 { return Err("VK вернул некорректный трек.".into()); }
    t.title = text(&t.title, 500); t.artist = text(&t.artist, 500); t.album = text(&t.album, 500); t.artwork = image(t.artwork.take());
    t.artist_refs.retain(|a|artist_id(&a.id) && !a.name.is_empty()); for a in &mut t.artist_refs { a.name = text(&a.name, 200); }
    if let Some(r) = &mut t.remote { r.access_key = None; r.search_result = !r.in_library; } Ok(())
}
fn validate(mut result: ResultData) -> Result<ResultData, String> {
    if result.checked_at < 0 || result.checked_at > now() + 60_000 { return Err("VK вернул некорректное время обновления.".into()); }
    if let Some(rows) = &mut result.artists { if rows.len() > 500 { return Err("Слишком много артистов.".into()); } for a in rows { clean_artist(a)?; } }
    if let Some(a) = &mut result.artist { clean_artist(a)?; }
    if let Some(rows) = &mut result.releases { if rows.len() > 200 { return Err("Слишком много релизов.".into()); } for r in rows { clean_release(r)?; } }
    if let Some(r) = &mut result.release { clean_release(r)?; }
    if let Some(rows) = &mut result.tracks { if rows.len() > 500 { return Err("Слишком много треков.".into()); } for t in rows { clean_track(t)?; } }
    if result.clip.as_ref().is_some_and(|c| !c.track_id.starts_with("vk-") || !c.from.is_finite() || !c.to.is_finite() || c.from < 0.0 || c.to <= c.from || c.to - c.from > 120.0) { return Err("VK вернул некорректный сниппет.".into()); }
    if result.artist_id.as_ref().is_some_and(|id|!artist_id(id)) || result.next_cursor.as_ref().is_some_and(|cursor|!page_cursor(cursor)) || result.total_tracks.is_some_and(|total|total > 1_000_000) { return Err("VK вернул некорректную страницу треков артиста.".into()); }
    result.message = result.message.take().map(|s|text(&s, 500)); Ok(result)
}
fn decode_web_result(mut value: Value) -> Result<ResultData, String> {
    // WebView2 serializes JavaScript integers as JSON floats in callbacks.
    // Normalize only this protocol's integer fields; artist IDs stay exact
    // decimal strings and clip/duration values retain their fractional part.
    fn normalize(value: &mut Value) -> Result<(), String> {
        match value {
            Value::Array(rows) => for row in rows { normalize(row)?; },
            Value::Object(fields) => for (key, value) in fields {
                if matches!(key.as_str(),"checkedAt"|"ownerId"|"playlistId"|"trackCount"|"totalTracks"|"plays"|"releasedAt"|"year"|"listeners"|"followers"|"addedAt"|"audioId") && value.is_number() {
                    let number = value.as_f64().filter(|n|n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0).ok_or("VK вернул некорректный числовой параметр каталога.")?;
                    *value = json!(number as i64);
                } else { normalize(value)?; }
            },
            _=>{},
        }
        Ok(())
    }
    normalize(&mut value)?;
    serde_json::from_value(value).map_err(|_|"VK изменил формат каталога артистов.".into())
}
fn matches_request(result: &ResultData, input: &Value) -> bool {
    match input.get("action").and_then(Value::as_str).unwrap_or("") {
        "resolve" => result.artists.is_some(),
        "artist" => result.artist.as_ref().is_some_and(|a|Some(a.id.as_str()) == input.get("artistId").and_then(Value::as_str)),
        "artist-tracks" => result.artist_id.as_deref() == input.get("artistId").and_then(Value::as_str) && result.tracks.as_ref().is_some_and(|tracks|tracks.len() <= 100) && result.has_more == result.next_cursor.is_some(),
        "follow" => result.artist.as_ref().is_some_and(|a|Some(a.id.as_str()) == input.get("artistId").and_then(Value::as_str) && a.followed == input.get("follow").and_then(Value::as_bool)),
        "release" => result.release.as_ref().is_some_and(|r|Some(r.id.as_str()) == input.get("releaseId").and_then(Value::as_str)) && result.tracks.is_some(),
        "updates" => result.artists.is_some() && result.releases.is_some(),
        "snippets" => result.tracks.is_some(),
        "recommendations" => result.tracks.as_ref().is_some_and(|tracks|tracks.len() <= 100),
        "snippet" => result.clip.as_ref().is_some_and(|c|Some(c.track_id.as_str()) == input.get("trackId").and_then(Value::as_str)),
        _=> false,
    }
}
fn cache_read(app: &AppHandle, account: i64) -> Cache {
    let path = data_dir(app).join("artist-catalog.json");
    if std::fs::metadata(&path).is_ok_and(|m|m.len() <= 6_000_000) {
        if let Some(c) = std::fs::read(&path).ok().and_then(|bytes|serde_json::from_slice::<Cache>(&bytes).ok()).filter(|c|c.account == account && c.entries.len() <= 30) { return c; }
    }
    Cache { account, ..Cache::default() }
}
fn register(app: &AppHandle, guard: &vk_web::UploadGuard, result: &mut ResultData) -> Result<(), String> {
    let shared = app.state::<AppState>(); let _storage = shared.storage_lock.lock().unwrap();
    if !vk_web::check_upload_guard(app, guard) { return Err("Аккаунт VK изменился. Запрос отменён.".into()); }
    let mut rows = result.tracks.clone().unwrap_or_default(); if let Some(a) = &result.artist { rows.extend(a.tracks.clone()); }
    if rows.is_empty() { return Ok(()); }
    let mut state = shared.state.lock().unwrap(); merge_web_search_results(&mut state, &mut rows)?;
    let known: BTreeMap<_,_> = rows.into_iter().map(|t|(t.id.clone(),t)).collect();
    if let Some(rows) = &mut result.tracks { for t in rows { if let Some(found) = known.get(&t.id) { *t = found.clone(); } } }
    if let Some(a) = &mut result.artist { for t in &mut a.tracks { if let Some(found) = known.get(&t.id) { *t = found.clone(); } } } Ok(())
}
fn cached_track_ids(result: &ResultData) -> Vec<String> {
    let mut ids: Vec<_> = result.tracks.iter().flatten().chain(result.artist.iter().flat_map(|a|a.tracks.iter())).map(|t|t.id.clone()).collect(); ids.sort(); ids.dedup(); ids
}
async fn hydrate_cached(app: &AppHandle, expected: &vk_web::UploadGuard, result: &mut ResultData) -> Result<(), String> {
    let ids = cached_track_ids(result);
    // Cards without audio (artist lookup/update feed) do not need a remote
    // registry. Release opening fetches its exact public ID independently.
    if ids.is_empty() { return Ok(()); }
    if ids.len() > 500 { return Err("Слишком большой сохранённый каталог.".into()); }
    let window = app.get_webview_window("vk-music").ok_or("Подключите VK.")?;
    let key = serde_json::to_string(&format!("artist-warm-{}-{}",now(),rand::random::<u64>())).unwrap();
    let scope = format!("if(window.top!==window.self||!['https://vk.com','https://vk.ru'].includes(location.origin)||Number(window.vk?.id)!=={})return {{complete:true,error:'Аккаунт VK изменился. Повторите запрос.'}};",expected.account_id);
    if !vk_web::check_upload_guard(app,expected) { return Err("Аккаунт VK изменился.".into()); }
    let input = json!({"action":"hydrate","ids":ids});
    let start = vk_web::evaluate(&window,format!("(()=>{{{scope}{ADAPTER};return {{accepted:window.__PULSE_VK_ARTISTS__?.start({key},{input},{})===true}};}})()",expected.account_id)).await?;
    if start.get("accepted").and_then(Value::as_bool) != Some(true) { return Err("VK ещё не готов восстановить сохранённую музыку.".into()); }
    let deadline = tokio::time::Instant::now()+Duration::from_secs(45);
    let fresh = loop {
        if !vk_web::check_upload_guard(app,expected) { return Err("Аккаунт VK изменился. Восстановление каталога отменено.".into()); }
        let receipt = vk_web::evaluate(&window,format!("(()=>{{{scope}return window.__PULSE_VK_ARTISTS__?.read({key},{})||{{complete:true,error:'Окно VK изменилось. Повторите запрос.'}};}})()",expected.account_id)).await?;
        if receipt.get("complete").and_then(Value::as_bool) == Some(true) {
            if let Some(e) = receipt.get("error").and_then(Value::as_str) { return Err(text(e,500)); }
            let fresh = decode_web_result(receipt.get("result").cloned().ok_or("VK не восстановил треки каталога.")?)?;
            break validate(fresh)?;
        }
        if tokio::time::Instant::now()>=deadline { return Err("VK не восстановил сохранённые треки вовремя.".into()); }
        tokio::time::sleep(Duration::from_millis(200)).await;
    };
    let rows = fresh.tracks.ok_or("VK не восстановил треки каталога.")?;
    let found: BTreeMap<_,_> = rows.into_iter().map(|t|(t.id.clone(),t)).collect();
    if ids.len() != found.len() || ids.iter().any(|id|!found.contains_key(id)) { return Err("VK не подтвердил все сохранённые треки. Обновите карточку.".into()); }
    if let Some(rows) = &mut result.tracks { for t in rows { *t = found[&t.id].clone(); } }
    if let Some(a) = &mut result.artist { for t in &mut a.tracks { *t = found[&t.id].clone(); } }
    Ok(())
}
#[tauri::command]
pub async fn vk_artist_music(app: AppHandle, input: Value) -> Result<Value, String> {
    let action = input.get("action").and_then(Value::as_str).ok_or("Выберите раздел музыки.")?;
    if !matches!(action,"resolve"|"artist"|"artist-tracks"|"release"|"updates"|"follow"|"snippets"|"snippet"|"recommendations") { return Err("Неизвестный раздел музыки.".into()); }
    let mut safe = json!({"action":action});
    for (field, max) in [("query",200),("artistId",30),("releaseId",100),("trackId",100),("cursor",103)] { if let Some(v) = input.get(field) { let s = v.as_str().filter(|s|!s.is_empty() && s.len() <= max).ok_or("Некорректный запрос музыки.")?; safe[field] = json!(s); } }
    if matches!(action,"artist"|"artist-tracks"|"follow") && !safe.get("artistId").and_then(Value::as_str).is_some_and(artist_id) { return Err("Выберите артиста VK.".into()); }
    if safe.get("cursor").is_some_and(|value|action != "artist-tracks" || !value.as_str().is_some_and(page_cursor)) { return Err("Некорректная страница треков артиста.".into()); }
    if action == "resolve" && safe.get("query").and_then(Value::as_str).is_none_or(|s|s.trim().is_empty()) { return Err("Введите имя артиста.".into()); }
    if action == "follow" { safe["follow"] = json!(input.get("follow").and_then(Value::as_bool).ok_or("Выберите состояние подписки.")?); }
    let expected = vk_web::upload_guard(&app).map_err(|_|"Подключите VK для каталога артистов.".to_string())?;
    let cache_key = serde_json::to_string(&safe).unwrap();
    let cacheable = matches!(action,"artist"|"release"|"resolve"|"updates");
    let cached = if cacheable { let shared = app.state::<AppState>(); let _storage = shared.storage_lock.lock().unwrap(); cache_read(&app,expected.account_id).entries.remove(&cache_key).and_then(|r|validate(r).ok()).filter(|r|matches_request(r,&safe)) } else { None };
    let ttl = if action == "updates" { 300_000 } else { 600_000 };
    if !input.get("force").and_then(Value::as_bool).unwrap_or(false) { if let Some(mut c) = cached.clone().filter(|c|now() - c.checked_at < ttl) { if hydrate_cached(&app,&expected,&mut c).await.is_ok() { c.cached = true; register(&app,&expected,&mut c)?; return serde_json::to_value(c).map_err(|e|e.to_string()); } } }
    let window = app.get_webview_window("vk-music").ok_or("Подключите VK.")?;
    let key = serde_json::to_string(&format!("artist-{}-{}",now(),rand::random::<u64>())).unwrap();
    let scope = format!("if(window.top!==window.self||!['https://vk.com','https://vk.ru'].includes(location.origin)||Number(window.vk?.id)!=={})return {{complete:true,error:'Аккаунт VK изменился. Повторите запрос.'}};",expected.account_id);
    let fetched: Result<ResultData,String> = async {
        if !vk_web::check_upload_guard(&app,&expected) { return Err("Аккаунт VK изменился.".into()); }
        let start = vk_web::evaluate(&window,format!("(()=>{{{scope}{ADAPTER};return {{accepted:window.__PULSE_VK_ARTISTS__?.start({key},{safe},{})===true}};}})()",expected.account_id)).await?;
        if start.get("accepted").and_then(Value::as_bool) != Some(true) { return Err("Каталог артистов VK ещё не готов. Повторите через несколько секунд.".into()); }
        let deadline = tokio::time::Instant::now()+Duration::from_secs(45);
        loop {
            if !vk_web::check_upload_guard(&app,&expected) { return Err("Аккаунт VK изменился. Запрос отменён.".into()); }
            let receipt = vk_web::evaluate(&window,format!("(()=>{{{scope}return window.__PULSE_VK_ARTISTS__?.read({key},{})||{{complete:true,error:'Окно VK изменилось. Повторите запрос.'}};}})()",expected.account_id)).await?;
            if receipt.get("complete").and_then(Value::as_bool) == Some(true) {
                if let Some(e) = receipt.get("error").and_then(Value::as_str) { return Err(text(e,500)); }
                let result = decode_web_result(receipt.get("result").cloned().ok_or("VK не предоставил результат.")?)?;
                let result = validate(result)?;
                if !matches_request(&result,&safe) { return Err("VK не подтвердил запрошенную карточку. Повторите запрос.".into()); }
                return Ok(result);
            }
            if tokio::time::Instant::now()>=deadline { return Err("VK не ответил вовремя. Повторите запрос.".into()); }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }.await;
    let mut result = match fetched { Ok(r)=>r, Err(e)=> { if let Some(mut c) = cached { if vk_web::check_upload_guard(&app,&expected) && hydrate_cached(&app,&expected,&mut c).await.is_ok() { c.cached = true; c.message = Some(format!("Показана сохранённая карточка. {e}")); register(&app,&expected,&mut c)?; return serde_json::to_value(c).map_err(|e|e.to_string()); } } return Err(e); } };
    register(&app,&expected,&mut result)?;
    if cacheable || action == "follow" {
        let shared = app.state::<AppState>(); let _storage = shared.storage_lock.lock().unwrap();
        if !vk_web::check_upload_guard(&app,&expected) { return Err("Аккаунт VK изменился. Запрос отменён.".into()); }
        let mut cache = cache_read(&app,expected.account_id);
        if action == "follow" { cache.entries.clear(); } else { cache.entries.insert(cache_key,result.clone()); }
        while cache.entries.len()>30 { if let Some(old) = cache.entries.iter().min_by_key(|(_,r)|r.checked_at).map(|(k,_)|k.clone()) { cache.entries.remove(&old); } }
        if serde_json::to_vec(&cache).is_ok_and(|v|v.len() <= 6_000_000) { let _ = write_json(&data_dir(&app).join("artist-catalog.json"),&cache,false); }
    }
    serde_json::to_value(result).map_err(|e|e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn preserves_large_artist_ids_and_rejects_private_art() { let mut a = Artist{id:"6749485843676900230".into(),name:"Daft Punk".into(),photo:Some("https://127.0.0.1/test".into()),..Default::default()}; clean_artist(&mut a).unwrap(); assert_eq!(a.id,"6749485843676900230"); assert!(a.photo.is_none()); assert!(image(Some("https://x.local/image".into())).is_none()); }
    #[test] fn invalid_clips_and_fake_native_sources_are_rejected() { assert!(validate(ResultData{checked_at:now(),clip:Some(Clip{track_id:"vk-1-2".into(),from:30.0,to:10.0}),..Default::default()}).is_err()); let t = Track{source:"vk".into(),url:"https://cdn.example/audio.mp3".into(),..Default::default()}; assert!(validate(ResultData{checked_at:now(),tracks:Some(vec![t]),..Default::default()}).is_err()); }
    #[test] fn receipts_must_match_artist_and_confirmed_follow_state() { let r = ResultData{artist:Some(Artist{id:"6749485843676900230".into(),followed:Some(false),..Default::default()}),..Default::default()}; assert!(!matches_request(&r,&json!({"action":"artist","artistId":"5428185118660812105"}))); assert!(!matches_request(&r,&json!({"action":"follow","artistId":"6749485843676900230","follow":true}))); assert!(matches_request(&r,&json!({"action":"artist","artistId":"6749485843676900230"}))); }
    #[test] fn warm_cache_hydration_uses_only_unique_exact_audio_identities() { let track = Track{id:"vk--200-1".into(),..Default::default()}; let result = ResultData{tracks:Some(vec![track.clone()]),artist:Some(Artist{tracks:vec![track],..Default::default()}),..Default::default()}; assert_eq!(cached_track_ids(&result),vec!["vk--200-1".to_string()]); }
    #[test] fn webview_float_integers_decode_in_artist_release_tracks_and_snippets() {
        let raw: Value = serde_json::from_str(r#"{"checkedAt":1792562400000.0,"artist":{"id":"6749485843676900230","name":"Daft Punk","checkedAt":1792562400000.0,"listeners":12345.0,"followers":42.0,"tracks":[{"id":"vk--200-1","source":"vk","url":"vk-web://-200/1","duration":300.125,"addedAt":123456.0,"remote":{"ownerId":-200.0,"audioId":1.0}}],"releases":[{"id":"vk-playlist--200-9","ownerId":-200.0,"playlistId":9.0,"title":"Album","kind":"album","trackCount":12.0,"plays":1234567.0,"year":2026.0,"releasedAt":1792562000000.0}]},"clip":{"trackId":"vk--200-1","from":0.001,"to":30.001}}"#).unwrap();
        assert!(serde_json::from_value::<ResultData>(raw.clone()).is_err());
        let result = validate(decode_web_result(raw).unwrap()).unwrap();
        let artist = result.artist.unwrap(); assert_eq!(artist.id,"6749485843676900230"); assert_eq!(artist.tracks[0].remote.as_ref().unwrap().owner_id,-200); assert_eq!(artist.releases[0].plays,Some(1234567)); assert_eq!(artist.tracks[0].duration,300.125); assert_eq!(result.clip.unwrap().from,0.001);
    }
    #[test] fn resolve_webview_timestamp_float_decodes_and_fractional_or_unsafe_integers_fail() {
        let raw = json!({"checkedAt":1792562400000.0,"artists":[{"id":"6749485843676900230","name":"Daft Punk"}]}); assert_eq!(decode_web_result(raw).unwrap().artists.unwrap()[0].id,"6749485843676900230");
        assert!(decode_web_result(json!({"checkedAt":1.5})).is_err()); assert!(decode_web_result(json!({"checkedAt":9007199254740992.0})).is_err()); assert!(decode_web_result(json!({"checkedAt":0,"artist":{"id":6749485843676900230.0,"name":"Wrong"}})).is_err());
    }
    #[test] fn artist_page_receipts_match_exact_artist_and_require_continuation_consistency() {
        let mut page = ResultData{artist_id:Some("6749485843676900230".into()),tracks:Some(vec![]),checked_at:now(),..Default::default()};
        let input = json!({"action":"artist-tracks","artistId":"6749485843676900230"});
        assert!(matches_request(&page,&input)); assert!(!matches_request(&page,&json!({"action":"artist-tracks","artistId":"123"})));
        page.has_more = true; assert!(!matches_request(&page,&input));
        page.next_cursor = Some("at-abcde12345-xyz123456".into()); assert!(matches_request(&page,&input)); assert!(validate(page.clone()).is_ok());
        page.next_cursor = Some("https://vk.ru/private?key=secret".into()); assert!(validate(page).is_err());
    }
    #[test] fn recommendations_are_bounded_and_artist_count_webview_float_decodes() {
        let decoded = decode_web_result(json!({"checkedAt":0.0,"totalTracks":101.0,"artistId":"123","tracks":[]})).unwrap(); assert_eq!(decoded.total_tracks,Some(101));
        assert!(matches_request(&decoded,&json!({"action":"recommendations"})));
        let oversized = ResultData{tracks:Some(vec![Track::default();101]),..Default::default()}; assert!(!matches_request(&oversized,&json!({"action":"recommendations"})));
    }
}
