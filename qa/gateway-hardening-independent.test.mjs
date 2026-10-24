// Local defensive regression tests. Every provider response is a fixture;
// these checks never contact a VPS, real DNS or a music-service account.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createServer } from '../services/pulse-gateway/src/gateway.mjs';
import { AbuseLimits } from '../services/pulse-gateway/src/limits.mjs';
import { clientIp, isPublicAddress, rateLimitKey } from '../services/pulse-gateway/src/security.mjs';

const config = {
  origin: 'https://gateway.example.org', userAgent: 'PulseGateway/fixture (https://example.org)',
  clientId: 'fixture-client', clientSecret: 'fixture-private', trustLoopbackProxy: true,
  maxGlobalConcurrent: 16, maxIpConcurrent: 6, metadataPerMinute: 60,
  mediaPerMinute: 600, globalPerMinute: 6000,
};
const json = value => ({ status: 200, headers: {}, bytes: Buffer.from(JSON.stringify(value)) });

async function fixture(task, patch = {}) {
  const calls = [];
  const transport = { request: async (value, options) => {
    calls.push({ url: String(value), kind: options.kind });
    if (options.kind === 'token') return json({ access_token: 'fixture-access', expires_in: 3600 });
    if (options.kind === 'media') return { status: 200, headers: { 'content-type': 'audio/aac' }, bytes: Buffer.from('fixture-audio') };
    if (String(value).endsWith('/streams')) return json({ hls_aac_160_url: 'https://cf-media.sndcdn.com/fixture.aac' });
    return json({ collection: [] });
  } };
  const server = createServer({ ...config, ...patch }, { transport });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, options) => fetch(new URL(path.startsWith('https:') ? new URL(path).pathname : path, base), options);
  try { await task({ request, calls }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('foreign web pages cannot spend provider quota with blind GET requests', async () => fixture(async ({ request, calls }) => {
  for (const headers of [
    { origin: 'https://untrusted.example' }, { origin: 'null' },
    { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' },
    { origin: config.origin, 'sec-fetch-site': 'cross-site' },
    { origin: config.origin + '.untrusted.example' },
  ]) {
    const response = await request('/v1/soundcloud/tracks?q=fixture', { headers });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'browser_origin_not_allowed' });
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  assert.equal(calls.length, 0);
  const native = await request('/v1/soundcloud/tracks?q=fixture');
  assert.equal(native.status, 200, 'rejected browser traffic must not consume the native quota');
  await native.arrayBuffer();
  assert.equal(calls.length, 2);
}, { metadataPerMinute: 1 }));

test('native 0.5.1 requests and explicit same-origin diagnostics retain their response contract', async () => fixture(async ({ request }) => {
  for (const headers of [{}, { origin: config.origin, 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'none' }]) {
    const response = await request('/v1/soundcloud/tracks?q=fixture', { headers });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { collection: [] });
  }
  const head = await request('/healthz', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
}));

test('health, metadata, media and errors suppress active documents and capability referrers', async () => fixture(async ({ request }) => {
  const grant = await request('/v1/soundcloud/tracks/123/streams');
  const { hls_aac_160_url: media } = await grant.json();
  for (const path of ['/healthz', '/readyz', '/v1/soundcloud/tracks?q=fixture', media, '/not-found']) {
    const response = await request(path);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'; sandbox/);
    assert.match(response.headers.get('cache-control'), /no-store/);
    if (path === media) {
      assert.equal(response.headers.get('content-type'), 'audio/aac');
      assert.equal(await response.text(), 'fixture-audio', 'security headers must not replace or modify media bytes');
    } else await response.arrayBuffer();
  }
}));

test('IPv6 address rotation and equivalent textual forms share one subnet quota', () => {
  const limits = new AbuseLimits({ ...config, metadataPerMinute: 1 });
  limits.acquire('2606:4700:1234:abcd::1').release();
  assert.throws(() => limits.acquire('2606:4700:1234:ABCD:1111:2222:3333:4444'), /rate_limited/);
  assert.throws(() => limits.acquire('2606:4700:1234:abcd:0:0:0:1'), /rate_limited/);
  limits.acquire('2606:4700:1234:abce::1').release();
  assert.equal(limits.clients.size, 2);
  assert.equal(rateLimitKey('::ffff:8.8.8.8'), rateLimitKey('8.8.8.8'));
  assert.equal(rateLimitKey('::ffff:808:808'), rateLimitKey('8.8.8.8'));
});

test('an IPv6 neighbor sharing the quota cannot use another clients actual HTTP media capability', async () => fixture(async ({ request, calls }) => {
  const grant = await request('/v1/soundcloud/tracks/123/streams', { headers: { 'x-forwarded-for': '2606:4700:1234:abcd::1' } });
  assert.equal(grant.status, 200);
  const { hls_aac_160_url: media } = await grant.json();
  const previous = calls.length;
  const neighbor = await request(media, { headers: { 'x-forwarded-for': '2606:4700:1234:abcd::2' } });
  assert.equal(neighbor.status, 410);
  await neighbor.arrayBuffer();
  assert.equal(calls.length, previous, 'unauthorized neighbor must not reach a provider');
  const equivalent = await request(media, { headers: { 'x-forwarded-for': '2606:4700:1234:ABCD:0000:0000:0000:0001' } });
  assert.equal(equivalent.status, 200);
  assert.equal(await equivalent.text(), 'fixture-audio');
}));

test('exact IP binding remains distinct from subnet quota and forwarding is trusted only on loopback', () => {
  const request = (remoteAddress, forwarded) => ({ socket: { remoteAddress }, headers: { 'x-forwarded-for': forwarded } });
  const first = clientIp(request('::ffff:127.0.0.1', '2606:4700:1234:abcd::1'), true);
  const second = clientIp(request('::1', '2606:4700:1234:abcd::2'), true);
  assert.notEqual(first, second, 'subnet grouping must not let neighboring clients use a media capability');
  assert.equal(rateLimitKey(first), rateLimitKey(second));
  assert.equal(clientIp(request('8.8.8.8', '1.1.1.1'), true), '8.8.8.8');
  assert.equal(clientIp(request('::1', '8.8.8.8, 1.1.1.1'), true), '0:0:0:0:0:0:0:1');
  assert.equal(clientIp(request('::1', '::ffff:808:808'), true), '8.8.8.8');
  for (const address of ['fe80::1%eth0', '2001:4860:4860::8888%eth0']) assert.equal(isPublicAddress(address), false);
});
