//! Keep downloaded audio playable by the platform webview and readable by
//! Lofty. Container changes copy packets; lossless FLAC preserves decoded PCM
//! when the original codec/container has no reliable native playback path.
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

#[derive(Debug, PartialEq)]
enum Preparation {
    Keep,
    AacContainer,
    OpusContainer,
    IntegerWave,
    FloatWave,
    UnsupportedPrecision,
    Flac,
}

fn preparation(extension: &str, codec: &str, macos: bool) -> Preparation {
    match (extension, codec) {
        (_, "pcm_f64be" | "pcm_f64le") => Preparation::UnsupportedPrecision,
        ("mp3", "mp3") | ("flac", "flac") => Preparation::Keep,
        ("wav", codec) if codec.starts_with("pcm_") => Preparation::Keep,
        ("m4a", "aac") => Preparation::Keep,
        ("ogg" | "opus", "vorbis" | "opus") if !macos => Preparation::Keep,
        ("aac", "aac") => Preparation::AacContainer,
        ("webm", "opus") if !macos => Preparation::OpusContainer,
        (_, "pcm_s32be" | "pcm_s32le" | "alac") => Preparation::IntegerWave,
        (_, "pcm_f32be" | "pcm_f32le" | "aac" | "opus" | "vorbis") => Preparation::FloatWave,
        _ => Preparation::Flac,
    }
}

struct OutputFile(Option<PathBuf>);
impl Drop for OutputFile {
    fn drop(&mut self) {
        if let Some(path) = &self.0 {
            let _ = std::fs::remove_file(path);
        }
    }
}

pub async fn prepare_download(
    path: &Path,
    tools: &Path,
    directory: &Path,
    codec: &str,
    duration: f64,
) -> Result<Option<PathBuf>, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mode = preparation(&extension, codec, cfg!(target_os = "macos"));
    if mode == Preparation::UnsupportedPrecision {
        return Err("Аудио с 64-битными дробными отсчётами не поддерживается встроенным плеером. Исходный файл не изменён; выберите доступный формат WAV 32-bit float или FLAC.".into());
    }
    if mode == Preparation::Keep {
        return Ok(None);
    }
    let extension = match mode {
        Preparation::AacContainer => "m4a",
        Preparation::OpusContainer => "ogg",
        Preparation::IntegerWave | Preparation::FloatWave => "wav",
        _ => "flac",
    };
    let output = directory.join(format!(
        "playable-{}.{}",
        hex::encode(rand::random::<[u8; 16]>()),
        extension
    ));
    let mut cleanup = OutputFile(Some(output.clone()));
    let mut command =
        tokio::process::Command::new(tools.join(crate::youtube::import_tool_name("ffmpeg")));
    command
        .args([
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-threads",
            "1",
            "-i",
        ])
        .arg(path)
        .args(["-map", "0:a:0", "-vn", "-map_metadata", "0"]);
    match mode {
        Preparation::AacContainer => {
            command.args(["-c:a", "copy", "-f", "ipod"]);
        }
        Preparation::OpusContainer => {
            command.args(["-c:a", "copy", "-f", "ogg"]);
        }
        Preparation::IntegerWave => {
            command.args(["-c:a", "pcm_s32le", "-f", "wav"]);
        }
        Preparation::FloatWave => {
            command.args(["-c:a", "pcm_f32le", "-f", "wav"]);
        }
        _ => {
            command.args([
                "-c:a",
                "flac",
                "-compression_level",
                "5",
                "-threads",
                "1",
                "-f",
                "flac",
            ]);
        }
    }
    command
        .args(["-fs", "209715201"])
        .arg(&output)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command
        .spawn()
        .map_err(|_| "Не удалось подготовить аудио для воспроизведения.")?;
    let status = tokio::time::timeout(Duration::from_secs(180), child.wait())
        .await
        .map_err(|_| "Подготовка аудио заняла слишком много времени. Исходный файл не изменён.")?
        .map_err(|_| "Подготовка аудио прервана.")?;
    if !status.success()
        || !std::fs::metadata(&output).is_ok_and(|value| {
            value.is_file() && value.len() > 0 && value.len() <= 200 * 1024 * 1024
        })
    {
        return Err(
            "Не удалось подготовить полный аудиофайл до 200 МБ для воспроизведения.".into(),
        );
    }
    let (_, actual) = crate::media_prepare::verify_audio(&output, tools, Some(duration)).await?;
    if actual < duration - 0.5 {
        return Err("При подготовке потеряна часть аудио. Неполный файл не добавлен.".into());
    }
    // A successful caller takes ownership. Errors/cancellation clean only the
    // generated copy, never the downloaded original or a user's selected file.
    cleanup.0.take();
    Ok(Some(output))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unsupported_local_containers_do_not_become_unplayable_library_entries() {
        assert_eq!(preparation("aiff", "pcm_s16be", false), Preparation::Flac);
        assert_eq!(
            preparation("webm", "opus", false),
            Preparation::OpusContainer
        );
        assert_eq!(
            preparation("aiff", "pcm_f32be", false),
            Preparation::FloatWave
        );
        assert_eq!(
            preparation("aiff", "pcm_f64be", false),
            Preparation::UnsupportedPrecision
        );
        assert_eq!(preparation("aac", "aac", false), Preparation::AacContainer);
        assert_eq!(preparation("m4a", "alac", false), Preparation::IntegerWave);
        assert_eq!(preparation("aiff", "pcm_s32be", false), Preparation::IntegerWave);
        assert_eq!(preparation("mp3", "mp3", false), Preparation::Keep);
        assert_eq!(preparation("ogg", "opus", false), Preparation::Keep);
        assert_eq!(preparation("ogg", "opus", true), Preparation::FloatWave);
        assert_eq!(preparation("flac", "flac", true), Preparation::Keep);
    }

    #[test]
    #[ignore = "Native lossless/remux regression; requires packaged ffmpeg/ffprobe"]
    fn native_local_preparation_preserves_decoded_pcm_and_music_tags() {
        use sha2::{Digest, Sha256};
        #[cfg(windows)] use std::os::windows::process::CommandExt;
        let tools = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/import-tools");
        let directory = std::env::temp_dir().join(format!("pulse-local-pcm-{}", hex::encode(rand::random::<[u8;16]>())));
        std::fs::create_dir(&directory).unwrap();
        struct Directory(PathBuf);
        impl Drop for Directory { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
        let _cleanup = Directory(directory.clone());
        let ffmpeg = tools.join(crate::youtube::import_tool_name("ffmpeg"));
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        for (name, encoder, codec) in [("float32.aiff","pcm_f32be","pcm_f32be"),("float64.aiff","pcm_f64be","pcm_f64be"),("int32.aiff","pcm_s32be","pcm_s32be"),("int16.aiff","pcm_s16be","pcm_s16be"),("opus.webm","libopus","opus"),("raw.aac","aac","aac"),("lossless.m4a","alac","alac")] {
            let input = directory.join(name);
            let mut command = std::process::Command::new(&ffmpeg);
            command.args(["-nostdin","-hide_banner","-loglevel","error","-f","lavfi","-i","aevalsrc=0.1*sin(440*2*PI*t):d=2","-metadata","title=Fixture Title","-metadata","artist=Fixture Artist","-c:a",encoder]);
            if name.ends_with(".aiff") { command.args(["-write_id3v2","1"]); }
            command.arg(&input).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
            #[cfg(windows)] command.creation_flags(0x08000000);
            assert!(command.status().unwrap().success(),"fixture {name}");
            let (_, duration) = runtime.block_on(crate::media_prepare::verify_audio(&input,&tools,None)).unwrap();
            if codec == "pcm_f64be" {
                assert!(runtime.block_on(prepare_download(&input,&tools,&directory,codec,duration)).unwrap_err().contains("64-бит"));
                assert!(input.exists()); continue;
            }
            let output = runtime.block_on(prepare_download(&input,&tools,&directory,codec,duration)).unwrap().unwrap();
            let decode = |path: &Path| {
                let mut command = std::process::Command::new(&ffmpeg);
                command.args(["-nostdin","-hide_banner","-loglevel","error","-i"]).arg(path).args(["-map","0:a:0","-c:a","pcm_f64le","-f","f64le","-"]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
                #[cfg(windows)] command.creation_flags(0x08000000);
                let result = command.output().unwrap(); assert!(result.status.success()); result.stdout
            };
            let before = decode(&input); let after = decode(&output);
            // WebM's millisecond timebase can round the final discard padding
            // by <1 ms during an Opus packet copy. No source sample may change
            // or disappear; no new lossy encoder is used.
            if name == "opus.webm" {
                assert!(after.len() >= before.len() && after.len()-before.len() <= 48*8);
                assert_eq!(Sha256::digest(&before),Sha256::digest(&after[..before.len()]),"{name}: every decoded source sample must remain identical");
            } else {
                assert_eq!(Sha256::digest(&before),Sha256::digest(&after),"{name}: decoded PCM must be identical");
            }
            let mut tag_command = std::process::Command::new(tools.join(crate::youtube::import_tool_name("ffprobe")));
            tag_command.args(["-v","error","-show_entries","format_tags=title,artist:stream_tags=title,artist","-of","json"]).arg(&output);
            #[cfg(windows)] tag_command.creation_flags(0x08000000);
            let tag_output = tag_command.output().unwrap();
            let tags: serde_json::Value = serde_json::from_slice(&tag_output.stdout).unwrap();
            // Raw ADTS cannot carry these tags. Every tagged source retains them.
            if name != "raw.aac" {
                let tag = |key: &str| [tags.pointer("/format/tags"), tags.pointer("/streams/0/tags")].into_iter().flatten().filter_map(serde_json::Value::as_object).flat_map(|tags| tags.iter()).find(|(name, _)| name.eq_ignore_ascii_case(key)).and_then(|(_, value)| value.as_str());
                assert_eq!(tag("title"),Some("Fixture Title"),"{name}: {tags}");
                assert_eq!(tag("artist"),Some("Fixture Artist"),"{name}: {tags}");
            }
            assert!(input.exists());
        }
    }
}
