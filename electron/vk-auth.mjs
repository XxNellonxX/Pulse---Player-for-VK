import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ORIGIN = 'https://id.vk.ru';
const REQUEST_TIMEOUT = 15_000;
const AUTH_TIMEOUT = 5 * 60_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const AUTH_KEYS = ['code', 'state', 'device_id', 'payload', 'error', 'error_description'];
const VK_ERROR_CODES = new Set(['access_denied', 'invalid_token', 'invalid_client', 'invalid_request', 'invalid_scope', 'invalid_grant', 'server_error', 'slow_down', 'temporarily_unavailable', 'login_required', 'interaction_required']);

/** Public errors intentionally contain no raw server response, URL, token, or cause. */
export class VkAuthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VkAuthError';
    this.code = code;
  }
}

const fail = (code, message) => new VkAuthError(code, message);
const cancelled = () => fail('cancelled', 'Операция VK ID отменена.');
const randomText = (bytes = 32) => randomBytes(bytes).toString('base64url');
const challengeFor = verifier => createHash('sha256').update(verifier, 'ascii').digest('base64url');
const safeError = error => error instanceof VkAuthError ? error : fail('internal', 'Не удалось завершить операцию VK ID.');
const validString = (value, max = 32_768) => typeof value === 'string' && value.length > 0 && value.length <= max;

function scopesFor(input) {
  const values = Array.isArray(input) ? input : String(input || 'vkid.personal_info').split(/\s+/);
  const result = [...new Set(values.filter(value => typeof value === 'string' && /^[a-zA-Z0-9._-]{1,80}$/.test(value)))];
  return (result.length ? result : ['vkid.personal_info']).slice(0, 64);
}

function redirectFor(input) {
  let url;
  try { url = new URL(input); } catch { throw fail('invalid_config', 'Укажите зарегистрированный VK ID redirect URI.'); }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname.toLowerCase())) {
    throw fail('invalid_config', 'Локальный callback VK ID разрешён только через http://localhost или http://127.0.0.1.');
  }
  if (url.username || url.password || url.hash || !url.pathname || url.pathname === '/' || AUTH_KEYS.some(key => url.searchParams.has(key))) {
    throw fail('invalid_config', 'VK ID redirect URI должен иметь отдельный callback path без параметров авторизации или fragment.');
  }
  // An omitted port means HTTP port 80. VK documents localhost:80 for development.
  if (url.port && (!Number.isInteger(Number(url.port)) || Number(url.port) < 1)) throw fail('invalid_config', 'VK ID callback требует фиксированный локальный порт.');
  return url;
}

function payloadFor(input) {
  if (!validString(input, 65_536)) return null;
  const candidates = [input];
  try { candidates.push(decodeURIComponent(input)); } catch { /* invalid encoding */ }
  for (const candidate of candidates) {
    try {
      const object = JSON.parse(candidate);
      if (object && typeof object === 'object' && !Array.isArray(object)) return object;
    } catch { /* direct query parameters remain supported */ }
  }
  return null;
}

function callbackValues(url, expectedState) {
  if (AUTH_KEYS.some(key => url.searchParams.getAll(key).length > 1)) return null;
  const packed = url.searchParams.has('payload') ? payloadFor(url.searchParams.get('payload')) : {};
  if (!packed) return null;
  const pick = key => {
    const direct = url.searchParams.get(key);
    const nested = packed[key];
    if (direct !== null && nested !== undefined && direct !== nested) return undefined;
    return direct ?? nested;
  };
  const state = pick('state');
  if (state !== expectedState) return null;
  const error = pick('error');
  if (error) return { error: VK_ERROR_CODES.has(error) ? error : 'access_denied' };
  const code = pick('code');
  const deviceId = pick('device_id');
  if (!validString(code) || !validString(deviceId, 4096)) return null;
  return { code, deviceId, state };
}

/**
 * VK ID OAuth 2.1 public client. Requires a client_id and an exactly registered
 * HTTP loopback redirect URI. Arbitrary desktop ports/custom URI support is NOT
 * promised by VK's current docs; register and verify this redirect before use.
 * No audio capabilities are inferred from a successful identity login.
 *
 * safeStorage is Electron's safeStorage, supplied after app.whenReady().
 * All public methods are asynchronous and return no tokens. userInfo() returns
 * only profile fields. The token file contains one encrypted atomic snapshot;
 * no backup is kept because rotated refresh tokens must never be reused.
 */
export class VkAuth {
  constructor({ clientId = '', redirectUri, scopes = 'vkid.personal_info', userData, openExternal, safeStorage } = {}) {
    this.clientId = String(clientId || '').trim();
    this.redirect = redirectFor(redirectUri);
    this.redirectUri = this.redirect.toString();
    this.scopes = scopesFor(scopes);
    if (typeof userData !== 'string' || !userData) throw fail('invalid_config', 'Не указан каталог пользовательских данных VK ID.');
    this.storageFile = path.join(userData, 'vk-auth.json');
    this.userData = userData;
    this.openExternal = openExternal;
    this.safeStorage = safeStorage;
    this.tokens = null;
    this.loaded = false;
    this._loadPromise = null;
    this._storagePromise = Promise.resolve();
    this._connectPromise = null;
    this._refreshPromise = null;
    this._authController = null;
    this._refreshController = null;
    this._generation = 0;
    this._status = this.clientId
      ? { state: 'disconnected', message: 'Войдите через VK ID.' }
      : { state: 'not-configured', message: 'VK ID client_id не настроен. Требуются зарегистрированный public client и точный redirect URI.' };
  }

  async getStatus() {
    await this._load();
    if (this.tokens && this._status.state === 'connected' && !this._usable()) this._status = { state: 'expired', message: 'Сессия VK ID требует обновления.' };
    return {
      ...this._status,
      configured: Boolean(this.clientId),
      userId: this.tokens?.userId ?? null,
      expiresAt: this.tokens?.expiresAt ?? null,
      scope: this.tokens?.scope ?? this.scopes.join(' '),
      musicAccess: 'unknown',
    };
  }

  _assertGeneration(generation, signal) {
    if (generation !== this._generation || signal?.aborted) throw cancelled();
  }

  _assertStorage() {
    if (!this.safeStorage || typeof this.safeStorage.encryptString !== 'function' || typeof this.safeStorage.decryptString !== 'function' || (typeof this.safeStorage.isEncryptionAvailable === 'function' && !this.safeStorage.isEncryptionAvailable())) {
      throw fail('storage_unavailable', 'Системное шифрование Windows для сессии VK ID недоступно.');
    }
  }

  _assertConfigured() {
    if (!this.clientId) throw fail('not_configured', 'VK ID client_id не настроен. Зарегистрируйте public client и точный redirect URI в кабинете VK ID.');
    if (!/^\d{1,32}$/.test(this.clientId)) throw fail('invalid_config', 'VK ID client_id должен быть идентификатором зарегистрированного приложения.');
    if (typeof this.openExternal !== 'function') throw fail('invalid_config', 'Не настроен запуск системного браузера для VK ID.');
    this._assertStorage();
  }

  _usable(skew = 0) {
    return Boolean(this.tokens?.accessToken && this.tokens.expiresAt > Date.now() + skew);
  }

  async _load() {
    if (this.loaded) return;
    if (this._loadPromise) return this._loadPromise;
    const generation = this._generation;
    this._loadPromise = (async () => {
      try {
        this._assertStorage();
        const raw = await readFile(this.storageFile, 'utf8');
        if (raw.length > MAX_RESPONSE_BYTES) throw fail('storage_invalid', 'Сохранённая сессия VK ID повреждена.');
        const envelope = JSON.parse(raw);
        if (envelope?.version !== 1 || !validString(envelope.encrypted, MAX_RESPONSE_BYTES)) throw fail('storage_invalid', 'Сохранённая сессия VK ID повреждена.');
        const data = JSON.parse(this.safeStorage.decryptString(Buffer.from(envelope.encrypted, 'base64')));
        if (data.clientId !== this.clientId || data.redirectUri !== this.redirectUri) throw fail('storage_config_changed', 'Настройки VK ID изменены. Выполните вход заново.');
        if (data.rotationPending === true) throw fail('rotation_pending', 'Обновление сессии VK ID было прервано. Для безопасности выполните вход заново.');
        if (!validString(data.accessToken) || !validString(data.refreshToken) || !validString(data.deviceId, 4096) || !Number.isFinite(data.expiresAt) || !Number.isFinite(data.refreshExpiresAt)) throw fail('storage_invalid', 'Сохранённая сессия VK ID повреждена.');
        if (data.refreshExpiresAt <= Date.now()) throw fail('session_expired', 'Сессия VK ID истекла. Выполните вход заново.');
        if (generation !== this._generation) return;
        this.tokens = { accessToken: data.accessToken, refreshToken: data.refreshToken, expiresAt: data.expiresAt, refreshExpiresAt: data.refreshExpiresAt, deviceId: data.deviceId, userId: data.userId ?? null, scope: typeof data.scope === 'string' ? data.scope : this.scopes.join(' ') };
        this._status = { state: this._usable() ? 'connected' : 'expired', message: this._usable() ? 'VK ID подключён. Доступ к музыке проверяется отдельно.' : 'Сессия VK ID требует обновления.' };
      } catch (error) {
        if (generation !== this._generation) return;
        this.tokens = null;
        if (error?.code !== 'ENOENT' && this.clientId) this._status = { state: 'error', message: error instanceof VkAuthError ? error.message : 'Не удалось прочитать защищённую сессию VK ID. Выполните вход заново.', requiresReauth: ['rotation_pending', 'session_expired', 'storage_invalid', 'storage_config_changed'].includes(error?.code) };
      } finally {
        if (generation === this._generation) this.loaded = true;
        this._loadPromise = null;
      }
    })();
    return this._loadPromise;
  }

  _serializeStorage(operation) {
    const pending = this._storagePromise.catch(() => {}).then(operation);
    this._storagePromise = pending;
    return pending;
  }

  _save(tokens, generation, signal, { rotationPending = false } = {}) {
    return this._serializeStorage(async () => {
      this._assertGeneration(generation, signal);
      this._assertStorage();
      let encrypted;
      try { encrypted = this.safeStorage.encryptString(JSON.stringify({ clientId: this.clientId, redirectUri: this.redirectUri, ...tokens, rotationPending })); } catch { throw fail('storage_failed', 'Не удалось зашифровать сессию VK ID.'); }
      const temp = `${this.storageFile}.${randomUUID()}.tmp`;
      try {
        await mkdir(this.userData, { recursive: true });
        await writeFile(temp, JSON.stringify({ version: 1, encrypted: Buffer.from(encrypted).toString('base64') }), { encoding: 'utf8', mode: 0o600, flush: true });
        this._assertGeneration(generation, signal);
        await rename(temp, this.storageFile);
        this._assertGeneration(generation, signal);
      } catch (error) {
        throw error instanceof VkAuthError ? error : fail('storage_failed', 'Не удалось сохранить защищённую сессию VK ID.');
      } finally {
        await rm(temp, { force: true }).catch(() => {});
      }
    });
  }

  _removeSaved() {
    return this._serializeStorage(async () => {
      try { await rm(this.storageFile, { force: true }); } catch { throw fail('storage_failed', 'Не удалось удалить локальную сессию VK ID.'); }
    });
  }

  async _readResponse(response) {
    const length = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw fail('invalid_response', 'VK ID вернул слишком большой ответ.');
    let text;
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); throw fail('invalid_response', 'VK ID вернул слишком большой ответ.'); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      text = Buffer.concat(chunks).toString('utf8');
    } else text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { throw fail('invalid_response', 'VK ID вернул некорректный ответ.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('invalid_response', 'VK ID вернул некорректный ответ.');
    if (!response.ok || body.error) {
      const code = VK_ERROR_CODES.has(body.error) ? body.error : 'vk_error';
      throw fail(code, code === 'access_denied' ? 'Доступ VK ID отклонён.' : 'VK ID отклонил запрос. Выполните вход заново.');
    }
    return body;
  }

  async _post(endpoint, values, { signal, timeoutMs = REQUEST_TIMEOUT } = {}) {
    if (signal?.aborted) throw cancelled();
    const controller = new AbortController();
    let timer;
    let onAbort;
    const interrupted = new Promise((_, reject) => {
      onAbort = () => { controller.abort(); reject(cancelled()); };
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => { controller.abort(); reject(fail('timeout', 'VK ID не ответил вовремя.')); }, Math.max(1, Math.min(timeoutMs, 60_000)));
    });
    const request = (async () => {
      try {
        const response = await fetch(`${ORIGIN}/oauth2/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(values).toString(), redirect: 'error', cache: 'no-store', signal: controller.signal });
        return await this._readResponse(response);
      } catch (error) {
        if (error instanceof VkAuthError) throw error;
        if (signal?.aborted) throw cancelled();
        throw fail('network', 'Не удалось связаться с VK ID.');
      }
    })();
    try { return await Promise.race([request, interrupted]); } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
  }

  async _stopServer(server, sockets) {
    if (!server) return;
    await new Promise(resolve => {
      const finish = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { server.closeAllConnections?.(); for (const socket of sockets || []) socket.destroy(); resolve(); }, 250);
      try { server.close(finish); server.closeIdleConnections?.(); } catch { finish(); }
    });
  }

  async _waitForCallback(authUrl, state, controller, timeoutMs) {
    let resolveCallback, rejectCallback;
    let settled = false;
    const callback = new Promise((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject; });
    // Attach immediately; a bind error must not become an unhandled rejection.
    callback.catch(() => {});
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) rejectCallback(error); else resolveCallback(value);
    };
    const onAbort = () => finish(cancelled());
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => finish(fail('timeout', 'Время ожидания входа VK ID истекло.')), Math.max(1, Math.min(timeoutMs, 10 * 60_000)));
    const sockets = new Set();
    const server = createServer((request, response) => {
      const respond = (status, message) => {
        response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', connection: 'close' });
        response.end(`<!doctype html><html lang="ru"><meta charset="utf-8"><title>VK Player</title><p>${message}</p></html>`);
      };
      try {
        if (request.method !== 'GET' || String(request.headers.host || '').toLowerCase() !== this.redirect.host.toLowerCase()) { respond(404, 'Адрес не найден.'); return; }
        const url = new URL(request.url || '/', this.redirectUri);
        if (url.origin !== this.redirect.origin || url.pathname !== this.redirect.pathname || url.hash) { respond(404, 'Адрес не найден.'); return; }
        for (const [key, value] of this.redirect.searchParams) if (url.searchParams.getAll(key).length !== 1 || url.searchParams.get(key) !== value) { respond(400, 'Некорректный callback.'); return; }
        const values = callbackValues(url, state);
        if (!values || settled) { respond(400, 'Некорректный или устаревший callback.'); return; }
        respond(values.error ? 400 : 200, values.error ? 'Вход отклонён. Можно вернуться в VK Player.' : 'Запрос получен. Можно вернуться в VK Player.');
        finish(values.error ? fail(values.error, 'Вход VK ID отменён или отклонён.') : null, values);
      } catch { respond(400, 'Некорректный callback.'); }
    });
    server.requestTimeout = 5000;
    server.headersTimeout = 5000;
    server.keepAliveTimeout = 1;
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
    server.on('error', () => finish(fail('callback_server', 'Не удалось открыть локальный callback VK ID. Проверьте зарегистрированный порт.')));
    try {
      if (controller.signal.aborted) throw cancelled();
      const listening = new Promise(resolve => server.once('listening', resolve));
      server.listen(Number(this.redirect.port || 80), this.redirect.hostname);
      await Promise.race([listening, callback]);
      if (settled) return await callback;
      Promise.resolve().then(() => this.openExternal(authUrl)).catch(() => finish(fail('browser', 'Не удалось открыть системный браузер для VK ID.')));
      return await callback;
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      await this._stopServer(server, sockets);
    }
  }

  connect(options = {}) {
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = this._connect(options).finally(() => { this._connectPromise = null; });
    return this._connectPromise;
  }

  async _connect({ signal, timeoutMs = AUTH_TIMEOUT } = {}) {
    const generation = this._generation;
    let controller;
    let onAbort;
    try {
      await this._load();
      this._assertGeneration(generation, signal);
      this._assertConfigured();
      if (this._usable()) return this.getStatus();
      if (this.tokens?.refreshToken) {
        try { await this.refreshIfNeeded({ signal }); } catch (error) { if (error.code === 'cancelled') throw error; }
        this._assertGeneration(generation, signal);
        if (this._usable()) return this.getStatus();
      }
      controller = new AbortController();
      this._authController = controller;
      onAbort = () => controller.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) controller.abort();
      this._assertGeneration(generation, controller.signal);
      const verifier = randomText(48);
      const state = randomText(32);
      const url = new URL(`${ORIGIN}/authorize`);
      url.search = new URLSearchParams({ response_type: 'code', client_id: this.clientId, redirect_uri: this.redirectUri, state, code_challenge: challengeFor(verifier), code_challenge_method: 'S256', scope: this.scopes.join(' ') }).toString();
      this._status = { state: 'connecting', message: 'Завершите вход в системном браузере VK ID.' };
      const callback = await this._waitForCallback(url.toString(), state, controller, timeoutMs);
      this._assertGeneration(generation, controller.signal);
      const response = await this._post('auth', { grant_type: 'authorization_code', code_verifier: verifier, redirect_uri: this.redirectUri, code: callback.code, client_id: this.clientId, device_id: callback.deviceId, state }, { signal: controller.signal });
      this._assertGeneration(generation, controller.signal);
      if (response.state !== state) throw fail('state_mismatch', 'VK ID вернул неверное состояние авторизации. Повторите вход.');
      const next = this._tokenResponse(response, callback.deviceId);
      await this._save(next, generation, controller.signal);
      this._assertGeneration(generation, controller.signal);
      this.tokens = next;
      this._status = { state: 'connected', message: 'VK ID подключён. Доступ к музыке проверяется отдельно.' };
      return this.getStatus();
    } catch (error) {
      const safe = safeError(error);
      if (generation === this._generation) this._status = { state: safe.code === 'not_configured' ? 'not-configured' : safe.code === 'cancelled' ? 'disconnected' : 'error', message: safe.message };
      throw safe;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (this._authController === controller) this._authController = null;
    }
  }

  _tokenResponse(response, deviceId) {
    const seconds = Number(response.expires_in);
    if (!validString(response.access_token) || !validString(response.refresh_token) || !validString(deviceId, 4096) || !Number.isFinite(seconds) || seconds <= 0 || seconds > 366 * 86400) throw fail('invalid_response', 'VK ID вернул неполный набор токенов. Повторите вход.');
    return { accessToken: response.access_token, refreshToken: response.refresh_token, deviceId, userId: typeof response.user_id === 'number' || typeof response.user_id === 'string' ? response.user_id : null, scope: typeof response.scope === 'string' ? response.scope : this.scopes.join(' '), expiresAt: Date.now() + seconds * 1000, refreshExpiresAt: Date.now() + 180 * 86400_000 };
  }

  async refreshIfNeeded({ signal, skewMs = 60_000, timeoutMs = REQUEST_TIMEOUT } = {}) {
    await this._load();
    if (signal?.aborted) throw cancelled();
    if (this._usable(Math.max(0, skewMs)) || !this.tokens?.refreshToken) return this.getStatus();
    if (this._refreshPromise) return this._refreshPromise;
    this._refreshPromise = this._refresh({ signal, timeoutMs }).finally(() => { this._refreshPromise = null; });
    return this._refreshPromise;
  }

  async _refresh({ signal, timeoutMs }) {
    const generation = this._generation;
    const previous = this.tokens;
    const controller = new AbortController();
    this._refreshController = controller;
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let sent = false;
    let pendingWriteAttempted = false;
    try {
      this._assertGeneration(generation, signal);
      if (previous.refreshExpiresAt <= Date.now()) throw fail('session_expired', 'Сессия VK ID истекла. Выполните вход заново.');
      const state = randomText(32);
      // Commit this marker before contacting VK. If the process exits after
      // the one-use refresh was consumed, the next process must require login
      // instead of replaying the old token and revoking the token family.
      pendingWriteAttempted = true;
      await this._save(previous, generation, controller.signal, { rotationPending: true });
      this._assertGeneration(generation, controller.signal);
      sent = true;
      const response = await this._post('auth', { grant_type: 'refresh_token', refresh_token: previous.refreshToken, client_id: this.clientId, device_id: previous.deviceId, state }, { signal: controller.signal, timeoutMs });
      this._assertGeneration(generation, controller.signal);
      if (response.state !== state) throw fail('state_mismatch', 'VK ID вернул неверное состояние обновления сессии.');
      const next = this._tokenResponse(response, previous.deviceId);
      await this._save(next, generation, controller.signal);
      this._assertGeneration(generation, controller.signal);
      this.tokens = next;
      this._status = { state: 'connected', message: 'VK ID подключён. Доступ к музыке проверяется отдельно.' };
      return this.getStatus();
    } catch (error) {
      if (generation === this._generation) {
        // A refresh may have been consumed even if its response was lost. Never
        // reuse the old refresh token: VK may revoke the entire token family.
        if (sent || error.code === 'session_expired') {
          this.tokens = null;
          await this._removeSaved();
          this._status = { state: 'error', message: 'Не удалось безопасно обновить сессию VK ID. Выполните вход заново.', requiresReauth: true };
        } else {
          // No request left the process: the old pair is still valid. Roll
          // back a marker interrupted before send without discarding a login.
          if (pendingWriteAttempted) {
            try { await this._save(previous, generation); }
            catch {
              this.tokens = null;
              this._status = { state: 'error', message: 'Не удалось восстановить защищённую сессию VK ID. Выполните вход заново.', requiresReauth: true };
              throw fail('storage_failed', this._status.message);
            }
          }
          this.tokens = previous;
          this._status = { state: this._usable() ? 'connected' : 'expired', message: safeError(error).message };
        }
      }
      throw safeError(error);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (this._refreshController === controller) this._refreshController = null;
    }
  }

  async userInfo({ signal, timeoutMs = REQUEST_TIMEOUT } = {}) {
    await this.refreshIfNeeded({ signal, timeoutMs });
    const generation = this._generation;
    if (!this.tokens?.accessToken) throw fail('not_connected', 'Сначала войдите через VK ID.');
    const response = await this._post('user_info', { client_id: this.clientId, access_token: this.tokens.accessToken }, { signal, timeoutMs });
    this._assertGeneration(generation, signal);
    const user = response.user;
    if (!user || typeof user !== 'object' || Array.isArray(user)) throw fail('invalid_response', 'VK ID не вернул профиль пользователя.');
    const profile = {};
    for (const key of ['user_id', 'first_name', 'last_name', 'avatar', 'sex', 'verified', 'birthday', 'email', 'phone']) {
      if (typeof user[key] === 'string' || typeof user[key] === 'number' || typeof user[key] === 'boolean') profile[key] = user[key];
    }
    return profile;
  }

  /** Call a documented VK API method without exposing the access token to the renderer. */
  async apiRequest(method, params = {}, { signal, timeoutMs = REQUEST_TIMEOUT } = {}) {
    await this.refreshIfNeeded({ signal, timeoutMs });
    if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/i.test(method)) throw fail('invalid_method', 'VK API метод не разрешён.');
    if (!this.tokens?.accessToken) throw fail('not_connected', 'Сначала войдите через VK ID.');
    const controller = new AbortController();
    let timer; let onAbort;
    const interrupted = new Promise((_, reject) => {
      onAbort = () => { controller.abort(); reject(cancelled()); };
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => { controller.abort(); reject(fail('timeout', 'VK API не ответил вовремя.')); }, Math.max(1, Math.min(timeoutMs, 60_000)));
    });
    const request = (async () => {
      try {
        const values = { ...params, access_token: this.tokens.accessToken, v: '5.199' };
        const body = new URLSearchParams();
        for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null) body.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
        const response = await fetch(`https://api.vk.ru/method/${method}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body, redirect: 'error', cache: 'no-store', signal: controller.signal });
        const length = Number(response.headers?.get?.('content-length'));
        if (Number.isFinite(length) && length > 4 * MAX_RESPONSE_BYTES) throw fail('invalid_response', 'VK API вернул слишком большой ответ.');
        const text = await response.text();
        if (text.length > 4 * MAX_RESPONSE_BYTES) throw fail('invalid_response', 'VK API вернул слишком большой ответ.');
        let result; try { result = JSON.parse(text); } catch { throw fail('invalid_response', 'VK API вернул некорректный ответ.'); }
        if (!response.ok || result?.error) {
          const code = Number(result?.error?.error_code);
          if (code === 5 || code === 27) throw fail('api_auth', 'VK API отклонил авторизацию. Выполните вход заново.');
          if (code === 6 || code === 29) throw fail('api_rate_limit', 'VK API временно ограничил запросы. Повторите позже.');
          throw fail('api_unavailable', 'VK не подтвердил доступ к этой музыкальной операции.');
        }
        return result?.response ?? null;
      } catch (error) { if (error instanceof VkAuthError) throw error; if (signal?.aborted) throw cancelled(); throw fail('network', 'Не удалось связаться с VK API.'); }
    })();
    try { return await Promise.race([request, interrupted]); } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
  }

  async disconnect({ signal, timeoutMs = REQUEST_TIMEOUT } = {}) {
    ++this._generation;
    this.loaded = true;
    const previous = this.tokens;
    this.tokens = null;
    this._status = { state: 'disconnected', message: 'Вы вышли из VK ID.' };
    this._authController?.abort();
    this._refreshController?.abort();
    await this._removeSaved();
    let remoteLogout = 'not-needed';
    if (previous?.accessToken) {
      try { await this._post('logout', { client_id: this.clientId, access_token: previous.accessToken }, { signal, timeoutMs }); remoteLogout = 'complete'; }
      catch { remoteLogout = 'unconfirmed'; }
    }
    return { ...(await this.getStatus()), remoteLogout };
  }
}

export default VkAuth;
