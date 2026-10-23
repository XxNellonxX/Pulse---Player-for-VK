import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createGateway } from '../src/gateway.mjs';
import { MediaByteCache } from '../src/media-cache.mjs';

const config = {
  origin: 'https://gateway.example.org', userAgent: 'PulseGateway/fixture (https://example.org)',
  clientId: 'fixture-client', clientSecret: 'fixture-secret', maxGlobalConcurrent: 16, maxIpConcurrent: 16,
  metadataPerMinute: 600, mediaPerMinute: 6000, globalPerMinute: 6000,
};
const ip = '198.51.100.44';
const path = value => new URL(value).pathname;
const segmentLines = bytes => bytes.toString().split('\n').filter(line => line && !line.startsWith('#'));

async function get(gateway, url, { address = ip, range, method = 'GET' } = {}) {
  const response = new EventEmitter();
  response.headersSent = false;
  response.writeHead = (status, headers) => { response.status = status; response.headers = headers; response.headersSent = true; };
  response.end = bytes => { response.bytes = bytes; response.emit('finish'); };
  response.destroy = () => response.emit('close');
  await gateway.handler({ method, url: url.startsWith('https:') ? path(url) : url, headers: range ? { range } : {}, socket: { remoteAddress: address } }, response);
  return response;
}

function fixture({ manifest = '#EXTM3U\nsegment.aac?signature=fixture\n', media, now = Date.now } = {}) {
  const calls = [];
  const gateway = createGateway(config, { now, delay: async () => {}, transport: { request: async (value, options) => {
    const url = new URL(value);
    calls.push({ url, range: options.headers.range });
    if (url.pathname.endsWith('master.m3u8')) return { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' }, bytes: Buffer.from(manifest) };
    return media ? media(url, options, calls) : { status: 200, headers: { 'content-type': 'audio/aac' }, bytes: Buffer.from('fixture-audio') };
  } } });
  const create = (address = ip) => gateway.sessions.create(address, ['https://cf-media.sndcdn.com/master.m3u8?signature=fixture']);
  return { gateway, calls, create };
}

test('handler reuses a segment only within its current authorized capability', async () => {
  const f = fixture();
  try {
    const session = f.create();
    const manifest = await get(f.gateway, session.urls[0]);
    const segment = segmentLines(manifest.bytes)[0];
    const first = await get(f.gateway, segment);
    const hit = await get(f.gateway, segment);
    assert.equal(first.status, 200);
    assert.deepEqual(hit.bytes, first.bytes);
    assert.equal(hit.headers['cache-control'], 'private, no-store');
    assert.equal(f.calls.length, 2, 'Repeated segment must not contact the provider');
    assert.equal(f.gateway.mediaCache.entries.size, 1);
    const denied = await get(f.gateway, segment, { address: '198.51.100.45' });
    assert.equal(denied.status, 410);
    assert.equal(f.calls.length, 2, 'Wrong client must be rejected before a cache lookup or provider call');
    const second = f.create();
    const secondManifest = await get(f.gateway, second.urls[0]);
    await get(f.gateway, segmentLines(secondManifest.bytes)[0]);
    assert.equal(f.calls.length, 4, 'A fresh stream capability must not reuse the previous capability cache');
  } finally { f.gateway.close(); }
  assert.equal(f.gateway.mediaCache.bytes, 0, 'Shutdown removes retained audio');
});

test('cached segment replay still consumes the existing per-client bandwidth budget', async () => {
  const payload = Buffer.alloc(6 * 1024 * 1024);
  const f = fixture({ media: () => ({ status: 200, headers: { 'content-type': 'audio/aac' }, bytes: payload }) });
  try {
    const session = f.create();
    const segment = segmentLines((await get(f.gateway, session.urls[0])).bytes)[0];
    for (let index = 0; index < 20; index++) assert.equal((await get(f.gateway, segment)).status, 200);
    assert.equal(f.calls.length, 2, 'Only the first segment request should contact the provider');
    const blocked = await get(f.gateway, segment);
    assert.equal(blocked.status, 429);
    assert.equal(JSON.parse(blocked.bytes).error, 'bandwidth_limited');
    assert.equal(f.calls.length, 2);
  } finally { f.gateway.close(); }
});

test('segments remain reusable past three minutes without extending the original media session', async () => {
  let now = 1000;
  const f = fixture({ now: () => now });
  try {
    const session = f.create();
    const segment = segmentLines((await get(f.gateway, session.urls[0])).bytes)[0];
    await get(f.gateway, segment);
    now += 180_000;
    await get(f.gateway, segment);
    assert.equal(f.calls.length, 2);
    now += 600_000;
    await get(f.gateway, segment);
    assert.equal(f.calls.length, 2, 'Repeat within the still-valid capability must retain cached bytes');
    assert.equal(f.gateway.sessions.get(session.token, 0, ip).session.expires, 901_000);
  } finally { f.gateway.close(); }
});

test('expired or evicted sessions return 410 even when their segment was cached', async () => {
  let now = 1000;
  const f = fixture({ now: () => now });
  try {
    const session = f.create();
    f.gateway.sessions.get(session.token, 0, ip).session.expires = now + 50;
    const segment = segmentLines((await get(f.gateway, session.urls[0])).bytes)[0];
    await get(f.gateway, segment);
    assert.equal(f.gateway.mediaCache.entries.size, 1);
    now += 50;
    assert.equal((await get(f.gateway, segment)).status, 410);
    assert.equal(f.calls.length, 2);
    assert.equal(f.gateway.mediaCache.bytes, 0);
    const replacement = f.create();
    const replacementSegment = segmentLines((await get(f.gateway, replacement.urls[0])).bytes)[0];
    await get(f.gateway, replacementSegment);
    for (let index = 0; index < 8; index++) f.create();
    assert.equal((await get(f.gateway, replacementSegment)).status, 410);
    assert.equal(f.gateway.mediaCache.bytes, 0, 'Registry eviction eagerly removes its cached bytes');
  } finally { f.gateway.close(); }
});

test('expiry during the upstream await cannot return or cache a segment', async () => {
  let now = 1000;
  const f = fixture({ now: () => now, media: async () => {
    now += 900_000;
    await new Promise(resolve => setImmediate(resolve));
    return { status: 200, headers: { 'content-type': 'audio/aac' }, bytes: Buffer.from('must-not-be-returned') };
  } });
  try {
    const session = f.create();
    const segment = segmentLines((await get(f.gateway, session.urls[0])).bytes)[0];
    const response = await get(f.gateway, segment);
    assert.equal(response.status, 410);
    assert.doesNotMatch(response.bytes.toString(), /must-not-be-returned/);
    assert.equal(f.gateway.mediaCache.bytes, 0);
  } finally { f.gateway.close(); }
});

test('exact signed URLs and Range responses cannot contaminate each other', async () => {
  const f = fixture({ manifest: '#EXTM3U\nsegment.aac?signature=one\nsegment.aac?signature=two\n', media: (url, options) => {
    const original = Buffer.from(url.searchParams.get('signature') === 'one' ? 'abcdefgh' : 'ABCDEFGH');
    if (!options.headers.range) return { status: 200, headers: { 'content-type': 'audio/aac' }, bytes: original };
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(options.headers.range);
    return { status: 206, headers: { 'content-type': 'audio/aac', 'content-range': `bytes ${start}-${end}/8` }, bytes: original.subarray(Number(start), Number(end) + 1) };
  } });
  try {
    const session = f.create();
    const [one, two] = segmentLines((await get(f.gateway, session.urls[0])).bytes);
    assert.equal((await get(f.gateway, one, { range: 'bytes=0-3' })).bytes.toString(), 'abcd');
    assert.equal((await get(f.gateway, one, { range: 'bytes=4-7' })).bytes.toString(), 'efgh');
    assert.equal((await get(f.gateway, two, { range: 'bytes=0-3' })).bytes.toString(), 'ABCD');
    const hit = await get(f.gateway, one, { range: 'bytes=0-3' });
    assert.equal(hit.headers['content-range'], 'bytes 0-3/8');
    assert.equal(hit.bytes.toString(), 'abcd');
    assert.equal(f.calls.length, 4);
    assert.equal((await get(f.gateway, one)).bytes.toString(), 'abcdefgh');
    assert.equal(f.calls.length, 5, 'A full GET must not reuse a partial response');
    assert.equal((await get(f.gateway, one, { range: 'bytes=0-1,4-5' })).status, 416);
    assert.equal(f.calls.length, 5);
  } finally { f.gateway.close(); }
});

test('manifests, keys, non-media responses and provider failures never enter the segment cache', async () => {
  let fail = true;
  const f = fixture({ manifest: '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="secret.aac"\nsecret.aac\n#EXT-X-MAP:URI="init.mp4"\nsegment.aac\nplain.bin\n', media: url => {
    if (url.pathname.endsWith('segment.aac') && fail) return { status: 503, headers: {}, bytes: Buffer.from('private upstream failure') };
    return { status: 200, headers: { 'content-type': url.pathname.endsWith('plain.bin') ? 'text/plain' : 'audio/aac' }, bytes: Buffer.from('fixture-media') };
  } });
  try {
    const session = f.create();
    const manifest = await get(f.gateway, session.urls[0]);
    await get(f.gateway, session.urls[0]);
    assert.equal(f.calls.length, 2, 'Manifests must be fetched and rewritten for the current capability');
    const [key, segment, plain] = segmentLines(manifest.bytes);
    await get(f.gateway, key); await get(f.gateway, key);
    assert.equal(f.calls.length, 4, 'A key is never cached, even if also referenced as a segment');
    await get(f.gateway, plain); await get(f.gateway, plain);
    assert.equal(f.calls.length, 6, 'Unknown non-media content must not be cached');
    assert.equal((await get(f.gateway, segment)).status, 502);
    assert.equal(f.gateway.mediaCache.entries.size, 0);
    fail = false;
    assert.equal((await get(f.gateway, segment)).status, 200);
    const calls = f.calls.length;
    await get(f.gateway, segment);
    assert.equal(f.calls.length, calls, 'A recovered successful segment can subsequently be reused');
    const map = /#EXT-X-MAP:URI="([^"]+)"/.exec(manifest.bytes.toString())[1];
    await get(f.gateway, map); await get(f.gateway, map);
    assert.equal(f.calls.length, calls + 1, 'Media initialization maps are reusable within the capability');
  } finally { f.gateway.close(); }
});

test('HEAD may read existing cached bytes but cannot populate the segment cache', async () => {
  const f = fixture();
  try {
    const session = f.create();
    const segment = segmentLines((await get(f.gateway, session.urls[0])).bytes)[0];
    const head = await get(f.gateway, segment, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.bytes.length, 0);
    assert.equal(head.headers['content-length'], '13');
    assert.equal(f.gateway.mediaCache.entries.size, 0);
    await get(f.gateway, segment);
    const calls = f.calls.length;
    const cached = await get(f.gateway, segment, { method: 'HEAD' });
    assert.equal(cached.bytes.length, 0);
    assert.equal(cached.headers['content-length'], '13');
    assert.equal(f.calls.length, calls);
  } finally { f.gateway.close(); }
});

test('fresh successful identical grants reuse the live capability without extending its original deadline', async () => {
  let now = 1000;
  let apiCalls = 0;
  let source = 'https://cf-media.sndcdn.com/master.m3u8?signature=one';
  let providerStatus = 200;
  const gateway = createGateway(config, { now: () => now, delay: async () => {}, transport: { request: async (value, options) => {
    if (options.kind === 'token') return { status: 200, headers: {}, bytes: Buffer.from(JSON.stringify({ access_token: 'fixture-access', expires_in: 3600 })) };
    apiCalls++;
    return { status: providerStatus, headers: {}, bytes: Buffer.from(JSON.stringify({ hls_aac_160_url: source, hls_mp3_128_url: source })) };
  } } });
  const streamPath = '/v1/soundcloud/tracks/123/streams';
  try {
    const first = JSON.parse((await get(gateway, streamPath)).bytes);
    assert.equal(first.expires_at, now + 900_000, 'The native client needs the actual gateway capability deadline');
    assert.equal(first.expires_in_ms, 900_000, 'Relative deadline avoids trusting the desktop wall clock');
    assert.equal(first.hls_aac_160_url, first.hls_mp3_128_url, 'Identical provider URLs share their registry index');
    const token = /\/media\/([a-f0-9]{48})\//.exec(first.hls_aac_160_url)[1];
    const deadline = gateway.sessions.get(token, 0, ip).session.expires;
    now += 600_000;
    const second = JSON.parse((await get(gateway, streamPath)).bytes);
    assert.deepEqual(second, { ...first, expires_in_ms: 300_000 });
    assert.equal(second.expires_at, deadline, 'The deadline metadata is not refreshed by reuse');
    assert.equal(apiCalls, 2, 'Reuse must still require a fresh successful provider grant');
    assert.equal(gateway.sessions.get(token, 0, ip).session.expires, deadline, 'Replay cannot prolong the old capability');
    assert.notDeepEqual(JSON.parse((await get(gateway, streamPath, { address: '198.51.100.45' })).bytes), first, 'Another IP must get another capability');
    assert.notDeepEqual(JSON.parse((await get(gateway, '/v1/soundcloud/tracks/456/streams')).bytes), first, 'Different tracks cannot share a capability even with equal provider URLs');
    providerStatus = 403;
    const failed = await get(gateway, streamPath);
    assert.equal(failed.status, 503);
    assert.doesNotMatch(failed.bytes.toString(), new RegExp(token), 'A failed fresh grant cannot be replaced by a cached grant');
    providerStatus = 200;
    source = 'https://cf-media.sndcdn.com/master.m3u8?signature=two';
    assert.notDeepEqual(JSON.parse((await get(gateway, streamPath)).bytes), first, 'Changed signatures require a new capability');
    source = 'https://cf-media.sndcdn.com/master.m3u8?signature=one';
    now = deadline - 59_000;
    const renewed = JSON.parse((await get(gateway, streamPath)).bytes);
    assert.notDeepEqual(renewed, first, 'A nearly expired grant must be replaced instead of causing immediate renewal loops');
    assert.equal(renewed.expires_at, now + 900_000);
    now = deadline;
    assert.notDeepEqual(JSON.parse((await get(gateway, streamPath)).bytes), first, 'Expired capabilities cannot be revived by another successful grant');
  } finally { gateway.close(); }
});

test('LRU cache bounds include key overhead, cap entries and bytes, and reject oversized values', () => {
  let now = 0;
  const cache = new MediaByteCache({ maxEntries: 2, maxBytes: 1300, ttlMs: 100, now: () => now });
  const value = bytes => ({ status: 200, headers: {}, bytes: Buffer.alloc(bytes) });
  cache.set('one', 'session-one', value(100), 1000);
  cache.set('two', 'session-two', value(100), 1000);
  assert.equal(cache.entries.size, 2);
  cache.get('one');
  cache.set('three', 'session-three', value(100), 1000);
  assert.equal(cache.get('two'), undefined);
  assert.ok(cache.bytes <= 1300);
  cache.set('oversized', 'session-one', value(1300), 1000);
  assert.equal(cache.get('oversized'), undefined);
  cache.deleteSession('session-one');
  assert.equal(cache.get('one'), undefined);
  now = 100;
  cache.prune();
  assert.equal(cache.entries.size, 0);
  assert.equal(cache.bytes, 0);
});

test('concurrent handler completions cannot grow the media cache beyond its 64 MiB budget', async () => {
  const payload = Buffer.alloc(5_500_000);
  const f = fixture({ manifest: `#EXTM3U\n${Array.from({ length: 13 }, (_, index) => `segment-${index}.aac`).join('\n')}\n`, media: async () => {
    await new Promise(resolve => setImmediate(resolve));
    return { status: 200, headers: { 'content-type': 'audio/aac' }, bytes: payload };
  } });
  try {
    const session = f.create();
    const segments = segmentLines((await get(f.gateway, session.urls[0])).bytes);
    const responses = await Promise.all(segments.map(segment => get(f.gateway, segment)));
    assert.ok(responses.every(response => response.status === 200));
    assert.ok(f.gateway.mediaCache.bytes <= 64 * 1024 * 1024);
    assert.ok(f.gateway.mediaCache.entries.size < 13, 'Concurrent inserts must evict before exceeding byte budget');
    assert.ok(f.gateway.mediaCache.entries.size <= 128);
    assert.equal(f.calls.length, 14);
    await get(f.gateway, segments[0]);
    assert.equal(f.calls.length, 15, 'An evicted segment must be fetched again');
  } finally { f.gateway.close(); }
});
