//! Public artist and release-group metadata from MusicBrainz.
//! This is not an audio provider or a verified release announcement service.
use reqwest::{header, redirect::Policy, Client, Response, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fmt, fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tauri::AppHandle;
use tokio::time::{sleep_until, timeout, Instant};
use url::Url;

const API_BASE: &str = "https://musicbrainz.org/ws/2/";
const USER_AGENT: &str = concat!(
    "Pulse/",
    env!("CARGO_PKG_VERSION"),
    " (https://github.com/XxNellonxX/Pulse---Player-for-VK)"
);
const SEARCH_LIMIT: usize = 20;
const RELEASE_LIMIT: usize = 30;
const MAX_OFFSET: u32 = 10_000;
const MAX_BODY: usize = 2 * 1024 * 1024;
const MAX_CACHE_BYTES: usize = 10 * 1024 * 1024;
const MAX_CACHE_ENTRIES: usize = 128;
const FRESH_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const RELEASE_FRESH_MS: i64 = 24 * 60 * 60 * 1000;
const RETAIN_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const REQUEST_INTERVAL: Duration = Duration::from_secs(1);
static RATE_GATE: tokio::sync::Mutex<Option<Instant>> = tokio::sync::Mutex::const_new(None);
static PROVIDER: OnceLock<Mutex<Option<ConfiguredProvider>>> = OnceLock::new();
static SHARED_CACHE: OnceLock<Arc<Mutex<Option<ProfileCache>>>> = OnceLock::new();
static ROUTE_LOCK: Mutex<()> = Mutex::new(());

struct ConfiguredProvider {
    profile: PathBuf,
    proxy: Option<String>,
    provider: Arc<MusicBrainzCatalog>,
}

#[derive(Clone, Serialize, Deserialize)]
struct RouteConfiguration {
    proxy: Option<String>,
}

#[derive(Serialize)]
pub struct RouteStatus {
    available: bool,
    proxy: bool,
    message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum CatalogError {
    InvalidRequest,
    Network,
    NotFound,
    RateLimited,
    Upstream,
    InvalidResponse,
}
impl fmt::Display for CatalogError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidRequest => "Проверьте имя исполнителя или адрес карточки MusicBrainz.",
            Self::Network => "Не удалось подключиться к MusicBrainz. Попробуйте позже.",
            Self::NotFound => "В MusicBrainz нет такой карточки исполнителя.",
            Self::RateLimited => "MusicBrainz ограничил частоту запросов. Повторите позже.",
            Self::Upstream => "MusicBrainz временно недоступен. Попробуйте позже.",
            Self::InvalidResponse => "MusicBrainz вернул неподдерживаемые данные.",
        })
    }
}
impl CatalogError {
    fn permits_stale(&self) -> bool {
        matches!(self, Self::Network | Self::Upstream | Self::RateLimited)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtistSummary {
    pub id: String,
    pub name: String,
    pub sort_name: String,
    pub disambiguation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub country: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtistLink {
    pub label: String,
    pub url: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtistDetails {
    #[serde(flatten)]
    pub summary: ArtistSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub links: Vec<ArtistLink>,
    pub tags: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseGroup {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_release_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_type: Option<String>,
    pub secondary_types: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtistSearch {
    pub artists: Vec<ArtistSummary>,
    pub has_more: bool,
    pub offset: u32,
    pub stale: bool,
    pub fetched_at: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtistPage {
    pub artist: ArtistDetails,
    pub releases: Vec<ReleaseGroup>,
    pub has_more: bool,
    pub offset: u32,
    pub stale: bool,
    pub fetched_at: i64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "page", rename_all = "camelCase")]
enum CachedPage {
    Search(ArtistSearch),
    Artist(ArtistPage),
}
impl CachedPage {
    fn fetched_at(&self) -> i64 {
        match self {
            Self::Search(page) => page.fetched_at,
            Self::Artist(page) => page.fetched_at,
        }
    }
    fn stale(mut self) -> Self {
        match &mut self {
            Self::Search(page) => page.stale = true,
            Self::Artist(page) => page.stale = true,
        };
        self
    }
}
#[derive(Serialize, Deserialize)]
struct CacheEntry {
    key: String,
    value: CachedPage,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    releases_fetched_at: Option<i64>,
}
#[derive(Default, Serialize, Deserialize)]
struct CacheFile {
    version: u32,
    entries: Vec<CacheEntry>,
}
struct ProfileCache {
    path: PathBuf,
    file: CacheFile,
}

struct MusicBrainzCatalog {
    client: Client,
    cache: Arc<Mutex<Option<ProfileCache>>>,
}
impl MusicBrainzCatalog {
    #[cfg(test)]
    fn new() -> Result<Self, CatalogError> {
        Self::with_proxy(None, Arc::new(Mutex::new(None)))
    }

    fn with_proxy(
        proxy: Option<&str>,
        cache: Arc<Mutex<Option<ProfileCache>>>,
    ) -> Result<Self, CatalogError> {
        let mut builder = Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(12))
            .user_agent(USER_AGENT);
        if let Some(proxy) = proxy {
            builder = builder
                .proxy(reqwest::Proxy::all(proxy).map_err(|_| CatalogError::InvalidRequest)?);
        }
        let client = builder.build().map_err(|_| CatalogError::Network)?;
        Ok(Self { client, cache })
    }

    fn cached(&self, path: &Path, key: &str, now: i64) -> Option<CachedPage> {
        let mut slot = self.cache.lock().ok()?;
        if slot.as_ref().map_or(true, |cache| cache.path != path) {
            *slot = Some(ProfileCache {
                path: path.into(),
                file: read_cache(path, now),
            });
        }
        slot.as_ref()?
            .file
            .entries
            .iter()
            .find(|entry| {
                entry.key == key
                    && age(entry.value.fetched_at(), now).is_some_and(|age| age <= RETAIN_MS)
            })
            .map(|entry| entry.value.clone())
    }

    fn remember(&self, path: &Path, key: String, value: CachedPage, now: i64) {
        let Ok(mut slot) = self.cache.lock() else {
            return;
        };
        if slot.as_ref().map_or(true, |cache| cache.path != path) {
            *slot = Some(ProfileCache {
                path: path.into(),
                file: read_cache(path, now),
            });
        }
        if let Some(cache) = slot.as_mut() {
            cache.file.entries.retain(|entry| entry.key != key);
            let releases_fetched_at = matches!(&value, CachedPage::Artist(_)).then_some(now);
            cache.file.entries.push(CacheEntry {
                key,
                value,
                releases_fetched_at,
            });
            trim_cache(&mut cache.file, now);
            let _ = save_cache(path, &cache.file);
        }
    }

    fn cached_artist_details(
        &self,
        path: &Path,
        id: &str,
        now: i64,
    ) -> Option<(ArtistDetails, i64)> {
        let slot = self.cache.lock().ok()?;
        let cache = slot.as_ref().filter(|cache| cache.path == path)?;
        cache
            .file
            .entries
            .iter()
            .filter_map(|entry| match &entry.value {
                CachedPage::Artist(page)
                    if page.artist.summary.id == id && fresh(page.fetched_at, now) =>
                {
                    Some((page.artist.clone(), page.fetched_at))
                }
                _ => None,
            })
            .max_by_key(|(_, fetched_at)| *fetched_at)
    }

    fn releases_fresh(&self, path: &Path, key: &str, now: i64) -> bool {
        let Ok(slot) = self.cache.lock() else {
            return false;
        };
        slot.as_ref()
            .filter(|cache| cache.path == path)
            .and_then(|cache| cache.file.entries.iter().find(|entry| entry.key == key))
            .and_then(|entry| {
                age(
                    entry
                        .releases_fetched_at
                        .unwrap_or_else(|| entry.value.fetched_at()),
                    now,
                )
            })
            .is_some_and(|age| age < RELEASE_FRESH_MS)
    }

    async fn request(&self, url: Url) -> Result<Value, CatalogError> {
        validate_api_url(&url)?;
        timeout(Duration::from_secs(20), async {
            wait_for_slot(&RATE_GATE, REQUEST_INTERVAL).await;
            let response = self
                .client
                .get(url)
                .header(header::ACCEPT, "application/json")
                .send()
                .await
                .map_err(|_| CatalogError::Network)?;
            match response.status() {
                StatusCode::OK => {}
                StatusCode::NOT_FOUND => return Err(CatalogError::NotFound),
                StatusCode::TOO_MANY_REQUESTS | StatusCode::SERVICE_UNAVAILABLE => {
                    let retry = response
                        .headers()
                        .get(header::RETRY_AFTER)
                        .and_then(|value| value.to_str().ok())
                        .and_then(|value| value.parse::<u64>().ok())
                        .unwrap_or(2)
                        .clamp(1, 60);
                    let mut next = RATE_GATE.lock().await;
                    *next = Some(
                        next.unwrap_or_else(Instant::now)
                            .max(Instant::now() + Duration::from_secs(retry)),
                    );
                    return Err(CatalogError::RateLimited);
                }
                status if status.is_server_error() => return Err(CatalogError::Upstream),
                _ => return Err(CatalogError::InvalidResponse),
            }
            let bytes = bounded_response(response).await?;
            serde_json::from_slice(&bytes).map_err(|_| CatalogError::InvalidResponse)
        })
        .await
        .map_err(|_| CatalogError::Network)?
    }

    async fn search(
        &self,
        path: &Path,
        query: &str,
        offset: u32,
    ) -> Result<ArtistSearch, CatalogError> {
        let query = clean_query(query)?;
        let url = search_url(&query, offset)?;
        let key = search_key(&query, offset);
        let cached = self.cached(path, &key, crate::now());
        if let Some(CachedPage::Search(page)) = cached
            .as_ref()
            .filter(|page| fresh(page.fetched_at(), crate::now()))
        {
            return Ok(page.clone());
        }
        let value = match self.request(url).await {
            Ok(value) => value,
            Err(error) => {
                return stale_or_error(cached, error).and_then(|page| match page {
                    CachedPage::Search(page) => Ok(page),
                    _ => Err(CatalogError::InvalidResponse),
                })
            }
        };
        let page = parse_search(&value, offset, crate::now())?;
        self.remember(path, key, CachedPage::Search(page.clone()), crate::now());
        Ok(page)
    }

    async fn artist(&self, path: &Path, id: &str, offset: u32) -> Result<ArtistPage, CatalogError> {
        let id = uuid(id)?;
        validate_offset(offset)?;
        let key = format!("artist:{id}:{offset}");
        let cached = self.cached(path, &key, crate::now());
        if let Some(CachedPage::Artist(page)) = cached.as_ref().filter(|page| {
            fresh(page.fetched_at(), crate::now()) && self.releases_fresh(path, &key, crate::now())
        }) {
            return Ok(page.clone());
        }
        let mut lookup = endpoint(&format!("artist/{id}"))?;
        lookup
            .query_pairs_mut()
            .append_pair("fmt", "json")
            .append_pair("inc", "url-rels+tags");
        let mut releases = endpoint("release-group")?;
        releases
            .query_pairs_mut()
            .append_pair("fmt", "json")
            .append_pair("artist", &id)
            .append_pair("limit", &RELEASE_LIMIT.to_string())
            .append_pair("offset", &offset.to_string());
        let known_artist = self.cached_artist_details(path, &id, crate::now());
        let fetched = async {
            let (artist, artist_fetched_at) = match known_artist {
                Some(artist) => artist,
                None => (parse_details(&self.request(lookup).await?)?, crate::now()),
            };
            let release_groups = self.request(releases).await?;
            parse_artist_page_with_details(
                artist,
                &release_groups,
                &id,
                offset,
                artist_fetched_at.min(crate::now()),
            )
        }
        .await;
        let page = match fetched {
            Ok(page) => page,
            Err(error) => {
                return stale_or_error(cached, error).and_then(|page| match page {
                    CachedPage::Artist(page) => Ok(page),
                    _ => Err(CatalogError::InvalidResponse),
                })
            }
        };
        self.remember(path, key, CachedPage::Artist(page.clone()), crate::now());
        Ok(page)
    }
}

fn proxy_configuration(value: &str) -> Result<RouteConfiguration, String> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(RouteConfiguration { proxy: None });
    }
    let invalid = || {
        "Неверный адрес прокси каталога. Используйте HTTP, HTTPS или SOCKS5h с адресом сервера и портом.".to_string()
    };
    if value.len() > 8192 || value.chars().any(char::is_control) {
        return Err(invalid());
    }
    let url = Url::parse(value).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "http" | "https" | "socks5h")
        || url.host_str().is_none()
        || !url.port_or_known_default().is_some_and(|port| port > 0)
        || !matches!(url.path(), "" | "/")
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    reqwest::Proxy::all(url.as_str()).map_err(|_| invalid())?;
    Ok(RouteConfiguration {
        proxy: Some(url.to_string()),
    })
}

fn route_entry(app: &AppHandle) -> Result<keyring::Entry, String> {
    let key = crate::data_dir(app).to_string_lossy().into_owned();
    keyring::Entry::new("ru.vkplayer.desktop.musicbrainz", &key)
        .map_err(|_| "Хранилище настроек маршрута каталога недоступно.".into())
}

fn read_route(app: &AppHandle) -> Result<RouteConfiguration, String> {
    match route_entry(app)?.get_password() {
        Ok(value) => {
            if value.len() > 16384 {
                return Err("Сохранённый маршрут каталога повреждён. Укажите его заново.".into());
            }
            let stored: RouteConfiguration = serde_json::from_str(&value)
                .map_err(|_| "Сохранённый маршрут каталога повреждён. Укажите его заново.")?;
            proxy_configuration(stored.proxy.as_deref().unwrap_or_default())
        }
        Err(keyring::Error::NoEntry) => Ok(RouteConfiguration { proxy: None }),
        Err(_) => Err("Система не разрешила прочитать сохранённый маршрут каталога.".into()),
    }
}

fn provider(app: &AppHandle) -> Result<Arc<MusicBrainzCatalog>, String> {
    let _configuration = ROUTE_LOCK
        .lock()
        .map_err(|_| "Не удалось прочитать настройки маршрута каталога.")?;
    let profile = crate::data_dir(app);
    let route = read_route(app)?;
    let mut slot = PROVIDER
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "Не удалось подключить каталог.")?;
    if let Some(cached) = slot
        .as_ref()
        .filter(|cached| cached.profile == profile && cached.proxy == route.proxy)
    {
        return Ok(cached.provider.clone());
    }
    let cache = SHARED_CACHE
        .get_or_init(|| Arc::new(Mutex::new(None)))
        .clone();
    let provider = Arc::new(
        MusicBrainzCatalog::with_proxy(route.proxy.as_deref(), cache)
            .map_err(|error| error.to_string())?,
    );
    *slot = Some(ConfiguredProvider {
        profile,
        proxy: route.proxy,
        provider: provider.clone(),
    });
    Ok(provider)
}

#[tauri::command]
pub async fn status_catalog_route(app: AppHandle) -> RouteStatus {
    match read_route(&app) {
        Ok(route) => RouteStatus {
            available: true,
            proxy: route.proxy.is_some(),
            message: if route.proxy.is_some() {
                "Для каталога сохранён отдельный прокси. Соединение проверяется при поиске; VK и SoundCloud используют свои маршруты.".into()
            } else {
                "Каталог подключается напрямую. Отдельный прокси можно указать ниже; доступ проверяется при поиске.".into()
            },
        },
        Err(message) => RouteStatus {
            available: false,
            proxy: false,
            message,
        },
    }
}

#[tauri::command]
pub async fn configure_catalog_route(app: AppHandle, proxy: String) -> Result<(), String> {
    let route = proxy_configuration(&proxy)?;
    // Build before persisting so unsupported routes never replace a working one.
    let cache = SHARED_CACHE
        .get_or_init(|| Arc::new(Mutex::new(None)))
        .clone();
    let provider = Arc::new(
        MusicBrainzCatalog::with_proxy(route.proxy.as_deref(), cache)
            .map_err(|error| error.to_string())?,
    );
    let _configuration = ROUTE_LOCK
        .lock()
        .map_err(|_| "Не удалось сохранить маршрут каталога.")?;
    route_entry(&app)?
        .set_password(
            &serde_json::to_string(&route).map_err(|_| "Не удалось сохранить маршрут каталога.")?,
        )
        .map_err(|_| "Система не разрешила сохранить маршрут каталога. Настройки не изменены.")?;
    let mut slot = PROVIDER
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "Не удалось применить маршрут каталога. Перезапустите Pulse.")?;
    *slot = Some(ConfiguredProvider {
        profile: crate::data_dir(&app),
        proxy: route.proxy,
        provider,
    });
    Ok(())
}

async fn wait_for_slot(gate: &tokio::sync::Mutex<Option<Instant>>, interval: Duration) {
    let mut next = gate.lock().await;
    let start = next.unwrap_or_else(Instant::now).max(Instant::now());
    sleep_until(start).await;
    *next = Some(Instant::now() + interval);
}

#[tauri::command]
pub async fn search_catalog_artists(
    app: AppHandle,
    query: String,
    offset: Option<u32>,
) -> Result<ArtistSearch, String> {
    provider(&app)?
        .search(
            &crate::data_dir(&app).join("musicbrainz-catalog.json"),
            &query,
            offset.unwrap_or(0),
        )
        .await
        .map_err(|error| error.to_string())
}
#[tauri::command]
pub async fn get_catalog_artist(
    app: AppHandle,
    id: String,
    offset: Option<u32>,
) -> Result<ArtistPage, String> {
    provider(&app)?
        .artist(
            &crate::data_dir(&app).join("musicbrainz-catalog.json"),
            &id,
            offset.unwrap_or(0),
        )
        .await
        .map_err(|error| error.to_string())
}

fn clean_text(value: &str, limit: usize) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .take(limit)
        .collect::<String>()
        .trim()
        .into()
}
fn clean_query(value: &str) -> Result<String, CatalogError> {
    if value.chars().count() > 200 || value.len() > 800 || value.chars().any(char::is_control) {
        return Err(CatalogError::InvalidRequest);
    }
    let query = value.trim();
    if query.is_empty() {
        Err(CatalogError::InvalidRequest)
    } else {
        Ok(query.into())
    }
}
fn validate_offset(offset: u32) -> Result<(), CatalogError> {
    if offset <= MAX_OFFSET {
        Ok(())
    } else {
        Err(CatalogError::InvalidRequest)
    }
}
fn uuid(value: &str) -> Result<String, CatalogError> {
    if value.len() != 36
        || !value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
    {
        return Err(CatalogError::InvalidRequest);
    }
    let value = value.to_ascii_lowercase();
    if value == "00000000-0000-0000-0000-000000000000" {
        return Err(CatalogError::InvalidRequest);
    }
    Ok(value)
}
fn endpoint(path: &str) -> Result<Url, CatalogError> {
    Url::parse(API_BASE)
        .and_then(|url| url.join(path))
        .map_err(|_| CatalogError::InvalidRequest)
}
fn validate_api_url(url: &Url) -> Result<(), CatalogError> {
    if url.scheme() != "https"
        || url.host_str() != Some("musicbrainz.org")
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || !url.path().starts_with("/ws/2/")
        || url.as_str().len() > 4096
    {
        return Err(CatalogError::InvalidRequest);
    }
    if url.query_pairs().any(|(name, _)| {
        !matches!(
            name.as_ref(),
            "query" | "fmt" | "limit" | "offset" | "inc" | "artist"
        )
    }) {
        return Err(CatalogError::InvalidRequest);
    }
    Ok(())
}
fn search_url(query: &str, offset: u32) -> Result<Url, CatalogError> {
    validate_offset(offset)?;
    let query = clean_query(query)?;
    let quoted = query.replace('\\', "\\\\").replace('"', "\\\"");
    let mut url = endpoint("artist")?;
    url.query_pairs_mut()
        .append_pair("query", &format!("artist:\"{quoted}\""))
        .append_pair("fmt", "json")
        .append_pair("limit", &SEARCH_LIMIT.to_string())
        .append_pair("offset", &offset.to_string());
    Ok(url)
}
fn search_key(query: &str, offset: u32) -> String {
    format!(
        "search:{}:{offset}",
        hex::encode(Sha256::digest(query.as_bytes()))
    )
}
fn required_text(value: &Value, key: &str, limit: usize) -> Result<String, CatalogError> {
    let result = clean_text(
        value
            .get(key)
            .and_then(Value::as_str)
            .ok_or(CatalogError::InvalidResponse)?,
        limit,
    );
    if result.is_empty() {
        Err(CatalogError::InvalidResponse)
    } else {
        Ok(result)
    }
}
fn parse_summary(value: &Value) -> Result<ArtistSummary, CatalogError> {
    let id = uuid(
        value
            .get("id")
            .and_then(Value::as_str)
            .ok_or(CatalogError::InvalidResponse)?,
    )
    .map_err(|_| CatalogError::InvalidResponse)?;
    let name = required_text(value, "name", 300)?;
    Ok(ArtistSummary {
        id,
        sort_name: value
            .get("sort-name")
            .and_then(Value::as_str)
            .map(|text| clean_text(text, 300))
            .filter(|text| !text.is_empty())
            .unwrap_or_else(|| name.clone()),
        name,
        disambiguation: value
            .get("disambiguation")
            .and_then(Value::as_str)
            .map(|text| clean_text(text, 300))
            .unwrap_or_default(),
        kind: value
            .get("type")
            .and_then(Value::as_str)
            .map(|text| clean_text(text, 80))
            .filter(|text| !text.is_empty()),
        country: value
            .get("country")
            .and_then(Value::as_str)
            .filter(|text| text.len() == 2 && text.bytes().all(|byte| byte.is_ascii_uppercase()))
            .map(str::to_owned),
    })
}
fn parse_search(value: &Value, offset: u32, fetched_at: i64) -> Result<ArtistSearch, CatalogError> {
    let artists = value
        .get("artists")
        .and_then(Value::as_array)
        .filter(|artists| artists.len() <= SEARCH_LIMIT)
        .ok_or(CatalogError::InvalidResponse)?
        .iter()
        .map(parse_summary)
        .collect::<Result<Vec<_>, _>>()?;
    let count = value
        .get("count")
        .and_then(Value::as_u64)
        .ok_or(CatalogError::InvalidResponse)?;
    Ok(ArtistSearch {
        has_more: !artists.is_empty()
            && offset as u64 + (artists.len() as u64) < count
            && offset < MAX_OFFSET,
        artists,
        offset,
        stale: false,
        fetched_at,
    })
}
fn public_link(value: &str) -> Option<String> {
    if value.len() > 4096 || value.chars().any(char::is_control) {
        return None;
    }
    let mut url = Url::parse(value).ok()?;
    let host = url.host_str()?;
    if url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || !host.contains('.')
        || host.parse::<std::net::IpAddr>().is_ok()
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host.ends_with('.')
        || url.query_pairs().any(|(key, _)| {
            matches!(
                key.to_ascii_lowercase().as_str(),
                "access_token"
                    | "token"
                    | "client_secret"
                    | "password"
                    | "oauth_token"
                    | "secret"
                    | "api_key"
                    | "signature"
                    | "sig"
            )
        })
    {
        return None;
    }
    url.set_fragment(None);
    Some(url.to_string())
}
fn parse_details(value: &Value) -> Result<ArtistDetails, CatalogError> {
    let summary = parse_summary(value)?;
    let mut links = vec![ArtistLink {
        label: "MusicBrainz".into(),
        url: format!("https://musicbrainz.org/artist/{}", summary.id),
    }];
    for relation in value
        .get("relations")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(100)
    {
        let Some(url) = relation
            .pointer("/url/resource")
            .and_then(Value::as_str)
            .and_then(public_link)
        else {
            continue;
        };
        if links.len() >= 20 || links.iter().any(|link| link.url == url) {
            continue;
        }
        let label = match relation
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("Ссылка")
        {
            "official homepage" => "Официальный сайт".into(),
            "wikipedia" => "Википедия".into(),
            "wikidata" => "Wikidata".into(),
            "discogs" => "Discogs".into(),
            label => clean_text(label, 80),
        };
        links.push(ArtistLink { label, url });
    }
    let mut tags = Vec::new();
    for tag in value
        .get("tags")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(100)
    {
        if let Some(name) = tag
            .get("name")
            .and_then(Value::as_str)
            .map(|name| clean_text(name, 80))
            .filter(|name| !name.is_empty())
        {
            if tags.len() < 30 && !tags.contains(&name) {
                tags.push(name);
            }
        }
    }
    Ok(ArtistDetails {
        summary,
        description: None,
        links,
        tags,
    })
}
fn release_date(value: &str) -> Option<String> {
    let parts = value.split('-').collect::<Vec<_>>();
    if !(1..=3).contains(&parts.len())
        || parts[0].len() != 4
        || !parts[0].bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let year = parts[0].parse::<u32>().ok().filter(|year| *year > 0)?;
    if parts.len() > 1
        && (parts[1].len() != 2
            || !parts[1]
                .parse::<u8>()
                .is_ok_and(|month| (1..=12).contains(&month)))
    {
        return None;
    }
    if parts.len() == 3 {
        let month = parts[1].parse::<u8>().ok()?;
        let day = parts[2].parse::<u8>().ok()?;
        let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
        let maximum = match month {
            2 if leap => 29,
            2 => 28,
            4 | 6 | 9 | 11 => 30,
            _ => 31,
        };
        if day > maximum {
            return None;
        }
    }
    if parts.len() > 2
        && (parts[2].len() != 2
            || !parts[2]
                .parse::<u8>()
                .is_ok_and(|day| (1..=31).contains(&day)))
    {
        return None;
    }
    Some(value.into())
}
fn parse_release(value: &Value) -> Result<ReleaseGroup, CatalogError> {
    let id = uuid(
        value
            .get("id")
            .and_then(Value::as_str)
            .ok_or(CatalogError::InvalidResponse)?,
    )
    .map_err(|_| CatalogError::InvalidResponse)?;
    Ok(ReleaseGroup {
        id,
        title: required_text(value, "title", 400)?,
        first_release_date: value
            .get("first-release-date")
            .and_then(Value::as_str)
            .and_then(release_date),
        primary_type: value
            .get("primary-type")
            .and_then(Value::as_str)
            .map(|value| clean_text(value, 80))
            .filter(|value| !value.is_empty()),
        secondary_types: value
            .get("secondary-types")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .take(10)
            .map(|value| clean_text(value, 80))
            .filter(|value| !value.is_empty())
            .collect(),
    })
}
#[cfg(test)]
fn parse_artist_page(
    artist: &Value,
    releases: &Value,
    id: &str,
    offset: u32,
    fetched_at: i64,
) -> Result<ArtistPage, CatalogError> {
    let artist = parse_details(artist)?;
    parse_artist_page_with_details(artist, releases, id, offset, fetched_at)
}

fn parse_artist_page_with_details(
    artist: ArtistDetails,
    releases: &Value,
    id: &str,
    offset: u32,
    fetched_at: i64,
) -> Result<ArtistPage, CatalogError> {
    if artist.summary.id != id {
        return Err(CatalogError::InvalidResponse);
    }
    let groups = releases
        .get("release-groups")
        .and_then(Value::as_array)
        .filter(|groups| groups.len() <= RELEASE_LIMIT)
        .ok_or(CatalogError::InvalidResponse)?
        .iter()
        .map(parse_release)
        .collect::<Result<Vec<_>, _>>()?;
    let count = releases
        .get("release-group-count")
        .and_then(Value::as_u64)
        .ok_or(CatalogError::InvalidResponse)?;
    Ok(ArtistPage {
        has_more: !groups.is_empty()
            && (offset as u64) + (groups.len() as u64) < count
            && offset < MAX_OFFSET,
        artist,
        releases: groups,
        offset,
        stale: false,
        fetched_at,
    })
}
async fn bounded_response(mut response: Response) -> Result<Vec<u8>, CatalogError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_BODY as u64)
    {
        return Err(CatalogError::InvalidResponse);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| CatalogError::Network)? {
        if chunk.len() > MAX_BODY.saturating_sub(body.len()) {
            return Err(CatalogError::InvalidResponse);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}
fn age(fetched_at: i64, now: i64) -> Option<i64> {
    (fetched_at > 0 && now >= fetched_at).then(|| now.saturating_sub(fetched_at))
}
fn fresh(fetched_at: i64, now: i64) -> bool {
    age(fetched_at, now).is_some_and(|age| age < FRESH_MS)
}
fn stale_or_error(
    cached: Option<CachedPage>,
    error: CatalogError,
) -> Result<CachedPage, CatalogError> {
    if error.permits_stale() {
        cached.map(CachedPage::stale).ok_or(error)
    } else {
        Err(error)
    }
}

fn valid_cached(page: &CachedPage, now: i64) -> bool {
    let safe_text = |value: &str, max: usize| {
        value.chars().count() <= max && !value.chars().any(char::is_control)
    };
    let valid_summary = |artist: &ArtistSummary| {
        uuid(&artist.id).is_ok()
            && !artist.name.is_empty()
            && artist.name.chars().count() <= 300
            && safe_text(&artist.name, 300)
            && safe_text(&artist.sort_name, 300)
            && safe_text(&artist.disambiguation, 300)
            && artist
                .kind
                .as_ref()
                .map_or(true, |kind| safe_text(kind, 80))
            && artist.country.as_ref().map_or(true, |country| {
                country.len() == 2 && country.bytes().all(|byte| byte.is_ascii_uppercase())
            })
    };
    if !age(page.fetched_at(), now).is_some_and(|age| age <= RETAIN_MS) {
        return false;
    }
    match page {
        CachedPage::Search(page) => {
            page.offset <= MAX_OFFSET
                && page.artists.len() <= SEARCH_LIMIT
                && page.artists.iter().all(valid_summary)
        }
        CachedPage::Artist(page) => {
            page.offset <= MAX_OFFSET
                && valid_summary(&page.artist.summary)
                && page.artist.description.is_none()
                && page.artist.links.len() <= 20
                && page.artist.links.iter().all(|link| {
                    safe_text(&link.label, 80)
                        && public_link(&link.url).as_deref() == Some(link.url.as_str())
                })
                && page.artist.tags.len() <= 30
                && page.artist.tags.iter().all(|tag| safe_text(tag, 80))
                && page.releases.len() <= RELEASE_LIMIT
                && page.releases.iter().all(|release| {
                    uuid(&release.id).is_ok()
                        && !release.title.is_empty()
                        && safe_text(&release.title, 400)
                        && release.secondary_types.len() <= 10
                        && release
                            .secondary_types
                            .iter()
                            .all(|kind| safe_text(kind, 80))
                        && release
                            .primary_type
                            .as_ref()
                            .map_or(true, |kind| safe_text(kind, 80))
                        && release
                            .first_release_date
                            .as_ref()
                            .map_or(true, |date| release_date(date).is_some())
                })
        }
    }
}
fn valid_cache_entry(entry: &CacheEntry, now: i64) -> bool {
    if entry.key.len() > 128
        || !valid_cached(&entry.value, now)
        || entry
            .releases_fetched_at
            .is_some_and(|time| age(time, now).is_none() || time < entry.value.fetched_at())
    {
        return false;
    }
    match &entry.value {
        CachedPage::Search(page) => {
            let Some((hash, offset)) = entry
                .key
                .strip_prefix("search:")
                .and_then(|value| value.split_once(':'))
            else {
                return false;
            };
            hash.len() == 64
                && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
                && offset == page.offset.to_string()
        }
        CachedPage::Artist(page) => {
            entry.key == format!("artist:{}:{}", page.artist.summary.id, page.offset)
        }
    }
}

fn trim_cache(cache: &mut CacheFile, now: i64) {
    cache.version = 1;
    cache.entries.retain(|entry| valid_cache_entry(entry, now));
    cache.entries.sort_by_key(|entry| {
        entry
            .releases_fetched_at
            .unwrap_or_else(|| entry.value.fetched_at())
    });
    let mut keys = HashSet::new();
    cache.entries.reverse();
    cache.entries.retain(|entry| keys.insert(entry.key.clone()));
    cache.entries.reverse();
    while cache.entries.len() > MAX_CACHE_ENTRIES {
        cache.entries.remove(0);
    }
    while serde_json::to_vec(cache).is_ok_and(|bytes| bytes.len() > MAX_CACHE_BYTES)
        && !cache.entries.is_empty()
    {
        cache.entries.remove(0);
    }
}
fn read_cache(path: &Path, now: i64) -> CacheFile {
    let read = || -> Option<CacheFile> {
        let mut bytes = Vec::new();
        fs::File::open(path)
            .ok()?
            .take(MAX_CACHE_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.len() > MAX_CACHE_BYTES {
            return None;
        }
        let file: CacheFile = serde_json::from_slice(&bytes).ok()?;
        (file.version == 1).then_some(file)
    };
    let mut file = read().unwrap_or_else(|| CacheFile {
        version: 1,
        entries: vec![],
    });
    trim_cache(&mut file, now);
    file
}
fn save_cache(path: &Path, cache: &CacheFile) -> Result<(), ()> {
    let bytes = serde_json::to_vec(cache).map_err(|_| ())?;
    if bytes.len() > MAX_CACHE_BYTES {
        return Err(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|_| ())?;
    }
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, bytes).map_err(|_| ())?;
    fs::rename(&temporary, path).map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        io::Write,
        net::{TcpListener, TcpStream},
        thread,
    };
    const ID: &str = "f82bcf78-5b69-4622-a5ef-73800768d9ac";
    const RELEASE: &str = "d0347daf-b934-4dec-af56-13591492f71d";
    const NOW: i64 = 1_800_000_000_000;

    fn summary() -> Value {
        json!({"id":ID,"name":"Кишлак","sort-name":"Кишлак","type":"Person","country":"RU","disambiguation":"российский исполнитель"})
    }
    fn search_page(fetched_at: i64) -> CachedPage {
        CachedPage::Search(
            parse_search(&json!({"artists":[summary()],"count":1}), 0, fetched_at).unwrap(),
        )
    }

    #[test]
    fn unicode_search_stays_one_quoted_structured_query() {
        let url = search_url("Кишлак & Kendrick \"Lamar\"", 20).unwrap();
        assert_eq!(url.host_str(), Some("musicbrainz.org"));
        assert_eq!(url.path(), "/ws/2/artist");
        let pairs = url.query_pairs().collect::<Vec<_>>();
        assert_eq!(pairs.len(), 4);
        assert_eq!(
            pairs.iter().find(|(key, _)| key == "query").unwrap().1,
            "artist:\"Кишлак & Kendrick \\\"Lamar\\\"\""
        );
        assert_eq!(
            pairs.iter().find(|(key, _)| key == "limit").unwrap().1,
            "20"
        );
        assert_eq!(
            pairs.iter().find(|(key, _)| key == "offset").unwrap().1,
            "20"
        );
        assert!(validate_api_url(&url).is_ok());
        assert!(search_url(" ", 0).is_err());
        assert!(search_url("x\r\nInjected: true", 0).is_err());
        assert!(search_url(&"я".repeat(201), 0).is_err());
        assert!(search_url("artist", MAX_OFFSET + 1).is_err());
        assert!(USER_AGENT.starts_with(concat!("Pulse/", env!("CARGO_PKG_VERSION"))));
        assert!(USER_AGENT.contains("https://github.com/XxNellonxX/Pulse---Player-for-VK"));
    }

    #[test]
    fn private_catalog_route_configuration_is_independent_and_roundtrips_direct() {
        for route in [
            "http://u:private-test-password@localhost:8765",
            "https://proxy.example:443",
            "socks5h://127.0.0.1:1080",
        ] {
            let config = proxy_configuration(route).unwrap();
            assert!(config.proxy.is_some());
            let restored: RouteConfiguration =
                serde_json::from_str(&serde_json::to_string(&config).unwrap()).unwrap();
            assert_eq!(restored.proxy, config.proxy);
            assert!(MusicBrainzCatalog::with_proxy(
                restored.proxy.as_deref(),
                Arc::new(Mutex::new(None))
            )
            .is_ok());
        }
        for route in [
            "file:///private",
            "socks5://localhost:1080",
            "http://localhost:0",
            "https://proxy.example/path",
            "https://proxy.example/?token=private-test-password",
            "https://proxy.example/#fragment",
            "http://localhost:8080\r\nInjected: yes",
        ] {
            let error = proxy_configuration(route).err().unwrap();
            assert!(!error.contains(route) && !error.contains("private-test-password"));
        }
        let direct = proxy_configuration(" ").unwrap();
        let restored: RouteConfiguration =
            serde_json::from_str(&serde_json::to_string(&direct).unwrap()).unwrap();
        assert!(restored.proxy.is_none());
        let cache = Arc::new(Mutex::new(None));
        let direct_client = MusicBrainzCatalog::with_proxy(None, cache.clone()).unwrap();
        let routed_client =
            MusicBrainzCatalog::with_proxy(Some("http://localhost:8765"), cache.clone()).unwrap();
        assert!(Arc::ptr_eq(&direct_client.cache, &routed_client.cache));
        let serialized_status = serde_json::to_value(RouteStatus {
            available: true,
            proxy: true,
            message: "Маршрут сохранён".into(),
        })
        .unwrap();
        assert_eq!(serialized_status.as_object().unwrap().len(), 3);
        assert!(
            serialized_status.get("clientSecret").is_none()
                && serialized_status.get("url").is_none()
        );
    }

    fn accept_fixture(listener: TcpListener) -> TcpStream {
        listener.set_nonblocking(true).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            match listener.accept() {
                Ok((stream, _)) => {
                    stream.set_nonblocking(false).unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    return stream;
                }
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        && std::time::Instant::now() < deadline =>
                {
                    thread::sleep(Duration::from_millis(5))
                }
                Err(_) => panic!("Local proxy fixture did not receive a connection"),
            }
        }
    }

    #[test]
    fn configured_http_proxy_receives_only_official_connect_and_sensitive_proxy_auth() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let capture = thread::spawn(move || {
            let mut stream = accept_fixture(listener);
            let mut bytes = Vec::new();
            while !bytes.ends_with(b"\r\n\r\n") && bytes.len() < 16384 {
                let mut byte = [0];
                stream.read_exact(&mut byte).unwrap();
                bytes.push(byte[0]);
            }
            stream
                .write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
                .unwrap();
            String::from_utf8(bytes).unwrap()
        });
        let config =
            proxy_configuration(&format!("http://u:private-test-password@{address}")).unwrap();
        let provider =
            MusicBrainzCatalog::with_proxy(config.proxy.as_deref(), Arc::new(Mutex::new(None)))
                .unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let failure = runtime
            .block_on(provider.request(search_url("Kendrick Lamar", 0).unwrap()))
            .unwrap_err();
        let request = capture.join().unwrap();
        assert!(request.starts_with("CONNECT musicbrainz.org:443 HTTP/1.1\r\n"));
        assert!(request
            .to_ascii_lowercase()
            .contains("proxy-authorization: basic "));
        assert!(!request.contains("access_token") && !request.contains("client_secret"));
        assert!(
            !failure.to_string().contains("private-test-password")
                && !failure.to_string().contains(&address.to_string())
        );
    }

    #[test]
    fn socks5h_sends_provider_hostname_to_proxy_without_local_target_resolution() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let capture = thread::spawn(move || {
            let mut stream = accept_fixture(listener);
            let mut greeting = [0; 2];
            stream.read_exact(&mut greeting).unwrap();
            assert_eq!(greeting[0], 5);
            let mut methods = vec![0; greeting[1] as usize];
            stream.read_exact(&mut methods).unwrap();
            assert!(methods.contains(&0));
            stream.write_all(&[5, 0]).unwrap();
            let mut request = [0; 4];
            stream.read_exact(&mut request).unwrap();
            assert_eq!(request, [5, 1, 0, 3]);
            let mut length = [0];
            stream.read_exact(&mut length).unwrap();
            let mut domain = vec![0; length[0] as usize];
            stream.read_exact(&mut domain).unwrap();
            let mut port = [0; 2];
            stream.read_exact(&mut port).unwrap();
            stream.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]).unwrap();
            (String::from_utf8(domain).unwrap(), u16::from_be_bytes(port))
        });
        let config = proxy_configuration(&format!("socks5h://{address}")).unwrap();
        let provider =
            MusicBrainzCatalog::with_proxy(config.proxy.as_deref(), Arc::new(Mutex::new(None)))
                .unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        assert!(runtime
            .block_on(provider.request(search_url("Кишлак", 0).unwrap()))
            .is_err());
        assert_eq!(capture.join().unwrap(), ("musicbrainz.org".into(), 443));
    }

    #[test]
    fn strict_uuid_and_endpoint_never_accept_credentials_or_host_changes() {
        assert_eq!(uuid(&ID.to_ascii_uppercase()).unwrap(), ID);
        for id in [
            "",
            "../artist",
            "00000000-0000-0000-0000-000000000000",
            "f82bcf78-5b69-4622-a5ef-73800768d9ag",
            "https://musicbrainz.org/artist/123",
        ] {
            assert!(uuid(id).is_err());
        }
        for url in [
            "http://musicbrainz.org/ws/2/artist",
            "https://evil.example/ws/2/artist",
            "https://musicbrainz.org:444/ws/2/artist",
            "https://u:p@musicbrainz.org/ws/2/artist",
            "https://musicbrainz.org/ws/2/artist?access_token=private-test-token",
            "https://musicbrainz.org/ws/2/artist#token",
        ] {
            assert!(validate_api_url(&Url::parse(url).unwrap()).is_err());
        }
    }

    #[test]
    fn parses_realistic_artist_and_release_groups_without_inventing_biography() {
        let mut artist = summary();
        artist["relations"] = json!([
            {"type":"official homepage","url":{"resource":"https://example.org/artist"}},
            {"type":"streaming","url":{"resource":"https://service.example/artist?access_token=private-test-token"}},
            {"type":"streaming","url":{"resource":"http://127.0.0.1/audio"}},
            {"type":"wikipedia","url":{"resource":"https://ru.wikipedia.org/wiki/Кишлак"}}
        ]);
        artist["tags"] = json!([{"name":"hip hop"},{"name":"hip hop"},{"name":"rap"}]);
        let releases = json!({"release-group-count":31,"release-groups":[{"id":RELEASE,"title":"Тестовый EP","first-release-date":"2024-05","primary-type":"EP","secondary-types":["Live"]}]});
        let page = parse_artist_page(&artist, &releases, ID, 0, NOW).unwrap();
        assert_eq!(page.artist.summary.name, "Кишлак");
        assert_eq!(page.artist.links.len(), 3);
        assert_eq!(page.artist.tags, ["hip hop", "rap"]);
        assert!(page.artist.description.is_none());
        assert_eq!(
            page.releases[0].first_release_date.as_deref(),
            Some("2024-05")
        );
        assert_eq!(page.releases[0].primary_type.as_deref(), Some("EP"));
        assert!(page.has_more);
        let encoded = serde_json::to_string(&page).unwrap();
        assert!(
            encoded.contains("sortName")
                && encoded.contains("firstReleaseDate")
                && encoded.contains("secondaryTypes")
        );
        assert!(!encoded.contains("private-test-token") && !encoded.contains("description"));
        assert!(parse_artist_page(&artist, &releases, RELEASE, 0, NOW).is_err());
        assert!(parse_search(&json!({"artists":[{"id":ID}],"count":1}), 0, NOW).is_err());
        assert!(parse_search(
            &json!({"artists":vec![summary(); SEARCH_LIMIT + 1],"count":100}),
            0,
            NOW
        )
        .is_err());
    }

    #[test]
    fn link_and_partial_date_validation_preserve_only_public_metadata() {
        for url in [
            "https://u:p@example.org/",
            "https://localhost/",
            "https://example.local/",
            "https://localhost./",
            "https://127.0.0.1/a",
            "javascript:alert(1)",
            "https://example.org/?token=secret",
            "https://example.org:444/",
        ] {
            assert!(public_link(url).is_none());
        }
        assert_eq!(
            public_link("https://example.org/artist#access_token=private-test-token").as_deref(),
            Some("https://example.org/artist")
        );
        for date in ["2024", "2024-02", "2024-02-15", "2024-02-29", "2000-02-29"] {
            assert_eq!(release_date(date).as_deref(), Some(date));
        }
        for date in [
            "2024-13",
            "2024-01-00",
            "2024-01-32",
            "2024-1",
            "date",
            "2026-02-31",
            "2026-02-29",
            "1900-02-29",
            "2024-04-31",
            "0000",
        ] {
            assert!(release_date(date).is_none());
        }
    }

    #[test]
    fn cache_ttl_is_seven_days_and_stale_requires_network_failure() {
        assert!(fresh(NOW, NOW + FRESH_MS - 1));
        assert!(!fresh(NOW, NOW + FRESH_MS));
        assert!(!fresh(NOW + 1, NOW));
        let cached = search_page(NOW);
        let stale = stale_or_error(Some(cached.clone()), CatalogError::Network).unwrap();
        assert!(matches!(
            stale,
            CachedPage::Search(ArtistSearch {
                stale: true,
                fetched_at: NOW,
                ..
            })
        ));
        for error in [
            CatalogError::InvalidRequest,
            CatalogError::NotFound,
            CatalogError::InvalidResponse,
        ] {
            assert!(stale_or_error(Some(cached.clone()), error).is_err());
        }
        assert!(stale_or_error(None, CatalogError::Network).is_err());
        assert!(!valid_cached(&cached, NOW + RETAIN_MS + 1));
    }

    #[test]
    fn cache_roundtrip_bounds_entries_and_drops_wrong_identity_or_future_data() {
        let path = std::env::temp_dir().join(format!(
            "pulse-mb-cache-test-{}.json",
            hex::encode(rand::random::<[u8; 8]>())
        ));
        let mut cache = CacheFile {
            version: 1,
            entries: (0..140)
                .map(|index| CacheEntry {
                    key: search_key(&format!("artist-{index}"), 0),
                    value: search_page(NOW - 140 + index),
                    releases_fetched_at: None,
                })
                .collect(),
        };
        cache.entries.push(CacheEntry {
            key: "artist:wrong:0".into(),
            value: search_page(NOW),
            releases_fetched_at: None,
        });
        cache.entries.push(CacheEntry {
            key: search_key("future", 0),
            value: search_page(NOW + 1),
            releases_fetched_at: None,
        });
        trim_cache(&mut cache, NOW);
        assert_eq!(cache.entries.len(), MAX_CACHE_ENTRIES);
        assert!(serde_json::to_vec(&cache).unwrap().len() <= MAX_CACHE_BYTES);
        save_cache(&path, &cache).unwrap();
        let loaded = read_cache(&path, NOW);
        assert_eq!(loaded.entries.len(), MAX_CACHE_ENTRIES);
        assert!(loaded
            .entries
            .iter()
            .all(|entry| valid_cache_entry(entry, NOW)));
        fs::write(&path, b"broken json").unwrap();
        assert!(read_cache(&path, NOW).entries.is_empty());
        assert_eq!(fs::read(&path).unwrap(), b"broken json");
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn release_pages_refresh_daily_without_extending_artist_metadata_age() {
        let path = PathBuf::from("unused-musicbrainz-test-profile.json");
        let artist_time = NOW - 6 * RELEASE_FRESH_MS;
        let page = parse_artist_page(
            &summary(),
            &json!({"release-group-count":0,"release-groups":[]}),
            ID,
            0,
            artist_time,
        )
        .unwrap();
        let key = format!("artist:{ID}:0");
        let provider = MusicBrainzCatalog::new().unwrap();
        *provider.cache.lock().unwrap() = Some(ProfileCache {
            path: path.clone(),
            file: CacheFile {
                version: 1,
                entries: vec![CacheEntry {
                    key: key.clone(),
                    value: CachedPage::Artist(page),
                    releases_fetched_at: Some(NOW),
                }],
            },
        });
        assert!(provider.releases_fresh(&path, &key, NOW + RELEASE_FRESH_MS - 1));
        assert!(!provider.releases_fresh(&path, &key, NOW + RELEASE_FRESH_MS));
        assert_eq!(
            provider.cached_artist_details(&path, ID, NOW).unwrap().1,
            artist_time
        );
        assert!(provider
            .cached_artist_details(&path, ID, artist_time + FRESH_MS)
            .is_none());
    }

    #[test]
    fn corrupt_cached_optional_text_and_dates_are_never_returned() {
        let mut page = parse_artist_page(&summary(), &json!({"release-group-count":1,"release-groups":[{"id":RELEASE,"title":"Album","first-release-date":"2024-02-29","primary-type":"Album","secondary-types":[]}]}), ID, 0, NOW).unwrap();
        assert!(valid_cached(&CachedPage::Artist(page.clone()), NOW));
        page.artist.tags = vec!["hidden\ncontrol".into()];
        assert!(!valid_cached(&CachedPage::Artist(page.clone()), NOW));
        page.artist.tags.clear();
        page.artist.summary.kind = Some("x".repeat(81));
        assert!(!valid_cached(&CachedPage::Artist(page.clone()), NOW));
        page.artist.summary.kind = None;
        page.releases[0].first_release_date = Some("2026-02-31".into());
        assert!(!valid_cached(&CachedPage::Artist(page), NOW));
        let mut cache = CacheFile {
            version: 1,
            entries: vec![
                CacheEntry {
                    key: search_key("same", 0),
                    value: search_page(NOW - 100),
                    releases_fetched_at: None,
                },
                CacheEntry {
                    key: search_key("same", 0),
                    value: search_page(NOW),
                    releases_fetched_at: None,
                },
            ],
        };
        trim_cache(&mut cache, NOW);
        assert_eq!(cache.entries.len(), 1);
        assert_eq!(cache.entries[0].value.fetched_at(), NOW);
    }

    #[test]
    fn rate_gate_serializes_concurrent_starts_at_the_requested_interval() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let gate = std::sync::Arc::new(tokio::sync::Mutex::new(None));
            let mut jobs = vec![];
            for _ in 0..3 {
                let gate = gate.clone();
                jobs.push(tokio::spawn(async move {
                    wait_for_slot(&gate, Duration::from_millis(35)).await;
                    Instant::now()
                }));
            }
            let mut starts = vec![];
            for job in jobs {
                starts.push(job.await.unwrap());
            }
            starts.sort();
            assert!(starts[1].duration_since(starts[0]) >= Duration::from_millis(30));
            assert!(starts[2].duration_since(starts[1]) >= Duration::from_millis(30));
            assert_eq!(REQUEST_INTERVAL, Duration::from_secs(1));
        });
    }

    #[test]
    fn response_body_limit_rejects_oversize_even_without_content_length() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let response = Response::from(
                tauri::http::Response::builder()
                    .body(vec![0; MAX_BODY + 1])
                    .unwrap(),
            );
            assert!(matches!(
                bounded_response(response).await,
                Err(CatalogError::InvalidResponse)
            ));
            let response = Response::from(
                tauri::http::Response::builder()
                    .body(b"{}".to_vec())
                    .unwrap(),
            );
            assert_eq!(bounded_response(response).await.unwrap(), b"{}");
        });
    }

    #[test]
    #[ignore = "Explicit read-only external MusicBrainz smoke check, no credentials"]
    fn musicbrainz_live_smoke_en_ru() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let provider = MusicBrainzCatalog::new().unwrap();
            let path = std::env::temp_dir().join(format!("pulse-mb-live-{}.json", hex::encode(rand::random::<[u8; 8]>())));
            let mut failures = Vec::new();
            for query in ["Kendrick Lamar", "Кишлак"] {
                let started = std::time::Instant::now();
                let result = provider.search(&path, query, 0).await;
                match result {
                    Ok(page) => {
                        eprintln!("MusicBrainz live query={query:?} elapsed_ms={} artists={} stale={}", started.elapsed().as_millis(), page.artists.len(), page.stale);
                        if query == "Kendrick Lamar" && page.artists.is_empty() { failures.push("Known English artist returned no results".to_string()); }
                        if page.artists.is_empty() { eprintln!("MusicBrainz live coverage gap: no results for {query:?}"); }
                        if let Some(artist) = page.artists.iter().find(|artist| artist.name.to_lowercase() == query.to_lowercase()).or_else(|| page.artists.first()) {
                            let started = std::time::Instant::now();
                            match provider.artist(&path, &artist.id, 0).await {
                                Ok(page) => eprintln!("MusicBrainz live artist={:?} elapsed_ms={} releases={} tags={} links={} more={} stale={}", page.artist.summary.name, started.elapsed().as_millis(), page.releases.len(), page.artist.tags.len(), page.artist.links.len(), page.has_more, page.stale),
                                Err(error) => { eprintln!("MusicBrainz live artist lookup failed: {error}"); failures.push(error.to_string()); },
                            }
                        }
                    },
                    Err(error) => { eprintln!("MusicBrainz live query={query:?} elapsed_ms={} failed={error}", started.elapsed().as_millis()); failures.push(error.to_string()); },
                }
            }
            let _ = fs::remove_file(path);
            assert!(failures.is_empty(), "External MusicBrainz smoke failed: {}", failures.join("; "));
        });
    }
}
