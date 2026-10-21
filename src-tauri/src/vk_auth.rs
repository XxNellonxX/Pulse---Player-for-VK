//! Small, renderer-independent VK ID OAuth 2.1 client.
//!
//! Tokens never cross the Tauri IPC boundary.  They are kept in the Windows
//! Credential Manager through `keyring`; the callback listener only accepts
//! the exact registered loopback path and validates state before returning a
//! code to the exchange routine.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use keyring::Entry;
use rand::{rngs::OsRng, RngCore};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fmt,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex as AsyncMutex;
use url::Url;

const ID_ORIGIN: &str = "https://id.vk.ru";
const API_ORIGIN: &str = "https://api.vk.ru";
const KEYRING_SERVICE: &str = "ru.vkplayer.desktop.vk";
const KEYRING_USER: &str = "session";
const MAX_CALLBACK_BYTES: usize = 32 * 1024;
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct VkAuthError {
    pub code: String,
    pub message: String,
}
impl VkAuthError {
    fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}
impl fmt::Display for VkAuthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for VkAuthError {}

#[derive(Debug, Clone, Serialize, Default)]
pub struct VkAuthStatus {
    pub state: String,
    pub message: String,
    #[serde(rename = "userId", skip_serializing_if = "Option::is_none")]
    pub user_id: Option<i64>,
    #[serde(rename = "expiresAt", skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    pub configured: bool,
    pub scope: String,
    #[serde(rename = "requiresReauth", skip_serializing_if = "is_false")]
    pub requires_reauth: bool,
}
fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Tokens {
    access_token: String,
    refresh_token: String,
    device_id: String,
    user_id: Option<i64>,
    scope: String,
    expires_at: i64,
    refresh_expires_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Stored {
    version: u8,
    client_id: String,
    redirect_uri: String,
    rotation_pending: bool,
    tokens: Tokens,
}

#[derive(Debug, Clone)]
struct CallbackConfig {
    host: String,
    path: String,
    port: u16,
    // VK ID's current local-registration example uses `http://localhost`
    // without an explicit port. Keep that distinction so the HTTP Host header
    // can be accepted both as `localhost` and `localhost:80`.
    implicit_port: bool,
}

pub struct VkAuthManager {
    pub client_id: String,
    pub redirect_uri: String,
    pub scopes: String,
    callback: CallbackConfig,
    tokens: Mutex<Option<Tokens>>,
    status: Mutex<VkAuthStatus>,
    load_once: Mutex<bool>,
    refresh_lock: AsyncMutex<()>,
    connect_lock: AsyncMutex<()>,
    http: Client,
    generation: Arc<AtomicU64>,
    storage_lock: Mutex<()>,
}

impl VkAuthManager {
    pub fn session_epoch(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }
    pub fn new(
        client_id: impl Into<String>,
        redirect_uri: impl Into<String>,
        scopes: impl Into<String>,
    ) -> Result<Self, VkAuthError> {
        let client_id = client_id.into().trim().to_string();
        let redirect_uri = redirect_uri.into().trim().to_string();
        let callback = parse_redirect(&redirect_uri)?;
        let scopes = normalize_scopes(&scopes.into());
        let configured = !client_id.is_empty() && client_id.chars().all(|c| c.is_ascii_digit());
        Ok(Self {
            client_id,
            redirect_uri,
            scopes: scopes.clone(),
            callback,
            tokens: Mutex::new(None),
            status: Mutex::new(VkAuthStatus {
                state: if configured {
                    "disconnected"
                } else {
                    "not-configured"
                }
                .into(),
                message: if configured {
                    "Войдите через VK ID."
                } else {
                    "VK ID client_id не настроен."
                }
                .into(),
                configured,
                scope: scopes,
                ..Default::default()
            }),
            load_once: Mutex::new(false),
            refresh_lock: AsyncMutex::new(()),
            connect_lock: AsyncMutex::new(()),
            http: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(15))
                .build()
                .map_err(|_| {
                    VkAuthError::new("internal", "Не удалось инициализировать сетевой клиент.")
                })?,
            generation: Arc::new(AtomicU64::new(0)),
            storage_lock: Mutex::new(()),
        })
    }

    pub fn status(&self) -> VkAuthStatus {
        self.load();
        self.status.lock().expect("status lock").clone()
    }

    fn entry(&self) -> Result<Entry, VkAuthError> {
        Entry::new(
            KEYRING_SERVICE,
            &format!("{}:{}", KEYRING_USER, self.client_id),
        )
        .map_err(|_| {
            VkAuthError::new(
                "storage_unavailable",
                "Не удалось открыть защищённое хранилище VK ID.",
            )
        })
    }

    fn load(&self) {
        let mut once = self.load_once.lock().expect("load lock");
        if *once {
            return;
        }
        let _storage = self.storage_lock.lock().expect("storage lock");
        *once = true;
        let result = self.entry().and_then(|entry| match entry.get_password() {
            Ok(raw) => {
                if raw.len() > MAX_RESPONSE_BYTES {
                    return Err(VkAuthError::new(
                        "storage_invalid",
                        "Сохранённая сессия VK ID повреждена.",
                    ));
                }
                let stored: Stored = serde_json::from_str(&raw).map_err(|_| {
                    VkAuthError::new("storage_invalid", "Сохранённая сессия VK ID повреждена.")
                })?;
                if stored.version != 1
                    || stored.client_id != self.client_id
                    || stored.redirect_uri != self.redirect_uri
                {
                    return Err(VkAuthError::new(
                        "storage_config_changed",
                        "Настройки VK ID изменились. Выполните вход заново.",
                    ));
                }
                if stored.rotation_pending {
                    return Err(VkAuthError::new(
                        "rotation_pending",
                        "Обновление сессии VK ID было прервано. Выполните вход заново.",
                    ));
                }
                if stored.tokens.refresh_expires_at <= now_ms() {
                    return Err(VkAuthError::new(
                        "session_expired",
                        "Сессия VK ID истекла. Выполните вход заново.",
                    ));
                }
                if !valid_tokens(&stored.tokens) {
                    return Err(VkAuthError::new(
                        "storage_invalid",
                        "Сохранённая сессия VK ID повреждена.",
                    ));
                }
                let token = stored.tokens;
                *self.tokens.lock().expect("token lock") = Some(token.clone());
                let mut status = self.status.lock().expect("status lock");
                status.user_id = token.user_id;
                status.expires_at = Some(token.expires_at);
                status.scope = token.scope;
                Ok(())
            }
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(VkAuthError::new(
                "storage_unavailable",
                "Не удалось прочитать защищённую сессию VK ID.",
            )),
        });
        if let Err(error) = result {
            let mut status = self.status.lock().expect("status lock");
            status.state = "error".into();
            status.message = error.message;
            status.requires_reauth = true;
        } else if let Some(token) = self.tokens.lock().expect("token lock").as_ref() {
            let mut status = self.status.lock().expect("status lock");
            status.state = if token.expires_at > now_ms() {
                "connected"
            } else {
                "error"
            }
            .into();
            status.message = if token.expires_at > now_ms() {
                "VK ID подключён. Доступ к музыке проверяется отдельно."
            } else {
                "Сессия VK ID требует обновления. Нажмите подключить или синхронизировать."
            }
            .into();
        }
    }

    fn save(
        &self,
        tokens: &Tokens,
        rotation_pending: bool,
        generation: u64,
    ) -> Result<(), VkAuthError> {
        let _storage = self.storage_lock.lock().expect("storage lock");
        self.assert_generation(generation)?;
        let value = Stored {
            version: 1,
            client_id: self.client_id.clone(),
            redirect_uri: self.redirect_uri.clone(),
            rotation_pending,
            tokens: tokens.clone(),
        };
        self.entry()?
            .set_password(&serde_json::to_string(&value).map_err(|_| {
                VkAuthError::new("storage_failed", "Не удалось сохранить сессию VK ID.")
            })?)
            .map_err(|_| VkAuthError::new("storage_failed", "Не удалось сохранить сессию VK ID."))
    }

    fn remove_saved(&self) -> Result<(), VkAuthError> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(VkAuthError::new(
                "storage_failed",
                "Не удалось удалить локальную сессию VK ID. Повторите выход.",
            )),
        }
    }

    fn publish(&self, token: Tokens, generation: u64) -> Result<VkAuthStatus, VkAuthError> {
        let _storage = self.storage_lock.lock().expect("storage lock");
        self.assert_generation(generation)?;
        *self.tokens.lock().expect("token lock") = Some(token.clone());
        let mut status = self.status.lock().expect("status lock");
        status.state = "connected".into();
        status.message = "VK ID подключён. Доступ к музыке проверяется отдельно.".into();
        status.user_id = token.user_id;
        status.expires_at = Some(token.expires_at);
        status.scope = token.scope;
        status.requires_reauth = false;
        Ok(status.clone())
    }

    pub async fn connect<F>(&self, open_external: F) -> Result<VkAuthStatus, VkAuthError>
    where
        F: FnOnce(String) -> Result<(), String> + Send + 'static,
    {
        let generation = self.generation.load(Ordering::SeqCst);
        let _guard = self.connect_lock.lock().await;
        self.assert_generation(generation)?;
        self.load();
        self.assert_configured()?;
        if self.usable(60_000) {
            return Ok(self.status());
        }
        if self.tokens.lock().expect("token lock").is_some() {
            if self.refresh_at_epoch(generation).await.is_ok() && self.usable(0) {
                return Ok(self.status());
            }
        }
        self.assert_generation(generation)?;
        let verifier = random_text(48);
        let state = random_text(32);
        let mut auth = Url::parse(&format!("{ID_ORIGIN}/authorize"))
            .map_err(|_| VkAuthError::new("internal", "Некорректный адрес VK ID."))?;
        auth.query_pairs_mut()
            .append_pair("response_type", "code")
            .append_pair("client_id", &self.client_id)
            .append_pair("redirect_uri", &self.redirect_uri)
            .append_pair("state", &state)
            .append_pair("code_challenge", &challenge_for(&verifier))
            .append_pair("code_challenge_method", "S256")
            .append_pair("scope", &self.scopes);
        self.status.lock().expect("status lock").state = "connecting".into();
        let callback_config = self.callback.clone();
        let state_clone = state.clone();
        let listener = TcpListener::bind((&callback_config.host[..], callback_config.port))
            .map_err(|_| {
                VkAuthError::new(
                    "callback_server",
                    "Не удалось открыть локальный callback VK ID.",
                )
            })?;
        listener.set_nonblocking(true).ok();
        let generation_counter = self.generation.clone();
        let wait = tokio::task::spawn_blocking(move || {
            wait_callback(
                listener,
                callback_config,
                state_clone,
                generation_counter,
                generation,
            )
        });
        if open_external(auth.to_string()).is_err() {
            self.generation.fetch_add(1, Ordering::SeqCst);
            let _ = wait.await;
            return Err(VkAuthError::new(
                "browser",
                "Не удалось открыть системный браузер для VK ID.",
            ));
        }
        let callback = wait.await.map_err(|_| {
            VkAuthError::new(
                "callback_server",
                "Локальный callback VK ID завершился с ошибкой.",
            )
        })??;
        self.assert_generation(generation)?;
        if callback.denied {
            return Err(VkAuthError::new(
                "access_denied",
                "Вход VK ID отменён или отклонён.",
            ));
        }
        let device_id = callback.device_id.clone();
        let response = self
            .post(
                "auth",
                &[
                    ("grant_type", "authorization_code".into()),
                    ("code_verifier", verifier),
                    ("redirect_uri", self.redirect_uri.clone()),
                    ("code", callback.code),
                    ("client_id", self.client_id.clone()),
                    ("device_id", callback.device_id),
                    ("state", state.clone()),
                ],
            )
            .await?;
        if response.get("state").and_then(Value::as_str) != Some(state.as_str()) {
            return Err(VkAuthError::new(
                "state_mismatch",
                "VK ID вернул неверное состояние авторизации.",
            ));
        }
        self.assert_generation(generation)?;
        let tokens = token_response(&response, &self.scopes, Some(&device_id))?;
        self.save(&tokens, false, generation)?;
        self.publish(tokens, generation)
    }

    pub async fn refresh_if_needed(&self) -> Result<VkAuthStatus, VkAuthError> {
        let generation = self.session_epoch();
        self.refresh_at_epoch(generation).await
    }

    pub(crate) async fn refresh_at_epoch(
        &self,
        generation: u64,
    ) -> Result<VkAuthStatus, VkAuthError> {
        let _guard = self.refresh_lock.lock().await;
        self.assert_generation(generation)?;
        self.load();
        self.assert_generation(generation)?;
        if self.usable(60_000) {
            return Ok(self.status());
        }
        let previous = self
            .tokens
            .lock()
            .expect("token lock")
            .clone()
            .ok_or_else(|| VkAuthError::new("not_connected", "Сначала войдите через VK ID."))?;
        if previous.refresh_expires_at <= now_ms() {
            let _storage = self.storage_lock.lock().expect("storage lock");
            self.assert_generation(generation)?;
            let _ = self.remove_saved();
            *self.tokens.lock().expect("token lock") = None;
            let mut status = self.status.lock().expect("status lock");
            status.state = "error".into();
            status.requires_reauth = true;
            status.user_id = None;
            status.expires_at = None;
            status.message = "Сессия VK ID истекла. Выполните вход заново.".into();
            return Err(VkAuthError::new(
                "session_expired",
                "Сессия VK ID истекла. Выполните вход заново.",
            ));
        }
        self.save(&previous, true, generation)?;
        let state = random_text(32);
        let result = self
            .post(
                "auth",
                &[
                    ("grant_type", "refresh_token".into()),
                    ("refresh_token", previous.refresh_token.clone()),
                    ("client_id", self.client_id.clone()),
                    ("device_id", previous.device_id.clone()),
                    ("state", state.clone()),
                ],
            )
            .await;
        let finished = match result {
            Ok(response)
                if response.get("state").and_then(Value::as_str) == Some(state.as_str()) =>
            {
                (|| {
                    self.assert_generation(generation)?;
                    let mut next =
                        token_response(&response, &self.scopes, Some(&previous.device_id))?;
                    if next.user_id.is_some()
                        && previous.user_id.is_some()
                        && next.user_id != previous.user_id
                    {
                        return Err(VkAuthError::new(
                            "invalid_response",
                            "VK ID вернул другой аккаунт при обновлении сессии.",
                        ));
                    }
                    next.user_id = next.user_id.or(previous.user_id);
                    self.save(&next, false, generation)?;
                    self.publish(next, generation)
                })()
            }
            Ok(_) | Err(_) => Err(VkAuthError::new(
                "refresh_failed",
                "Не удалось безопасно обновить сессию VK ID. Выполните вход заново.",
            )),
        };
        if finished.is_err() {
            let _storage = self.storage_lock.lock().expect("storage lock");
            self.assert_generation(generation)?;
            let _ = self.remove_saved();
            *self.tokens.lock().expect("token lock") = None;
            let mut s = self.status.lock().expect("status lock");
            s.state = "error".into();
            s.requires_reauth = true;
            s.user_id = None;
            s.expires_at = None;
            s.message = "Не удалось безопасно обновить сессию VK ID. Выполните вход заново.".into();
        }
        finished
    }

    pub async fn api_request(
        &self,
        method: &str,
        params: &[(String, String)],
    ) -> Result<Value, VkAuthError> {
        self.api_request_at_epoch(method, params, self.session_epoch())
            .await
    }

    /// Keep a logical operation tied to its initiating account, including time
    /// spent waiting for synchronization and refresh locks.
    pub async fn api_request_at_epoch(
        &self,
        method: &str,
        params: &[(String, String)],
        generation: u64,
    ) -> Result<Value, VkAuthError> {
        self.assert_generation(generation)?;
        if !method
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
            || !method.contains('.')
        {
            return Err(VkAuthError::new(
                "invalid_method",
                "VK API метод не разрешён.",
            ));
        }
        self.refresh_at_epoch(generation).await?;
        let token = {
            let _storage = self.storage_lock.lock().expect("storage lock");
            self.assert_generation(generation)?;
            self.tokens
                .lock()
                .expect("token lock")
                .clone()
                .ok_or_else(|| VkAuthError::new("not_connected", "Сначала войдите через VK ID."))?
        };
        let mut form = params.iter().cloned().collect::<Vec<_>>();
        form.push(("access_token".into(), token.access_token));
        form.push(("v".into(), "5.199".into()));
        let body = self
            .http
            .post(format!("{API_ORIGIN}/method/{method}"))
            .form(&form)
            .send()
            .await
            .map_err(|_| VkAuthError::new("network", "Не удалось связаться с VK API."))?;
        let ok = body.status().is_success();
        let value = read_limited_json(body).await?;
        self.assert_generation(generation)?;
        if !ok || value.get("error").is_some() {
            return Err(VkAuthError::new(
                "api_unavailable",
                &format!(
                    "VK не подтвердил доступ к {method} (код {}).",
                    value
                        .get("error")
                        .and_then(|e| e.get("error_code"))
                        .and_then(Value::as_i64)
                        .map(|n| n.to_string())
                        .unwrap_or_else(|| "HTTP".into())
                ),
            ));
        }
        value.get("response").cloned().ok_or_else(|| {
            VkAuthError::new(
                "invalid_response",
                "VK вернул ответ без результата операции.",
            )
        })
    }

    pub fn disconnect(&self) -> VkAuthStatus {
        self.generation.fetch_add(1, Ordering::SeqCst);
        let _storage = self.storage_lock.lock().expect("storage lock");
        let removed = self.remove_saved();
        *self.tokens.lock().expect("token lock") = None;
        let mut s = self.status.lock().expect("status lock");
        s.state = "disconnected".into();
        s.message = "Локальная сессия VK ID удалена.".into();
        s.requires_reauth = false;
        s.user_id = None;
        s.expires_at = None;
        if let Err(error) = removed {
            s.state = "error".into();
            s.message = error.message;
            s.requires_reauth = true;
        }
        s.clone()
    }
    fn assert_generation(&self, generation: u64) -> Result<(), VkAuthError> {
        if self.generation.load(Ordering::SeqCst) == generation {
            Ok(())
        } else {
            Err(VkAuthError::new("cancelled", "Операция VK ID отменена."))
        }
    }
    fn assert_configured(&self) -> Result<(), VkAuthError> {
        if self.client_id.is_empty() || !self.client_id.chars().all(|c| c.is_ascii_digit()) {
            Err(VkAuthError::new(
                "not_configured",
                "VK ID client_id не настроен.",
            ))
        } else {
            Ok(())
        }
    }
    fn usable(&self, skew: i64) -> bool {
        self.tokens
            .lock()
            .expect("token lock")
            .as_ref()
            .map(|t| !t.access_token.is_empty() && t.expires_at > now_ms() + skew)
            .unwrap_or(false)
    }
    async fn post(&self, endpoint: &str, values: &[(&str, String)]) -> Result<Value, VkAuthError> {
        let response = self
            .http
            .post(format!("{ID_ORIGIN}/oauth2/{endpoint}"))
            .form(values)
            .send()
            .await
            .map_err(|_| VkAuthError::new("network", "Не удалось связаться с VK ID."))?;
        let ok = response.status().is_success();
        let body = read_limited_json(response).await?;
        if !ok
            || body.get("error").is_some()
            || body.get("access_token").is_none() && endpoint == "auth"
        {
            return Err(VkAuthError::new(
                "vk_error",
                "VK ID отклонил запрос. Выполните вход заново.",
            ));
        }
        Ok(body)
    }
}

async fn read_limited_json(mut response: reqwest::Response) -> Result<Value, VkAuthError> {
    if response
        .content_length()
        .map(|n| n > MAX_RESPONSE_BYTES as u64)
        .unwrap_or(false)
    {
        return Err(VkAuthError::new(
            "invalid_response",
            "VK вернул слишком большой ответ.",
        ));
    }
    let mut data = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| VkAuthError::new("network", "Не удалось прочитать ответ VK."))?
    {
        if data.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(VkAuthError::new(
                "invalid_response",
                "VK вернул слишком большой ответ.",
            ));
        }
        data.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&data)
        .map_err(|_| VkAuthError::new("invalid_response", "VK вернул некорректный ответ."))
}

#[derive(Debug)]
struct Callback {
    code: String,
    device_id: String,
    denied: bool,
}
fn parse_redirect(input: &str) -> Result<CallbackConfig, VkAuthError> {
    let url = Url::parse(input).map_err(|_| {
        VkAuthError::new(
            "invalid_config",
            "Укажите зарегистрированный VK ID redirect URI.",
        )
    })?;
    let localhost_root = url.host_str() == Some("localhost")
        && url.port_or_known_default() == Some(80)
        && url.path() == "/";
    if url.scheme() != "http"
        || !matches!(url.host_str(), Some("localhost" | "127.0.0.1"))
        || (url.path() == "/" && !localhost_root)
        || url.path().is_empty()
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
    {
        return Err(VkAuthError::new(
            "invalid_config",
            "VK ID callback должен быть loopback path без параметров; корень разрешён для http://localhost/.",
        ));
    }
    let implicit_port = url.port().is_none();
    if implicit_port && url.host_str() != Some("localhost") {
        return Err(VkAuthError::new(
            "invalid_config",
            "Для callback без порта используйте localhost; для 127.0.0.1 укажите порт.",
        ));
    }
    let port = url.port().unwrap_or(80);
    Ok(CallbackConfig {
        host: url.host_str().unwrap().into(),
        path: url.path().into(),
        port,
        implicit_port,
    })
}
fn normalize_scopes(input: &str) -> String {
    let mut out = Vec::new();
    for value in input.split_whitespace() {
        if !value.is_empty()
            && value.len() <= 80
            && value
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || ".-_".contains(c))
            && !out.iter().any(|x| *x == value)
        {
            out.push(value);
        }
    }
    if out.is_empty() {
        "vkid.personal_info".into()
    } else {
        out.into_iter().take(64).collect::<Vec<_>>().join(" ")
    }
}
fn random_text(bytes: usize) -> String {
    let mut data = vec![0u8; bytes];
    OsRng.fill_bytes(&mut data);
    URL_SAFE_NO_PAD.encode(data)
}
fn challenge_for(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
fn valid_tokens(tokens: &Tokens) -> bool {
    !tokens.access_token.is_empty()
        && tokens.access_token.len() <= 32_768
        && !tokens.refresh_token.is_empty()
        && tokens.refresh_token.len() <= 32_768
        && !tokens.device_id.is_empty()
        && tokens.device_id.len() <= 4096
        && tokens.expires_at > 0
        && tokens.refresh_expires_at > 0
}
fn token_response(value: &Value, scope: &str, device: Option<&str>) -> Result<Tokens, VkAuthError> {
    let access = value
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|x| !x.is_empty() && x.len() <= 32_768)
        .ok_or_else(|| {
            VkAuthError::new("invalid_response", "VK ID вернул неполный набор токенов.")
        })?;
    let refresh = value
        .get("refresh_token")
        .and_then(Value::as_str)
        .filter(|x| !x.is_empty() && x.len() <= 32_768)
        .ok_or_else(|| {
            VkAuthError::new("invalid_response", "VK ID вернул неполный набор токенов.")
        })?;
    let device_id = device
        .map(str::to_owned)
        .or_else(|| {
            value
                .get("device_id")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .ok_or_else(|| {
            VkAuthError::new("invalid_response", "VK ID вернул неполный набор токенов.")
        })?;
    if device_id.is_empty() || device_id.len() > 4096 {
        return Err(VkAuthError::new(
            "invalid_response",
            "VK ID вернул некорректное устройство.",
        ));
    }
    let expires = value
        .get("expires_in")
        .and_then(Value::as_i64)
        .filter(|x| *x > 0 && *x <= 366 * 86400)
        .ok_or_else(|| {
            VkAuthError::new("invalid_response", "VK ID вернул некорректный срок сессии.")
        })?;
    Ok(Tokens {
        access_token: access.into(),
        refresh_token: refresh.into(),
        device_id,
        user_id: value.get("user_id").and_then(|x| x.as_i64()),
        scope: value
            .get("scope")
            .and_then(Value::as_str)
            .unwrap_or(scope)
            .into(),
        expires_at: now_ms() + expires * 1000,
        refresh_expires_at: now_ms() + 180 * 86400_000,
    })
}

fn callback_from_request(
    request: &str,
    config: &CallbackConfig,
    expected_state: &str,
) -> Option<Callback> {
    if request.len() > MAX_CALLBACK_BYTES || !request.contains("\r\n\r\n") {
        return None;
    }
    let first = request.lines().next()?;
    let mut pieces = first.split_whitespace();
    if pieces.next()? != "GET" {
        return None;
    }
    let target = pieces.next()?;
    if !target.starts_with('/') || !matches!(pieces.next(), Some("HTTP/1.1" | "HTTP/1.0")) {
        return None;
    }
    let hosts = request
        .lines()
        .filter_map(|line| {
            line.split_once(':')
                .filter(|(name, _)| name.eq_ignore_ascii_case("host"))
                .map(|(_, value)| value.trim())
        })
        .collect::<Vec<_>>();
    let expected_host = format!("{}:{}", config.host, config.port);
    let host_matches = hosts.len() == 1
        && (hosts[0].eq_ignore_ascii_case(&expected_host)
            || (config.implicit_port && hosts[0].eq_ignore_ascii_case(&config.host)));
    if !host_matches {
        return None;
    }
    let url = Url::parse(&format!("http://{}{}", hosts[0], target)).ok()?;
    if url.path() != config.path || url.fragment().is_some() {
        return None;
    }
    let query = url.query_pairs().collect::<Vec<_>>();
    for key in ["state", "code", "device_id", "payload", "error"] {
        if query.iter().filter(|(name, _)| name == key).count() > 1 {
            return None;
        }
    }
    let payload = query
        .iter()
        .find(|(name, _)| name == "payload")
        .map(|(_, value)| serde_json::from_str::<Value>(value))
        .transpose()
        .ok()?;
    if payload
        .as_ref()
        .map(|value| !value.is_object())
        .unwrap_or(false)
    {
        return None;
    }
    let one = |name: &str| {
        let values = query
            .iter()
            .filter(|(key, _)| key == name)
            .map(|(_, value)| value.to_string())
            .collect::<Vec<_>>();
        let direct = values.first().cloned();
        let nested = payload
            .as_ref()
            .and_then(|value| value.get(name))
            .and_then(Value::as_str)
            .map(str::to_owned);
        if direct.is_some() && nested.is_some() && direct != nested {
            return None;
        }
        direct.or(nested)
    };
    let state = one("state")?;
    if state != expected_state {
        return None;
    }
    if one("error").is_some() {
        return Some(Callback {
            code: String::new(),
            device_id: String::new(),
            denied: true,
        });
    }
    let code = one("code")?;
    let device_id = one("device_id")?;
    if state != expected_state
        || code.is_empty()
        || code.len() > 32_768
        || device_id.is_empty()
        || device_id.len() > 4096
    {
        return None;
    }
    Some(Callback {
        code,
        device_id,
        denied: false,
    })
}
fn wait_callback(
    listener: TcpListener,
    config: CallbackConfig,
    expected_state: String,
    generation_counter: Arc<AtomicU64>,
    generation: u64,
) -> Result<Callback, VkAuthError> {
    let deadline = Instant::now() + Duration::from_secs(300);
    while Instant::now() < deadline {
        if generation_counter.load(Ordering::SeqCst) != generation {
            return Err(VkAuthError::new("cancelled", "Операция VK ID отменена."));
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                stream.set_read_timeout(Some(Duration::from_secs(1))).ok();
                let mut bytes = Vec::new();
                let mut buf = [0u8; 4096];
                while bytes.len() < MAX_CALLBACK_BYTES {
                    let Ok(n) = stream.read(&mut buf) else {
                        break;
                    };
                    if n == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&buf[..n]);
                    if bytes.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                if let Some(callback) = callback_from_request(
                    &String::from_utf8_lossy(&bytes),
                    &config,
                    &expected_state,
                ) {
                    reply(
                        &mut stream,
                        200,
                        "Запрос получен. Можно вернуться в VK Player.",
                    );
                    return Ok(callback);
                }
                reply(&mut stream, 400, "Некорректный или устаревший callback.");
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(25))
            }
            Err(_) => {
                return Err(VkAuthError::new(
                    "callback_server",
                    "Локальный callback VK ID завершился с ошибкой.",
                ))
            }
        }
    }
    Err(VkAuthError::new(
        "timeout",
        "Время ожидания входа VK ID истекло.",
    ))
}
fn reply(stream: &mut TcpStream, status: u16, text: &str) {
    let body = format!("<!doctype html><meta charset=utf-8><title>VK Player</title><p>{text}</p>");
    let _ = write!(stream, "HTTP/1.1 {}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'\r\nConnection: close\r\n\r\n{}", status, body.len(), body);
    let _ = stream.flush();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::Future;

    #[test]
    fn pkce_is_base64url() {
        let value = challenge_for("verifier");
        assert!(!value.contains('='));
        assert!(value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn redirect_rejects_non_loopback_and_query() {
        assert!(parse_redirect("https://example.com/cb").is_err());
        assert!(parse_redirect("http://127.0.0.1:49281/callback?state=x").is_err());
        assert!(parse_redirect("http://127.0.0.1:49281/callback").is_ok());
        assert!(parse_redirect("http://localhost/callback").is_ok());
        assert!(parse_redirect("http://127.0.0.1/callback").is_err());
    }

    #[test]
    fn official_localhost_root_redirect_accepts_exact_callback_only() {
        let config = parse_redirect("http://localhost/").expect("official local redirect");
        assert_eq!(config.port, 80);
        assert!(callback_from_request(
            "GET /?state=s&code=c&device_id=d HTTP/1.1\r\nHost: localhost\r\n\r\n",
            &config,
            "s"
        )
        .is_some());
        assert!(callback_from_request(
            "GET /callback?state=s&code=c&device_id=d HTTP/1.1\r\nHost: localhost\r\n\r\n",
            &config,
            "s"
        )
        .is_none());
        assert!(parse_redirect("http://127.0.0.1:49281/").is_err());
        assert!(parse_redirect("http://localhost:49281/").is_err());
    }

    #[test]
    fn scopes_have_no_injection() {
        assert_eq!(
            normalize_scopes("vkid.personal_info bad! vkid.personal_info"),
            "vkid.personal_info"
        );
    }

    #[test]
    fn callback_rejects_forged_state_duplicates_wrong_origin_and_method() {
        let config = parse_redirect("http://127.0.0.1:49281/callback").unwrap();
        let request = |query: &str, host: &str, method: &str| {
            format!("{method} /callback?{query} HTTP/1.1\r\nHost: {host}\r\n\r\n")
        };
        assert!(callback_from_request(
            &request(
                "state=expected&code=c&device_id=d",
                "127.0.0.1:49281",
                "GET"
            ),
            &config,
            "expected"
        )
        .is_some());
        assert!(callback_from_request(
            &request("state=forged&code=c&device_id=d", "127.0.0.1:49281", "GET"),
            &config,
            "expected"
        )
        .is_none());

        let localhost = parse_redirect("http://localhost/callback").unwrap();
        let request_implicit =
            "GET /callback?state=expected&code=c&device_id=d HTTP/1.1\r\nHost: localhost\r\n\r\n";
        assert!(callback_from_request(request_implicit, &localhost, "expected").is_some());
        let request_with_port = "GET /callback?state=expected&code=c&device_id=d HTTP/1.1\r\nHost: localhost:80\r\n\r\n";
        assert!(callback_from_request(request_with_port, &localhost, "expected").is_some());
        assert!(callback_from_request(
            &request(
                "state=expected&state=expected&code=c&device_id=d",
                "127.0.0.1:49281",
                "GET"
            ),
            &config,
            "expected"
        )
        .is_none());
        assert!(callback_from_request(
            &request(
                "state=expected&code=c&device_id=d",
                "evil.test:49281",
                "GET"
            ),
            &config,
            "expected"
        )
        .is_none());
        assert!(callback_from_request(
            &request(
                "state=expected&code=c&device_id=d",
                "127.0.0.1:49281",
                "POST"
            ),
            &config,
            "expected"
        )
        .is_none());
    }

    #[test]
    fn callback_listener_stops_on_logout_generation() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let config = parse_redirect(&format!("http://127.0.0.1:{port}/callback")).unwrap();
        let generation = Arc::new(AtomicU64::new(1));
        let started = Instant::now();
        let error = wait_callback(listener, config, "s".into(), generation, 0).unwrap_err();
        assert_eq!(error.code, "cancelled");
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn token_response_requires_rotation_material() {
        let value = serde_json::json!({"access_token":"a", "refresh_token":"r", "device_id":"d", "expires_in":3600, "state":"s"});
        let token = token_response(&value, "vkid.personal_info", None).expect("valid token");
        assert!(token.expires_at > now_ms());
        assert!(token.refresh_expires_at > token.expires_at);
        let missing = serde_json::json!({"access_token":"a", "expires_in":3600});
        assert_eq!(
            token_response(&missing, "x", None).unwrap_err().code,
            "invalid_response"
        );
    }

    #[test]
    fn rotation_marker_is_serialized_and_detected() {
        let token = Tokens {
            access_token: "a".into(),
            refresh_token: "r".into(),
            device_id: "d".into(),
            user_id: None,
            scope: "x".into(),
            expires_at: now_ms() + 1000,
            refresh_expires_at: now_ms() + 10_000,
        };
        let stored = Stored {
            version: 1,
            client_id: "1".into(),
            redirect_uri: "http://127.0.0.1:1/cb".into(),
            rotation_pending: true,
            tokens: token,
        };
        let encoded = serde_json::to_string(&stored).expect("stored json");
        let decoded: Stored = serde_json::from_str(&encoded).expect("stored json roundtrip");
        assert!(decoded.rotation_pending);
    }

    #[test]
    fn queued_refresh_rejects_the_session_that_ended_while_waiting() {
        let auth = VkAuthManager::new("1", "http://localhost/", "vkid.personal_info").unwrap();
        // Avoid touching the user's Credential Manager from a regression test.
        *auth.load_once.lock().unwrap() = true;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        runtime.block_on(async {
            let original = auth.session_epoch();
            let guard = auth.refresh_lock.lock().await;
            let future = auth.refresh_at_epoch(original);
            tokio::pin!(future);
            std::future::poll_fn(|cx| {
                assert!(future.as_mut().poll(cx).is_pending());
                std::task::Poll::Ready(())
            })
            .await;
            auth.generation.fetch_add(1, Ordering::SeqCst);
            drop(guard);
            assert_eq!(future.await.unwrap_err().code, "cancelled");
            let error = auth
                .api_request_at_epoch("audio.createPlaylist", &[], original)
                .await
                .unwrap_err();
            assert_eq!(error.code, "cancelled");
        });
    }
}
