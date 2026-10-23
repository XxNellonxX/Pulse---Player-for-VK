// Independent user-flow regression against an actual HTTP listener. Upstream
// audio, OAuth and time are synthetic; no credentials, disk cache or network.
import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createServer } from '../services/pulse-gateway/src/gateway.mjs';

const origin = 'https://gateway.example.org';
const config = { origin, clientId: 'fixture-client', clientSecret: 'fixture-secret', userAgent: 'IndependentCacheQA/1.0 (qa@example.org)', trustLoopbackProxy: true, maxGlobalConcurrent: 16, maxIpConcurrent: 6, metadataPerMinute: 600, mediaPerMinute: 6000, globalPerMinute: 6000 };
const grant = 'https://cf-media.sndcdn.com/qa/master.m3u8?signature=fixture';
const audio = Buffer.alloc(512, 7);
const defaultManifest = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:10,\nsegment.aac\n#EXT-X-ENDLIST\n';
const segment = manifest => manifest.split('\n').find(line => line && !line.startsWith('#'));
const key = manifest => /URI="([^"]+)"/.exec(manifest)?.[1];

async function fixture() {
  const state = { now: Date.UTC(2026, 9, 23), manifest: defaultManifest, streamStatus: 200, mediaStatus: 200, calls: [], beforeMedia: null };
  const json = (value, url, status = 200) => ({ status, bytes: Buffer.from(JSON.stringify(value)), headers: { 'content-type': 'application/json' }, finalUrl: String(url) });
  const transport = { close() {}, async request(value, options) {
    const url = new URL(value); state.calls.push({ kind: options.kind, path: url.pathname, range: options.headers.range });
    if (options.kind === 'token') return json({ access_token: 'fixture-token', expires_in: 3600 }, url);
    if (options.kind === 'api' && url.pathname.endsWith('/streams')) return json({ hls_aac_160_url: grant }, url, state.streamStatus);
    if (options.kind !== 'media') throw Error('Unexpected fixture target');
    if (state.beforeMedia) await state.beforeMedia(url, options);
    if (url.pathname.endsWith('master.m3u8')) return { status: 200, bytes: Buffer.from(state.manifest), headers: { 'content-type': 'application/vnd.apple.mpegurl' }, finalUrl: url.href };
    if (state.mediaStatus !== 200) return json({ error: 'fixture_failure' }, url, state.mediaStatus);
    let bytes = audio, status = 200, headers = { 'content-type': 'application/octet-stream' };
    if (url.pathname.endsWith('key.bin')) bytes = Buffer.alloc(16, 1);
    if (options.headers.range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(options.headers.range);
      const start = Number(match[1]), end = match[2] ? Number(match[2]) : bytes.length - 1;
      status = 206; headers['content-range'] = `bytes ${start}-${end}/${bytes.length}`; bytes = bytes.subarray(start, end + 1);
    }
    return { status, bytes, headers, finalUrl: url.href };
  } };
  const server = createServer(config, { transport, now: () => state.now, delay: async () => {} });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (value, options = {}) => {
    const url = new URL(value, origin);
    assert.equal(url.origin, origin, 'Fixture target changed origin');
    return fetch(base + url.pathname + url.search, { ...options, headers: { 'x-forwarded-for': '8.8.8.8', ...options.headers } });
  };
  const mediaCalls = () => state.calls.filter(call => call.kind === 'media').length;
  const streams = async (id = '123', options) => {
    const response = await get(`/v1/soundcloud/tracks/${id}/streams`, options);
    assert.equal(response.status, 200);
    return response.json();
  };
  const start = async () => {
    const value = await streams();
    const response = await get(value.hls_aac_160_url); assert.equal(response.status, 200);
    return { value, manifest: await response.text() };
  };
  return { state, get, streams, start, mediaCalls, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

async function withFixture(action) { const f = await fixture(); try { await action(f); } finally { await f.close(); } }

test('real HTTP repeated playback reuses exact segment bytes while fresh grants and manifest still contact providers', async () => withFixture(async f => {
  const first = await f.start();
  const url = segment(first.manifest);
  for (let i = 0; i < 2; i++) { const response = await f.get(url); assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), audio); }
  assert.equal(f.mediaCalls(), 2, 'Second segment read contacted the upstream');
  f.state.now += 30_000;
  const repeat = await f.start();
  assert.equal(repeat.value.hls_aac_160_url, first.value.hls_aac_160_url, 'An identical fresh authorized grant lost the valid short-term replay cache');
  assert.equal(repeat.value.expires_at, first.value.expires_at, 'Replaying extended the original capability deadline');
  assert.equal(repeat.value.expires_in_ms, first.value.expires_in_ms - 30_000, 'Relative expiry must describe the original server capability, not reset on each grant');
  const response = await f.get(segment(repeat.manifest)); assert.equal(response.status, 200); await response.arrayBuffer();
  assert.equal(f.mediaCalls(), 3, 'Repeat should fetch only a new manifest, not cached audio');
  assert.equal(f.state.calls.filter(call => call.kind === 'api').length, 2, 'The server replaced a fresh grant with stale authorization');
}));

test('cached media never crosses client IP, track identity, exact byte Range or capability expiry', async () => withFixture(async f => {
  const first = await f.start(), url = segment(first.manifest);
  const bounded = await f.get(url, { headers: { range: 'bytes=0-255' } }); assert.equal(bounded.status, 206); assert.equal((await bounded.arrayBuffer()).byteLength, 256);
  let response = await f.get(url, { headers: { range: 'bytes=0-255' } }); assert.equal(response.status, 206); await response.arrayBuffer(); assert.equal(f.mediaCalls(), 2);
  response = await f.get(url, { headers: { range: 'bytes=256-511' } }); assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), 'bytes 256-511/512'); await response.arrayBuffer(); assert.equal(f.mediaCalls(), 3);
  response = await f.get(url); assert.equal(response.status, 200); assert.equal((await response.arrayBuffer()).byteLength, 512); assert.equal(f.mediaCalls(), 4);
  response = await f.get(url, { headers: { 'x-forwarded-for': '9.9.9.9' } }); assert.equal(response.status, 410); await response.arrayBuffer(); assert.equal(f.mediaCalls(), 4);
  const secondTrack = await f.streams('456'); assert.notEqual(secondTrack.hls_aac_160_url, first.value.hls_aac_160_url);
  assert.equal(first.value.expires_at, f.state.now + 15 * 60_000, 'The client cannot safely bound native reuse without the exact server deadline');
  assert.equal(first.value.expires_in_ms, 15 * 60_000, 'Relative TTL must allow a clock-independent native bound');
  f.state.now = first.value.expires_at;
  response = await f.get(url); assert.equal(response.status, 410); await response.arrayBuffer(); assert.equal(f.mediaCalls(), 4);
}));

test('HEAD cannot warm a segment cache, encryption keys and manifests stay uncached', async () => withFixture(async f => {
  const { value, manifest } = await f.start(), url = segment(manifest), keyUrl = key(manifest);
  let response = await f.get(url, { method: 'HEAD' }); assert.equal(response.status, 200); assert.equal((await response.arrayBuffer()).byteLength, 0);
  response = await f.get(url); assert.equal(response.status, 200); await response.arrayBuffer(); assert.equal(f.mediaCalls(), 3);
  response = await f.get(url, { method: 'HEAD' }); assert.equal(response.status, 200); await response.arrayBuffer(); assert.equal(f.mediaCalls(), 3, 'HEAD may reuse an existing authorized segment');
  for (let i = 0; i < 2; i++) { response = await f.get(keyUrl); assert.equal(response.status, 200); assert.equal((await response.arrayBuffer()).byteLength, 16); }
  assert.equal(f.mediaCalls(), 5, 'A key was retained as audio');
  response = await f.get(value.hls_aac_160_url); assert.equal(response.status, 200); await response.arrayBuffer(); assert.equal(f.mediaCalls(), 6, 'A manifest was retained as audio');
}));

test('a segment reclassified as a key stops using earlier cached bytes even when that key is larger than AES-128', async () => withFixture(async f => {
  const { value, manifest } = await f.start(), url = segment(manifest);
  let response = await f.get(url); assert.equal(response.status, 200); await response.arrayBuffer();
  f.state.manifest = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="segment.aac"\n#EXTINF:10,\nother.aac\n';
  response = await f.get(value.hls_aac_160_url); assert.equal(response.status, 200); const updated = await response.text(); assert.equal(key(updated), url);
  for (let i = 0; i < 2; i++) { response = await f.get(key(updated)); assert.equal(response.status, 200); assert.equal((await response.arrayBuffer()).byteLength, audio.length); }
  assert.equal(f.mediaCalls(), 5, 'A resource promoted to encryption key inherited cached segment bytes');
}));

test('expiry during an actual in-flight segment rejects the completion and cannot resurrect its cache entry', async () => withFixture(async f => {
  const { value, manifest } = await f.start();
  let finish;
  const blocked = new Promise(resolve => { finish = resolve; });
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  f.state.beforeMedia = async url => { if (url.pathname.endsWith('segment.aac')) { started(); await blocked; } };
  const pending = f.get(segment(manifest));
  await entered; f.state.now = value.expires_at; finish();
  const response = await pending; assert.equal(response.status, 410); await response.arrayBuffer();
  f.state.beforeMedia = null;
  const retry = await f.get(segment(manifest)); assert.equal(retry.status, 410); await retry.arrayBuffer(); assert.equal(f.mediaCalls(), 2);
}));

test('cached audio cannot replace a newly denied grant and transient errors never become successful media cache entries', async () => withFixture(async f => {
  const { manifest } = await f.start(), url = segment(manifest);
  let response = await f.get(url); assert.equal(response.status, 200); await response.arrayBuffer();
  f.state.streamStatus = 403;
  response = await f.get('/v1/soundcloud/tracks/123/streams'); assert.equal(response.status, 503); const denied = await response.json(); assert.equal(typeof denied.error, 'string'); assert.equal(denied.hls_aac_160_url, undefined);
  // A different range is a miss; two transient attempts still cannot poison it.
  f.state.mediaStatus = 503;
  response = await f.get(url, { headers: { range: 'bytes=0-255' } }); assert.equal(response.status, 502); await response.arrayBuffer(); const failedCalls = f.mediaCalls();
  f.state.mediaStatus = 200;
  response = await f.get(url, { headers: { range: 'bytes=0-255' } }); assert.equal(response.status, 206); await response.arrayBuffer(); assert.equal(f.mediaCalls(), failedCalls + 1);
}));
