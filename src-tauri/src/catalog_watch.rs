//! Bounded, profile-local MusicBrainz subscriptions and metadata discoveries.
//! A discovery means a record appeared since a page's baseline, not an artist announcement.
use crate::musicbrainz_catalog::{ArtistPage, ArtistSummary, ReleaseGroup};
use serde::{Deserialize, Serialize};
use std::{collections::{HashMap, HashSet}, fs, io::Read, path::{Path, PathBuf}, sync::{Mutex, OnceLock}};
use tauri::{AppHandle, Emitter};

const FOLLOW_INTERVAL: i64 = 6 * 60 * 60 * 1000;
const OPENED_INTERVAL: i64 = 24 * 60 * 60 * 1000;
const RECENT_RETENTION: i64 = 14 * 24 * 60 * 60 * 1000;
const MAX_ARTISTS: usize = 100;
const MAX_FOLLOWED: usize = 80;
const MAX_UPDATES: usize = 100;
const MAX_KNOWN: usize = 512;
const MAX_PAGE_OFFSET: u32 = 270;
const MAX_PER_RUN: usize = 20;
const MAX_FILE_BYTES: u64 = 3 * 1024 * 1024;
const STORAGE_ERROR: &str = "Не удалось прочитать или сохранить подписки каталога. Сохранённые данные не изменены.";
static PROFILES: OnceLock<Mutex<HashMap<PathBuf, Runtime>>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchedArtist {
    pub artist: ArtistSummary,
    pub followed: bool,
    pub opened_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_checked_at: Option<i64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseUpdate {
    pub artist: ArtistSummary,
    pub release: ReleaseGroup,
    pub discovered_at: i64,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchState {
    pub artists: Vec<WatchedArtist>,
    pub updates: Vec<ReleaseUpdate>,
    pub refreshing: bool,
    pub revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_refresh_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_refresh_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    #[serde(flatten)]
    value: WatchedArtist,
    known: Vec<String>,
    baseline_pages: Vec<u32>,
    next_page_offset: u32,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WatchFile {
    version: u32,
    artists: Vec<Entry>,
    updates: Vec<ReleaseUpdate>,
    last_refresh_at: Option<i64>,
    next_refresh_at: Option<i64>,
    failures: u32,
}
impl Default for WatchFile {
    fn default() -> Self { Self { version: 1, artists: vec![], updates: vec![], last_refresh_at: None, next_refresh_at: None, failures: 0 } }
}
struct Runtime {
    file: WatchFile,
    generation: u64,
    revision: u64,
    refreshing: bool,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
    error: Option<String>,
}
impl Runtime {
    fn state(&self) -> WatchState {
        WatchState { artists: self.file.artists.iter().map(|entry| entry.value.clone()).collect(), updates: self.file.updates.clone(), refreshing: self.refreshing, revision: self.revision, last_refresh_at: self.file.last_refresh_at, next_refresh_at: self.file.next_refresh_at, error: self.error.clone() }
    }
}
fn id_valid(value: &str) -> bool {
    value.len() == 36 && value != "00000000-0000-0000-0000-000000000000" && value.bytes().enumerate().all(|(i, b)| if [8,13,18,23].contains(&i) { b == b'-' } else { b.is_ascii_hexdigit() })
}
fn text_valid(value: &str, max: usize) -> bool { !value.is_empty() && value.chars().count() <= max && !value.chars().any(char::is_control) }
fn summary_valid(artist: &ArtistSummary) -> bool {
    id_valid(&artist.id) && text_valid(&artist.name, 300) && artist.sort_name.chars().count() <= 300 && !artist.sort_name.chars().any(char::is_control) && artist.disambiguation.chars().count() <= 1000 && !artist.disambiguation.chars().any(char::is_control)
        && artist.kind.as_ref().map_or(true, |value| text_valid(value, 80)) && artist.country.as_ref().map_or(true, |value| value.len() == 2 && value.bytes().all(|byte| byte.is_ascii_uppercase()))
}
fn valid_file(file: &WatchFile) -> bool {
    let mut ids = HashSet::new();
    file.version == 1 && file.artists.len() <= MAX_ARTISTS && file.artists.iter().filter(|entry| entry.value.followed).count() <= MAX_FOLLOWED
        && file.updates.len() <= MAX_UPDATES && file.failures <= 6
        && file.artists.iter().all(|entry| summary_valid(&entry.value.artist) && ids.insert(entry.value.artist.id.clone()) && entry.known.len() <= MAX_KNOWN && entry.known.iter().all(|id| id_valid(id)) && entry.baseline_pages.len() <= 10 && entry.baseline_pages.iter().all(|offset| *offset <= MAX_PAGE_OFFSET && offset % 30 == 0) && entry.next_page_offset <= MAX_PAGE_OFFSET && entry.next_page_offset % 30 == 0)
        && file.updates.iter().all(|update| summary_valid(&update.artist) && id_valid(&update.release.id) && text_valid(&update.release.title, 400) && update.release.secondary_types.len() <= 10 && update.release.secondary_types.iter().all(|value| text_valid(value, 80)) && update.release.primary_type.as_ref().map_or(true, |value| text_valid(value, 80)) && update.release.first_release_date.as_ref().map_or(true, |value| value.len() <= 10 && value.bytes().all(|byte| byte.is_ascii_digit() || byte == b'-')) && file.artists.iter().any(|entry| entry.value.followed && entry.value.artist.id == update.artist.id))
}
fn read_file(profile: &Path) -> Result<WatchFile, String> {
    let path = profile.join("catalog-watchlist.json");
    let file = match fs::File::open(path) { Ok(file) => file, Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(WatchFile::default()), Err(_) => return Err(STORAGE_ERROR.into()) };
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes).map_err(|_| STORAGE_ERROR)?;
    if bytes.len() as u64 > MAX_FILE_BYTES { return Err(STORAGE_ERROR.into()); }
    let file: WatchFile = serde_json::from_slice(&bytes).map_err(|_| STORAGE_ERROR)?;
    if !valid_file(&file) { return Err(STORAGE_ERROR.into()); }
    Ok(file)
}
fn save_file(profile: &Path, file: &WatchFile) -> Result<(), String> {
    if !valid_file(file) || serde_json::to_vec(file).map_err(|_| STORAGE_ERROR)?.len() as u64 > MAX_FILE_BYTES { return Err(STORAGE_ERROR.into()); }
    crate::write_json(&profile.join("catalog-watchlist.json"), file, false).map_err(|_| STORAGE_ERROR.into())
}
fn with_runtime<T>(profile: &Path, apply: impl FnOnce(&mut Runtime) -> Result<T, String>) -> Result<T, String> {
    let mut profiles = PROFILES.get_or_init(|| Mutex::new(HashMap::new())).lock().map_err(|_| STORAGE_ERROR)?;
    if !profiles.contains_key(profile) {
        if profiles.len() >= 4 {
            if let Some(key) = profiles.iter().find(|(_, value)| !value.refreshing).map(|(key, _)| key.clone()) { profiles.remove(&key); }
            else { return Err(STORAGE_ERROR.into()); }
        }
        let file = read_file(profile)?;
        profiles.insert(profile.into(), Runtime { file, generation: 0, revision: 0, refreshing: false, task: None, error: None });
    }
    apply(profiles.get_mut(profile).ok_or(STORAGE_ERROR)?)
}
fn emit(app: &AppHandle, state: &WatchState) { let _ = app.emit("catalog:updates", state); }

fn seed_page(entry: &mut Entry, page: &ArtistPage) {
    if page.stale || page.offset > MAX_PAGE_OFFSET || page.offset % 30 != 0 { return; }
    for release in &page.releases {
        if !entry.known.contains(&release.id) { entry.known.push(release.id.clone()); }
    }
    while entry.known.len() > MAX_KNOWN { entry.known.remove(0); }
    if page.offset <= MAX_PAGE_OFFSET && !entry.baseline_pages.contains(&page.offset) { entry.baseline_pages.push(page.offset); }
}
pub(crate) fn record_open(app: &AppHandle, page: &ArtistPage) {
    let profile = crate::data_dir(app);
    let now = crate::now();
    let result = with_runtime(&profile, |runtime| {
        let mut next = runtime.file.clone();
        if !next.artists.iter().any(|entry| entry.value.artist.id == page.artist.summary.id) {
            if next.artists.len() >= MAX_ARTISTS {
                if let Some((index, _)) = next.artists.iter().enumerate().filter(|(_, entry)| !entry.value.followed).min_by_key(|(_, entry)| entry.value.opened_at) { next.artists.remove(index); }
                else { return Ok(runtime.state()); }
            }
            next.artists.push(Entry { value: WatchedArtist { artist: page.artist.summary.clone(), followed: false, opened_at: now, last_checked_at: None }, known: vec![], baseline_pages: vec![], next_page_offset: 30 });
            if next.failures == 0 { next.next_refresh_at = None; }
        }
        if let Some(entry) = next.artists.iter_mut().find(|entry| entry.value.artist.id == page.artist.summary.id) {
            entry.value.artist = page.artist.summary.clone(); entry.value.opened_at = now;
            if !entry.value.followed { seed_page(entry, page); }
        }
        save_file(&profile, &next)?; runtime.file = next; runtime.revision = runtime.revision.wrapping_add(1); Ok(runtime.state())
    });
    if let Ok(state) = result { emit(app, &state); }
}

#[tauri::command]
pub async fn catalog_watch_status(app: AppHandle) -> Result<WatchState, String> {
    with_runtime(&crate::data_dir(&app), |runtime| Ok(runtime.state()))
}
#[tauri::command]
pub async fn catalog_set_followed(app: AppHandle, id: String, followed: bool) -> Result<WatchState, String> {
    if !id_valid(&id) { return Err("Откройте карточку артиста перед подпиской.".into()); }
    let profile = crate::data_dir(&app);
    let state = with_runtime(&profile, |runtime| {
        let mut next = runtime.file.clone();
        if followed && next.artists.iter().filter(|entry| entry.value.followed && entry.value.artist.id != id).count() >= MAX_FOLLOWED { return Err("Достигнут предел локальных подписок: 80 артистов.".into()); }
        let entry = next.artists.iter_mut().find(|entry| entry.value.artist.id == id).ok_or("Сначала откройте карточку артиста из каталога.")?;
        if followed && !entry.value.followed {
            entry.known.clear(); entry.baseline_pages.clear(); entry.value.last_checked_at = None;
            if next.failures == 0 { next.next_refresh_at = None; }
        }
        entry.value.followed = followed;
        if !followed { next.updates.retain(|update| update.artist.id != id); }
        save_file(&profile, &next)?; runtime.file = next; runtime.revision = runtime.revision.wrapping_add(1); Ok(runtime.state())
    })?;
    emit(&app, &state); Ok(state)
}
fn due_artists(file: &WatchFile, now: i64) -> Vec<String> {
    let mut entries: Vec<_> = file.artists.iter().filter(|entry| {
        (entry.value.followed || now.saturating_sub(entry.value.opened_at) <= RECENT_RETENTION)
            && entry.value.last_checked_at.map_or(true, |last| now.saturating_sub(last) >= if entry.value.followed { FOLLOW_INTERVAL } else { OPENED_INTERVAL })
    }).collect();
    entries.sort_by_key(|entry| (entry.value.last_checked_at.unwrap_or(0), !entry.value.followed, entry.value.opened_at));
    entries.into_iter().take(MAX_PER_RUN).map(|entry| entry.value.artist.id.clone()).collect()
}
fn next_due_at(file: &WatchFile, now: i64) -> Option<i64> {
    file.artists.iter().filter(|entry| entry.value.followed || now.saturating_sub(entry.value.opened_at) <= RECENT_RETENTION)
        .map(|entry| entry.value.last_checked_at.map(|last| last.saturating_add(if entry.value.followed { FOLLOW_INTERVAL } else { OPENED_INTERVAL })).unwrap_or(now))
        .min()
}
fn schedule_after_run(file: &WatchFile, now: i64, failure: bool) -> Option<i64> {
    if failure {
        let delay = (15 * 60 * 1000_i64 * (1_i64 << file.failures.saturating_sub(1).min(5))).min(FOLLOW_INTERVAL);
        Some(now.saturating_add(delay))
    } else {
        next_due_at(file, now).map(|next| if next <= now { now + 15 * 60 * 1000 } else { next })
    }
}
fn apply_page(file: &mut WatchFile, page: &ArtistPage, now: i64) {
    let Some(entry) = file.artists.iter_mut().find(|entry| entry.value.artist.id == page.artist.summary.id) else { return; };
    if page.stale { return; }
    let baseline = entry.baseline_pages.contains(&page.offset);
    let unseen: Vec<_> = page.releases.iter().filter(|release| !entry.known.contains(&release.id)).cloned().collect();
    if baseline && entry.value.followed {
        for release in unseen {
            if !file.updates.iter().any(|update| update.artist.id == entry.value.artist.id && update.release.id == release.id) {
                file.updates.insert(0, ReleaseUpdate { artist: page.artist.summary.clone(), release, discovered_at: now });
            }
        }
    }
    entry.value.artist = page.artist.summary.clone();
    seed_page(entry, page);
    if page.offset > 0 { entry.next_page_offset = if page.has_more && page.offset < MAX_PAGE_OFFSET { (page.offset + 30).min(MAX_PAGE_OFFSET) } else { 30 }; }
    file.updates.truncate(MAX_UPDATES);
}
fn running(profile: &Path, generation: u64) -> bool { with_runtime(profile, |runtime| Ok(runtime.refreshing && runtime.generation == generation)).unwrap_or(false) }
async fn run_refresh(app: AppHandle, profile: PathBuf, generation: u64, ids: Vec<String>) {
    let mut failure = false;
    for id in ids {
        if !running(&profile, generation) { return; }
        let offset = with_runtime(&profile, |runtime| Ok(runtime.file.artists.iter().find(|entry| entry.value.artist.id == id).map(|entry| entry.next_page_offset).unwrap_or(30))).unwrap_or(30);
        let first = match crate::musicbrainz_catalog::refresh_catalog_artist(&app, &id, 0).await { Ok(page) if !page.stale => page, _ => { failure = true; break; } };
        if !running(&profile, generation) { return; }
        let more = first.has_more;
        let mut pages = vec![first];
        if more {
            match crate::musicbrainz_catalog::refresh_catalog_artist(&app, &id, offset).await { Ok(page) if !page.stale => pages.push(page), _ => { failure = true; break; } }
        }
        let state = with_runtime(&profile, |runtime| {
            if !runtime.refreshing || runtime.generation != generation { return Ok(None); }
            let mut next = runtime.file.clone();
            for page in &pages { apply_page(&mut next, page, crate::now()); }
            if let Some(entry) = next.artists.iter_mut().find(|entry| entry.value.artist.id == id) { entry.value.last_checked_at = Some(crate::now()); }
            save_file(&profile, &next)?; runtime.file = next; runtime.revision = runtime.revision.wrapping_add(1); Ok(Some(runtime.state()))
        });
        match state { Ok(Some(state)) => emit(&app, &state), Ok(None) => return, Err(_) => { failure = true; break; } }
    }
    let state = with_runtime(&profile, |runtime| {
        if runtime.generation != generation { return Ok(None); }
        let mut next = runtime.file.clone();
        next.last_refresh_at = Some(crate::now());
        next.failures = if failure { (next.failures + 1).min(6) } else { 0 };
        next.next_refresh_at = schedule_after_run(&next, crate::now(), failure);
        runtime.refreshing = false; runtime.task = None;
        runtime.error = failure.then(|| "Каталог сейчас недоступен. Сохранённые релизы доступны; проверка повторится позже.".into());
        if save_file(&profile, &next).is_err() {
            runtime.error = Some(STORAGE_ERROR.into());
            next.next_refresh_at = Some(crate::now() + 15 * 60 * 1000);
        }
        runtime.file = next; runtime.revision = runtime.revision.wrapping_add(1);
        Ok(Some(runtime.state()))
    });
    if let Ok(Some(state)) = state { emit(&app, &state); }
}

#[tauri::command]
pub async fn catalog_refresh(app: AppHandle) -> Result<WatchState, String> {
    let profile = crate::data_dir(&app);
    let now = crate::now();
    let prepared = with_runtime(&profile, |runtime| {
        if runtime.refreshing || runtime.file.next_refresh_at.is_some_and(|time| time > now) { return Ok((runtime.state(), None)); }
        let ids = due_artists(&runtime.file, now);
        if ids.is_empty() { return Ok((runtime.state(), None)); }
        runtime.generation = runtime.generation.wrapping_add(1); runtime.revision = runtime.revision.wrapping_add(1); runtime.refreshing = true; runtime.error = None;
        Ok((runtime.state(), Some((runtime.generation, ids))))
    })?;
    if let Some((generation, ids)) = prepared.1 {
        emit(&app, &prepared.0);
        let worker_app = app.clone(); let worker_profile = profile.clone();
        let task = tauri::async_runtime::spawn(async move { run_refresh(worker_app, worker_profile, generation, ids).await; });
        with_runtime(&profile, |runtime| { if runtime.generation == generation && runtime.refreshing { runtime.task = Some(task); } else { task.abort(); } Ok(()) })?;
    }
    Ok(prepared.0)
}
#[tauri::command]
pub async fn catalog_cancel_refresh(app: AppHandle) -> Result<WatchState, String> {
    let state = with_runtime(&crate::data_dir(&app), |runtime| {
        runtime.generation = runtime.generation.wrapping_add(1); runtime.revision = runtime.revision.wrapping_add(1); runtime.refreshing = false;
        if let Some(task) = runtime.task.take() { task.abort(); }
        Ok(runtime.state())
    })?;
    emit(&app, &state); Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn summary(n: usize) -> ArtistSummary { ArtistSummary { id: format!("00000000-0000-4000-8000-{n:012}"), name: format!("Artist {n}"), sort_name: format!("Artist {n}"), disambiguation: String::new(), kind: None, country: None } }
    fn page(n: usize, releases: &[usize], offset: u32) -> ArtistPage { ArtistPage { artist: crate::musicbrainz_catalog::ArtistDetails { summary: summary(n), description: None, links: vec![], tags: vec![] }, releases: releases.iter().map(|n| ReleaseGroup { id: format!("10000000-0000-4000-8000-{n:012}"), title: format!("Release {n}"), first_release_date: None, primary_type: Some("Album".into()), secondary_types: vec![] }).collect(), has_more: false, offset, stale: false, fetched_at: 1000 } }
    fn entry(n: usize, followed: bool) -> Entry { Entry { value: WatchedArtist { artist: summary(n), followed, opened_at: 1, last_checked_at: None }, known: vec![], baseline_pages: vec![], next_page_offset: 30 } }
    #[test] fn initial_baseline_is_quiet_and_next_page_discovery_is_not_an_announcement() {
        let mut file = WatchFile::default(); file.artists.push(entry(1, true));
        apply_page(&mut file, &page(1, &[1,2], 0), 1000); assert!(file.updates.is_empty());
        apply_page(&mut file, &page(1, &[1,2,3], 0), 2000); assert_eq!(file.updates.len(), 1); assert_eq!(file.updates[0].release.title, "Release 3");
        apply_page(&mut file, &page(1, &[4], 30), 3000); assert_eq!(file.updates.len(), 1);
        apply_page(&mut file, &page(1, &[1,2,3], 0), 4000); assert_eq!(file.updates.len(), 1);
    }
    #[test] fn stale_or_unfollowed_records_never_generate_updates() {
        let mut file = WatchFile::default(); file.artists.push(entry(1, false));
        apply_page(&mut file, &page(1, &[1], 0), 1000); apply_page(&mut file, &page(1, &[2], 0), 2000); assert!(file.updates.is_empty());
        file.artists[0].value.followed = true;
        let mut stale = page(1, &[3], 0); stale.stale = true; apply_page(&mut file, &stale, 3000); assert!(file.updates.is_empty()); assert_eq!(file.artists[0].known.len(), 2);
    }
    #[test] fn schedule_caps_twenty_and_rotates_over_oldest_checked_followed_artists() {
        let mut file = WatchFile::default(); file.artists = (1..=80).map(|n| entry(n, true)).collect();
        let first = due_artists(&file, FOLLOW_INTERVAL); assert_eq!(first.len(), MAX_PER_RUN);
        for entry in &mut file.artists { if first.contains(&entry.value.artist.id) { entry.value.last_checked_at = Some(FOLLOW_INTERVAL); } }
        let second = due_artists(&file, FOLLOW_INTERVAL + 1); assert!(second.iter().all(|id| !first.contains(id)));
    }
    #[test] fn persisted_watchlist_is_bounded_and_has_no_implicit_follows() {
        let mut file = WatchFile::default(); file.artists.push(entry(1, false)); assert!(valid_file(&file)); assert_eq!(file.artists.iter().filter(|entry| entry.value.followed).count(), 0);
        file.artists[0].known = vec!["invalid-id".into()]; assert!(!valid_file(&file));
        file.artists = (1..=101).map(|n| entry(n, false)).collect(); assert!(!valid_file(&file));
    }
    #[test] fn updates_and_known_ids_are_capped() {
        let mut file = WatchFile::default(); file.artists.push(entry(1, true)); apply_page(&mut file, &page(1, &[1], 0), 1000);
        for n in 2..=650 { apply_page(&mut file, &page(1, &[n], 0), n as i64); }
        assert_eq!(file.updates.len(), MAX_UPDATES); assert_eq!(file.artists[0].known.len(), MAX_KNOWN); assert!(valid_file(&file));
    }
    #[test] fn remaining_batches_use_fifteen_minutes_then_actual_artist_due_time() {
        let now = 50_000_000;
        let mut file = WatchFile::default(); file.artists = (1..=40).map(|n| entry(n, true)).collect();
        for entry in file.artists.iter_mut().take(20) { entry.value.last_checked_at = Some(now); }
        assert_eq!(schedule_after_run(&file, now, false), Some(now + 15 * 60 * 1000));
        for entry in &mut file.artists { entry.value.last_checked_at = Some(now); }
        assert_eq!(schedule_after_run(&file, now, false), Some(now + FOLLOW_INTERVAL));
        file.artists[0].value.followed = false;
        file.artists[0].value.opened_at = now;
        file.artists.retain(|entry| !entry.value.followed);
        assert_eq!(schedule_after_run(&file, now, false), Some(now + OPENED_INTERVAL));
        file.failures = 3;
        assert_eq!(schedule_after_run(&file, now, true), Some(now + 60 * 60 * 1000));
    }
    #[test] fn watchlist_and_baseline_survive_restart_and_corruption_does_not_reset_file() {
        let path = std::env::temp_dir().join(format!("pulse-catalog-watch-test-{}-{}", std::process::id(), crate::now()));
        let mut file = WatchFile::default(); file.artists.push(entry(1, true));
        apply_page(&mut file, &page(1, &[1], 0), 1000);
        save_file(&path, &file).unwrap();
        let mut restored = read_file(&path).unwrap();
        assert!(restored.artists[0].value.followed);
        apply_page(&mut restored, &page(1, &[1,2], 0), 2000);
        assert_eq!(restored.updates.len(), 1);
        fs::write(path.join("catalog-watchlist.json"), b"broken file").unwrap();
        assert!(read_file(&path).is_err());
        assert_eq!(fs::read(path.join("catalog-watchlist.json")).unwrap(), b"broken file");
        fs::remove_file(path.join("catalog-watchlist.json")).unwrap(); fs::remove_dir(path).unwrap();
    }
}
