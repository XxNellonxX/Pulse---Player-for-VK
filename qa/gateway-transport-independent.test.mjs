// Real gateway transport with a synthetic HTTPS connection and DNS answers.
// No network sockets, actual TLS credentials or real DNS requests.
import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createTransport } from '../services/pulse-gateway/src/transport.mjs';

function connection({ responseHeaders = {}, chunks = [Buffer.from('fixture bytes')], onLookup } = {}) {
  const calls = [];
  const request = (url, options, callback) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => queueMicrotask(async () => {
      calls.push({ url: String(url), options });
      if (onLookup) await onLookup(url, options);
      const response = new PassThrough();
      response.statusCode = 200;
      response.headers = responseHeaders;
      callback(response);
      for (const chunk of chunks) if (!response.destroyed) response.write(chunk);
      response.end();
    });
    return req;
  };
  return { request, calls };
}

test('one private address among public DNS results prevents the entire outbound connection', async () => {
  for (const addresses of [
    [{ address: '127.0.0.1', family: 4 }],
    [{ address: '8.8.8.8', family: 4 }, { address: '169.254.169.254', family: 4 }],
    [{ address: '2001::1', family: 6 }],
    [{ address: '2001:4860:4860::8888', family: 6 }, { address: '::ffff:127.0.0.1', family: 6 }],
    [],
  ]) {
    let calls = 0;
    const transport = createTransport({ lookup: async () => addresses, request: () => { calls++; throw Error('Unexpected connection'); } });
    try {
      await assert.rejects(transport.request('https://api.soundcloud.com/tracks', { kind: 'api' }), error => error.code === 'invalid_provider_target');
      assert.equal(calls, 0);
    } finally { transport.close(); }
  }
});

test('the actual TLS request receives pinned public answers and never performs a second DNS lookup', async () => {
  let lookups = 0;
  const pinned = [];
  const fake = connection({ onLookup: async (url, options) => {
    pinned.push(await new Promise((resolve, reject) => options.lookup(url.hostname, { all: true }, (error, result) => error ? reject(error) : resolve(result))));
    pinned.push(await new Promise((resolve, reject) => options.lookup(url.hostname, { family: 6 }, (error, address, family) => error ? reject(error) : resolve({ address, family }))));
  } });
  const addresses = [{ address: '8.8.8.8', family: 4 }, { address: '2001:4860:4860::8888', family: 6 }];
  const transport = createTransport({ lookup: async () => { lookups++; return lookups === 1 ? addresses : [{ address: '127.0.0.1', family: 4 }]; }, request: fake.request });
  try {
    const result = await transport.request('https://api.soundcloud.com/tracks', { kind: 'api' });
    assert.equal(result.status, 200); assert.equal(result.bytes.toString(), 'fixture bytes'); assert.equal(lookups, 1);
    assert.deepEqual(pinned, [addresses, addresses[1]]);
    assert.equal(fake.calls[0].options.headers['accept-encoding'], 'identity');
  } finally { transport.close(); }
});

test('host validation occurs before DNS and rejects arbitrary fetch targets', async () => {
  let lookups = 0, requests = 0;
  const transport = createTransport({ lookup: async () => { lookups++; return [{ address: '8.8.8.8', family: 4 }]; }, request: () => { requests++; } });
  try {
    for (const url of ['http://api.soundcloud.com/tracks', 'https://evil.example/private', 'https://api.soundcloud.com.evil.example/tracks']) await assert.rejects(transport.request(url, { kind: 'api' }));
    assert.equal(lookups, 0); assert.equal(requests, 0);
  } finally { transport.close(); }
});

test('response limits reject declared, compressed and streaming oversized payloads', async () => {
  for (const fixture of [
    { responseHeaders: { 'content-length': '1025' }, chunks: [] },
    { responseHeaders: { 'content-encoding': 'gzip' }, chunks: [] },
    { responseHeaders: {}, chunks: [Buffer.alloc(700), Buffer.alloc(700)] },
  ]) {
    const fake = connection(fixture);
    const transport = createTransport({ lookup: async () => [{ address: '8.8.8.8', family: 4 }], request: fake.request });
    try { await assert.rejects(transport.request('https://api.soundcloud.com/tracks', { kind: 'api', maxBytes: 1024 }), error => error.code === 'provider_response_too_large'); }
    finally { transport.close(); }
  }
});

test('DNS and socket failures expose fixed public errors without secret details', async () => {
  const secret = 'fixture-private-transport-detail';
  const lookupFailure = createTransport({ lookup: async () => { throw Error(secret); } });
  try { await assert.rejects(lookupFailure.request('https://api.soundcloud.com/tracks', { kind: 'api' }), error => error.code === 'provider_dns_unavailable' && !String(error).includes(secret)); }
  finally { lookupFailure.close(); }
  const transport = createTransport({ lookup: async () => [{ address: '8.8.8.8', family: 4 }], request: () => {
    const req = new EventEmitter(); req.write = () => {}; req.destroy = () => {};
    req.end = () => queueMicrotask(() => req.emit('error', Error(secret)));
    return req;
  } });
  try { await assert.rejects(transport.request('https://api.soundcloud.com/tracks', { kind: 'api' }), error => error.code === 'provider_unavailable' && !String(error).includes(secret)); }
  finally { transport.close(); }
});

test('a DNS wait cannot outlive the remaining request budget or open a connection after expiry', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  let connections = 0, finished = false;
  const transport = createTransport({
    lookup: async () => new Promise(() => {}),
    request: () => { connections++; assert.fail('Expired DNS must not open a socket'); },
  });
  try {
    const pending = assert.rejects(transport.request('https://api.soundcloud.com/tracks', { kind: 'api', timeoutMs: 200 }), error => error.status === 504 && error.code === 'provider_timeout')
      .then(() => { finished = true; });
    t.mock.timers.tick(199);
    await Promise.resolve();
    assert.equal(finished, false);
    t.mock.timers.tick(1);
    await pending;
    assert.equal(finished, true);
    assert.equal(Date.now(), 1200);
    assert.equal(connections, 0);
  } finally { transport.close(); }
});

test('DNS elapsed time reduces the socket response deadline instead of resetting the request timeout', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  let resolveDns, connections = 0, destroyed = 0, finished = false;
  const transport = createTransport({
    lookup: () => new Promise(resolve => { resolveDns = resolve; }),
    request: () => {
      connections++;
      const req = new EventEmitter();
      req.write = () => {};
      req.end = () => {};
      req.destroy = () => { destroyed++; };
      return req;
    },
  });
  try {
    const pending = assert.rejects(transport.request('https://api.soundcloud.com/tracks', { kind: 'api', timeoutMs: 1000 }), error => error.status === 504 && error.code === 'provider_timeout')
      .then(() => { finished = true; });
    t.mock.timers.tick(400);
    resolveDns([{ address: '8.8.8.8', family: 4 }]);
    for (let index = 0; index < 5; index++) await Promise.resolve();
    assert.equal(connections, 1);
    t.mock.timers.tick(599);
    await Promise.resolve();
    assert.equal(finished, false);
    assert.equal(destroyed, 0);
    t.mock.timers.tick(1);
    await pending;
    assert.equal(Date.now(), 2000);
    assert.equal(destroyed, 1);
    assert.equal(finished, true);
  } finally { transport.close(); }
});
