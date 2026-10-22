import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SoundCloudTokens } from '../src/oauth.mjs';
import { BoundedCache, AbuseLimits, IntervalGate } from '../src/limits.mjs';
import { MediaSessions, rewriteManifest } from '../src/media.mjs';
import { createTransport } from '../src/transport.mjs';
import { createGateway } from '../src/gateway.mjs';

const config = { clientId: 'server-client', clientSecret: 'server-private', maxGlobalConcurrent: 4, maxIpConcurrent: 2, metadataPerMinute: 3, mediaPerMinute: 5, globalPerMinute: 100 };
const jsonResponse = data => ({ status: 200, headers: {}, bytes: Buffer.from(JSON.stringify(data)) });

test('OAuth concurrent callers share exchange, reuse access, rotate single-use refresh and use documented grant formats', async () => {
  let now = 100000;
  const calls = [];
  const tokens = new SoundCloudTokens(config, { request: async (url, options) => {
    calls.push({ url, ...options });
    await new Promise(resolve => setImmediate(resolve));
    return jsonResponse({ access_token: `access${calls.length}`, refresh_token: `refresh${calls.length}`, expires_in: 100 });
  } }, () => now);
  assert.deepEqual(await Promise.all(Array.from({ length: 20 }, () => tokens.get())), Array(20).fill('access1'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.authorization, `Basic ${Buffer.from('server-client:server-private').toString('base64')}`);
  assert.deepEqual([...new URLSearchParams(calls[0].body)], [['grant_type', 'client_credentials']]);
  assert.equal(await tokens.get(), 'access1');
  now += 100000;
  assert.equal(await tokens.get(), 'access2');
  assert.equal(calls[1].headers.authorization, undefined);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[1].body)), { grant_type: 'refresh_token', refresh_token: 'refresh1', client_id: 'server-client', client_secret: 'server-private' });
  assert.equal(await tokens.get('access2'), 'access3');
  assert.equal(new URLSearchParams(calls[2].body).get('refresh_token'), 'refresh2');
});

test('OAuth rejected refresh falls back once, and persistent failure enters cooldown without retry storms', async () => {
  let now = 100000;
  let calls = 0;
  const tokens = new SoundCloudTokens(config, { request: async () => {
    calls++;
    if (calls === 1 || calls === 3) return jsonResponse({ access_token: `access${calls}`, refresh_token: `refresh${calls}`, expires_in: 10 });
    if (calls === 2) return { status: 400, headers: {}, bytes: Buffer.from('provider internal secret') };
    return { status: 429, headers: { 'retry-after': '300' }, bytes: Buffer.alloc(0) };
  } }, () => now);
  await tokens.get();
  now += 20000;
  assert.equal(await tokens.get(), 'access3');
  assert.equal(calls, 3);
  now += 20000;
  await assert.rejects(tokens.get(), error => error.status === 503 && error.retryAfter === 300 && !error.message.includes('secret'));
  await assert.rejects(tokens.get(), /provider_retry_later/);
  assert.equal(calls, 4);
});

test('metadata cache limits bytes and entries, expires values, evicts least recently used only', () => {
  let now = 10;
  const cache = new BoundedCache({ maxEntries: 2, maxBytes: 100, now: () => now });
  cache.set('a', { a: 'one' }, 20);
  cache.set('b', { b: 'two' }, 20);
  assert.deepEqual(cache.get('a'), { a: 'one' });
  cache.set('c', { c: 'three' }, 20);
  assert.equal(cache.get('b'), undefined);
  cache.set('huge', 'x'.repeat(1000), 20);
  assert.equal(cache.get('huge'), undefined);
  assert.ok(cache.bytes <= 100);
  now = 31;
  assert.equal(cache.get('a'), undefined);
});

test('abuse gates cap active operations, enforce minute requests and recover after time rollover', () => {
  let now = 0;
  const limits = new AbuseLimits(config, () => now);
  const one = limits.acquire('one');
  const two = limits.acquire('one');
  assert.throws(() => limits.acquire('one'), /gateway_busy/);
  one.release(); one.release(); two.release();
  limits.acquire('one').release();
  assert.throws(() => limits.acquire('one'), /rate_limited/);
  now = 60000;
  limits.acquire('one').release();
  assert.equal(limits.global.active, 0);
});

test('MusicBrainz global gate serializes concurrent starts one second apart', async () => {
  let now = 0;
  const starts = [];
  const gate = new IntervalGate(1000, () => now, async delay => { await new Promise(resolve => setImmediate(resolve)); now += delay; });
  await Promise.all(Array.from({ length: 4 }, async () => { await gate.enter(); starts.push(now); }));
  assert.deepEqual(starts, [0, 1000, 2000, 3000]);
});

test('capabilities remain bounded per IP and expire; manifests rewrite encryption keys without downgrading encryption', () => {
  let now = 0;
  const sessions = new MediaSessions('https://music.example.com', () => now);
  const first = sessions.create('ip', ['https://cf-hls-media.sndcdn.com/a.m3u8']);
  const { session } = sessions.get(first.token, 0, 'ip');
  const manifest = Buffer.from('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI="init.mp4"\nsegment.ts\n');
  const output = rewriteManifest(manifest, 'https://cf-hls-media.sndcdn.com/a.m3u8', value => sessions.register(first.token, session, value)).toString();
  assert.match(output, /METHOD=AES-128/);
  assert.equal((output.match(/https:\/\/music.example.com\/v1\/media/g) || []).length, 3);
  assert.doesNotMatch(output, /sndcdn/);
  for (let i = 0; i < 8; i++) sessions.create('ip', ['https://cf-hls-media.sndcdn.com/a.m3u8']);
  assert.equal(sessions.sessions.size, 8);
  assert.throws(() => sessions.get(first.token, 0, 'ip'), /media_session_expired/);
  now = 16 * 60_000;
  sessions.prune();
  assert.equal(sessions.sessions.size, 0);
  assert.equal(sessions.urlBytes, 0);
  assert.throws(() => rewriteManifest(Buffer.from('#EXTM3U\n#EXT-X-KEY:URI=file:///secret\n'), 'https://cf-hls-media.sndcdn.com/a.m3u8', x => x), /invalid_manifest/);
});

test('transport rejects mixed/private DNS before opening TLS and pins validated answers through lookup', async () => {
  let opened = false;
  const denied = createTransport({ lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }], request: () => { opened = true; } });
  await assert.rejects(denied.request('https://api.soundcloud.com/tracks', { kind: 'api' }), /invalid_provider_target/);
  assert.equal(opened, false);
  denied.close();
  let pinned;
  const transport = createTransport({ lookup: async () => [{ address: '93.184.216.34', family: 4 }], request: (url, options, callback) => {
    opened = true;
    options.lookup(url.hostname, { all: true }, (_error, addresses) => { pinned = addresses; });
    const request = new EventEmitter();
    request.end = () => {
      const response = new EventEmitter(); response.headers = {}; response.statusCode = 200; response.destroy = () => {};
      callback(response);
      response.emit('data', Buffer.from('ok')); response.emit('end');
    };
    request.destroy = () => {};
    return request;
  } });
  const result = await transport.request('https://api.soundcloud.com/tracks', { kind: 'api' });
  assert.equal(result.bytes.toString(), 'ok');
  assert.deepEqual(pinned, [{ address: '93.184.216.34', family: 4 }]);
  transport.close();
});

test('transport bounds provider bodies before returning data', async () => {
  const transport = createTransport({ lookup: async () => [{ address: '93.184.216.34', family: 4 }], request: (_url, _options, callback) => {
    const request = new EventEmitter(); request.destroy = () => {};
    request.end = () => {
      const response = new EventEmitter(); response.headers = {}; response.statusCode = 200; response.destroy = () => {};
      callback(response); response.emit('data', Buffer.alloc(11)); response.emit('end');
    };
    return request;
  } });
  await assert.rejects(transport.request('https://api.soundcloud.com/tracks', { kind: 'api', maxBytes: 10 }), /provider_response_too_large/);
  transport.close();
});

test('SoundCloud grant and authenticated media requests identify Pulse and retain OAuth only on the API origin', async () => {
  const userAgent = 'PulseGateway/fixture (https://example.com/contact)';
  const origin = 'https://music.example.com';
  const apiMedia = 'https://api.soundcloud.com/tracks/soundcloud:tracks:123/streams/00000000-0000-4000-8000-000000000000/hls';
  const calls = [];
  const gateway = createGateway({ ...config, origin, userAgent }, { transport: { request: async (value, options) => {
    const url = new URL(value);
    calls.push({ url, options });
    if (options.kind === 'token') return jsonResponse({ access_token: 'fixture-access', expires_in: 3600 });
    // This fixture reproduces the provider's rejection of bare JSON requests:
    // both API stages must send Pulse's own identity and explicit JSON charset.
    if (url.hostname === 'api.soundcloud.com') {
      if (options.headers['user-agent'] !== userAgent || options.headers.accept !== 'application/json; charset=utf-8') return { status: 500, headers: {}, bytes: Buffer.from('{"error":"Middleware error"}') };
      assert.equal(options.headers.authorization, 'OAuth fixture-access');
      if (options.kind === 'api') {
        assert.equal(url.pathname, '/tracks/soundcloud:tracks:123/streams');
        return jsonResponse({ hls_aac_160_url: apiMedia });
      }
      assert.equal(url.href, apiMedia);
      return { status: 302, headers: { location: 'https://cf-hls-media.sndcdn.com/fixture/master.m3u8' }, bytes: Buffer.alloc(0) };
    }
    assert.equal(url.hostname, 'cf-hls-media.sndcdn.com');
    assert.equal(options.headers['user-agent'], userAgent);
    assert.equal(options.headers.accept, '*/*');
    assert.equal(options.headers.authorization, undefined);
    assert.equal(options.headers.cookie, undefined);
    return { status: 200, headers: { 'content-type': url.pathname.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'audio/aac' }, bytes: Buffer.from(url.pathname.endsWith('.m3u8') ? '#EXTM3U\nsegment.ts\n' : 'fixture-audio') };
  } } });
  async function get(path) {
    const response = new EventEmitter();
    response.headersSent = false;
    response.writeHead = (status, headers) => { response.status = status; response.headers = headers; response.headersSent = true; };
    response.end = bytes => { response.bytes = bytes; response.emit('finish'); };
    response.destroy = () => { response.emit('close'); };
    await gateway.handler({ method: 'GET', url: path, headers: {}, socket: { remoteAddress: '198.51.100.44' } }, response);
    return response;
  }
  try {
    const grant = await get('/v1/soundcloud/tracks/soundcloud%3Atracks%3A123/streams');
    assert.equal(grant.status, 200);
    assert.doesNotMatch(grant.bytes.toString(), /soundcloud\.com|sndcdn\.com|fixture-access/);
    const capability = JSON.parse(grant.bytes).hls_aac_160_url;
    assert.equal(new URL(capability).origin, origin);
    const manifest = await get(new URL(capability).pathname);
    assert.equal(manifest.status, 200);
    assert.doesNotMatch(manifest.bytes.toString(), /soundcloud\.com|sndcdn\.com|fixture-access/);
    const segment = manifest.bytes.toString().split('\n').find(line => line && !line.startsWith('#'));
    const audio = await get(new URL(segment).pathname);
    assert.equal(audio.status, 200);
    assert.equal(audio.bytes.toString(), 'fixture-audio');
    assert.equal(calls.filter(call => call.url.hostname === 'api.soundcloud.com').length, 2);
    assert.equal(calls.filter(call => call.url.hostname === 'cf-hls-media.sndcdn.com').length, 2);
  } finally { gateway.close(); }
});
