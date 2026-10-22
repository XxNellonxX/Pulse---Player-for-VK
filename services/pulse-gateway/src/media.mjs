import { randomBytes } from 'node:crypto';
import { GatewayError, upstreamStatus } from './errors.mjs';
import { validateRange, validateTarget } from './security.mjs';

export class MediaSessions {
  constructor(origin, now = Date.now) {
    this.origin = origin;
    this.now = now;
    this.sessions = new Map();
    this.urlBytes = 0;
  }
  prune() {
    for (const [token, session] of this.sessions) if (session.expires <= this.now()) this.remove(token);
  }
  remove(token) {
    const session = this.sessions.get(token);
    if (session) this.urlBytes -= session.bytes;
    this.sessions.delete(token);
  }
  create(ip, urls) {
    this.prune();
    const sameIp = [...this.sessions].filter(([, session]) => session.ip === ip);
    if (sameIp.length >= 8) this.remove(sameIp[0][0]);
    if (this.sessions.size >= 512) this.remove(this.sessions.keys().next().value);
    const token = randomBytes(24).toString('hex');
    const session = { ip, expires: this.now() + 15 * 60_000, urls: [], bytes: 0 };
    this.sessions.set(token, session);
    try { return { token, urls: urls.map(url => this.register(token, session, url)) }; }
    catch (error) { this.remove(token); throw error; }
  }
  get(token, index, ip) {
    this.prune();
    const session = this.sessions.get(token);
    if (!session || session.ip !== ip || !session.urls[index]) throw new GatewayError(410, 'media_session_expired');
    return { session, url: session.urls[index] };
  }
  register(token, session, value) {
    const url = validateTarget(value, 'media').href;
    let index = session.urls.indexOf(url);
    if (index < 0) {
      const bytes = Buffer.byteLength(url);
      if (session.urls.length >= 2048 || session.bytes + bytes > 1024 * 1024 || this.urlBytes + bytes > 16 * 1024 * 1024) throw new GatewayError(503, 'media_registry_full', 30);
      index = session.urls.length;
      session.urls.push(url);
      session.bytes += bytes;
      this.urlBytes += bytes;
    }
    return `${this.origin}/v1/media/${token}/${index}`;
  }
}

export function isManifest(bytes, contentType) {
  return String(contentType).toLowerCase().includes('mpegurl') || bytes.subarray(0, 64).toString('utf8').replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U');
}

export function rewriteManifest(bytes, base, register) {
  if (bytes.length > 1024 * 1024) throw new GatewayError(502, 'invalid_manifest');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''); } catch { throw new GatewayError(502, 'invalid_manifest'); }
  if (!text.trimStart().startsWith('#EXTM3U') || text.split('\n').length > 10000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new GatewayError(502, 'invalid_manifest');
  const address = value => {
    if (!value || value.length > 16384 || /[\x00-\x20\x7f]/.test(value)) throw new GatewayError(502, 'invalid_manifest');
    let url;
    try { url = new URL(value, base); } catch { throw new GatewayError(502, 'invalid_manifest'); }
    return register(url.href);
  };
  return Buffer.from(text.split(/\r?\n/).map(line => {
    const trimmed = line.trim();
    if (!trimmed) return '';
    if (!trimmed.startsWith('#')) return address(trimmed);
    if (/(?:^|[:,])\s*(?:SERVER-URI|X-ASSET-URI|X-ASSET-LIST)\s*=/i.test(trimmed)) throw new GatewayError(502, 'unsupported_manifest');
    // Every URI attribute (keys, maps, renditions, prefetch and variants) is
    // rewritten. Unquoted/nonstandard URI values are rejected, not passed on.
    const rewritten = trimmed.replace(/([:,])\s*URI="([^"\r\n]*)"/g, (_, separator, value) => `${separator}URI="${address(value)}"`);
    if (/([:,])\s*URI\s*=/i.test(rewritten.replace(/([:,])URI="[^"]*"/g, ''))) throw new GatewayError(502, 'invalid_manifest');
    return rewritten;
  }).join('\n'));
}

// One retry belongs to the entire GET operation, including its redirect chain.
// Retry only an explicit transient HTTP response; do not retry authentication,
// quota errors, validation failures or ambiguous network exceptions.
export async function transientRequest(transport, url, options, { deadline, requestTimeout, budget, delay }) {
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new GatewayError(504, 'provider_timeout');
    const response = await transport.request(url, { ...options, timeoutMs: Math.min(requestTimeout, remaining) });
    if (![500, 502, 503, 504].includes(response.status) || budget.used) return response;
    budget.used = true;
    if (deadline - Date.now() <= 500) throw new GatewayError(504, 'provider_timeout');
    await delay(500);
  }
}

export async function relayMedia({ transport, tokens, sessions, userAgent, token, index, ip, range, head = false, delay }) {
  const { session, url: initial } = sessions.get(token, index, ip);
  const checkedRange = validateRange(range);
  let url = initial;
  let rejected = false;
  const transientBudget = { used: false };
  const wait = delay || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  let lastToken;
  const deadline = Date.now() + 40000;
  for (let hop = 0; hop <= 5; hop++) {
    validateTarget(url, 'media');
    const headers = { accept: '*/*', 'user-agent': userAgent };
    if (checkedRange) headers.range = checkedRange;
    if (new URL(url).hostname === 'api.soundcloud.com') {
      headers.accept = 'application/json; charset=utf-8';
      lastToken = await tokens.get();
      headers.authorization = `OAuth ${lastToken}`;
    }
    if (Date.now() >= deadline) throw new GatewayError(504, 'provider_timeout');
    const response = await transientRequest(transport, url, { kind: 'media', method: 'GET', headers, maxBytes: 8 * 1024 * 1024 }, { deadline, requestTimeout: 30000, budget: transientBudget, delay: wait });
    if (response.status === 401 && headers.authorization && !rejected) { await tokens.get(lastToken); rejected = true; continue; }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (hop === 5 || typeof response.headers.location !== 'string') throw new GatewayError(502, 'invalid_provider_redirect');
      url = validateTarget(new URL(response.headers.location, url), 'media').href;
      continue;
    }
    if (response.status !== 200 && response.status !== 206) throw upstreamStatus(response.status, response.headers);
    const type = String(response.headers['content-type'] || 'application/octet-stream').slice(0, 128);
    if (/json/i.test(type)) {
      if (response.bytes.length > 65536 || hop === 5) throw new GatewayError(502, 'invalid_provider_response');
      let body;
      try { body = JSON.parse(response.bytes); } catch { throw new GatewayError(502, 'invalid_provider_response'); }
      url = validateTarget(body.url, 'media').href;
      continue;
    }
    if (/html|javascript/i.test(type) || /^\s*(?:<!doctype|<html)/i.test(response.bytes.subarray(0, 100).toString())) throw new GatewayError(502, 'invalid_provider_response');
    // Expiry or registry eviction during an upstream operation cannot extend a
    // capability's lifetime or register fresh URLs into a dead session.
    sessions.get(token, index, ip);
    const manifest = isManifest(response.bytes, type);
    if (manifest && response.status !== 200) throw new GatewayError(502, 'invalid_manifest');
    const bytes = manifest ? rewriteManifest(response.bytes, response.finalUrl || url, target => sessions.register(token, session, target)) : response.bytes;
    const headersOut = { 'content-type': manifest ? 'application/vnd.apple.mpegurl' : type, 'content-length': String(bytes.length), 'cache-control': 'private, no-store', 'accept-ranges': 'bytes' };
    const contentRange = response.headers['content-range'];
    if (response.status === 206) {
      const match = typeof contentRange === 'string' && /^bytes (\d{1,16})-(\d{1,16})\/(\d{1,16}|\*)$/.exec(contentRange);
      if (!match) throw new GatewayError(502, 'invalid_provider_response');
      const start = Number(match[1]), end = Number(match[2]), total = match[3] === '*' ? undefined : Number(match[3]);
      const requested = checkedRange && /^bytes=(\d+)-(\d*)$/.exec(checkedRange);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || end - start + 1 !== response.bytes.length || (total !== undefined && (!Number.isSafeInteger(total) || total <= end)) || !requested || start !== Number(requested[1]) || (requested[2] && end > Number(requested[2]))) throw new GatewayError(502, 'invalid_provider_response');
      headersOut['content-range'] = contentRange;
    }
    return { status: response.status, headers: headersOut, bytes: head ? Buffer.alloc(0) : bytes, chargedBytes: bytes.length };
  }
  throw new GatewayError(502, 'invalid_provider_redirect');
}
