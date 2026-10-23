import http from 'node:http';
import { GatewayError, upstreamStatus } from './errors.mjs';
import { requireGet } from './config.mjs';
import { allowedQuery, clientIp, integerQuery, publicPermalink, queryText, trackId, uuid, validateTarget } from './security.mjs';
import { BoundedCache, AbuseLimits, IntervalGate } from './limits.mjs';
import { MediaSessions, relayMedia, transientRequest } from './media.mjs';
import { MediaByteCache } from './media-cache.mjs';
import { SoundCloudTokens } from './oauth.mjs';
import { createTransport } from './transport.mjs';

const STREAM_KEYS = ['hls_aac_160_url', 'hls_mp3_128_url'];

function json(response) {
  if (response.status !== 200) throw upstreamStatus(response.status, response.headers);
  try { return JSON.parse(response.bytes); } catch { throw new GatewayError(502, 'invalid_provider_response'); }
}

export function createGateway(config, { transport = createTransport(), now = Date.now, delay } = {}) {
  const cache = new BoundedCache({ now });
  const limits = new AbuseLimits(config, now);
  const mbGate = new IntervalGate(1000, now, delay);
  const tokens = new SoundCloudTokens(config, transport, now);
  const mediaCache = new MediaByteCache({ now });
  const sessions = new MediaSessions(config.origin, now, token => mediaCache.deleteSession(token));
  const sweep = setInterval(() => { sessions.prune(); mediaCache.prune(); }, 30_000);
  sweep.unref();
  const pending = new Map();
  const wait = delay || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));

  async function cached(key, ttl, fetch) {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    if (pending.has(key)) return pending.get(key);
    const request = fetch().then(value => { cache.set(key, value, ttl); return value; }).finally(() => pending.delete(key));
    pending.set(key, request);
    return request;
  }

  async function scApi(url) {
    validateTarget(url, 'api');
    const deadline = Date.now() + 30000;
    const transientBudget = { used: false };
    for (let retry = 0; retry < 2; retry++) {
      const access = await tokens.get();
      let rejected = false;
      for (let hop = 0; hop <= 5; hop++) {
        if (Date.now() >= deadline) throw new GatewayError(504, 'provider_timeout');
        const response = await transientRequest(transport, url, { kind: 'api', headers: { accept: 'application/json; charset=utf-8', 'user-agent': config.userAgent, authorization: `OAuth ${access}` }, maxBytes: 2 * 1024 * 1024 }, { deadline, requestTimeout: 20000, budget: transientBudget, delay: wait });
        if (response.status === 401 && retry === 0) { await tokens.get(access); rejected = true; break; }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (hop === 5 || typeof response.headers.location !== 'string') throw new GatewayError(502, 'invalid_provider_redirect');
          url = validateTarget(new URL(response.headers.location, url), 'api');
          continue;
        }
        return json(response);
      }
      if (!rejected) break;
    }
    throw new GatewayError(503, 'provider_access_unavailable');
  }

  async function mbApi(url, ttl) {
    return cached(url.href, ttl, async () => {
      await mbGate.enter();
      const response = await transport.request(url, { kind: 'musicbrainz', headers: { accept: 'application/json', 'user-agent': config.userAgent }, maxBytes: 2 * 1024 * 1024, timeoutMs: 12000 });
      return json(response);
    });
  }

  function page(value, source) {
    if (!value || !Array.isArray(value.collection) || value.collection.length > 50) throw new GatewayError(502, 'invalid_provider_response');
    const copy = { ...value };
    if (copy.next_href) {
      const next = validateTarget(copy.next_href, 'api');
      if (next.pathname !== '/tracks') throw new GatewayError(502, 'invalid_provider_response');
      allowedQuery(next.searchParams, ['q', 'limit', 'offset', 'cursor', 'linked_partitioning', 'access']);
      if (!next.searchParams.has('q')) next.searchParams.set('q', source.searchParams.get('q'));
      copy.next_href = `${config.origin}/v1/soundcloud/tracks${next.search}`;
    }
    return copy;
  }

  async function metadata(url, ip) {
    let match;
    if (url.pathname === '/v1/musicbrainz/search') {
      allowedQuery(url.searchParams, ['query', 'offset']);
      const query = queryText(url.searchParams.get('query'), 1024);
      const offset = integerQuery(url.searchParams.get('offset'), 0, 0, 10000);
      const upstream = new URL('https://musicbrainz.org/ws/2/artist');
      upstream.search = new URLSearchParams({ query, fmt: 'json', limit: '20', offset: String(offset) });
      return mbApi(upstream, 6 * 60 * 60_000);
    }
    if ((match = /^\/v1\/musicbrainz\/artist\/([^/]+)(\/releases)?$/.exec(url.pathname))) {
      allowedQuery(url.searchParams, match[2] ? ['offset'] : []);
      const id = uuid(match[1]);
      const upstream = new URL(match[2] ? 'https://musicbrainz.org/ws/2/release-group' : `https://musicbrainz.org/ws/2/artist/${id}`);
      upstream.search = new URLSearchParams(match[2] ? { fmt: 'json', artist: id, limit: '30', offset: String(integerQuery(url.searchParams.get('offset'), 0, 0, 10000)) } : { fmt: 'json', inc: 'url-rels+tags' });
      return mbApi(upstream, match[2] ? 60 * 60_000 : 6 * 60 * 60_000);
    }
    if (url.pathname === '/v1/soundcloud/tracks') {
      allowedQuery(url.searchParams, ['q', 'limit', 'offset', 'cursor', 'linked_partitioning', 'access']);
      const upstream = new URL('https://api.soundcloud.com/tracks');
      upstream.searchParams.set('q', queryText(url.searchParams.get('q'), 300));
      upstream.searchParams.set('limit', String(integerQuery(url.searchParams.get('limit'), 30, 1, 50)));
      upstream.searchParams.set('linked_partitioning', 'true');
      upstream.searchParams.set('access', 'playable');
      if (url.searchParams.has('offset')) upstream.searchParams.set('offset', String(integerQuery(url.searchParams.get('offset'), 0, 0, 10000)));
      if (url.searchParams.has('cursor')) upstream.searchParams.set('cursor', queryText(url.searchParams.get('cursor'), 2048));
      if (url.searchParams.has('linked_partitioning') && url.searchParams.get('linked_partitioning') !== 'true') throw new GatewayError(400, 'invalid_request');
      if (url.searchParams.has('access') && url.searchParams.get('access') !== 'playable') throw new GatewayError(400, 'invalid_request');
      return page(await cached(upstream.href, 5 * 60_000, () => scApi(upstream)), upstream);
    }
    if (url.pathname === '/v1/soundcloud/resolve') {
      allowedQuery(url.searchParams, ['url']);
      const upstream = new URL('https://api.soundcloud.com/resolve');
      upstream.searchParams.set('url', publicPermalink(url.searchParams.get('url')));
      return cached(upstream.href, 5 * 60_000, () => scApi(upstream));
    }
    if ((match = /^\/v1\/soundcloud\/tracks\/([^/]+)(\/streams)?$/.exec(url.pathname))) {
      allowedQuery(url.searchParams, []);
      let id;
      try { id = trackId(decodeURIComponent(match[1])); } catch { throw new GatewayError(400, 'invalid_request'); }
      const upstream = new URL(`https://api.soundcloud.com/tracks/soundcloud:tracks:${id}${match[2] || ''}`);
      if (!match[2]) return cached(upstream.href, 5 * 60_000, () => scApi(upstream));
      // Never cache stream grants. Their temporary signed URLs exist only in a
      // bounded capability registry and are never returned to clients.
      const value = await scApi(upstream);
      const keys = STREAM_KEYS.filter(key => typeof value?.[key] === 'string');
      if (!keys.length) throw new GatewayError(404, 'not_available');
      const session = sessions.createOrReuse(ip, keys.map(key => value[key]), id);
      return { ...Object.fromEntries(keys.map((key, index) => [key, session.urls[index]])), expires_at: session.expiresAt, expires_in_ms: Math.max(0, session.expiresAt - now()) };
    }
    throw new GatewayError(404, 'not_found');
  }

  async function handler(request, response) {
    let lease;
    const finished = new Promise(resolve => { response.once('finish', resolve); response.once('close', resolve); });
    const deadline = setTimeout(() => response.destroy(), 45000);
    deadline.unref();
    try {
      requireGet(request.method);
      if (request.url.length > 8192 || !request.url.startsWith('/') || request.url.startsWith('//')) throw new GatewayError(400, 'invalid_request');
      if (request.headers['content-length'] && request.headers['content-length'] !== '0' || request.headers['transfer-encoding']) throw new GatewayError(400, 'body_not_allowed');
      const url = new URL(request.url, config.origin);
      if (url.pathname === '/healthz' || url.pathname === '/readyz') {
        if (url.search) throw new GatewayError(400, 'invalid_request');
        const bytes = Buffer.from(JSON.stringify(url.pathname === '/healthz' ? { status: 'ok' } : { status: 'configured', providersVerified: false }));
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(bytes.length), 'cache-control': 'no-store' });
        return response.end(request.method === 'HEAD' ? undefined : bytes);
      }
      const ip = clientIp(request, config.trustLoopbackProxy);
      const media = /^\/v1\/media\/([a-f0-9]{48})\/(0|[1-9]\d{0,3})$/.exec(url.pathname);
      lease = limits.acquire(ip, Boolean(media));
      if (media) {
        allowedQuery(url.searchParams, []);
        const result = await relayMedia({ transport, tokens, sessions, mediaCache, userAgent: config.userAgent, token: media[1], index: Number(media[2]), ip, range: request.headers.range, head: request.method === 'HEAD', delay: wait });
        lease.bytes(result.chargedBytes);
        response.writeHead(result.status, { ...result.headers, 'x-content-type-options': 'nosniff' });
        response.end(result.bytes);
        return;
      }
      if (request.headers.range) throw new GatewayError(400, 'invalid_request');
      const data = await metadata(url, ip);
      const bytes = Buffer.from(JSON.stringify(data));
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(bytes.length), 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      const safe = error instanceof GatewayError ? error : new GatewayError(502, 'gateway_unavailable');
      const bytes = Buffer.from(JSON.stringify({ error: safe.code }));
      const headers = { 'content-type': 'application/json', 'content-length': String(bytes.length), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
      if (safe.retryAfter) headers['retry-after'] = String(safe.retryAfter);
      if (safe.status === 405) headers.allow = 'GET, HEAD';
      if (!response.headersSent) response.writeHead(safe.status, headers);
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } finally {
      // Retain the in-flight lease through a slow client's buffered response.
      // A disconnected client still holds it until its bounded upstream work
      // returns, so disconnect storms cannot start unlimited provider requests.
      await finished;
      clearTimeout(deadline);
      lease?.release();
    }
  }
  return { handler, close: () => { clearInterval(sweep); mediaCache.clear(); transport.close?.(); }, cache, mediaCache, sessions };
}

export function createServer(config, dependencies) {
  const gateway = createGateway(config, dependencies);
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 15000, headersTimeout: 10000, keepAliveTimeout: 5000 }, gateway.handler);
  server.maxRequestsPerSocket = 200;
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  server.once('close', gateway.close);
  return server;
}
