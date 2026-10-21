//! A retained copy of bytes uploaded by this app, bound only to VK's verified
//! receipt. No URL, cookie, access hash or title-based matching is stored.
use crate::Track;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{fs, io::{Read, Write}, path::{Path, PathBuf}};

const MAX_FILE: u64 = 200 * 1024 * 1024;
const DIRECTORY: &str = "uploaded-audio";

pub(crate) struct StagedUpload {
    pub path: PathBuf,
    retained: bool,
}
impl StagedUpload {
    pub fn retain(mut self) { self.retained = true; }
}
impl Drop for StagedUpload {
    fn drop(&mut self) {
        if !self.retained { let _ = fs::remove_file(&self.path); }
    }
}

fn directory(profile: &Path) -> PathBuf { profile.join(DIRECTORY) }

fn file_digest(path: &Path) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_FILE { return None; }
    let mut hasher = Sha256::new();
    let mut size = 0u64;
    let mut bytes = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut bytes).ok()?;
        if count == 0 { break; }
        size += count as u64;
        if size > MAX_FILE { return None; }
        hasher.update(&bytes[..count]);
    }
    (size == metadata.len()).then(|| hex::encode(hasher.finalize()))
}

/// Stage the already validated MP3 before uploading. The upload reads this
/// private copy rather than a user's file that can move/change mid-request.
pub(crate) fn stage(profile: &Path, source: &Path) -> Result<StagedUpload, String> {
    let mut input = fs::File::open(source).map_err(|_| "Не удалось сохранить исходник загрузки.")?;
    let metadata = input.metadata().map_err(|_| "Не удалось прочитать исходник загрузки.")?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_FILE {
        return Err("Нужен непустой исходник загрузки до 200 МБ.".into());
    }
    let dir = directory(profile);
    fs::create_dir_all(&dir).map_err(|_| "Не удалось создать папку исходников загрузок.")?;
    let nonce = hex::encode(rand::random::<[u8; 16]>());
    let temporary = dir.join(format!("{nonce}.part"));
    let mut cleanup = StagedUpload { path: temporary.clone(), retained: false };
    let mut output = fs::OpenOptions::new().write(true).create_new(true).open(&temporary)
        .map_err(|_| "Не удалось сохранить копию исходника загрузки.")?;
    let mut hasher = Sha256::new();
    let mut bytes = [0u8; 64 * 1024];
    let mut size = 0u64;
    loop {
        let count = input.read(&mut bytes).map_err(|_| "Не удалось дочитать исходник загрузки.")?;
        if count == 0 { break; }
        size += count as u64;
        if size > MAX_FILE { return Err("Исходник изменился во время сохранения.".into()); }
        output.write_all(&bytes[..count]).map_err(|_| "Не удалось сохранить копию исходника загрузки.")?;
        hasher.update(&bytes[..count]);
    }
    if size != metadata.len() { return Err("Исходник изменился во время сохранения.".into()); }
    output.sync_all().map_err(|_| "Не удалось записать копию исходника загрузки.")?;
    drop(output);
    let path = dir.join(format!("{}-{nonce}.mp3", hex::encode(hasher.finalize())));
    fs::rename(temporary, &path).map_err(|_| "Не удалось завершить сохранение исходника загрузки.")?;
    cleanup.path = path;
    Ok(cleanup)
}

fn managed_file(profile: &Path, path: &Path) -> Option<PathBuf> {
    let root = directory(profile).canonicalize().ok()?;
    let path = path.canonicalize().ok()?;
    if path.parent()? != root { return None; }
    let name = path.file_name()?.to_str()?;
    let stem = name.strip_suffix(".mp3")?;
    let (digest, nonce) = stem.split_once('-')?;
    if digest.len() != 64 || nonce.len() != 32 || !digest.bytes().chain(nonce.bytes()).all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        return None;
    }
    if file_digest(&path)?.as_str() != digest { return None; }
    Some(path)
}

pub(crate) fn verified_binding(profile: &Path, path: &Path, account: i64, receipt: &Value) -> Option<(String, PathBuf)> {
    if account <= 0 || receipt.get("status")?.as_str()? != "uploaded" { return None; }
    let id = receipt.get("trackId")?.as_str()?;
    let suffix = id.strip_prefix(&format!("vk-{account}-"))?;
    let audio: i64 = suffix.parse().ok()?;
    if audio <= 0 || id != format!("vk-{account}-{audio}") { return None; }
    Some((id.into(), managed_file(profile, path)?))
}

pub(crate) fn own_track(account: i64, track: &Track) -> bool {
    account > 0 && track.source == "vk" && track.available && crate::vk_web::valid_web_track(track)
        && track.remote.as_ref().is_some_and(|remote| remote.owner_id == account && remote.audio_id > 0 && remote.in_library
            && track.id == format!("vk-{account}-{}", remote.audio_id))
}

pub(crate) fn resolve(profile: &Path, path: &Path, account: i64, track: &Track) -> Option<PathBuf> {
    if !own_track(account, track) { return None; }
    managed_file(profile, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{RemoteTrack, Envelope, defaults};
    use serde_json::json;

    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("pulse-owned-source-{}", rand::random::<u64>()));
            fs::create_dir_all(&p).unwrap(); Self(p)
        }
        fn source(&self) -> PathBuf {
            let p = self.0.join("User original.mp3"); fs::write(&p, b"ID3 validated upload bytes").unwrap(); p
        }
    }
    impl Drop for Scratch { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    fn track() -> Track { Track { id: "vk-42-7".into(), source: "vk".into(), url: "vk-web://42/7".into(), available: true,
        remote: Some(RemoteTrack { owner_id: 42, audio_id: 7, in_library: true, access_key: None, search_result: false }), ..Default::default() } }

    #[test]
    fn verified_upload_survives_original_removal_and_envelope_restart() {
        let s = Scratch::new(); let original = s.source(); let staged = stage(&s.0, &original).unwrap();
        let (id, path) = verified_binding(&s.0, &staged.path, 42, &json!({"status":"uploaded","trackId":"vk-42-7"})).unwrap();
        assert_eq!(fs::read(&original).unwrap(), fs::read(&path).unwrap());
        staged.retain(); fs::remove_file(original).unwrap();
        let mut state = defaults(); state.tracks.push(track());
        let envelope = Envelope { schema: 1, files: vec![(id, path)], state };
        let bytes = serde_json::to_vec(&envelope).unwrap();
        let restored: Envelope = serde_json::from_slice(&bytes).unwrap();
        assert!(resolve(&s.0, &restored.files[0].1, 42, &restored.state.tracks[0]).is_some());
    }
    #[test]
    fn only_exact_verified_own_receipts_bind_and_failed_upload_copies_are_discarded() {
        let s = Scratch::new(); let original = s.source(); let staged = stage(&s.0, &original).unwrap(); let path = staged.path.clone();
        for receipt in [json!({"status":"uncertain","trackId":"vk-42-7"}), json!({"status":"failed","trackId":"vk-42-7"}),
            json!({"status":"uploaded","trackId":"vk-43-7"}), json!({"status":"uploaded","trackId":"vk-42-07"}),
            json!({"status":"uploaded","trackId":"vk-42-7-extra"}), json!({"status":"uploaded"})] {
            assert!(verified_binding(&s.0, &path, 42, &receipt).is_none());
        }
        drop(staged); assert!(!path.exists()); assert!(original.exists());
    }
    #[test]
    fn account_change_removed_file_unregistered_identity_and_tampering_never_resolve() {
        let s = Scratch::new(); let staged = stage(&s.0, &s.source()).unwrap(); let mut t = track();
        assert!(resolve(&s.0, &staged.path, 43, &t).is_none());
        t.remote.as_mut().unwrap().in_library = false; assert!(resolve(&s.0, &staged.path, 42, &t).is_none());
        t = track(); t.id = "vk-42-8".into(); assert!(resolve(&s.0, &staged.path, 42, &t).is_none());
        t = track(); fs::write(&staged.path, b"Other bytes").unwrap(); assert!(resolve(&s.0, &staged.path, 42, &t).is_none());
        fs::remove_file(&staged.path).unwrap(); assert!(resolve(&s.0, &staged.path, 42, &t).is_none());
    }
    #[test]
    fn arbitrary_user_paths_and_other_profiles_are_not_managed_sources() {
        let s = Scratch::new(); let original = s.source(); let staged = stage(&s.0, &original).unwrap(); let other = Scratch::new();
        assert!(resolve(&s.0, &original, 42, &track()).is_none());
        assert!(resolve(&other.0, &staged.path, 42, &track()).is_none());
        assert!(verified_binding(&s.0, &original, 42, &json!({"status":"uploaded","trackId":"vk-42-7"})).is_none());
    }
    #[test]
    fn explicitly_selected_original_can_bind_without_a_cloud_upload_receipt() {
        let s = Scratch::new(); let original = s.source();
        let staged = stage(&s.0, &original).unwrap();
        // The picker action is a distinct local association with an existing
        // native record. It neither fabricates an upload nor rewrites VK data.
        let before = serde_json::to_value(track()).unwrap();
        assert!(own_track(42, &track()));
        let path = resolve(&s.0, &staged.path, 42, &track()).unwrap();
        assert_eq!(fs::read(&path).unwrap(), fs::read(&original).unwrap());
        assert_eq!(serde_json::to_value(track()).unwrap(), before);
        let mut removed = track(); removed.available = false;
        assert!(!own_track(42, &removed));
        removed = track(); removed.remote.as_mut().unwrap().in_library = false;
        assert!(!own_track(42, &removed));
        assert!(!own_track(43, &track()));
        assert!(verified_binding(&s.0, &path, 42, &json!({"attached":true})).is_none());
    }
}
