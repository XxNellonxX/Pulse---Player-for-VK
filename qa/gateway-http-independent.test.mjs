// Actual gateway HTTP listener, synthetic SoundCloud/MusicBrainz transport only.
// No Docker, real provider credentials, DNS, outbound connections or OS profile.
import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createServer } from '../services/pulse-gateway/src/gateway.mjs';

const config = {
  origin: 'https://gateway.example.org', clientId: 'independent-fixture-client', clientSecret: 'independent-fixture-secret',
  userAgent: 'IndependentFixture/1.0 (fixture@example.org)', trustLoopbackProxy: true,
  maxGlobalConcurrent: 16, maxIpConcurrent: 6, metadataPerMinute: 60, mediaPerMinute: 600, globalPerMinute: 6000,
};
const secrets = [config.clientSecret, 'fixture-oauth-private', 'fixture-refresh-private', 'private-signed-policy'];
const artistId = '12345678-1234-1234-1234-123456789abc';
const grant = 'https://cf-media.sndcdn.com/base/manifest.m3u8?Policy=private-signed-policy';
const json = (value, url, status = 200, headers = {}) => ({ status, headers: { 'content-type': 'application/json', ...headers }, bytes: Buffer.from(JSON.stringify(value)), finalUrl: String(url) });

async function fixture(patch = {}) {
  const state = { now: Date.UTC(2026, 9, 22), calls: [], mode: '', media: undefined };
  const transport = { close() {}, async request(value, options) {
    const url = new URL(value); state.calls.push({ url: url.href, ...options });
    if (state.mode === 'throw') throw Error('private-signed-policy fixture-oauth-private');
    if (options.kind === 'token') return json({ access_token: secrets[1], refresh_token: secrets[2], expires_in: 3600 }, url);
    if (options.kind === 'musicbrainz') return json(url.pathname.includes('release-group') ? { 'release-group-count': 1, 'release-group-offset': 0, 'release-groups': [{ id: artistId, title: 'Fixture release' }] } : { artists: [{ id: artistId, name: 'Fixture artist' }], count: 1, offset: 0 }, url);
    if (options.kind === 'api') {
      if (state.mode === 'forbidden') return json({ error: secrets[1] }, url, 403);
      if (url.pathname.endsWith('/streams')) return json({ hls_aac_160_url: grant }, url);
      if (url.pathname === '/tracks') return json({ collection: [{ id: 123, urn: 'soundcloud:tracks:123', title: 'Fixture song', user: { username: 'Fixture artist' }, duration: 180000, streamable: true, access: 'playable' }], next_href: 'https://api.soundcloud.com/tracks?q=Fixture&limit=1&cursor=next&linked_partitioning=true&access=playable' }, url);
      return json({ id: 123, urn: 'soundcloud:tracks:123', title: 'Fixture song', user: { username: 'Fixture artist' }, duration: 180000, streamable: true, access: 'playable' }, url);
    }
    if (options.kind === 'media') {
      if (state.media) return typeof state.media === 'function' ? state.media(url, options) : { ...state.media, finalUrl: url.href };
      return { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' }, finalUrl: url.href, bytes: Buffer.from('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin?Policy=private-signed-policy"\n#EXT-X-MAP:URI="init.mp4?Policy=private-signed-policy"\n#EXTINF:10,\nsegment.ts?Policy=private-signed-policy\n') };
    }
    throw Error('Unexpected fixture provider');
  } };
  const server = createServer({ ...config, ...patch }, { transport, now: () => state.now, delay: async () => {} });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const fetchLocal = (url, options) => fetch(new URL(url.startsWith('https://') ? new URL(url).pathname + new URL(url).search : url, base), options);
  return { state, server, request: fetchLocal, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

async function withFixture(task, patch) { const f = await fixture(patch); try { await task(f); } finally { await f.close(); } }
async function body(response) { const text = await response.text(); for (const secret of secrets) assert.equal(text.includes(secret), false, 'HTTP response exposed a private provider value'); return text; }
async function mediaUrl(f) { const response = await f.request('/v1/soundcloud/tracks/123/streams'); assert.equal(response.status, 200); return Object.values(JSON.parse(await body(response)))[0]; }

test('health endpoints are configuration status only and never query or disclose providers', async () => withFixture(async f => {
  assert.deepEqual(JSON.parse(await body(await f.request('/healthz'))), { status: 'ok' });
  assert.deepEqual(JSON.parse(await body(await f.request('/readyz'))), { status: 'configured', providersVerified: false });
  assert.equal(f.state.calls.length, 0);
}));

test('public HTTP routes reject fetch abuse, duplicate or unknown query fields and unsupported methods before contacting providers', async () => withFixture(async f => {
  for (const url of [
    '/v1/soundcloud/tracks?q=a&q=b', '/v1/soundcloud/tracks?q=a&url=https://127.0.0.1',
    '/v1/soundcloud/tracks?q=a&access_token=private', '/v1/soundcloud/tracks/1/streams?url=https://evil.example',
    '/v1/soundcloud/resolve?url=https://127.0.0.1/private', '/v1/soundcloud/resolve?url=https://soundcloud.com/a/b?secret_token=private',
    '/v1/musicbrainz/search?query=x&proxy=https://evil.example', '/v1/musicbrainz/artist/not-a-uuid',
    '/v1/musicbrainz/artist/' + artistId + '?url=https://127.0.0.1', '/readyz?probe=all',
  ]) { const response = await f.request(url); assert.ok(response.status >= 400 && response.status < 500); await body(response); }
  const response = await f.request('/v1/soundcloud/tracks?q=Fixture', { method: 'POST', body: 'private' });
  assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'GET, HEAD'); await body(response);
  assert.equal(f.state.calls.length, 0);
}));

test('same concurrent metadata request coalesces OAuth and upstream request while rewriting pagination to the gateway', async () => withFixture(async f => {
  const responses = await Promise.all(Array.from({ length: 5 }, () => f.request('/v1/soundcloud/tracks?q=Fixture&limit=1')));
  for (const response of responses) {
    assert.equal(response.status, 200); const value = JSON.parse(await body(response));
    assert.equal(value.collection[0].title, 'Fixture song'); assert.ok(value.next_href.startsWith(config.origin + '/v1/soundcloud/tracks?'));
  }
  assert.equal(f.state.calls.filter(call => call.kind === 'token').length, 1);
  assert.equal(f.state.calls.filter(call => call.kind === 'api').length, 1);
  await body(await f.request('/v1/soundcloud/tracks?q=Fixture&limit=1'));
  assert.equal(f.state.calls.filter(call => call.kind === 'api').length, 1);
}));

test('MusicBrainz endpoint constructs provider-only URLs and caches identical metadata', async () => withFixture(async f => {
  for (let i = 0; i < 2; i++) { const response = await f.request('/v1/musicbrainz/search?query=Fixture'); assert.equal(response.status, 200); await body(response); }
  assert.equal(f.state.calls.length, 1);
  const url = new URL(f.state.calls[0].url); assert.equal(url.origin, 'https://musicbrainz.org'); assert.equal(url.pathname, '/ws/2/artist');
  assert.equal(url.searchParams.get('offset'), '0'); assert.equal(f.state.calls[0].kind, 'musicbrainz');
}));

test('gateway preserves the exact native Lucene search expression and accepts the shared SoundCloud query limit', async () => withFixture(async f => {
  const query = 'artist:"Кишлак & Kendrick \\"Lamar\\""';
  const response = await f.request('/v1/musicbrainz/search?' + new URLSearchParams({ query, offset: '20' }));
  assert.equal(response.status, 200); await body(response);
  const upstream = new URL(f.state.calls.find(call => call.kind === 'musicbrainz').url);
  assert.equal(upstream.searchParams.get('query'), query); assert.equal(upstream.searchParams.get('offset'), '20');
  const soundCloud = await f.request('/v1/soundcloud/tracks?' + new URLSearchParams({ q: 'a'.repeat(300) }));
  assert.equal(soundCloud.status, 200, 'A valid native SoundCloud query was rejected in managed mode'); await body(soundCloud);
}));

test('stream grant and HLS keys, maps and segments expose gateway capabilities only', async () => withFixture(async f => {
  const url = await mediaUrl(f); assert.match(url, /^https:\/\/gateway\.example\.org\/v1\/media\/[a-f0-9]{48}\/0$/);
  const response = await f.request(url); assert.equal(response.status, 200);
  const manifest = await body(response); assert.ok(manifest.startsWith('#EXTM3U')); assert.equal(manifest.includes('sndcdn.com'), false);
  assert.equal((manifest.match(/https:\/\/gateway\.example\.org\/v1\/media\//g) || []).length, 3);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const tokenCall = f.state.calls.find(call => call.kind === 'token'), apiCall = f.state.calls.find(call => call.kind === 'api'), mediaCall = f.state.calls.find(call => call.kind === 'media');
  assert.ok(tokenCall.headers.authorization.startsWith('Basic ')); assert.equal(apiCall.headers.authorization, 'OAuth ' + secrets[1]);
  assert.equal(mediaCall.headers.authorization, undefined, 'The CDN received the server API credential');
}));

test('an HLS steering URI in the first tag attribute cannot bypass rewriting', async () => withFixture(async f => {
  const url = await mediaUrl(f);
  f.state.media = { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' }, bytes: Buffer.from('#EXTM3U\n#EXT-X-CONTENT-STEERING:SERVER-URI="https://evil.example/steer?Policy=private-signed-policy",PATHWAY-ID="a"\n#EXTINF:10,\nsegment.ts\n') };
  const response = await f.request(url);
  assert.equal(response.status, 502, 'HLS steering target escaped the private relay'); await body(response);
}));

test('capabilities are bound to an IP, expire, and reject malformed ranges without a provider request', async () => withFixture(async f => {
  const url = await mediaUrl(f), calls = f.state.calls.length;
  assert.equal((await f.request(url, { headers: { 'x-forwarded-for': '8.8.8.8' } })).status, 410);
  assert.equal((await f.request(url, { headers: { range: 'bytes=1-0' } })).status, 416);
  assert.equal(f.state.calls.length, calls);
  f.state.now += 15 * 60_000;
  assert.equal((await f.request(url)).status, 410); assert.equal(f.state.calls.length, calls);
}));

test('provider JSON redirect cannot send a media request to an arbitrary/private destination', async () => withFixture(async f => {
  const url = await mediaUrl(f), calls = f.state.calls.length;
  f.state.media = json({ url: 'https://127.0.0.1/private?token=private-signed-policy' }, grant);
  const response = await f.request(url); assert.equal(response.status, 502); await body(response);
  assert.equal(f.state.calls.length, calls + 1);
}));

test('a lying Content-Range cannot fabricate a playable partial audio response', async () => withFixture(async f => {
  const url = await mediaUrl(f);
  f.state.media = { status: 206, headers: { 'content-type': 'audio/mpeg', 'content-range': 'bytes 0-9999/10000' }, bytes: Buffer.from('fake') };
  const response = await f.request(url, { headers: { range: 'bytes=0-3' } });
  assert.equal(response.status, 502, 'Malformed partial content was forwarded as valid audio'); await body(response);
}));

test('server restart discards session capabilities and rehydrates metadata using a new provider request', async () => {
  let oldUrl;
  await withFixture(async f => { await body(await f.request('/v1/soundcloud/tracks?q=Fixture')); oldUrl = await mediaUrl(f); });
  await withFixture(async f => {
    assert.equal((await f.request(oldUrl)).status, 410);
    assert.equal(f.state.calls.length, 0);
    assert.equal((await f.request('/v1/soundcloud/tracks?q=Fixture')).status, 200);
    assert.equal(f.state.calls.filter(call => call.kind === 'api').length, 1);
  });
});

test('provider errors cannot reflect access token, keys, URLs or stack traces', async () => withFixture(async f => {
  f.state.mode = 'throw';
  const response = await f.request('/v1/soundcloud/tracks?q=Fixture'); assert.equal(response.status, 503);
  const result = JSON.parse(await body(response)); assert.deepEqual(Object.keys(result), ['error']);
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.ok(Number(response.headers.get('retry-after')) > 0);
}));

test('per-client metadata quota is bounded and gives an explicit retry interval', async () => withFixture(async f => {
  assert.equal((await f.request('/v1/soundcloud/tracks?q=Fixture')).status, 200);
  const response = await f.request('/v1/soundcloud/tracks?q=Fixture'); assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get('retry-after')) > 0); await body(response);
}, { metadataPerMinute: 1 }));
