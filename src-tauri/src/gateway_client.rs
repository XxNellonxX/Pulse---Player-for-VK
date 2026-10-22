//! A fixed, public Pulse service origin. No VK traffic or account data is sent.
use reqwest::{header, redirect::Policy, Client};
use serde_json::Value;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
use url::Url;

const MAX_URL: usize = 8192;
const JSON_LIMIT: usize = 2 * 1024 * 1024;
const MEDIA_LIMIT: usize = 8 * 1024 * 1024;
const TOTAL_TIMEOUT: Duration = Duration::from_secs(45);

fn raw_url_valid(value: &str) -> bool {
    value.len() <= MAX_URL
        && !value
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte == b' ')
}
fn decimal(value: &str, min: u32, max: u32) -> bool {
    !value.is_empty()
        && value.len() <= 10
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && value
            .parse::<u32>()
            .is_ok_and(|number| (min..=max).contains(&number))
}
fn uuid(value: &str) -> bool {
    value.len() == 36
        && value != "00000000-0000-0000-0000-000000000000"
        && value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}
fn text(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.chars().count() <= max && !value.chars().any(char::is_control)
}
fn query(url: &Url, allowed: &[&str]) -> Result<std::collections::HashMap<String, String>, String> {
    if !raw_url_valid(url.as_str()) {
        return Err("Некорректный запрос сервиса Pulse.".into());
    }
    let mut result = std::collections::HashMap::new();
    for (name, value) in url.query_pairs() {
        if !allowed.contains(&name.as_ref())
            || result
                .insert(name.into_owned(), value.into_owned())
                .is_some()
        {
            return Err("Некорректный запрос сервиса Pulse.".into());
        }
    }
    Ok(result)
}
fn track_id(value: &str) -> bool {
    let value = value.strip_prefix("soundcloud:tracks:").unwrap_or(value);
    !value.is_empty()
        && !value.starts_with('0')
        && value.len() <= 20
        && value.bytes().all(|byte| byte.is_ascii_digit())
}
fn soundcloud_query(url: &Url) -> Result<(), String> {
    let invalid = || "Неподдерживаемый запрос SoundCloud.".to_string();
    match url.path() {
        "/tracks" => {
            let values = query(
                url,
                &[
                    "q",
                    "limit",
                    "offset",
                    "cursor",
                    "linked_partitioning",
                    "access",
                ],
            )?;
            if !values.get("q").is_some_and(|value| text(value, 300))
                || values
                    .get("limit")
                    .is_some_and(|value| !decimal(value, 1, 50))
                || values
                    .get("offset")
                    .is_some_and(|value| !decimal(value, 0, 10_000))
                || values.get("cursor").is_some_and(|value| !text(value, 2048))
                || values
                    .get("linked_partitioning")
                    .is_some_and(|value| value != "true")
                || values
                    .get("access")
                    .is_some_and(|value| value != "playable")
            {
                return Err(invalid());
            }
        }
        "/resolve" => {
            let values = query(url, &["url"])?;
            let value = values
                .get("url")
                .filter(|value| raw_url_valid(value))
                .ok_or_else(invalid)?;
            let permalink = Url::parse(value).map_err(|_| invalid())?;
            let parts: Vec<_> = permalink.path().trim_matches('/').split('/').collect();
            if permalink.scheme() != "https"
                || permalink.port_or_known_default() != Some(443)
                || !matches!(
                    permalink.host_str(),
                    Some("soundcloud.com" | "www.soundcloud.com" | "on.soundcloud.com")
                )
                || !permalink.username().is_empty()
                || permalink.password().is_some()
                || permalink.fragment().is_some()
                || permalink.query().is_some()
                || !(1..=2).contains(&parts.len())
                || parts.iter().any(|part| {
                    part.is_empty()
                        || !part
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
                })
            {
                return Err(invalid());
            }
        }
        path => {
            let normalized = path.replace("%3A", ":").replace("%3a", ":");
            let mut parts = normalized
                .strip_prefix("/tracks/")
                .ok_or_else(invalid)?
                .split('/');
            if !track_id(parts.next().unwrap_or_default())
                || !matches!(
                    (parts.next(), parts.next()),
                    (None, None) | (Some("streams"), None)
                )
                || !query(url, &[])?.is_empty()
            {
                return Err(invalid());
            }
        }
    }
    Ok(())
}

#[derive(Clone)]
pub(crate) struct Gateway {
    base: Url,
    client: Arc<Mutex<Option<(Instant, Client)>>>,
}
pub(crate) struct Resource {
    pub status: u16,
    pub bytes: Vec<u8>,
    pub content_type: String,
    pub content_range: Option<String>,
    pub final_url: String,
}

impl Gateway {
    pub fn configured() -> Result<Option<Self>, String> {
        // A publisher embeds a public origin at build time, never a shared key.
        option_env!("PULSE_GATEWAY_URL")
            .filter(|url| !url.is_empty())
            .map(Self::new)
            .transpose()
    }
    pub fn new(value: &str) -> Result<Self, String> {
        if !raw_url_valid(value) {
            return Err("Неверный адрес сервиса Pulse.".into());
        }
        let url = Url::parse(value).map_err(|_| "Неверный адрес сервиса Pulse.")?;
        let host = url.host_str().ok_or("Неверный адрес сервиса Pulse.")?;
        let public_name = host.contains('.')
            && host.len() <= 253
            && host.split('.').all(|label| {
                !label.is_empty()
                    && label.len() <= 63
                    && !label.starts_with('-')
                    && !label.ends_with('-')
                    && label
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            })
            && !["localhost", "local", "internal", "lan"]
                .iter()
                .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")));
        if url.scheme() != "https"
            || url.port_or_known_default() != Some(443)
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
            || !public_name
            || host.parse::<std::net::IpAddr>().is_ok()
            || host.contains(':')
            || value.len() > 2048
        {
            return Err("Нужен публичный HTTPS-домен сервиса Pulse без пути и ключей.".into());
        }
        Ok(Self {
            base: url,
            client: Arc::new(Mutex::new(None)),
        })
    }
    pub fn soundcloud_url(&self, upstream: &Url) -> Result<Url, String> {
        if upstream.scheme() != "https"
            || upstream.host_str() != Some("api.soundcloud.com")
            || upstream.port_or_known_default() != Some(443)
            || !upstream.username().is_empty()
            || upstream.password().is_some()
            || upstream.fragment().is_some()
        {
            return Err("Неподдерживаемый запрос SoundCloud.".into());
        }
        soundcloud_query(upstream)?;
        let mut url = self
            .base
            .join("v1/soundcloud/")
            .map_err(|_| "Неверный сервис Pulse.")?;
        url.set_path(&format!("/v1/soundcloud{}", upstream.path()));
        url.set_query(upstream.query());
        if url.as_str().len() > MAX_URL {
            return Err("Слишком длинный запрос SoundCloud.".into());
        }
        Ok(url)
    }
    pub fn musicbrainz_url(&self, upstream: &Url) -> Result<Url, String> {
        if upstream.host_str() != Some("musicbrainz.org")
            || upstream.scheme() != "https"
            || upstream.port_or_known_default() != Some(443)
            || !upstream.username().is_empty()
            || upstream.password().is_some()
            || upstream.fragment().is_some()
        {
            return Err("Неподдерживаемый запрос каталога.".into());
        }
        let query = query(
            upstream,
            &["query", "offset", "fmt", "limit", "artist", "inc"],
        )?;
        if query
            .get("offset")
            .is_some_and(|value| !decimal(value, 0, 10_000))
        {
            return Err("Неверная страница каталога.".into());
        }
        let path = upstream.path();
        let mut url = if path == "/ws/2/artist" {
            if !query.get("query").is_some_and(|value| text(value, 1024))
                || query
                    .keys()
                    .any(|key| !["query", "offset", "fmt", "limit"].contains(&key.as_str()))
            {
                return Err("Неверный запрос каталога.".into());
            }
            let mut url = self
                .base
                .join("v1/musicbrainz/search")
                .map_err(|_| "Неверный сервис Pulse.")?;
            url.query_pairs_mut().append_pair(
                "query",
                query.get("query").map(String::as_str).unwrap_or_default(),
            );
            url
        } else if let Some(id) = path.strip_prefix("/ws/2/artist/") {
            if !uuid(id)
                || query
                    .keys()
                    .any(|key| !["fmt", "inc"].contains(&key.as_str()))
            {
                return Err("Неверная карточка каталога.".into());
            }
            self.base
                .join(&format!("v1/musicbrainz/artist/{id}"))
                .map_err(|_| "Неверный сервис Pulse.")?
        } else if path == "/ws/2/release-group" {
            let id = query.get("artist").ok_or("Нет артиста каталога.")?;
            if !uuid(id)
                || query
                    .keys()
                    .any(|key| !["artist", "offset", "fmt", "limit"].contains(&key.as_str()))
            {
                return Err("Неверная карточка каталога.".into());
            }
            self.base
                .join(&format!("v1/musicbrainz/artist/{id}/releases"))
                .map_err(|_| "Неверный сервис Pulse.")?
        } else {
            return Err("Неподдерживаемый запрос каталога.".into());
        };
        if let Some(offset) = query.get("offset") {
            url.query_pairs_mut().append_pair("offset", offset);
        }
        if url.as_str().len() > MAX_URL {
            return Err("Слишком длинный запрос каталога.".into());
        }
        Ok(url)
    }
    pub fn media_url(&self, value: &str) -> Result<String, String> {
        if !raw_url_valid(value) {
            return Err("Неверный медиаканал Pulse.".into());
        }
        let url = Url::parse(value).map_err(|_| "Неверный медиаканал Pulse.")?;
        let parts: Vec<_> = url.path().split('/').collect();
        if url.origin() != self.base.origin()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || parts.len() != 5
            || parts[1] != "v1"
            || parts[2] != "media"
            || parts[3].len() != 48
            || !parts[3]
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || parts[4].is_empty()
            || parts[4].len() > 4
            || !parts[4].bytes().all(|b| b.is_ascii_digit())
            || parts[4].parse::<u16>().map_or(true, |index| index > 2047)
            || (parts[4].len() > 1 && parts[4].starts_with('0'))
        {
            return Err("Неверный медиаканал Pulse.".into());
        }
        Ok(url.to_string())
    }
    pub fn upstream_cursor(&self, value: &str) -> Result<String, String> {
        if !raw_url_valid(value) {
            return Err("Неверная страница SoundCloud.".into());
        }
        let url = Url::parse(value).map_err(|_| "Неверная страница SoundCloud.")?;
        if url.origin() != self.base.origin()
            || url.path() != "/v1/soundcloud/tracks"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err("Неверная страница SoundCloud.".into());
        }
        let mut upstream = Url::parse("https://api.soundcloud.com/tracks").unwrap();
        upstream.set_query(url.query());
        soundcloud_query(&upstream)?;
        Ok(upstream.to_string())
    }
    async fn client(&self) -> Result<Client, String> {
        let mut slot = self.client.lock().await;
        if let Some((at, client)) = slot
            .as_ref()
            .filter(|(at, _)| at.elapsed() < Duration::from_secs(300))
        {
            let _ = at;
            return Ok(client.clone());
        }
        let host = self.base.host_str().ok_or("Неверный сервис Pulse.")?;
        let addrs: Vec<_> =
            tokio::time::timeout(Duration::from_secs(8), tokio::net::lookup_host((host, 443)))
                .await
                .map_err(|_| "Сервис Pulse не ответил.")?
                .map_err(|_| "Сервис Pulse недоступен.")?
                .take(32)
                .collect();
        if addrs.is_empty()
            || addrs
                .iter()
                .any(|addr| !crate::soundcloud_catalog::public_ip(addr.ip()))
        {
            return Err("Адрес сервиса Pulse недоступен.".into());
        }
        let client = Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(30))
            .resolve_to_addrs(host, &addrs)
            .user_agent(concat!("Pulse/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| "Сервис Pulse недоступен.")?;
        *slot = Some((Instant::now(), client.clone()));
        Ok(client)
    }
    async fn get(&self, url: Url, range: Option<&str>, limit: usize) -> Result<Resource, u16> {
        tokio::time::timeout(TOTAL_TIMEOUT, self.get_inner(url, range, limit))
            .await
            .map_err(|_| 504u16)?
    }
    async fn get_inner(
        &self,
        url: Url,
        range: Option<&str>,
        limit: usize,
    ) -> Result<Resource, u16> {
        if url.origin() != self.base.origin()
            || !raw_url_valid(url.as_str())
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || limit > MEDIA_LIMIT
        {
            return Err(400);
        }
        let client = self.client().await.map_err(|_| 502u16)?;
        let mut request = client
            .get(url.clone())
            .header(header::ACCEPT_ENCODING, "identity");
        if let Some(range) = range {
            crate::soundcloud_catalog::validate_range(range).map_err(|_| 416u16)?;
            request = request.header(header::RANGE, range);
        }
        let mut response = request.send().await.map_err(|_| 502u16)?;
        let status = response.status().as_u16();
        if !matches!(status, 200 | 206) {
            return Err(if response.status().is_success() {
                502
            } else {
                status
            });
        }
        if response.content_length().is_some_and(|n| n > limit as u64) {
            return Err(502);
        }
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream")
            .chars()
            .filter(|c| !c.is_control())
            .take(200)
            .collect();
        let content_range = response
            .headers()
            .get(header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .map(|value| {
                value
                    .chars()
                    .filter(|c| !c.is_control())
                    .take(200)
                    .collect()
            });
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| 502u16)? {
            if bytes.len() + chunk.len() > limit {
                return Err(502);
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(Resource {
            status,
            bytes,
            content_type,
            content_range,
            final_url: url.to_string(),
        })
    }
    pub async fn json(&self, url: Url) -> Result<Value, u16> {
        let resource = self.get(url, None, JSON_LIMIT).await?;
        if resource.status != 200 {
            return Err(502);
        }
        serde_json::from_slice(&resource.bytes).map_err(|_| 502)
    }
    pub async fn media(&self, url: &str, range: Option<&str>) -> Result<Resource, u16> {
        let checked = self.media_url(url).map_err(|_| 400u16)?;
        self.get(
            Url::parse(&checked).map_err(|_| 400u16)?,
            range,
            MEDIA_LIMIT,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn service_origin_and_media_are_exact_and_public() {
        for value in [
            "http://pulse.example",
            "https://127.0.0.1",
            "https://localhost",
            "https://u:p@pulse.example",
            "https://pulse.example/a",
            "https://pulse.example?token=x",
        ] {
            assert!(Gateway::new(value).is_err());
        }
        let gateway = Gateway::new("https://pulse.example").unwrap();
        let good = format!("https://pulse.example/v1/media/{}/0", "a".repeat(48));
        assert!(gateway.media_url(&good).is_ok());
        for bad in [
            good.replace("pulse.example", "other.example"),
            format!("{good}?url=https://private"),
            good.replace("/0", "/../private"),
            good.replace("/0", "/file"),
        ] {
            assert!(gateway.media_url(&bad).is_err());
        }
    }
    #[test]
    fn provider_routes_preserve_only_the_service_origin() {
        let gateway = Gateway::new("https://pulse.example").unwrap();
        assert!(gateway
            .soundcloud_url(&Url::parse("https://evil.example/tracks").unwrap())
            .is_err());
        let url=gateway.musicbrainz_url(&Url::parse("https://musicbrainz.org/ws/2/release-group?artist=11111111-1111-4111-8111-111111111111&offset=30&limit=30").unwrap()).unwrap();
        assert_eq!(url.as_str(),"https://pulse.example/v1/musicbrainz/artist/11111111-1111-4111-8111-111111111111/releases?offset=30");
        assert!(gateway
            .upstream_cursor("https://evil.example/v1/soundcloud/tracks?offset=30")
            .is_err());
    }
    #[test]
    fn opaque_media_contract_uses_lower_hex_and_canonical_bounded_indices() {
        let gateway = Gateway::new("https://pulse.example").unwrap();
        for index in ["0", "1", "2047"] {
            assert!(gateway
                .media_url(&format!(
                    "https://pulse.example/v1/media/{}/{index}",
                    "abcdef01".repeat(6)
                ))
                .is_ok());
        }
        for index in [
            "00", "01", "0001", "2048", "9999", "-1", "+1", "%31", "1/", "1?x=1", "1#x",
        ] {
            assert!(
                gateway
                    .media_url(&format!(
                        "https://pulse.example/v1/media/{}/{index}",
                        "a".repeat(48)
                    ))
                    .is_err(),
                "index {index}"
            );
        }
        for token in [
            "A".repeat(48),
            "g".repeat(48),
            "a".repeat(47),
            "a".repeat(49),
        ] {
            assert!(gateway
                .media_url(&format!("https://pulse.example/v1/media/{token}/0"))
                .is_err());
        }
        let valid = format!("https://pulse.example/v1/media/{}/1", "a".repeat(48));
        for bad in [
            format!("\n{valid}"),
            format!("{valid}\t"),
            valid.replace("pulse.example", "user@pulse.example"),
            valid.replace("https://", "http://"),
        ] {
            assert!(gateway.media_url(&bad).is_err());
        }
    }
    #[test]
    fn provider_metadata_routes_reject_duplicate_unknown_and_cross_route_arguments() {
        let gateway = Gateway::new("https://pulse.example").unwrap();
        for value in [
            "https://musicbrainz.org/ws/2/release-group?artist=valid-id",
            "https://musicbrainz.org/ws/2/artist/11111111-1111-4111-8111-111111111111/releases",
            "https://musicbrainz.org/ws/2/artist?query=Artist&offset=1&offset=2",
            "https://musicbrainz.org/ws/2/artist?query=Artist&offset=10001",
            "https://musicbrainz.org/ws/2/artist?query=Artist&url=https://private.example",
            "https://musicbrainz.org/ws/2/artist/11111111-1111-4111-8111-111111111111?offset=30",
        ] {
            assert!(
                gateway
                    .musicbrainz_url(&Url::parse(value).unwrap())
                    .is_err(),
                "{value}"
            );
        }
        for value in [
            "https://api.soundcloud.com/me",
            "https://api.soundcloud.com/tracks?q=song&limit=10&limit=50",
            "https://api.soundcloud.com/tracks?q=song&offset=10001",
            "https://api.soundcloud.com/tracks?q=song&access_token=secret",
            "https://api.soundcloud.com/tracks/01/streams",
            "https://api.soundcloud.com/tracks/1/streams?url=https://other.example",
            "https://api.soundcloud.com/resolve?url=https%3A%2F%2Fevil.example%2Ftrack",
            "https://api.soundcloud.com/resolve?url=https%3A%2F%2Fsoundcloud.com%2Fa%2Fb%3Fsecret%3Dx",
        ] { assert!(gateway.soundcloud_url(&Url::parse(value).unwrap()).is_err(), "{value}"); }
        assert_eq!(
            gateway
                .soundcloud_url(
                    &Url::parse(
                        "https://api.soundcloud.com/tracks/soundcloud%3Atracks%3A123/streams"
                    )
                    .unwrap()
                )
                .unwrap()
                .path(),
            "/v1/soundcloud/tracks/soundcloud%3Atracks%3A123/streams"
        );
    }
    #[test]
    fn gateway_cursor_cannot_import_credentials_or_unbounded_pagination() {
        let gateway = Gateway::new("https://pulse.example").unwrap();
        let cursor =
            "https://pulse.example/v1/soundcloud/tracks?q=music&offset=30&limit=30&cursor=next";
        assert_eq!(
            gateway.upstream_cursor(cursor).unwrap(),
            "https://api.soundcloud.com/tracks?q=music&offset=30&limit=30&cursor=next"
        );
        for suffix in [
            "q=x&limit=51",
            "q=x&offset=10001",
            "q=x&cursor=one&cursor=two",
            "q=x&client_secret=secret",
            "q=x&linked_partitioning=false",
            "q=x&access=blocked",
        ] {
            assert!(gateway
                .upstream_cursor(&format!(
                    "https://pulse.example/v1/soundcloud/tracks?{suffix}"
                ))
                .is_err());
        }
        assert!(gateway
            .upstream_cursor(&format!(
                "https://pulse.example/v1/soundcloud/tracks?q=x&cursor={}",
                "a".repeat(2049)
            ))
            .is_err());
    }
    #[test]
    fn managed_soundcloud_source_validator_accepts_only_opaque_gateway_media() {
        let gateway = Gateway::new("https://pulse.example").unwrap();
        let provider = crate::soundcloud_catalog::SoundCloudCatalog::from_gateway(gateway);
        let good = format!("https://pulse.example/v1/media/{}/2047", "a".repeat(48));
        assert_eq!(provider.validate_source(&good).unwrap(), good);
        for bad in [
            "https://cf-hls-media.sndcdn.com/media/track.m3u8",
            "https://api.soundcloud.com/tracks/1/streams",
            "https://other.example/v1/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/0",
        ] {
            assert!(provider.validate_source(bad).is_err());
        }
    }
}
