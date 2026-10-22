import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createGateway } from '../src/gateway.mjs';
import { MediaSessions, relayMedia, transientRequest } from '../src/media.mjs';

const config = {
  origin: 'https://gateway.example.org', userAgent: 'PulseGateway/fixture (https://example.org)',
  clientId: 'fixture-client', clientSecret: 'fixture-secret', maxGlobalConcurrent: 8, maxIpConcurrent: 8,
  metadataPerMinute: 60, mediaPerMinute: 600, globalPerMinute: 6000,
};
const json = (value, status = 200, headers = {}) => ({ status, headers, bytes: Buffer.from(JSON.stringify(value)) });
const failure = status => json({ error: 'fixture-private https://cf-media.sndcdn.com/private?signature=fixture-secret' }, status);

async function get(gateway, path) {
  const response = new EventEmitter();
  response.headersSent = false;
  response.writeHead = (status, headers) => { response.status = status; response.headers = headers; response.headersSent = true; };
  response.end = bytes => { response.bytes = bytes; response.emit('finish'); };
  response.destroy = () => response.emit('close');
  await gateway.handler({ method: 'GET', url: path, headers: {}, socket: { remoteAddress: '198.51.100.44' } }, response);
  return response;
}

function apiFixture(statuses) {
  let exchanges = 0;
  const calls = [], waits = [];
  const gateway = createGateway(config, {
    delay: async milliseconds => waits.push(milliseconds),
    transport: { request: async (value, options) => {
      if (options.kind === 'token') { exchanges++; return json({ access_token: `access-${exchanges}`, expires_in: 3600 }); }
      calls.push({ url: new URL(value), options });
      const status = statuses.shift();
      assert.ok(status, 'Unexpected extra API request');
      return status === 200 ? json({ urn: 'soundcloud:tracks:123', title: 'fixture' }) : failure(status);
    } },
  });
  return { gateway, calls, waits, exchanges: () => exchanges };
}

test('API GET retries one transient response with the same token and canonical documented URN', async () => {
  const fixture = apiFixture([503, 200]);
  try {
    const response = await get(fixture.gateway, '/v1/soundcloud/tracks/123');
    assert.equal(response.status, 200);
    assert.equal(fixture.calls.length, 2);
    assert.deepEqual(fixture.waits, [500]);
    assert.equal(fixture.exchanges(), 1);
    for (const call of fixture.calls) {
      assert.equal(call.url.pathname, '/tracks/soundcloud:tracks:123');
      assert.equal(call.options.headers.authorization, 'OAuth access-1');
    }
  } finally { fixture.gateway.close(); }
});

test('persistent transient API failure stops after exactly two attempts and exposes only a safe error', async () => {
  for (const status of [500, 502, 503, 504]) {
    const fixture = apiFixture([status, status]);
    try {
      const response = await get(fixture.gateway, '/v1/soundcloud/tracks/soundcloud%3Atracks%3A123/streams');
      assert.equal(response.status, 502);
      assert.deepEqual(JSON.parse(response.bytes), { error: 'provider_unavailable' });
      assert.equal(fixture.calls.length, 2);
      assert.deepEqual(fixture.waits, [500]);
      assert.equal(fixture.exchanges(), 1);
      assert.doesNotMatch(response.bytes.toString(), /fixture-private|signature|sndcdn|access-1|fixture-secret/);
    } finally { fixture.gateway.close(); }
  }
});

test('quota, access and missing API responses never trigger a transient retry or token exchange', async () => {
  for (const [upstream, expected] of [[429, 429], [403, 503], [404, 404], [410, 404]]) {
    const fixture = apiFixture([upstream]);
    try {
      const response = await get(fixture.gateway, '/v1/soundcloud/tracks/123');
      assert.equal(response.status, expected);
      assert.equal(fixture.calls.length, 1);
      assert.deepEqual(fixture.waits, []);
      assert.equal(fixture.exchanges(), 1);
    } finally { fixture.gateway.close(); }
  }
});

test('authentication recovery retains its existing one-refresh limit and cannot replenish the transient budget', async () => {
  const fixture = apiFixture([500, 401, 503]);
  try {
    const response = await get(fixture.gateway, '/v1/soundcloud/tracks/123');
    assert.equal(response.status, 502);
    assert.equal(fixture.calls.length, 3);
    assert.equal(fixture.exchanges(), 2);
    assert.deepEqual(fixture.waits, [500]);
    assert.deepEqual(fixture.calls.map(call => call.options.headers.authorization), ['OAuth access-1', 'OAuth access-1', 'OAuth access-2']);
  } finally { fixture.gateway.close(); }
});

test('media transient retry shares one budget across redirects and does not send OAuth to CDN', async () => {
  const sessions = new MediaSessions(config.origin);
  const registered = sessions.create('fixture-ip', ['https://api.soundcloud.com/tracks/soundcloud:tracks:123/streams/fixture/hls']);
  const calls = [], waits = [], tokenArguments = [];
  const transport = { request: async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return failure(503);
    if (calls.length === 2) return { status: 302, headers: { location: 'https://cf-media.sndcdn.com/fixture.aac' }, bytes: Buffer.alloc(0) };
    assert.equal(calls.length, 3, 'Redirect must not replenish transient retry budget');
    assert.equal(options.headers.authorization, undefined);
    return failure(500);
  } };
  await assert.rejects(relayMedia({ transport, sessions, userAgent: config.userAgent,
    tokens: { get: async rejected => { tokenArguments.push(rejected); return 'fixture-access'; } },
    token: registered.token, index: 0, ip: 'fixture-ip', delay: async milliseconds => waits.push(milliseconds),
  }), error => error.code === 'provider_unavailable');
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [500]);
  assert.deepEqual(tokenArguments, [undefined]);
  assert.equal(calls[0].options.headers.authorization, calls[1].options.headers.authorization);
});

test('media returns a recovered segment after one retry without refreshing its token', async () => {
  const sessions = new MediaSessions(config.origin);
  const registered = sessions.create('fixture-ip', ['https://cf-media.sndcdn.com/fixture.aac']);
  let calls = 0;
  const result = await relayMedia({ sessions, userAgent: config.userAgent, token: registered.token, index: 0, ip: 'fixture-ip',
    tokens: { get: async () => assert.fail('CDN must not request a token') }, delay: async milliseconds => assert.equal(milliseconds, 500),
    transport: { request: async () => ++calls === 1 ? failure(502) : { status: 200, headers: { 'content-type': 'audio/aac' }, bytes: Buffer.from('fixture-audio') } },
  });
  assert.equal(result.bytes.toString(), 'fixture-audio');
  assert.equal(calls, 2);
});

test('media redirect cannot reset the operation deadline to make room for another attempt', async t => {
  let clock = 1000;
  t.mock.method(Date, 'now', () => clock);
  const sessions = new MediaSessions(config.origin);
  const registered = sessions.create('fixture-ip', ['https://cf-media.sndcdn.com/first.aac']);
  const timeouts = [];
  await assert.rejects(relayMedia({ sessions, userAgent: config.userAgent, token: registered.token, index: 0, ip: 'fixture-ip',
    tokens: { get: async () => assert.fail('CDN must not request a token') },
    delay: async () => assert.fail('The shared deadline leaves no time for a retry'),
    transport: { request: async (_url, options) => {
      timeouts.push(options.timeoutMs);
      if (timeouts.length === 1) {
        clock += 39600;
        return { status: 302, headers: { location: 'https://cf-media.sndcdn.com/second.aac' }, bytes: Buffer.alloc(0) };
      }
      return failure(503);
    } },
  }), error => error.code === 'provider_timeout');
  assert.deepEqual(timeouts, [30000, 400]);
});

test('shared deadline includes redirects, backoff and retry request timeouts', async t => {
  let clock = 1000;
  t.mock.method(Date, 'now', () => clock);
  const calls = [], waits = [];
  const transport = { request: async (_url, options) => { calls.push(options.timeoutMs); return calls.length === 1 ? failure(500) : json({ ok: true }); } };
  const budget = { used: false };
  await transientRequest(transport, 'https://api.soundcloud.com/tracks', {}, { deadline: 3000, requestTimeout: 20000, budget, delay: async ms => { waits.push(ms); clock += ms; } });
  assert.deepEqual(calls, [2000, 1500]);
  assert.deepEqual(waits, [500]);
  assert.equal(budget.used, true);
  const exhausted = { used: false };
  clock = 2800;
  await assert.rejects(transientRequest({ request: async () => failure(500) }, 'https://api.soundcloud.com/tracks', {}, { deadline: 3000, requestTimeout: 20000, budget: exhausted, delay: async () => assert.fail('No time for a backoff') }), error => error.code === 'provider_timeout');
});

test('network and validation exceptions are not retried or logged by the transient helper', async () => {
  let calls = 0;
  const exception = new Error('fixture-private URL and token');
  await assert.rejects(transientRequest({ request: async () => { calls++; throw exception; } }, 'https://api.soundcloud.com/tracks', {}, {
    deadline: Date.now() + 30000, requestTimeout: 20000, budget: { used: false }, delay: async () => assert.fail('Do not retry network exceptions'),
  }), error => error === exception);
  assert.equal(calls, 1);
});
