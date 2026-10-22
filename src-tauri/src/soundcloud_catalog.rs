//! SoundCloud catalog and stream provider.
//!
//! This module is deliberately separate from the legacy SoundCloud original-file
//! importer. It uses only the documented API, never scrapes a website client id,
//! and keeps credentials, OAuth tokens, stream URLs and media bytes in memory.
//! It does not write an audio cache or expose a public proxy.

use reqwest::{
    header::{self, HeaderValue},
    redirect::Policy,
    Client, Response, StatusCode,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    env, fmt,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{sync::Mutex, time::timeout};
use url::Url;

const API_HOST: &str = "api.soundcloud.com";
const TOKEN_HOST: &str = "secure.soundcloud.com";
const API_BASE: &str = "https://api.soundcloud.com";
const TOKEN_URL: &str = "https://secure.soundcloud.com/oauth/token";
const MAX_QUERY: usize = 300;
const MAX_CURSOR: usize = 8192;
const MAX_LIMIT: u32 = 50;
const MAX_RESPONSE: usize = 2 * 1024 * 1024;
const MAX_MEDIA_RESPONSE: usize = 8 * 1024 * 1024;
const MAX_DURATION: f64 = 24. * 60. * 60.;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CatalogError {
    InvalidConfig,
    InvalidRequest,
    Network,
    Unauthorized,
    NotFound,
    Forbidden,
    Expired,
    RateLimited { retry_after_seconds: Option<u64> },
    Upstream,
    InvalidResponse,
    Unavailable,
}

impl fmt::Display for CatalogError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidConfig => write!(f, "Неверные настройки доступа или прокси SoundCloud."),
            Self::InvalidRequest => write!(f, "Некорректный запрос к SoundCloud."),
            Self::Network => write!(f, "Не удалось подключиться к SoundCloud."),
            Self::Unauthorized => write!(f, "SoundCloud отклонил авторизацию приложения."),
            Self::NotFound => write!(f, "SoundCloud не нашёл запрошенный ресурс."),
            Self::Forbidden => write!(f, "SoundCloud ограничил доступ к этому ресурсу."),
            Self::Expired => write!(f, "Срок действия аудиоссылки истёк. Требуется обновить источник SoundCloud."),
            Self::RateLimited {
                retry_after_seconds,
            } => match retry_after_seconds {
                Some(seconds) => write!(
                    f,
                    "Достигнут лимит SoundCloud. Повторите через {seconds} с."
                ),
                None => write!(f, "Достигнут лимит SoundCloud. Повторите позже."),
            },
            Self::Upstream => write!(f, "Сервис SoundCloud временно вернул ошибку."),
            Self::InvalidResponse => write!(f, "SoundCloud вернул неподдерживаемый ответ."),
            Self::Unavailable => write!(
                f,
                "Этот трек SoundCloud недоступен для полного прослушивания."
            ),
        }
    }
}

impl std::error::Error for CatalogError {}

fn gateway_error(status: u16) -> CatalogError {
    match status { 400 => CatalogError::InvalidRequest, 401 => CatalogError::Unauthorized,
        403 => CatalogError::Forbidden, 404 => CatalogError::NotFound,
        410 => CatalogError::Expired,
        429 => CatalogError::RateLimited { retry_after_seconds: None },
        503 => CatalogError::Unavailable, _ => CatalogError::Network }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub provider: String,
    pub urn: String,
    pub id: String,
    pub title: String,
    pub artist: String,
    pub duration: f64,
    pub isrc: Option<String>,
    pub explicit: Option<bool>,
    pub access: String,
    pub streamable: bool,
    pub permalink_url: Option<String>,
    pub artwork_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPage {
    pub items: Vec<Candidate>,
    pub next_href: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamSource {
    pub url: String,
    pub format: String,
    pub mime_type: String,
    pub quality: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamGrant {
    pub track: Candidate,
    pub sources: Vec<StreamSource>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaResource {
    pub status: u16,
    pub bytes: Vec<u8>,
    pub content_type: String,
    pub content_range: Option<String>,
    pub final_url: String,
}

#[derive(Clone)]
pub struct SoundCloudCatalog {
    gateway: Option<crate::gateway_client::Gateway>,
    client_id: String,
    client_secret: String,
    proxy: Option<String>,
    token: Arc<Mutex<Option<AccessToken>>>,
    clients: Arc<Mutex<Vec<CachedClient>>>,
}

struct CachedClient {
    host: String,
    client: Client,
    created: Instant,
}

#[derive(Clone)]
struct AccessToken {
    value: String,
    refresh: Option<String>,
    expires_at: Instant,
}

impl SoundCloudCatalog {
    pub fn is_managed(&self) -> bool { self.gateway.is_some() }
    pub fn from_gateway(gateway: crate::gateway_client::Gateway) -> Self {
        Self { gateway: Some(gateway), client_id: String::new(), client_secret: String::new(), proxy: None,
            token: Arc::new(Mutex::new(None)), clients: Arc::new(Mutex::new(Vec::new())) }
    }
    pub fn validate_source(&self, value: &str) -> Result<String, CatalogError> {
        match &self.gateway { Some(gateway) => gateway.media_url(value).map_err(|_| CatalogError::InvalidRequest), None => validate_media_url(value) }
    }
    pub fn uses_proxy(&self) -> bool {
        self.proxy.is_some()
    }

    /// Verifies app authorization and one bounded public catalog request.
    /// This intentionally does not claim that a full audio stream is playable.
    pub async fn check_connection(&self) -> Result<(), CatalogError> {
        timeout(Duration::from_secs(30), self.search("soundcloud", None, 1))
            .await
            .map_err(|_| CatalogError::Network)?
            .map(|_| ())
    }

    /// Reads optional runtime configuration. No secret value is returned or logged.
    /// `Ok(None)` means that SoundCloud was not configured, rather than mocked.
    pub fn from_env() -> Result<Option<Self>, CatalogError> {
        let id = env::var("PULSE_SOUNDCLOUD_CLIENT_ID").ok();
        let secret = env::var("PULSE_SOUNDCLOUD_CLIENT_SECRET").ok();
        if id.is_none() && secret.is_none() {
            return Ok(None);
        }
        let proxy = env::var("PULSE_SOUNDCLOUD_PROXY").ok();
        Self::from_config(id.unwrap_or_default(), secret.unwrap_or_default(), proxy).map(Some)
    }

    pub fn from_config(
        client_id: String,
        client_secret: String,
        proxy: Option<String>,
    ) -> Result<Self, CatalogError> {
        if !valid_credential(&client_id)
            || !valid_credential(&client_secret)
            || placeholder_credential(&client_id)
            || placeholder_credential(&client_secret)
        {
            return Err(CatalogError::InvalidConfig);
        }
        if let Some(value) = proxy.as_deref() {
            validate_proxy(value)?;
        }
        Ok(Self {
            gateway: None,
            client_id,
            client_secret,
            proxy,
            token: Arc::new(Mutex::new(None)),
            clients: Arc::new(Mutex::new(Vec::new())),
        })
    }

    pub async fn search(
        &self,
        query: &str,
        next_href: Option<&str>,
        limit: u32,
    ) -> Result<CatalogPage, CatalogError> {
        let query = clean_query(query)?;
        let limit = limit.clamp(1, MAX_LIMIT);
        let url = if let Some(cursor) = next_href {
            validate_api_cursor(cursor)?
        } else {
            let mut url = api_url("/tracks")?;
            url.query_pairs_mut()
                .append_pair("q", &query)
                .append_pair("access", "playable")
                .append_pair("limit", &limit.to_string())
                .append_pair("linked_partitioning", "true");
            url
        };
        let value = self.api_json(url).await?;
        let mut value = value;
        if let Some(gateway) = &self.gateway {
            if let Some(cursor) = value.get("next_href").and_then(Value::as_str) {
                let cursor = gateway.upstream_cursor(cursor).map_err(|_|CatalogError::InvalidResponse)?;
                value["next_href"] = Value::String(cursor);
            }
        }
        parse_page(&value)
    }

    pub async fn resolve(&self, permalink: &str) -> Result<Candidate, CatalogError> {
        let permalink = validate_permalink(permalink)?;
        let mut url = api_url("/resolve")?;
        url.query_pairs_mut().append_pair("url", &permalink);
        let value = self.api_json(url).await?;
        parse_candidate(&value)
    }

    pub async fn streams(&self, track_urn: &str) -> Result<StreamGrant, CatalogError> {
        let urn = normalize_track_id(track_urn)?;
        let track = self.track(&urn).await?;
        if !track.streamable {
            return Err(CatalogError::Unavailable);
        }
        let url = api_url_segments(&["tracks", &urn, "streams"])?;
        let value = self.api_json(url).await?;
        let sources = parse_streams_with(&value, |url| self.validate_source(url))?;
        Ok(StreamGrant { track, sources })
    }

    /// Fetches one manifest/segment through this provider's optional proxy.
    /// The response is bounded and stays in memory; callers must not persist it
    /// as a public or cross-user audio cache.
    pub async fn fetch_media(
        &self,
        media_url: &str,
        range: Option<&str>,
    ) -> Result<MediaResource, CatalogError> {
        if let Some(gateway) = &self.gateway {
            let resource = gateway.media(media_url, range).await.map_err(gateway_error)?;
            return Ok(MediaResource { status: resource.status, bytes: resource.bytes, content_type: resource.content_type,
                content_range: resource.content_range, final_url: resource.final_url });
        }
        timeout(
            Duration::from_secs(45),
            self.fetch_media_inner(media_url, range),
        )
        .await
        .map_err(|_| CatalogError::Network)?
    }

    async fn fetch_media_inner(
        &self,
        media_url: &str,
        range: Option<&str>,
    ) -> Result<MediaResource, CatalogError> {
        let mut url = Url::parse(&validate_media_url(media_url)?)
            .map_err(|_| CatalogError::InvalidRequest)?;
        if let Some(value) = range {
            validate_range(value)?;
        }
        let mut redirects = 0;
        let mut refreshed = false;
        for _ in 0..=6 {
            let client = self.client_for(&url).await?;
            let mut request = client
                .get(url.clone())
                .header(header::ACCEPT_ENCODING, "identity");
            let token = if url.host_str() == Some(API_HOST) {
                Some(self.access_token(None).await?)
            } else {
                None
            };
            if let Some(token) = token.as_deref() {
                request = request.header(header::AUTHORIZATION, oauth_header(token)?);
            }
            if let Some(value) = range {
                request = request.header(
                    header::RANGE,
                    HeaderValue::from_str(value).map_err(|_| CatalogError::InvalidRequest)?,
                );
            }
            let response = timeout(Duration::from_secs(45), request.send())
                .await
                .map_err(|_| CatalogError::Network)?
                .map_err(|_| CatalogError::Network)?;
            let status = response.status();
            if status == StatusCode::UNAUTHORIZED && !refreshed {
                if let Some(token) = token.as_deref() {
                    self.access_token(Some(token)).await?;
                    refreshed = true;
                    continue;
                }
            }
            if status.is_redirection() {
                if redirects == 5 {
                    return Err(CatalogError::InvalidResponse);
                }
                redirects += 1;
                url = redirect_url(&response, &url, false)?;
                continue;
            }
            if !status.is_success() && status != StatusCode::PARTIAL_CONTENT {
                return Err(status_error(&response));
            }
            let content_type: String = response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("application/octet-stream")
                .chars()
                .filter(|character| !character.is_control())
                .take(200)
                .collect();
            if content_type
                .to_ascii_lowercase()
                .contains("application/json")
            {
                if redirects == 5 {
                    return Err(CatalogError::InvalidResponse);
                }
                redirects += 1;
                let value: Value =
                    serde_json::from_slice(&bounded_response(response, MAX_RESPONSE).await?)
                        .map_err(|_| CatalogError::InvalidResponse)?;
                let address = value
                    .get("url")
                    .and_then(Value::as_str)
                    .ok_or(CatalogError::InvalidResponse)?;
                url = Url::parse(&validate_media_url(address)?)
                    .map_err(|_| CatalogError::InvalidResponse)?;
                continue;
            }
            let content_range = response
                .headers()
                .get(header::CONTENT_RANGE)
                .and_then(|value| value.to_str().ok())
                .map(|value| {
                    value
                        .chars()
                        .filter(|character| !character.is_control())
                        .take(200)
                        .collect()
                });
            let bytes = bounded_response(response, MAX_MEDIA_RESPONSE).await?;
            if content_type.to_ascii_lowercase().contains("html")
                || bytes.starts_with(b"<!DOCTYPE")
                || bytes.starts_with(b"<html")
            {
                return Err(CatalogError::InvalidResponse);
            }
            return Ok(MediaResource {
                status: status.as_u16(),
                bytes,
                content_type,
                content_range,
                final_url: url.to_string(),
            });
        }
        Err(CatalogError::InvalidResponse)
    }

    pub async fn track(&self, id: &str) -> Result<Candidate, CatalogError> {
        let urn = normalize_track_id(id)?;
        let url = api_url_segments(&["tracks", &urn])?;
        let value = self.api_json(url).await?;
        let track = parse_candidate(&value)?;
        if track.urn != urn {
            return Err(CatalogError::InvalidResponse);
        }
        Ok(track)
    }

    async fn api_json(&self, url: Url) -> Result<Value, CatalogError> {
        if let Some(gateway) = &self.gateway {
            validate_api_url(&url)?;
            let url = gateway.soundcloud_url(&url).map_err(|_|CatalogError::InvalidRequest)?;
            return gateway.json(url).await.map_err(gateway_error);
        }
        timeout(Duration::from_secs(30), self.api_json_inner(url))
            .await
            .map_err(|_| CatalogError::Network)?
    }

    async fn api_json_inner(&self, mut url: Url) -> Result<Value, CatalogError> {
        validate_api_url(&url)?;
        for retry in 0..2 {
            let token = self.access_token(None).await?;
            let mut unauthorized = false;
            for redirects in 0..=5 {
                let client = self.client_for(&url).await?;
                let response = timeout(
                    Duration::from_secs(30),
                    client
                        .get(url.clone())
                        .header(header::AUTHORIZATION, oauth_header(&token)?)
                        .send(),
                )
                .await
                .map_err(|_| CatalogError::Network)?
                .map_err(|_| CatalogError::Network)?;
                if response.status() == StatusCode::UNAUTHORIZED && retry == 0 {
                    self.access_token(Some(&token)).await?;
                    unauthorized = true;
                    break;
                }
                if response.status().is_redirection() {
                    if redirects == 5 {
                        return Err(CatalogError::InvalidResponse);
                    }
                    url = redirect_url(&response, &url, true)?;
                    continue;
                }
                if !response.status().is_success() {
                    return Err(status_error(&response));
                }
                let bytes = bounded_response(response, MAX_RESPONSE).await?;
                return serde_json::from_slice(&bytes).map_err(|_| CatalogError::InvalidResponse);
            }
            if !unauthorized {
                return Err(CatalogError::InvalidResponse);
            }
        }
        Err(CatalogError::Unauthorized)
    }

    async fn access_token(&self, rejected: Option<&str>) -> Result<String, CatalogError> {
        // One refresh/exchange per provider, including concurrent searches.
        let mut slot = self.token.lock().await;
        if let Some(token) = slot.as_ref().filter(|token| {
            token.expires_at > Instant::now() && rejected != Some(token.value.as_str())
        }) {
            return Ok(token.value.clone());
        }
        let refresh = slot.as_ref().and_then(|token| token.refresh.clone());
        let token = match self.exchange_token(refresh.as_deref()).await {
            Err(CatalogError::Unauthorized | CatalogError::InvalidRequest) if refresh.is_some() => {
                self.exchange_token(None).await?
            }
            result => result?,
        };
        let result = token.value.clone();
        *slot = Some(token);
        Ok(result)
    }

    async fn exchange_token(&self, refresh: Option<&str>) -> Result<AccessToken, CatalogError> {
        let url = Url::parse(TOKEN_URL).map_err(|_| CatalogError::InvalidConfig)?;
        let client = self.client_for(&url).await?;
        let response = timeout(
            Duration::from_secs(20),
            self.token_request(&client, refresh).send(),
        )
        .await
        .map_err(|_| CatalogError::Network)?
        .map_err(|_| CatalogError::Network)?;
        if !response.status().is_success() {
            return Err(status_error(&response));
        }
        let bytes = bounded_response(response, MAX_RESPONSE).await?;
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| CatalogError::InvalidResponse)?;
        parse_token(&value)
    }

    fn token_request(&self, client: &Client, refresh: Option<&str>) -> reqwest::RequestBuilder {
        let request = client
            .post(TOKEN_URL)
            .header(header::ACCEPT, "application/json");
        match refresh {
            // The current official guide places these credentials in the form
            // for refresh. Client credentials grants remain strictly Basic-only.
            Some(token) => request.form(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", token),
                ("client_id", self.client_id.as_str()),
                ("client_secret", self.client_secret.as_str()),
            ]),
            None => request
                .basic_auth(&self.client_id, Some(&self.client_secret))
                .form(&[("grant_type", "client_credentials")]),
        }
    }

    async fn client_for(&self, url: &Url) -> Result<Client, CatalogError> {
        let host = url.host_str().ok_or(CatalogError::InvalidRequest)?;
        if !safe_https(url)
            || !(host == TOKEN_HOST
                || host == API_HOST
                || host.ends_with(".sndcdn.com")
                || host == "playback.media-streaming.soundcloud.cloud")
        {
            return Err(CatalogError::InvalidRequest);
        }
        // Reuse connections across HLS segments. DNS is pinned only for this
        // bounded lifetime; creating a new TLS client per segment causes stalls.
        let mut clients = self.clients.lock().await;
        clients.retain(|cached| cached.created.elapsed() < Duration::from_secs(300));
        if let Some(cached) = clients.iter().find(|cached| cached.host == host) {
            return Ok(cached.client.clone());
        }
        let mut builder = Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(30))
            .user_agent("Pulse SoundCloud catalog provider/1.0");
        if let Some(proxy) = self.proxy.as_deref() {
            // A user-selected proxy owns target DNS (including SOCKS5h). Do not
            // require a working local resolver or pretend its answer pins the
            // remote proxy's resolution. Only official provider hosts reach here.
            builder =
                builder.proxy(reqwest::Proxy::all(proxy).map_err(|_| CatalogError::InvalidConfig)?);
        } else {
            let addresses = timeout(
                Duration::from_secs(10),
                tokio::net::lookup_host((host, 443)),
            )
            .await
            .map_err(|_| CatalogError::Network)?
            .map_err(|_| CatalogError::Network)?
            .collect::<Vec<SocketAddr>>();
            if addresses.is_empty() || addresses.iter().any(|address| !public_ip(address.ip())) {
                return Err(CatalogError::InvalidRequest);
            }
            builder = builder.resolve_to_addrs(host, &addresses);
        }
        let client = builder.build().map_err(|_| CatalogError::Network)?;
        if clients.len() >= 32 {
            clients.remove(0);
        }
        clients.push(CachedClient {
            host: host.into(),
            client: client.clone(),
            created: Instant::now(),
        });
        Ok(client)
    }
}

#[cfg(test)]
fn parse_streams(value: &Value) -> Result<Vec<StreamSource>, CatalogError> {
    parse_streams_with(value, validate_media_url)
}
fn parse_streams_with(value: &Value, validate: impl Fn(&str) -> Result<String, CatalogError>) -> Result<Vec<StreamSource>, CatalogError> {
    if !value.is_object() {
        return Err(CatalogError::InvalidResponse);
    }
    let mut sources = Vec::new();
    for (key, quality) in [
        ("hls_aac_160_url", "aac-160"),
        ("hls_mp3_128_url", "mp3-128"),
    ] {
        if let Some(address) = value.get(key).filter(|value| !value.is_null()) {
            let address = address.as_str().ok_or(CatalogError::InvalidResponse)?;
            let address = validate(address)?;
            if sources
                .iter()
                .all(|source: &StreamSource| source.url != address)
            {
                sources.push(StreamSource {
                    url: address,
                    format: "hls".into(),
                    mime_type: "application/vnd.apple.mpegurl".into(),
                    quality: quality.into(),
                });
            }
        }
    }
    if sources.is_empty() {
        return Err(CatalogError::Unavailable);
    }
    Ok(sources)
}

fn parse_page(value: &Value) -> Result<CatalogPage, CatalogError> {
    let collection = value
        .get("collection")
        .and_then(Value::as_array)
        .ok_or(CatalogError::InvalidResponse)?;
    if collection.len() > MAX_LIMIT as usize {
        return Err(CatalogError::InvalidResponse);
    }
    let mut items = Vec::with_capacity(collection.len());
    for track in collection {
        if track.get("kind").and_then(Value::as_str).unwrap_or("track") == "track" {
            items.push(parse_candidate(track)?);
        }
    }
    let next_href = value
        .get("next_href")
        .and_then(Value::as_str)
        .map(validate_api_cursor)
        .transpose()?
        .map(|url| url.to_string());
    Ok(CatalogPage { items, next_href })
}

fn parse_candidate(value: &Value) -> Result<Candidate, CatalogError> {
    if value
        .get("kind")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind != "track")
    {
        return Err(CatalogError::InvalidResponse);
    }
    let urn = value
        .get("urn")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            value
                .get("id")
                .and_then(Value::as_u64)
                .map(|id| format!("soundcloud:tracks:{id}"))
        })
        .ok_or(CatalogError::InvalidResponse)?;
    let urn = validate_track_urn(&urn)?;
    let id = urn.rsplit(':').next().unwrap_or_default().to_owned();
    if let Some(numeric_id) = value.get("id").and_then(Value::as_u64) {
        if numeric_id.to_string() != id {
            return Err(CatalogError::InvalidResponse);
        }
    }
    let title = clean_text(
        value
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("SoundCloud track"),
        300,
    );
    let artist = clean_text(
        value
            .get("metadata_artist")
            .and_then(Value::as_str)
            .filter(|artist| !artist.trim().is_empty())
            .or_else(|| value.pointer("/user/username").and_then(Value::as_str))
            .unwrap_or("SoundCloud"),
        200,
    );
    let duration = value
        .get("duration")
        .and_then(Value::as_f64)
        .ok_or(CatalogError::InvalidResponse)?
        / 1000.;
    if !duration.is_finite() || !(0. ..=MAX_DURATION).contains(&duration) {
        return Err(CatalogError::InvalidResponse);
    }
    let access = clean_access(
        value
            .get("access")
            .and_then(Value::as_str)
            .unwrap_or("blocked"),
    );
    let isrc = value
        .get("isrc")
        .and_then(Value::as_str)
        .or_else(|| {
            value
                .pointer("/publisher_metadata/isrc_code")
                .and_then(Value::as_str)
        })
        .and_then(normalize_isrc);
    let explicit = value.get("explicit").and_then(Value::as_bool).or_else(|| {
        value
            .pointer("/publisher_metadata/explicit")
            .and_then(Value::as_bool)
    });
    let permalink_url = value
        .get("permalink_url")
        .and_then(Value::as_str)
        .map(validate_permalink)
        .transpose()?;
    let artwork_url = value
        .get("artwork_url")
        .and_then(Value::as_str)
        .map(validate_artwork)
        .transpose()?;
    let streamable =
        access == "playable" && value.get("streamable").and_then(Value::as_bool) != Some(false);
    Ok(Candidate {
        provider: "soundcloud".into(),
        urn,
        id,
        title,
        artist,
        duration,
        isrc,
        explicit,
        access: access.clone(),
        streamable,
        permalink_url,
        artwork_url,
    })
}

fn clean_access(value: &str) -> String {
    match value {
        "playable" | "preview" | "blocked" => value.into(),
        _ => "blocked".into(),
    }
}

fn clean_text(value: &str, max: usize) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .take(max)
        .collect::<String>()
        .trim()
        .into()
}

fn valid_credential(value: &str) -> bool {
    !value.is_empty() && value.len() <= 8192 && value.bytes().all(|byte| byte.is_ascii_graphic())
}

fn placeholder_credential(value: &str) -> bool {
    let normalized = value
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .flat_map(char::to_lowercase)
        .collect::<String>();
    matches!(
        normalized.as_str(),
        "clientid"
            | "clientsecret"
            | "yourclientid"
            | "yourclientsecret"
            | "changeme"
            | "replaceme"
            | "example"
    ) || normalized.contains("placeholder")
        || normalized.starts_with("pasteclient")
        || normalized.starts_with("pasteyour")
        || normalized.starts_with("insertyour")
        || normalized.starts_with("insertclient")
        || normalized.contains("clientidhere")
        || normalized.contains("clientsecrethere")
        || (value.starts_with('<') && value.ends_with('>'))
}

fn clean_query(value: &str) -> Result<String, CatalogError> {
    let value = clean_text(value, MAX_QUERY);
    if value.is_empty() {
        Err(CatalogError::InvalidRequest)
    } else {
        Ok(value)
    }
}

fn api_url(path: &str) -> Result<Url, CatalogError> {
    Url::parse(&format!("{API_BASE}{path}")).map_err(|_| CatalogError::InvalidConfig)
}

fn api_url_segments(segments: &[&str]) -> Result<Url, CatalogError> {
    let mut url = api_url("/")?;
    {
        let mut path = url
            .path_segments_mut()
            .map_err(|_| CatalogError::InvalidConfig)?;
        path.clear();
        for segment in segments {
            path.push(segment);
        }
    }
    Ok(url)
}

fn normalize_track_id(value: &str) -> Result<String, CatalogError> {
    if value.starts_with("soundcloud:tracks:") {
        return validate_track_urn(value);
    }
    validate_track_urn(&format!("soundcloud:tracks:{value}"))
}

fn safe_https(url: &Url) -> bool {
    url.as_str().len() <= 16384
        && url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && url.host_str().is_some()
        && !url.as_str().bytes().any(|byte| byte.is_ascii_control())
}

fn validate_api_url(url: &Url) -> Result<(), CatalogError> {
    if !safe_https(url)
        || url.host_str() != Some(API_HOST)
        || url.query_pairs().any(|(name, _)| {
            matches!(
                name.to_ascii_lowercase().as_str(),
                "access_token" | "client_secret" | "oauth_token" | "authorization"
            )
        })
    {
        return Err(CatalogError::InvalidRequest);
    }
    if matches!(url.path(), "/tracks" | "/resolve") {
        return Ok(());
    }
    let path = url.path().replace("%3A", ":").replace("%3a", ":");
    let mut parts = path
        .strip_prefix("/tracks/")
        .ok_or(CatalogError::InvalidRequest)?
        .split('/');
    normalize_track_id(parts.next().unwrap_or_default())?;
    match (parts.next(), parts.next()) {
        (None, None) | (Some("streams"), None) => Ok(()),
        _ => Err(CatalogError::InvalidRequest),
    }
}

fn redirect_url(response: &Response, current: &Url, api_only: bool) -> Result<Url, CatalogError> {
    let location = response
        .headers()
        .get(header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .ok_or(CatalogError::InvalidResponse)?;
    if location.len() > 16384 || location.bytes().any(|byte| byte.is_ascii_control()) {
        return Err(CatalogError::InvalidResponse);
    }
    let target = current
        .join(location)
        .map_err(|_| CatalogError::InvalidResponse)?;
    if api_only {
        validate_api_url(&target).map_err(|_| CatalogError::InvalidResponse)?;
    } else {
        validate_media_url(target.as_str())?;
    }
    Ok(target)
}

fn oauth_header(token: &str) -> Result<HeaderValue, CatalogError> {
    if !valid_credential(token) {
        return Err(CatalogError::InvalidResponse);
    }
    let mut value = HeaderValue::from_str(&format!("OAuth {token}"))
        .map_err(|_| CatalogError::InvalidResponse)?;
    value.set_sensitive(true);
    Ok(value)
}

fn parse_token(value: &Value) -> Result<AccessToken, CatalogError> {
    let token = value
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|value| valid_credential(value))
        .ok_or(CatalogError::InvalidResponse)?;
    let refresh = value
        .get("refresh_token")
        .filter(|value| !value.is_null())
        .map(|value| {
            value
                .as_str()
                .filter(|value| valid_credential(value))
                .map(str::to_owned)
                .ok_or(CatalogError::InvalidResponse)
        })
        .transpose()?;
    let lifetime = value
        .get("expires_in")
        .and_then(Value::as_u64)
        .filter(|seconds| (1..=604800).contains(seconds))
        .ok_or(CatalogError::InvalidResponse)?;
    let usable_lifetime = lifetime - (lifetime / 10).min(30);
    let expires_at = Instant::now()
        .checked_add(Duration::from_secs(usable_lifetime))
        .ok_or(CatalogError::InvalidResponse)?;
    Ok(AccessToken {
        value: token.into(),
        refresh,
        expires_at,
    })
}

fn normalize_isrc(value: &str) -> Option<String> {
    if value.len() > 64 {
        return None;
    }
    let value = value
        .bytes()
        .filter(|byte| !matches!(byte, b'-' | b' '))
        .map(|byte| byte.to_ascii_uppercase())
        .collect::<Vec<_>>();
    if value.len() != 12
        || !value[..2].iter().all(u8::is_ascii_uppercase)
        || !value[2..5].iter().all(u8::is_ascii_alphanumeric)
        || !value[5..].iter().all(u8::is_ascii_digit)
    {
        return None;
    }
    String::from_utf8(value).ok()
}

fn validate_api_cursor(value: &str) -> Result<Url, CatalogError> {
    if value.len() > MAX_CURSOR || value.bytes().any(|byte| byte.is_ascii_control()) {
        return Err(CatalogError::InvalidRequest);
    }
    let url = Url::parse(value).map_err(|_| CatalogError::InvalidRequest)?;
    validate_api_url(&url)?;
    if url.path() != "/tracks" {
        return Err(CatalogError::InvalidRequest);
    }
    let mut names = Vec::new();
    for (name, value) in url.query_pairs() {
        if !matches!(
            name.as_ref(),
            "q" | "limit" | "offset" | "cursor" | "linked_partitioning" | "access"
        ) || value.len() > 2048
        {
            return Err(CatalogError::InvalidRequest);
        }
        if names.iter().any(|existing: &String| existing == &name) {
            return Err(CatalogError::InvalidRequest);
        }
        if name == "limit"
            && value
                .parse::<u32>()
                .ok()
                .filter(|value| (1..=MAX_LIMIT).contains(value))
                .is_none()
        {
            return Err(CatalogError::InvalidRequest);
        }
        names.push(name.into_owned());
    }
    Ok(url)
}

fn validate_permalink(value: &str) -> Result<String, CatalogError> {
    if value.len() > 16384 || value.bytes().any(|byte| byte.is_ascii_control()) {
        return Err(CatalogError::InvalidResponse);
    }
    let url = Url::parse(value).map_err(|_| CatalogError::InvalidResponse)?;
    let host = url.host_str().unwrap_or_default();
    if !safe_https(&url)
        || !matches!(
            host,
            "soundcloud.com" | "www.soundcloud.com" | "on.soundcloud.com"
        )
    {
        return Err(CatalogError::InvalidResponse);
    }
    Ok(url.to_string())
}

fn validate_track_urn(value: &str) -> Result<String, CatalogError> {
    let id = value
        .strip_prefix("soundcloud:tracks:")
        .ok_or(CatalogError::InvalidRequest)?;
    if id.is_empty()
        || id.len() > 20
        || id.starts_with('0')
        || !id.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(CatalogError::InvalidRequest);
    }
    Ok(value.into())
}

fn validate_artwork(value: &str) -> Result<String, CatalogError> {
    if value.len() > 16384 || value.bytes().any(|byte| byte.is_ascii_control()) {
        return Err(CatalogError::InvalidResponse);
    }
    let url = Url::parse(value).map_err(|_| CatalogError::InvalidResponse)?;
    let host = url.host_str().unwrap_or_default();
    if !safe_https(&url) || !host.ends_with(".sndcdn.com") {
        return Err(CatalogError::InvalidResponse);
    }
    Ok(url.to_string())
}

pub(crate) fn validate_media_url(value: &str) -> Result<String, CatalogError> {
    if value.len() > 16384 || value.bytes().any(|byte| byte.is_ascii_control()) {
        return Err(CatalogError::InvalidResponse);
    }
    let url = Url::parse(value).map_err(|_| CatalogError::InvalidResponse)?;
    let host = url.host_str().unwrap_or_default();
    if !safe_https(&url)
        || !(host == API_HOST
            || host.ends_with(".sndcdn.com")
            || host == "playback.media-streaming.soundcloud.cloud")
    {
        return Err(CatalogError::InvalidResponse);
    }
    if host == API_HOST {
        let path = url.path().replace("%3A", ":").replace("%3a", ":");
        let mut parts = path
            .strip_prefix("/tracks/")
            .ok_or(CatalogError::InvalidResponse)?
            .split('/');
        normalize_track_id(parts.next().unwrap_or_default())?;
        if !matches!(parts.next(), Some("stream" | "streams")) {
            return Err(CatalogError::InvalidResponse);
        }
        if !parts.all(|part| {
            !part.is_empty()
                && part.len() <= 200
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        }) {
            return Err(CatalogError::InvalidResponse);
        }
    }
    if url.query_pairs().any(|(name, _)| {
        matches!(
            name.to_ascii_lowercase().as_str(),
            "access_token" | "client_secret" | "oauth_token" | "authorization"
        )
    }) {
        return Err(CatalogError::InvalidResponse);
    }
    Ok(url.to_string())
}

fn validate_proxy(value: &str) -> Result<(), CatalogError> {
    if value.len() > 8192 || value.bytes().any(|byte| byte.is_ascii_control()) {
        return Err(CatalogError::InvalidConfig);
    }
    let url = Url::parse(value).map_err(|_| CatalogError::InvalidConfig)?;
    if !matches!(url.scheme(), "http" | "https" | "socks5" | "socks5h")
        || url.host_str().is_none()
        || !url.port_or_known_default().is_some_and(|port| port != 0)
        || !matches!(url.path(), "" | "/")
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(CatalogError::InvalidConfig);
    }
    Ok(())
}

pub(crate) fn validate_range(value: &str) -> Result<(), CatalogError> {
    let bytes = value
        .strip_prefix("bytes=")
        .ok_or(CatalogError::InvalidRequest)?;
    let (start, end) = bytes.split_once('-').ok_or(CatalogError::InvalidRequest)?;
    if start.is_empty()
        || !start.chars().all(|character| character.is_ascii_digit())
        || (!end.is_empty() && !end.chars().all(|character| character.is_ascii_digit()))
        || bytes.len() > 64
    {
        return Err(CatalogError::InvalidRequest);
    }
    let start = start
        .parse::<u64>()
        .map_err(|_| CatalogError::InvalidRequest)?;
    if !end.is_empty() {
        let end = end
            .parse::<u64>()
            .map_err(|_| CatalogError::InvalidRequest)?;
        if end < start || end.saturating_sub(start) >= MAX_MEDIA_RESPONSE as u64 {
            return Err(CatalogError::InvalidRequest);
        }
    }
    Ok(())
}

fn status_error(response: &Response) -> CatalogError {
    match response.status() {
        StatusCode::UNAUTHORIZED => CatalogError::Unauthorized,
        StatusCode::FORBIDDEN => CatalogError::Forbidden,
        StatusCode::NOT_FOUND => CatalogError::NotFound,
        StatusCode::TOO_MANY_REQUESTS => CatalogError::RateLimited {
            retry_after_seconds: response
                .headers()
                .get(header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse().ok()),
        },
        status if status.is_client_error() => CatalogError::InvalidRequest,
        _ => CatalogError::Upstream,
    }
}

async fn bounded_response(mut response: Response, max: usize) -> Result<Vec<u8>, CatalogError> {
    if response
        .content_length()
        .is_some_and(|length| length > max as u64)
    {
        return Err(CatalogError::InvalidResponse);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| CatalogError::Network)? {
        if chunk.len() > max.saturating_sub(bytes.len()) {
            return Err(CatalogError::InvalidResponse);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0
        || a == 10
        || a == 127
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && (b == 168 || (b == 0 && c == 0) || (b == 0 && c == 2)))
        || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
        || (a == 203 && b == 0 && c == 113)
        || a >= 224)
}

pub(crate) fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(value) => public_v4(value),
        IpAddr::V6(value) => {
            if let Some(mapped) = value.to_ipv4_mapped() {
                return public_v4(mapped);
            }
            let segments = value.segments();
            (segments[0] & 0xe000) == 0x2000
                && !(segments[0] == 0x2001 && (segments[1] <= 0x01ff || segments[1] == 0xdb8))
                && segments[0] != 0x2002
                && segments[0] != 0x3fff
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_expiry_is_distinct_from_provider_failures_without_exposing_details() {
        assert_eq!(gateway_error(410), CatalogError::Expired);
        assert_eq!(gateway_error(404), CatalogError::NotFound);
        assert_eq!(gateway_error(403), CatalogError::Forbidden);
        assert_eq!(gateway_error(429), CatalogError::RateLimited { retry_after_seconds: None });
        assert_eq!(gateway_error(503), CatalogError::Unavailable);
        assert_eq!(gateway_error(502), CatalogError::Network);
        assert_eq!(gateway_error(504), CatalogError::Network);
        let message = gateway_error(410).to_string();
        assert!(message.contains("истёк") && message.contains("обновить"));
        assert!(!message.contains("https:") && !message.contains("token"));
    }
    use serde_json::json;

    #[test]
    fn parses_playable_metadata_and_preserves_optional_fields() {
        let value = json!({"kind":"track","urn":"soundcloud:tracks:1234","title":" Song\n","metadata_artist":"Artist","duration":21500,"isrc":"US-ABC-24-12345","access":"playable","explicit":true,"permalink_url":"https://soundcloud.com/artist/song","artwork_url":"https://i1.sndcdn.com/art.jpg"});
        let candidate = parse_candidate(&value).unwrap();
        assert_eq!(candidate.provider, "soundcloud");
        assert_eq!(candidate.duration, 21.5);
        assert_eq!(candidate.artist, "Artist");
        assert_eq!(candidate.isrc.as_deref(), Some("USABC2412345"));
        assert_eq!(candidate.explicit, Some(true));
        assert!(candidate.streamable);
    }

    #[test]
    fn preview_and_blocked_are_not_full_streams() {
        for access in ["preview", "blocked"] {
            let value = json!({"kind":"track","id":7,"title":"x","duration":1000,"access":access});
            let candidate = parse_candidate(&value).unwrap();
            assert!(!candidate.streamable);
            assert_eq!(candidate.access, access);
        }
    }

    #[test]
    fn parses_search_page_and_rejects_untrusted_cursor() {
        let value = json!({"collection":[{"kind":"track","id":1,"title":"a","duration":1000,"access":"playable"}],"next_href":"https://api.soundcloud.com/tracks?offset=1"});
        let page = parse_page(&value).unwrap();
        assert_eq!(page.items.len(), 1);
        assert!(validate_api_cursor(page.next_href.as_deref().unwrap()).is_ok());
        assert!(validate_api_cursor("https://evil.example/tracks?offset=1").is_err());
    }

    #[test]
    fn stream_parser_allowlists_hls_and_ignores_preview() {
        let value = json!({"hls_aac_160_url":"https://cf-hls-media.sndcdn.com/a.m3u8?token=x","preview_mp3_128_url":"https://cf-preview-media.sndcdn.com/p.mp3"});
        let sources = parse_streams(&value).unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].quality, "aac-160");
        assert_eq!(sources[0].format, "hls");
        assert!(sources[0].url.contains("/a.m3u8"));
        assert_eq!(
            parse_streams(
                &json!({"preview_mp3_128_url":"https://cf-preview-media.sndcdn.com/p.mp3"})
            )
            .unwrap_err(),
            CatalogError::Unavailable
        );
        assert_eq!(
            parse_streams(&json!({"hls_aac_160_url":"https://evil.example/a.m3u8"})).unwrap_err(),
            CatalogError::InvalidResponse
        );
        assert_eq!(
            parse_streams(&json!({"hls_mp3_128_url":25})).unwrap_err(),
            CatalogError::InvalidResponse
        );
        assert_eq!(
            parse_streams(&json!({"drm_url":"https://cf-hls-media.sndcdn.com/encrypted"}))
                .unwrap_err(),
            CatalogError::Unavailable
        );
    }

    #[test]
    fn rejects_private_urls_and_unsafe_proxies_without_leaking_values() {
        assert!(validate_media_url("http://127.0.0.1/private").is_err());
        assert!(validate_media_url("https://user:secret@cf-hls-media.sndcdn.com/a.m3u8").is_err());
        assert!(validate_proxy("file:///tmp/proxy").is_err());
        assert!(validate_proxy("socks5h://proxy.example:0").is_err());
        assert!(validate_proxy("http://proxy.example:0").is_err());
        assert!(validate_proxy("http://127.0.0.1:8080").is_ok());
        let error = CatalogError::RateLimited {
            retry_after_seconds: Some(30),
        }
        .to_string();
        assert!(!error.contains("secret") && !error.contains("client"));
    }

    #[test]
    fn validates_range_without_header_injection() {
        assert!(validate_range("bytes=0-1024").is_ok());
        assert!(validate_range("bytes=0-\r\nX-Injected: yes").is_err());
        assert!(validate_range("bytes=-1024").is_err());
        assert!(validate_range("bytes=2048-1024").is_err());
        assert!(validate_range("bytes=0-8388608").is_err());
        assert!(validate_range("bytes=0-8388607").is_ok());
        assert!(validate_range("bytes=0-9999999999999999999999999999").is_err());
        assert!(validate_range("bytes=0-1,5-10").is_err());
        assert!(validate_range("bytes=512-").is_ok());
    }

    #[test]
    fn validates_config_without_printing_credentials() {
        assert!(SoundCloudCatalog::from_config("id".into(), "secret".into(), None).is_ok());
        assert!(SoundCloudCatalog::from_config("".into(), "secret".into(), None).is_err());
        assert!(SoundCloudCatalog::from_config(
            "id".into(),
            "secret".into(),
            Some("socks5://127.0.0.1:1080".into())
        )
        .is_ok());
    }

    #[test]
    fn parses_tokens_with_real_expiry_and_sensitive_headers() {
        let before = Instant::now();
        let token = parse_token(&json!({"access_token":"test-token","refresh_token":"rotating-token","expires_in":3600})).unwrap();
        assert_eq!(token.value, "test-token");
        assert_eq!(token.refresh.as_deref(), Some("rotating-token"));
        assert!(token.expires_at >= before + Duration::from_secs(3570));
        assert!(token.expires_at < before + Duration::from_secs(3600));
        assert!(oauth_header(&token.value).unwrap().is_sensitive());
        for invalid in [
            json!({"access_token":"x\r\ny", "expires_in":3600}),
            json!({"access_token":"valid", "expires_in":0}),
            json!({"access_token":"valid", "expires_in":9999999999u64}),
            json!({"access_token":"valid", "expires_in":3600,"refresh_token":false}),
        ] {
            assert!(parse_token(&invalid).is_err());
        }
        let brief = parse_token(&json!({"access_token":"short","expires_in":1})).unwrap();
        assert!(brief.expires_at <= Instant::now() + Duration::from_secs(1));
    }

    #[test]
    fn client_credentials_uses_only_sensitive_basic_and_refresh_uses_documented_form() {
        let provider =
            SoundCloudCatalog::from_config("request-id".into(), "request-secret".into(), None)
                .unwrap();
        let client = Client::builder().no_proxy().build().unwrap();
        let initial = provider.token_request(&client, None).build().unwrap();
        assert_eq!(initial.method(), "POST");
        assert_eq!(initial.url().as_str(), TOKEN_URL);
        let authorization = &initial.headers()[header::AUTHORIZATION];
        assert!(authorization.is_sensitive());
        assert!(authorization.to_str().unwrap().starts_with("Basic "));
        let initial_form = url::form_urlencoded::parse(initial.body().unwrap().as_bytes().unwrap())
            .collect::<std::collections::BTreeMap<_, _>>();
        assert_eq!(initial_form.len(), 1);
        assert_eq!(
            initial_form.get("grant_type").unwrap(),
            "client_credentials"
        );
        let renewal = provider
            .token_request(&client, Some("single-use-refresh"))
            .build()
            .unwrap();
        assert!(renewal.headers().get(header::AUTHORIZATION).is_none());
        let renewal_form = url::form_urlencoded::parse(renewal.body().unwrap().as_bytes().unwrap())
            .collect::<std::collections::BTreeMap<_, _>>();
        assert_eq!(renewal_form.len(), 4);
        assert_eq!(renewal_form.get("grant_type").unwrap(), "refresh_token");
        assert_eq!(
            renewal_form.get("refresh_token").unwrap(),
            "single-use-refresh"
        );
        assert_eq!(renewal_form.get("client_id").unwrap(), "request-id");
        assert_eq!(renewal_form.get("client_secret").unwrap(), "request-secret");
    }

    #[test]
    fn template_credentials_are_rejected_before_any_network_request() {
        for value in [
            "PASTE_CLIENT_ID_HERE",
            "PASTE_CLIENT_SECRET_HERE",
            "YOUR_CLIENT_ID",
            "<CLIENT_SECRET>",
            "replace-me",
        ] {
            assert!(placeholder_credential(value));
            assert!(SoundCloudCatalog::from_config(
                value.into(),
                "real-looking-secret-value".into(),
                None
            )
            .is_err());
        }
        assert!(!placeholder_credential("9d39a4cb62109e2782b8ce52f5d98311"));
        assert!(!placeholder_credential("real-looking-secret-value"));
    }

    #[test]
    fn urls_cannot_escape_provider_hosts_or_smuggle_authorization() {
        for address in [
            "http://cf-hls-media.sndcdn.com/a",
            "https://cf-hls-media.sndcdn.com:444/a",
            "https://cf-hls-media.sndcdn.com/a#fragment",
            "https://sndcdn.com.evil.example/a",
            "https://127.0.0.1/a",
            "https://[::1]/a",
            "https://cf-hls-media.sndcdn.com/a\n",
            "https://cf-hls-media.sndcdn.com/a?Access_Token=secret",
            "https://api.soundcloud.com/users/12",
            "https://api.soundcloud.com/tracks/12/likes",
        ] {
            assert!(validate_media_url(address).is_err(), "accepted {address}");
        }
        assert!(validate_media_url(
            "https://api.soundcloud.com/tracks/soundcloud%3Atracks%3A12/stream/hls"
        )
        .is_ok());
        assert!(
            validate_api_cursor("https://api.soundcloud.com/tracks?access_token=secret").is_err()
        );
        assert!(
            validate_api_cursor("https://api.soundcloud.com/tracks?limit=50&limit=9999").is_err()
        );
        assert!(validate_api_cursor("https://api.soundcloud.com/tracks?limit=51").is_err());
        assert!(
            validate_api_cursor("https://api.soundcloud.com/tracks?limit=1&cursor=next").is_ok()
        );
    }

    #[test]
    fn ids_and_isrc_do_not_ambiguously_identify_a_recording() {
        assert_eq!(
            normalize_track_id("1234").unwrap(),
            "soundcloud:tracks:1234"
        );
        assert_eq!(
            normalize_track_id("soundcloud:tracks:1234").unwrap(),
            "soundcloud:tracks:1234"
        );
        for id in [
            "0",
            "0123",
            "123/stream",
            "soundcloud:users:123",
            "https://soundcloud.com/a/b",
            "-1",
            "１２３",
        ] {
            assert!(normalize_track_id(id).is_err());
        }
        assert_eq!(
            normalize_isrc("us-abc-24-12345").as_deref(),
            Some("USABC2412345")
        );
        assert!(normalize_isrc("not-an-isrc").is_none());
        assert!(normalize_isrc("USABCXX12345").is_none());
        assert!(normalize_isrc("USABĆ2412345").is_none());
    }

    #[test]
    fn ip_guard_rejects_private_and_special_ranges() {
        for value in [
            "127.0.0.1",
            "10.0.0.1",
            "100.64.1.2",
            "169.254.10.1",
            "192.168.1.1",
            "198.18.0.1",
            "192.0.2.1",
            "224.0.0.1",
            "::1",
            "::ffff:127.0.0.1",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
            "2001::1",
            "2002::1",
            "3fff::1",
        ] {
            assert!(!public_ip(value.parse().unwrap()), "accepted {value}");
        }
        for value in ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"] {
            assert!(public_ip(value.parse().unwrap()));
        }
    }

    fn fake_response(status: u16, location: Option<&str>, bytes: Vec<u8>) -> Response {
        let mut builder = tauri::http::Response::builder().status(status);
        if let Some(location) = location {
            builder = builder.header(header::LOCATION, location);
        }
        Response::from(builder.body(bytes).unwrap())
    }

    #[test]
    fn redirects_cannot_send_oauth_to_cdn_or_escape_the_media_allowlist() {
        let api = Url::parse(
            "https://api.soundcloud.com/resolve?url=https%3A%2F%2Fsoundcloud.com%2Fa%2Fb",
        )
        .unwrap();
        let next = fake_response(302, Some("/tracks/soundcloud:tracks:123"), vec![]);
        assert_eq!(
            redirect_url(&next, &api, true).unwrap().host_str(),
            Some(API_HOST)
        );
        let cdn = fake_response(
            302,
            Some("https://cf-hls-media.sndcdn.com/index.m3u8"),
            vec![],
        );
        assert!(redirect_url(&cdn, &api, true).is_err());
        assert!(redirect_url(&cdn, &api, false).is_ok());
        let evil = fake_response(302, Some("https://evil.example/index.m3u8"), vec![]);
        assert!(redirect_url(&evil, &api, false).is_err());
        let local = fake_response(302, Some("http://127.0.0.1/private"), vec![]);
        assert!(redirect_url(&local, &api, false).is_err());
        let downgrade = fake_response(
            302,
            Some("http://cf-hls-media.sndcdn.com/index.m3u8"),
            vec![],
        );
        assert!(redirect_url(&downgrade, &api, false).is_err());
        assert!(redirect_url(&fake_response(302, None, vec![]), &api, false).is_err());
    }

    #[test]
    fn response_limit_is_enforced_without_a_content_length_header() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            assert_eq!(
                bounded_response(fake_response(200, None, vec![0; 33]), 32)
                    .await
                    .unwrap_err(),
                CatalogError::InvalidResponse
            );
            assert_eq!(
                bounded_response(fake_response(200, None, vec![1; 32]), 32)
                    .await
                    .unwrap(),
                vec![1; 32]
            );
        });
    }
}
