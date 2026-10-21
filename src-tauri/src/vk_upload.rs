//! Original-file upload through the user's authenticated official VK page.
//! The website alone owns upload credentials, signatures and save requests.
use crate::vk_web::{self, UploadGuard};
use base64::Engine;
use lofty::{
    prelude::{Accessor, TaggedFileExt},
    probe::Probe,
};
use rand::RngCore;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

const ADAPTER: &str = include_str!("vk_upload_adapter.js");
const MAX_FILE: u64 = 209_715_200;
const CHUNK: usize = 256 * 1024;
static UPLOADING: AtomicBool = AtomicBool::new(false);

pub(crate) struct UploadSource {
    pub path: PathBuf,
    pub title: Option<String>,
    pub artist: Option<String>,
}

struct BatchPermit;
impl Drop for BatchPermit {
    fn drop(&mut self) {
        UPLOADING.store(false, Ordering::Release);
    }
}

fn public_name(path: &Path) -> String {
    path.file_name()
        .map(|name| {
            name.to_string_lossy()
                .chars()
                .filter(|c| !c.is_control())
                .take(255)
                .collect()
        })
        .unwrap_or_else(|| "Аудиофайл".into())
}

fn clean_metadata(value: Option<String>) -> Option<String> {
    value
        .map(|text| {
            text.chars()
                .filter(|c| !c.is_control())
                .take(500)
                .collect::<String>()
                .trim()
                .to_string()
        })
        .filter(|text| !text.is_empty())
}

fn metadata(source: &UploadSource) -> (Option<String>, Option<String>) {
    let mut title = clean_metadata(source.title.clone());
    let mut artist = clean_metadata(source.artist.clone());
    if title.is_none() || artist.is_none() {
        if let Ok(tagged) = Probe::open(&source.path).and_then(|probe| probe.read()) {
            if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
                title =
                    title.or_else(|| clean_metadata(tag.title().map(|value| value.into_owned())));
                artist =
                    artist.or_else(|| clean_metadata(tag.artist().map(|value| value.into_owned())));
            }
        }
    }
    let stem = source
        .path
        .file_stem()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    if let Some((filename_artist, filename_title)) = stem.split_once(" - ") {
        artist = artist.or_else(|| clean_metadata(Some(filename_artist.into())));
        title = title.or_else(|| clean_metadata(Some(filename_title.into())));
    }
    title = title.or_else(|| clean_metadata(Some(stem)));
    (title, artist)
}

fn fingerprint(path: &Path) -> Result<String, String> {
    if !path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("mp3"))
    {
        return Err("Для загрузки в VK выберите MP3. Файл не изменён.".into());
    }
    let mut input = File::open(path).map_err(|_| "Не удалось открыть выбранный файл.")?;
    let info = input
        .metadata()
        .map_err(|_| "Не удалось прочитать выбранный файл.")?;
    if !info.is_file() || info.len() == 0 || info.len() > MAX_FILE {
        return Err("Нужен непустой файл MP3 размером до 200 МБ.".into());
    }
    let probe = Probe::open(path)
        .and_then(|probe| Ok(probe.guess_file_type()?))
        .map_err(|_| "Не удалось распознать аудиофайл MP3.")?;
    if probe.file_type() != Some(lofty::file::FileType::Mpeg) {
        return Err("Файл не является MP3. Переименование расширения не меняет формат.".into());
    }
    probe
        .read()
        .map_err(|_| "Файл MP3 повреждён или не содержит читаемого аудио.")?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; CHUNK];
    let mut size = 0_u64;
    loop {
        let count = input
            .read(&mut buffer)
            .map_err(|_| "Не удалось дочитать выбранный файл.")?;
        if count == 0 {
            break;
        }
        size += count as u64;
        if size > MAX_FILE {
            return Err("Файл изменился во время чтения.".into());
        }
        hasher.update(&buffer[..count]);
    }
    if size != info.len() {
        return Err("Файл изменился во время чтения. Выберите его заново.".into());
    }
    Ok(hex::encode(hasher.finalize()))
}

fn guard(app: &AppHandle, expected: &UploadGuard) -> Result<WebviewWindow, String> {
    if !vk_web::check_upload_guard(app, expected) {
        return Err("Аккаунт VK изменился. Загрузка отменена.".into());
    }
    app.get_webview_window("vk-music")
        .ok_or_else(|| "Окно VK закрыто. Загрузка отменена.".into())
}

async fn command(
    app: &AppHandle,
    expected: &UploadGuard,
    expression: String,
) -> Result<Value, String> {
    let window = guard(app, expected)?;
    let script = format!("(()=>{{if(window.top!==window.self||!['https://vk.com','https://vk.ru'].includes(location.origin)||Number(window.vk?.id)!=={})return {{accepted:false,message:'Аккаунт VK изменился. Загрузка отменена.'}};return {expression};}})()", expected.account_id);
    let result = vk_web::evaluate(&window, script).await?;
    guard(app, expected)?;
    Ok(result)
}

fn progress(
    app: &AppHandle,
    phase: &str,
    message: &str,
    current: usize,
    total: usize,
    percent: Option<u64>,
) {
    let _ = app.emit_to(
        "main",
        "import:progress",
        json!({"phase":phase,"message":message,"current":current,"total":total,"percent":percent}),
    );
}

fn require_accepted(value: &Value) -> Result<(), String> {
    if value.get("accepted").and_then(Value::as_bool) == Some(true) {
        return Ok(());
    }
    Err(value
        .get("message")
        .and_then(Value::as_str)
        .filter(|message| message.len() <= 1000)
        .unwrap_or("VK не подтвердил загрузку.")
        .into())
}

async fn upload_one(
    app: &AppHandle,
    expected: &UploadGuard,
    source: &UploadSource,
    original_name: &str,
    current: usize,
    total: usize,
) -> Result<Value, String> {
    guard(app, expected)?;
    // The owned staging filename is private bookkeeping. VK should see the
    // user's original filename (with MP3 extension after format preparation).
    let name = Path::new(original_name).with_extension("mp3").to_string_lossy().into_owned();
    if !source
        .path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("mp3"))
    {
        return Err("Для загрузки в VK выберите MP3. Файл не изменён.".into());
    }
    let mut file =
        File::open(&source.path).map_err(|_| "Не удалось открыть выбранный файл.".to_string())?;
    let file_info = file
        .metadata()
        .map_err(|_| "Не удалось прочитать выбранный файл.".to_string())?;
    if !file_info.is_file() || file_info.len() == 0 || file_info.len() > MAX_FILE {
        return Err("Нужен непустой файл MP3 размером до 200 МБ.".into());
    }
    // Reject extension-only impostors before sending any original bytes.
    let mut header = [0_u8; 4096];
    let header_len = file
        .read(&mut header)
        .map_err(|_| "Не удалось прочитать выбранный файл.".to_string())?;
    let is_mp3 = header[..header_len].starts_with(b"ID3")
        || header[..header_len]
            .windows(2)
            .any(|bytes| bytes[0] == 0xff && bytes[1] & 0xe0 == 0xe0 && bytes[1] & 0x06 != 0);
    if !is_mp3 {
        return Err("Файл не похож на MP3. Переименование расширения не меняет формат.".into());
    }
    use std::io::{Seek, SeekFrom};
    file.seek(SeekFrom::Start(0))
        .map_err(|_| "Не удалось прочитать выбранный файл.".to_string())?;
    let metadata_source = UploadSource {
        path: source.path.clone(),
        title: source.title.clone(),
        artist: source.artist.clone(),
    };
    let (title, artist) = tauri::async_runtime::spawn_blocking(move || metadata(&metadata_source))
        .await
        .map_err(|_| "Не удалось прочитать название и исполнителя файла.".to_string())?;
    let mut random = [0_u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut random);
    let id = hex::encode(random);
    let id_json = serde_json::to_string(&id).unwrap();
    let window = guard(app, expected)?;
    window
        .eval(ADAPTER)
        .map_err(|_| "Не удалось подготовить загрузку VK.".to_string())?;
    let request = json!({"id":id,"account":expected.account_id,"size":file_info.len(),"name":name,"title":title,"artist":artist});
    require_accepted(
        &command(
            app,
            expected,
            format!("window.__PULSE_VK_UPLOAD__?.start({request})||{{accepted:false}}"),
        )
        .await?,
    )?;
    let mut save_may_have_started = false;
    let outcome = async {
        let mut buffer = vec![0; CHUNK];
        let mut offset = 0_u64;
        progress(app, "read", &format!("Читаю {name}"), current, total, Some(0));
        loop {
            let count = file.read(&mut buffer).map_err(|_| "Не удалось дочитать выбранный файл.".to_string())?;
            if count == 0 { break; }
            let encoded = base64::engine::general_purpose::STANDARD.encode(&buffer[..count]);
            let encoded_json = serde_json::to_string(&encoded).unwrap();
            let receipt = command(app, expected, format!("window.__PULSE_VK_UPLOAD__?.append({id_json},{offset},{encoded_json})||{{accepted:false}}" )).await?;
            require_accepted(&receipt)?;
            offset += count as u64;
            if receipt.get("received").and_then(Value::as_u64) != Some(offset) { return Err("VK не подтвердил целостность файла.".into()); }
        }
        if offset != file_info.len() { return Err("Файл изменился во время чтения. Выберите его заново.".into()); }
        require_accepted(&command(app, expected, format!("window.__PULSE_VK_UPLOAD__?.commit({id_json})||{{accepted:false}}" )).await?)?;
        // A lost status callback may skip the brief save phase entirely.
        // Treat transport uncertainty after commit conservatively.
        save_may_have_started = true;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(720);
        let mut previous = String::new();
        loop {
            let value = command(app, expected, format!("window.__PULSE_VK_UPLOAD__?.read({id_json})||{{status:'failed',message:'Загрузка прервана.'}}" )).await?;
            let phase = value.get("phase").and_then(Value::as_str).unwrap_or("upload");
            if matches!(phase, "save" | "verify") || value.get("trackId").is_some() { save_may_have_started = true; }
            match value.get("status").and_then(Value::as_str) {
                Some("uploaded" | "failed" | "uncertain") => return Ok(value),
                Some("pending") => {},
                _ => return Err("VK вернул непонятный статус загрузки.".into()),
            }
            let percent = value.get("percent").and_then(Value::as_u64);
            let marker = format!("{phase}:{percent:?}");
            if marker != previous {
                let message = match phase { "prepare" => format!("VK готовит загрузку: {name}"), "save" => format!("VK сохраняет: {name}"), "verify" => format!("Проверяю трек в VK: {name}"), _ => format!("Загружаю в VK: {name}") };
                progress(app, phase, &message, current, total, percent); previous = marker;
            }
            if tokio::time::Instant::now() >= deadline { return Err("VK не подтвердил результат вовремя. Обновите библиотеку перед повторной загрузкой.".into()); }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }.await;
    // Discard transferred bytes and abort any pending HTTP request. Guard the
    // cleanup too: never inject into a replaced page or a different account.
    if let Ok(window) = guard(app, expected) {
        let _ = window.eval(format!("window.__PULSE_VK_UPLOAD__?.cancel({id_json});"));
    }
    match outcome {
        Ok(value) => Ok(value),
        Err(message) if save_may_have_started => {
            Ok(json!({"status":"uncertain","message":message}))
        }
        Err(message) => Err(message),
    }
}

pub(crate) async fn upload_files(
    app: AppHandle,
    files: Vec<UploadSource>,
    expected: UploadGuard,
) -> Result<Value, String> {
    if files.is_empty() {
        return Ok(json!({"items":[],"cancelled":true,"accountId":expected.account_id}));
    }
    if files.len() > 20 {
        return Err("За один раз можно загрузить до 20 аудиофайлов.".into());
    }
    guard(&app, &expected)?;
    UPLOADING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "Дождитесь окончания текущей загрузки.".to_string())?;
    let _permit = BatchPermit;
    let total = files.len();
    let mut items = Vec::new();
    let mut seen = HashSet::new();
    let mut content = HashSet::new();
    for (index, mut source) in files.into_iter().enumerate() {
        let name = public_name(&source.path);
        let key = source
            .path
            .canonicalize()
            .unwrap_or_else(|_| source.path.clone());
        if !seen.insert(key) {
            items.push(json!({"name":name,"status":"skipped","message":"Этот файл уже выбран в текущей партии."}));
            continue;
        }
        if !vk_web::check_upload_guard(&app, &expected) {
            items.push(json!({"name":name,"status":"skipped","message":"Аккаунт VK изменился. Файл не отправлен."}));
            continue;
        }
        // VK takes MP3. Preserve an existing MP3 byte for byte; convert other
        // real audio formats without losing their original title/artist.
        // Keep the guard alive until upload_one finishes, then delete only
        // the generated conversion, never the user's original file.
        let prepared;
        {
            let (title, artist) = metadata(&source);
            let tools = crate::import_tools(&app)?;
            let directory = crate::data_dir(&app).join("imports");
            std::fs::create_dir_all(&directory).map_err(|_| "Не удалось создать папку подготовки аудио.")?;
            progress(&app, "prepare", &format!("Проверяем полную звуковую дорожку для VK: {name}"), index + 1, total, None);
            match crate::media_prepare::for_vk(&source.path, &tools, &directory).await {
                Ok(value) => {
                    source.path = value.path.clone(); source.title = title; source.artist = artist;
                    prepared = value;
                }
                Err(message) => { items.push(json!({"name":name,"status":"failed","message":message})); continue; }
            }
            if !vk_web::check_upload_guard(&app, &expected) {
                items.push(json!({"name":name,"status":"skipped","message":"Аккаунт VK изменился. Файл не отправлен."}));
                continue;
            }
        }
        let staging_profile = crate::data_dir(&app);
        let staging_source = source.path.clone();
        let staged = match tauri::async_runtime::spawn_blocking(move || crate::owned_uploads::stage(&staging_profile, &staging_source)).await {
            Ok(Ok(staged)) => staged,
            Ok(Err(message)) => { items.push(json!({"name":name,"status":"failed","message":message})); continue; }
            Err(_) => { items.push(json!({"name":name,"status":"failed","message":"Не удалось сохранить исходник загрузки."})); continue; }
        };
        source.path = staged.path.clone();
        let path = source.path.clone();
        let digest = tauri::async_runtime::spawn_blocking(move || fingerprint(&path))
            .await
            .map_err(|_| "Не удалось проверить выбранный файл.".to_string())?;
        match digest {
            Ok(digest) if !content.insert(digest.clone()) => {
                items.push(json!({"name":name,"status":"skipped","message":"Такой же файл уже выбран в текущей партии, даже если его имя отличается."}));
                continue;
            }
            Err(message) => {
                items.push(json!({"name":name,"status":"failed","message":message}));
                continue;
            }
            _ => {}
        }
        let result = upload_one(&app, &expected, &source, &name, index + 1, total).await;
        let mut item = match result {
            Ok(value) => value,
            Err(message) => json!({"status":"failed","message":message}),
        };
        if item.get("status").and_then(Value::as_str) == Some("uploaded") {
            let save_app = app.clone();
            let save_guard = expected.clone();
            let save_receipt = item.clone();
            let save_path = staged.path.clone();
            match tauri::async_runtime::spawn_blocking(move || crate::remember_uploaded_source(&save_app, &save_guard, &save_receipt, &save_path)).await {
                Ok(Ok(())) => staged.retain(),
                _ => {
                    // The cloud write already succeeded: never suggest retrying
                    // that mutation because a local disk save failed.
                    item["message"] = json!("Загружен в VK и подтверждён в библиотеке. Локальную копию сохранить не удалось; будет использован источник VK.");
                }
            }
        }
        // The verified owned copy is committed before the generated upload
        // conversion or a URL import's original download can be removed.
        drop(prepared);
        item["name"] = json!(name);
        // Return a bounded report, never arbitrary official page data.
        items.push(json!({"name":item["name"],"status":item["status"],"message":item["message"],"trackId":item.get("trackId").filter(|id| id.as_str().is_some_and(|id| id.len()<100))}));
    }
    if items.iter().any(|item| {
        matches!(
            item.get("status").and_then(Value::as_str),
            Some("uploaded" | "uncertain")
        )
    }) {
        // Cancel any pre-upload collection read and collect a fresh ordered
        // snapshot. The authoritative bridge commits it and notifies the UI.
        let _ = vk_web::refresh_after_upload(&app, &expected).await;
    }
    progress(
        &app,
        "done",
        "Загрузка файлов завершена.",
        total,
        total,
        None,
    );
    Ok(json!({"items":items,"cancelled":false,"accountId":expected.account_id}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metadata_fixture(title: Option<&str>, artist: &str) -> PathBuf {
        let directory =
            std::env::temp_dir().join(format!("pulse-upload-metadata-{}", rand::random::<u64>()));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("Filename Artist - Filename Title.mp3");
        let mut payload = Vec::new();
        for (kind, value) in [("TIT2", title), ("TPE1", Some(artist))] {
            if let Some(value) = value {
                payload.extend_from_slice(kind.as_bytes());
                payload.extend_from_slice(&((value.len() + 1) as u32).to_be_bytes());
                payload.extend_from_slice(&[0, 0, 0]); // Flags, then Latin-1 text encoding.
                payload.extend_from_slice(value.as_bytes());
            }
        }
        let size = payload.len();
        let mut bytes = b"ID3\x03\x00\x00".to_vec();
        bytes.extend_from_slice(&[
            ((size >> 21) & 0x7f) as u8,
            ((size >> 14) & 0x7f) as u8,
            ((size >> 7) & 0x7f) as u8,
            (size & 0x7f) as u8,
        ]);
        bytes.extend(payload);
        for _ in 0..8 {
            let mut frame = [0_u8; 417];
            frame[..4].copy_from_slice(&[0xff, 0xfb, 0x90, 0x64]);
            bytes.extend_from_slice(&frame);
        }
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn names_and_metadata_are_bounded() {
        assert_eq!(
            clean_metadata(Some("  Artist\n  ".into())).as_deref(),
            Some("Artist")
        );
        assert_eq!(clean_metadata(Some(" \n ".into())), None);
        assert_eq!(clean_metadata(Some("x".repeat(600))).unwrap().len(), 500);
        assert_eq!(
            public_name(Path::new("C:/secret/Artist - Track.mp3")),
            "Artist - Track.mp3"
        );
    }
    #[test]
    fn filename_preserves_artist_and_title_without_tags() {
        let source = UploadSource {
            path: PathBuf::from("Missing Artist - Missing Title.mp3"),
            title: None,
            artist: None,
        };
        assert_eq!(
            metadata(&source),
            (Some("Missing Title".into()), Some("Missing Artist".into()))
        );
    }

    #[test]
    fn existing_local_artist_tag_does_not_block_filename_title_fallback() {
        let path = metadata_fixture(None, "Tagged Artist");
        let tagged = Probe::open(&path).unwrap().read().unwrap();
        let tag = tagged.primary_tag().unwrap();
        assert!(tag.title().is_none());
        assert_eq!(tag.artist().as_deref(), Some("Tagged Artist"));
        // An inspect() filename fallback is deliberately not an explicit title.
        let source = UploadSource {
            path: path.clone(),
            title: None,
            artist: Some("Tagged Artist".into()),
        };
        assert_eq!(
            metadata(&source),
            (Some("Filename Title".into()), Some("Tagged Artist".into()))
        );
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn genuine_tag_title_equal_to_filename_stem_remains_intact() {
        let path = metadata_fixture(Some("Filename Artist - Filename Title"), "Tagged Artist");
        let source = UploadSource {
            path: path.clone(),
            title: None,
            artist: Some("Tagged Artist".into()),
        };
        assert_eq!(
            metadata(&source),
            (
                Some("Filename Artist - Filename Title".into()),
                Some("Tagged Artist".into())
            )
        );
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(path.parent().unwrap()).unwrap();
    }
}
