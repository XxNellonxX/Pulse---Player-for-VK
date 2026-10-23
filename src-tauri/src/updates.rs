//! Read-only release discovery. Installers are opened from this repository only.
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;
use url::Url;

#[cfg(test)]
const REPO: &str = "https://github.com/XxNellonxX/Pulse---Player-for-VK";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    current_version: String,
    latest_version: Option<String>,
    available: bool,
    notes: String,
    release_url: Option<String>,
    download_url: Option<String>,
}

fn version(value: &str) -> Option<[u64; 3]> {
    let parts: Vec<_> = value.strip_prefix('v').unwrap_or(value).split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let mut numbers = [0; 3];
    for (index, part) in parts.iter().enumerate() {
        if part.is_empty() || (part.len() > 1 && part.starts_with('0')) || !part.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        numbers[index] = part.parse().ok()?;
    }
    Some(numbers)
}

/// A published stable tag stays strict. The installed binary may be a valid
/// SemVer preview; the stable version of its own base is newer than that preview.
fn installed_version(value: &str) -> Option<([u64; 3], bool)> {
    fn identifiers(value: &str, prerelease: bool) -> bool {
        !value.is_empty() && value.split('.').all(|part| {
            !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                && !(prerelease && part.len() > 1 && part.bytes().all(|byte| byte.is_ascii_digit()) && part.starts_with('0'))
        })
    }
    let value = value.strip_prefix('v').unwrap_or(value);
    let (release, build) = value.split_once('+').map_or((value, None), |(release, build)| (release, Some(build)));
    if build.is_some_and(|value| !identifiers(value, false)) { return None; }
    let (core, prerelease) = release.split_once('-').map_or((release, None), |(core, prerelease)| (core, Some(prerelease)));
    if !core.as_bytes().first().is_some_and(u8::is_ascii_digit) { return None; }
    if prerelease.is_some_and(|value| !identifiers(value, true)) { return None; }
    Some((version(core)?, prerelease.is_some()))
}

fn asset_link(value: &str, tag: &str, name: &str) -> bool {
    if !release_link(value, true) { return false; }
    let Ok(mut expected) = Url::parse("https://github.com/XxNellonxX/Pulse---Player-for-VK/releases/download/") else { return false; };
    let Ok(mut segments) = expected.path_segments_mut() else { return false; };
    segments.pop_if_empty().push(tag).push(name);
    drop(segments);
    Url::parse(value).is_ok_and(|url| url == expected)
}

pub(crate) fn release_link(value: &str, download: bool) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    let prefix = if download {
        "/XxNellonxX/Pulse---Player-for-VK/releases/download/"
    } else {
        "/XxNellonxX/Pulse---Player-for-VK/releases/tag/"
    };
    url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.path().starts_with(prefix)
        && url.path().len() > prefix.len()
}

fn info(value: &Value, current: &str, os: &str, arch: &str) -> UpdateInfo {
    let mut result = UpdateInfo {
        current_version: current.into(),
        latest_version: None,
        available: false,
        notes: String::new(),
        release_url: None,
        download_url: None,
    };
    let Some(tag) = value.get("tag_name").and_then(Value::as_str) else {
        return result;
    };
    if value.get("draft").and_then(Value::as_bool) == Some(true)
        || value.get("prerelease").and_then(Value::as_bool) == Some(true)
    {
        return result;
    }
    let Some(latest) = version(tag) else {
        return result;
    };
    result.latest_version = Some(tag.trim_start_matches('v').into());
    result.available = installed_version(current).is_some_and(|(installed, prerelease)| latest > installed || latest == installed && prerelease);
    result.notes = value
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or("")
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .take(12_000)
        .collect();
    result.release_url = value
        .get("html_url")
        .and_then(Value::as_str)
        .filter(|url| release_link(url, false))
        .map(str::to_owned);
    let expected = if os == "windows" && arch == "x86_64" {
        Some("_x64-setup.exe")
    } else if os == "macos" && arch == "aarch64" {
        Some("_aarch64.dmg")
    } else if os == "macos" && arch == "x86_64" {
        Some("_x64.dmg")
    } else {
        None
    };
    if let (Some(assets), Some(suffix)) = (value.get("assets").and_then(Value::as_array), expected)
    {
        result.download_url = assets.iter().find_map(|asset| {
            let name = asset.get("name")?.as_str()?;
            let url = asset.get("browser_download_url")?.as_str()?;
            let version = tag.strip_prefix('v').unwrap_or(tag);
            let expected_name = format!("VK.Player_{version}{suffix}");
            let native_name = format!("VK Player_{version}{suffix}");
            ((name == expected_name || name == native_name) && asset_link(url, tag, name)).then(|| url.into())
        });
    }
    result
}

#[tauri::command]
pub async fn check_app_release() -> Result<UpdateInfo, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("Pulse/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| "Не удалось подготовить проверку обновлений.")?;
    let response = client
        .get("https://api.github.com/repos/XxNellonxX/Pulse---Player-for-VK/releases/latest")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|_| "Не удалось проверить обновления. Проверьте подключение.")?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(info(
            &Value::Null,
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
            std::env::consts::ARCH,
        ));
    }
    if !response.status().is_success() {
        return Err("Сервис обновлений временно недоступен. Попробуйте позже.".into());
    }
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Проверка обновлений прервана.")?
    {
        if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
            return Err("Некорректный ответ сервиса обновлений.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| "Некорректный ответ сервиса обновлений.")?;
    Ok(info(
        &value,
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn versions_are_compared_numerically_and_prereleases_are_excluded() {
        assert!(version("v0.10.0") > version("0.9.9"));
        assert_eq!(version("0.4.0-beta"), None);
        assert_eq!(version("999999999999999999999999.0.0"), None);
        assert!(
            !info(
                &json!({"tag_name":"v1.0.0","prerelease":true}),
                "0.4.0",
                "windows",
                "x86_64"
            )
            .available
        );
    }
    #[test]
    fn only_exact_repository_assets_and_current_architecture_are_used() {
        let base = format!("{REPO}/releases/download/v0.5.0/");
        let value = json!({"tag_name":"v0.5.0", "html_url":format!("{REPO}/releases/tag/v0.5.0"), "assets":[
            {"name":"VK.Player_0.5.0_aarch64.dmg","browser_download_url":format!("{base}VK.Player_0.5.0_aarch64.dmg")},
            {"name":"VK.Player_0.5.0_x64-setup.exe","browser_download_url":"https://github.com.evil.test/XxNellonxX/Pulse---Player-for-VK/releases/download/v0.5.0/a.exe"},
            {"name":"VK.Player_0.5.0_x64-setup.exe","browser_download_url":format!("{base}VK.Player_0.5.0_x64-setup.exe")}
        ]});
        let result = info(&value, "0.4.0", "windows", "x86_64");
        assert!(result.available);
        assert!(result
            .download_url
            .unwrap()
            .ends_with("VK.Player_0.5.0_x64-setup.exe"));
        assert!(info(&value, "0.4.0", "macos", "aarch64")
            .download_url
            .unwrap()
            .ends_with("_aarch64.dmg"));
        assert!(info(&value, "0.4.0", "macos", "x86_64")
            .download_url
            .is_none());
        assert!(!release_link(
            &format!("{base}installer.exe?redirect=evil"),
            true
        ));
    }

    fn release_051() -> Value {
        let base = format!("{REPO}/releases/download/v0.5.1/");
        json!({"tag_name":"v0.5.1","draft":false,"prerelease":false,"html_url":format!("{REPO}/releases/tag/v0.5.1"),"assets":[
            {"name":"VK.Player_0.5.1_aarch64.dmg","browser_download_url":format!("{base}VK.Player_0.5.1_aarch64.dmg")},
            {"name":"VK.Player_0.5.1_x64.dmg","browser_download_url":format!("{base}VK.Player_0.5.1_x64.dmg")},
            {"name":"VK.Player_0.5.1_x64-setup.exe","browser_download_url":format!("{base}VK.Player_0.5.1_x64-setup.exe")},
            {"name":"SHA256SUMS.txt","browser_download_url":format!("{base}SHA256SUMS.txt")}
        ]})
    }
    #[test]
    fn stable_051_updates_prior_stable_and_preview_builds() {
        for current in ["0.4.1", "0.5.0-preview.6", "0.5.0-preview.7", "0.5.1-preview.1", "0.5.1-rc.1+build.42"] {
            let result = info(&release_051(), current, "windows", "x86_64");
            assert!(result.available, "{current}");
            assert_eq!(result.latest_version.as_deref(), Some("0.5.1"));
        }
        for current in ["0.5.1", "0.5.1+build.42", "0.5.2-preview.1", "0.6.0", "1.0.0"] {
            assert!(!info(&release_051(), current, "windows", "x86_64").available, "{current}");
        }
    }
    #[test]
    fn invalid_versions_and_remote_previews_never_offer_an_update() {
        for current in ["", "0.5", "0.5.1-", "0.5.1-rc..1", "0.5.1-preview.01", "0.05.1", "0.5.1+", "0.5.1+a+b", "0.5.1-preview/1", "vv0.5.1", "999999999999999999999999.1.0"] {
            assert!(!info(&release_051(), current, "windows", "x86_64").available, "{current}");
        }
        for tag in ["v0.5.2-preview.1", "v0.5.2+build.1", "v00.5.2", "vv0.5.2", "v0.5.2-", "v0.5.2.1"] {
            let mut release = release_051(); release["tag_name"] = json!(tag);
            assert!(!info(&release, "0.4.1", "windows", "x86_64").available, "{tag}");
        }
        for flag in ["prerelease", "draft"] {
            let mut release = release_051(); release[flag] = json!(true);
            assert!(!info(&release, "0.4.1", "windows", "x86_64").available);
        }
    }
    #[test]
    fn stable_051_selects_the_exact_windows_or_mac_architecture_asset() {
        for (os, arch, suffix) in [("windows", "x86_64", "_x64-setup.exe"), ("macos", "aarch64", "_aarch64.dmg"), ("macos", "x86_64", "_x64.dmg")] {
            let selected = info(&release_051(), "0.4.1", os, arch).download_url.unwrap();
            assert_eq!(selected, format!("{REPO}/releases/download/v0.5.1/VK.Player_0.5.1{suffix}"));
        }
        for (os, arch) in [("linux", "x86_64"), ("windows", "aarch64"), ("macos", "arm"), ("android", "aarch64")] {
            assert!(info(&release_051(), "0.4.1", os, arch).download_url.is_none());
        }
    }
    #[test]
    fn stale_or_mislabeled_assets_are_not_selected_for_a_new_release() {
        let mut release = release_051();
        release["assets"] = json!([
            {"name":"VK.Player_0.4.1_x64-setup.exe","browser_download_url":format!("{REPO}/releases/download/v0.4.1/VK.Player_0.4.1_x64-setup.exe")},
            {"name":"VK.Player_0.5.1_x64-setup.exe","browser_download_url":format!("{REPO}/releases/download/v0.5.0/VK.Player_0.5.1_x64-setup.exe")},
            {"name":"VK.Player_0.5.1_x64-setup.exe","browser_download_url":format!("{REPO}/releases/download/v0.5.1/VK.Player_0.4.1_x64-setup.exe")},
            {"name":"other_0.5.1_x64-setup.exe","browser_download_url":format!("{REPO}/releases/download/v0.5.1/other_0.5.1_x64-setup.exe")}
        ]);
        assert!(info(&release, "0.4.1", "windows", "x86_64").download_url.is_none());
        release["assets"] = json!([{"name":"VK Player_0.5.1_x64-setup.exe","browser_download_url":format!("{REPO}/releases/download/v0.5.1/VK%20Player_0.5.1_x64-setup.exe")}]);
        assert!(info(&release, "0.4.1", "windows", "x86_64").download_url.is_some());
    }
}
