//! Validate downloaded audio before it enters the library. VK accepts MP3;
//! other formats are converted only for that destination, keeping music tags.
use serde_json::Value;
use std::{path::{Path, PathBuf}, process::Stdio, time::Duration};
use tokio::io::AsyncReadExt;

pub struct PreparedAudio { pub path: PathBuf, temporary: bool }
impl Drop for PreparedAudio {
    fn drop(&mut self) { if self.temporary { let _ = std::fs::remove_file(&self.path); } }
}

fn audio_details(value: &Value, expected: Option<f64>) -> Result<(String, f64), String> {
    let stream = value.get("streams").and_then(Value::as_array).and_then(|streams| streams.iter().find(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("audio")))
        .ok_or("Скачанный файл не содержит звуковой дорожки. Импорт отменён.")?;
    let codec = stream.get("codec_name").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or("Не удалось определить кодек аудио.")?;
    let parse_duration = |value: &Value| value.as_f64().or_else(|| value.as_str()?.parse::<f64>().ok()).filter(|duration| duration.is_finite() && *duration > 0.);
    let duration = stream.get("duration").and_then(parse_duration).or_else(|| value.pointer("/format/duration").and_then(parse_duration))
        .ok_or("У аудиофайла некорректная длительность.")?;
    if expected.is_some_and(|full| full.is_finite() && full > 30. && duration < full - (full * 0.08).max(5.)) {
        return Err("Сервис вернул короткий фрагмент вместо полного трека. Превью не добавлено; нужен полный аудиофайл.".into());
    }
    Ok((codec.into(), duration))
}

pub async fn verify_audio(path: &Path, tools: &Path, expected: Option<f64>) -> Result<(String, f64), String> {
    let mut command = tokio::process::Command::new(tools.join(crate::youtube::import_tool_name("ffprobe")));
    command.args(["-v", "warning", "-protocol_whitelist", "file,pipe", "-show_entries", "stream=codec_type,codec_name,duration:format=duration", "-of", "json"])
        .arg(path).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)] command.creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|_| "Не удалось запустить проверку аудио. Переустановите полную сборку Pulse.")?;
    let mut stdout = child.stdout.take().ok_or("Не удалось прочитать данные аудиофайла.")?;
    let mut stderr = child.stderr.take().ok_or("Не удалось прочитать результат проверки аудио.")?;
    let mut warnings = tokio::spawn(async move {
        let mut bytes = Vec::new();
        (&mut stderr).take(64 * 1024 + 1).read_to_end(&mut bytes).await.map(|_| bytes)
    });
    let header_result = tokio::time::timeout(Duration::from_secs(20), async {
        let mut bytes = Vec::new();
        (&mut stdout).take(256 * 1024 + 1).read_to_end(&mut bytes).await.map_err(|_| "Не удалось проверить аудиофайл.")?;
        if bytes.len() > 256 * 1024 { return Err("Некорректные данные аудиофайла.".to_string()); }
        let status = child.wait().await.map_err(|_| "Проверка аудиофайла прервана.")?;
        if !status.success() { return Err("Файл повреждён или не содержит доступного аудио. Импорт отменён.".into()); }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| "Не удалось прочитать параметры аудиофайла.")?;
        let warning_bytes = (&mut warnings).await.map_err(|_| "Не удалось проверить параметры аудио.")?
            .map_err(|_| "Не удалось проверить параметры аудио.")?;
        if warning_bytes.len() > 64 * 1024 { return Err("Некорректные параметры аудиофайла.".into()); }
        let estimated = String::from_utf8_lossy(&warning_bytes).contains("Estimating duration from bitrate");
        let (codec, duration) = audio_details(&value, None)?;
        Ok((codec, duration, estimated))
    }).await.map_err(|_| "Проверка аудио превысила допустимое время.");
    warnings.abort();
    let (codec, declared_duration, estimated_duration) = header_result??;
    // Container/Xing headers can retain the original duration after a download
    // was cut in half. Decode the actual audio to a null sink before accepting
    // it, without allocating PCM buffers or writing a second large file.
    let decoded_duration = decoded_duration(path, tools).await?;
    let tolerance = (declared_duration * 0.005).max(0.5);
    if !estimated_duration && decoded_duration < declared_duration - tolerance {
        return Err("Аудиофайл обрезан: фактическая звуковая дорожка короче заявленной. Неполный трек не добавлен.".into());
    }
    if decoded_duration > 10800.5 {
        return Err("Звуковая дорожка превышает 3 часа. Импорт отменён.".into());
    }
    if expected.is_some_and(|full| full.is_finite() && full > 30. && decoded_duration < full - (full * 0.08).max(5.)) {
        return Err("Сервис вернул короткий фрагмент вместо полного трека. Превью не добавлено; нужен полный аудиофайл.".into());
    }
    Ok((codec, decoded_duration))
}

fn completed_decode_duration(output: &[u8]) -> Result<f64, String> {
    let text = std::str::from_utf8(output).map_err(|_| "Не удалось проверить целостность аудио.")?;
    if !text.lines().any(|line| line.trim() == "progress=end") {
        return Err("Проверка звуковой дорожки не завершена. Импорт отменён.".into());
    }
    text.lines().filter_map(|line| line.strip_prefix("out_time_us="))
        .filter_map(|value| value.trim().parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.)
        .last().map(|value| value / 1_000_000.)
        .ok_or_else(|| "Файл не содержит декодируемой звуковой дорожки. Импорт отменён.".into())
}

async fn decoded_duration(path: &Path, tools: &Path) -> Result<f64, String> {
    let mut command = tokio::process::Command::new(tools.join(crate::youtube::import_tool_name("ffmpeg")));
    command.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-xerror", "-err_detect", "explode", "-threads", "1", "-protocol_whitelist", "file,pipe", "-i"])
        .arg(path).args(["-map", "0:a:0", "-vn", "-sn", "-dn", "-threads", "1", "-f", "null", "-progress", "pipe:1", "-stats_period", "10", "-nostats", "-"])
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)] command.creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|_| "Не удалось запустить проверку звуковой дорожки. Переустановите полную сборку Pulse.")?;
    let mut stdout = child.stdout.take().ok_or("Не удалось прочитать результат проверки звука.")?;
    tokio::time::timeout(Duration::from_secs(120), async {
        let mut output = Vec::new();
        (&mut stdout).take(64 * 1024 + 1).read_to_end(&mut output).await.map_err(|_| "Проверка звука прервана.")?;
        if output.len() > 64 * 1024 { return Err("Некорректный результат проверки звука.".into()); }
        let status = child.wait().await.map_err(|_| "Проверка звука прервана.")?;
        if !status.success() { return Err("Звуковая дорожка повреждена или не декодируется. Неполный трек не добавлен.".into()); }
        completed_decode_duration(&output)
    }).await.map_err(|_| "Проверка целостности аудио превысила 2 минуты. Файл не добавлен; попробуйте запись меньшего размера.")?
}

pub async fn for_vk(path: &Path, tools: &Path, directory: &Path) -> Result<PreparedAudio, String> {
    let input_metadata = std::fs::metadata(path).map_err(|_| "Не удалось прочитать аудиофайл для VK.".to_string())?;
    if !input_metadata.is_file() || input_metadata.len() == 0 || input_metadata.len() > 200 * 1024 * 1024 {
        return Err("Аудиофайл пуст или превышает ограничение VK в 200 МБ.".into());
    }
    let (codec, input_duration) = verify_audio(path, tools, None).await?;
    if codec == "mp3" && path.extension().is_some_and(|e| e.eq_ignore_ascii_case("mp3")) {
        return Ok(PreparedAudio { path: path.into(), temporary: false });
    }
    // A 320 kbit/s output that cannot fit is rejected before spending CPU on a
    // conversion which would hit -fs and produce only a partial track.
    if input_duration * 40_000. > (200 * 1024 * 1024 - 64 * 1024) as f64 {
        return Err("Полный трек в MP3 320 кбит/с превышает 200 МБ VK. Исходный файл не изменён.".into());
    }
    let mut prepared = PreparedAudio { path: directory.join(format!("vk-{}.mp3", hex::encode(rand::random::<[u8; 16]>()))), temporary: true };
    let mut command = tokio::process::Command::new(tools.join(crate::youtube::import_tool_name("ffmpeg")));
    command.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file,pipe", "-i"]).arg(path)
        .args(["-map", "0:a:0", "-vn", "-map_metadata", "0", "-c:a", "libmp3lame", "-b:a", "320k", "-fs", "209715201", "-f", "mp3"])
        .arg(&prepared.path).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)] command.creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|_| "Не удалось подготовить MP3 для VK.")?;
    let status = tokio::time::timeout(Duration::from_secs(180), child.wait()).await.map_err(|_| "Подготовка MP3 для VK заняла слишком много времени.")?
        .map_err(|_| "Подготовка MP3 для VK прервана.")?;
    if !status.success() || !std::fs::metadata(&prepared.path).is_ok_and(|m| m.is_file() && m.len() > 0 && m.len() <= 200 * 1024 * 1024) {
        return Err("Не удалось подготовить полный MP3 до 200 МБ для VK. Исходный файл не изменён.".into());
    }
    // A hard byte cap must never turn into an accepted, silently truncated
    // upload. Compare the converted duration with the validated source and
    // reject an output that lost a meaningful tail at the cap.
    let (_, converted_duration) = verify_audio(&prepared.path, tools, Some(input_duration)).await?;
    if converted_duration < input_duration - 0.5 {
        return Err("Подготовленный MP3 обрезан. Полный трек не помещается в 200 МБ; импорт отменён, исходный файл не изменён.".into());
    }
    // Retained until upload finishes; Drop removes the temporary conversion.
    prepared.temporary = true;
    Ok(prepared)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[cfg(windows)]
    use std::os::windows::process::CommandExt;
    #[test]
    fn audio_must_be_complete_and_have_real_audio_stream() {
        let full = json!({"streams":[{"codec_type":"audio","codec_name":"mp3"}],"format":{"duration":"180.4"}});
        assert_eq!(audio_details(&full, Some(180.)).unwrap().0, "mp3");
        let preview = json!({"streams":[{"codec_type":"audio","codec_name":"aac"}],"format":{"duration":"30"}});
        assert!(audio_details(&preview, Some(180.)).unwrap_err().contains("фрагмент"));
        assert!(audio_details(&json!({"streams":[{"codec_type":"video","codec_name":"h264"}],"format":{"duration":"180"}}), None).is_err());
        assert!(audio_details(&json!({"streams":[{"codec_type":"audio","codec_name":"mp3"}],"format":{"duration":"NaN"}}), None).is_err());
        assert!(audio_details(&json!({"streams":[],"format":{}}), None).is_err());
    }

    #[test]
    fn decode_requires_completion_and_positive_finite_audio_time() {
        assert_eq!(completed_decode_duration(b"out_time_us=44983923\nprogress=end\n").unwrap(), 44.983923);
        for output in [b"out_time_us=1000000\nprogress=continue\n".as_slice(), b"out_time_us=NaN\nprogress=end\n", b"out_time_us=0\nprogress=end\n", b"progress=end\n"] {
            assert!(completed_decode_duration(output).is_err());
        }
    }

    struct NativeFixture { directory: PathBuf, tools: PathBuf }
    impl NativeFixture {
        fn new() -> Self {
            let directory = std::env::temp_dir().join(format!("pulse-media-integrity-{}", hex::encode(rand::random::<[u8;16]>())));
            std::fs::create_dir(&directory).unwrap();
            let tools = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/import-tools");
            assert!(tools.join(crate::youtube::import_tool_name("ffmpeg")).is_file(), "Run npm run prepare:imports first");
            Self { directory, tools }
        }
        fn audio(&self, name: &str, codec: &str, duration: &str) -> PathBuf {
            let path = self.directory.join(name);
            let mut command = std::process::Command::new(self.tools.join(crate::youtube::import_tool_name("ffmpeg")));
            command.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", &format!("sine=frequency=440:duration={duration}"), "-metadata", "title=Fixture Title", "-metadata", "artist=Fixture Artist", "-c:a", codec]).arg(&path).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
            #[cfg(windows)] command.creation_flags(0x08000000);
            assert!(command.status().unwrap().success(), "fixture {name}");
            path
        }
        fn runtime(&self) -> tokio::runtime::Runtime {
            tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
        }
    }
    impl Drop for NativeFixture {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.directory); }
    }

    #[test]
    #[ignore = "Native codec regression; requires packaged ffmpeg/ffprobe"]
    fn native_xing_duration_cannot_hide_a_truncated_mp3() {
        let fixture = NativeFixture::new();
        let full = fixture.audio("full.mp3", "libmp3lame", "90");
        let truncated = fixture.directory.join("truncated.mp3");
        let bytes = std::fs::read(&full).unwrap();
        std::fs::write(&truncated, &bytes[..bytes.len()/2]).unwrap();
        fixture.runtime().block_on(async {
            let (codec, duration) = verify_audio(&full, &fixture.tools, Some(90.)).await.unwrap();
            assert_eq!(codec, "mp3"); assert!((duration-90.).abs() < 0.1);
            let error = verify_audio(&truncated, &fixture.tools, Some(90.)).await.unwrap_err();
            assert!(error.contains("обрезан"), "{error}");
            assert!(for_vk(&truncated, &fixture.tools, &fixture.directory).await.is_err());
            assert!(truncated.exists(), "never delete user's source file");
        });
    }

    #[test]
    #[ignore = "Native codec regression; requires packaged ffmpeg/ffprobe"]
    fn native_variable_bitrate_aac_uses_decoded_time_not_a_header_estimate() {
        let fixture = NativeFixture::new();
        let path = fixture.directory.join("variable.aac");
        let mut command = std::process::Command::new(fixture.tools.join(crate::youtube::import_tool_name("ffmpeg")));
        command.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=20", "-f", "lavfi", "-i", "anoisesrc=r=44100:d=40", "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1[a]", "-map", "[a]", "-c:a", "aac", "-q:a", "2"]).arg(&path).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        #[cfg(windows)] command.creation_flags(0x08000000);
        assert!(command.status().unwrap().success());
        fixture.runtime().block_on(async {
            let (codec, duration) = verify_audio(&path, &fixture.tools, Some(60.)).await.unwrap();
            assert_eq!(codec,"aac"); assert!((duration-60.).abs() < 0.1, "{duration}");
            let prepared = for_vk(&path, &fixture.tools, &fixture.directory).await.unwrap();
            assert!((verify_audio(&prepared.path, &fixture.tools, Some(60.)).await.unwrap().1 - 60.).abs() < 0.1);
        });
    }

    #[test]
    #[ignore = "Native codec regression; requires packaged ffmpeg/ffprobe"]
    fn native_vk_formats_convert_completely_and_cleanup_only_the_conversion() {
        let fixture = NativeFixture::new();
        fixture.runtime().block_on(async {
            for (name, codec) in [("track.wav","pcm_s16le"),("track.flac","flac"),("track.aac","aac"),("track.m4a","aac"),("track.ogg","libvorbis"),("track.opus","libopus"),("track.aiff","pcm_s16be"),("track.webm","libopus")] {
                let path = fixture.audio(name, codec, "2");
                let bytes = std::fs::read(&path).unwrap();
                let prepared = for_vk(&path, &fixture.tools, &fixture.directory).await.unwrap_or_else(|error| panic!("{name}: {error}"));
                assert_ne!(prepared.path, path);
                let (_, duration) = verify_audio(&prepared.path, &fixture.tools, Some(2.)).await.unwrap();
                assert!((duration-2.).abs() < 0.1, "{name} duration={duration}");
                let converted = prepared.path.clone(); drop(prepared);
                assert!(!converted.exists(), "{name}: cleanup conversion");
                assert_eq!(std::fs::read(&path).unwrap(), bytes, "{name}: unchanged original");
            }
            let path = fixture.audio("passthrough.mp3", "libmp3lame", "2");
            let bytes = std::fs::read(&path).unwrap();
            let prepared = for_vk(&path, &fixture.tools, &fixture.directory).await.unwrap();
            assert_eq!(prepared.path, path); drop(prepared);
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
            let invalid = fixture.directory.join("invalid.mp3");
            std::fs::write(&invalid, b"ID3not real audio").unwrap();
            assert!(verify_audio(&invalid, &fixture.tools, None).await.is_err());
        });
    }
}
