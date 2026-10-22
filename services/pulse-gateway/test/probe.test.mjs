import test from 'node:test';
import assert from 'node:assert/strict';
import { runProbe } from '../src/probe.mjs';

const origin = 'https://music.example.com';
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

async function fixture({ track = { id: 123 }, streams = { hls_aac_160_url: `${origin}/v1/media/capability/master.m3u8` }, manifest = '#EXTM3U\nsegment.ts\n', fail, media } = {}) {
  const calls = [];
  const logs = [];
  const result = await runProbe({ origin, queries: ['Synthetic query'], logger: { info: text => logs.push(text), error: text => logs.push(text) }, fetchFn: async (url, options) => {
    calls.push(url.href);
    assert.equal(options.redirect, 'error');
    if (url.pathname.startsWith('/v1/musicbrainz/')) return json({ artists: [] });
    if (url.pathname === '/v1/soundcloud/tracks') return json({ collection: [track] });
    if (url.pathname.endsWith('/streams')) return fail?.('streams') || json(streams);
    if (url.pathname.endsWith('/master.m3u8')) return fail?.('manifest') || new Response(manifest);
    if (url.pathname.endsWith('/segment.ts')) return media?.() || new Response('audio');
    throw new Error(`Unexpected request with synthetic-private-capability ${url}`);
  } });
  return { ...result, calls, logs };
}

test('probe accepts URN-only search results and resolves media relative to the manifest directory', async () => {
  const result = await fixture({ track: { urn: 'soundcloud:tracks:123' } });
  assert.equal(result.failures, 0);
  assert.ok(result.calls.includes(`${origin}/v1/soundcloud/tracks/soundcloud%3Atracks%3A123/streams`));
  assert.ok(result.calls.includes(`${origin}/v1/media/capability/segment.ts`));
});

test('probe accepts numeric and string identities and rejects rounded or contradictory identities', async () => {
  for (const track of [{ id: 123 }, { id: '123' }, { id: 123, urn: 'soundcloud:tracks:123' }]) assert.equal((await fixture({ track })).failures, 0);
  for (const track of [{ id: Number.MAX_SAFE_INTEGER + 1 }, { id: 124, urn: 'soundcloud:tracks:123' }, {}, { urn: 'https://evil.example/private' }]) {
    const result = await fixture({ track });
    assert.equal(result.failures, 1);
    assert.match(result.logs[0], /failed at search \(invalid_track_identity\)/);
    assert.equal(result.calls.length, 2);
  }
});

test('probe reports missing streams without requesting an undefined URL', async () => {
  const result = await fixture({ streams: {} });
  assert.equal(result.failures, 1);
  assert.match(result.logs[0], /failed at streams \(no_supported_stream\)/);
  assert.ok(!result.calls.some(value => value.includes('undefined')));
});

test('probe refuses external stream and manifest references before fetch', async () => {
  for (const options of [{ streams: { hls_aac_160_url: 'https://evil.example/synthetic-private-capability' } }, { manifest: '#EXTM3U\nhttps://evil.example/synthetic-private-capability\n' }]) {
    const result = await fixture(options);
    assert.equal(result.failures, 1);
    assert.ok(result.calls.every(value => value.startsWith(origin)));
    assert.match(result.logs[0], /unexpected_resource_origin/);
    assert.doesNotMatch(result.logs.join('\n'), /evil|synthetic-private-capability/);
  }
});

test('probe reports the HTTP stage and status without response bodies or capability URLs', async () => {
  const result = await fixture({ fail: stage => stage === 'manifest' ? new Response('private-provider-secret', { status: 502 }) : undefined });
  assert.equal(result.failures, 1);
  assert.match(result.logs[0], /failed at manifest \(http_502\)/);
  assert.doesNotMatch(result.logs.join('\n'), /private-provider-secret|capability|https:/);
});

test('probe does not print network exception text', async () => {
  const result = await fixture({ fail: stage => { if (stage === 'streams') throw new Error('token=synthetic-secret https://private.example/private'); } });
  assert.equal(result.failures, 1);
  assert.match(result.logs[0], /failed at streams \(network_or_response_error\)/);
  assert.doesNotMatch(result.logs.join('\n'), /synthetic-secret|private.example/);
});

test('probe cancels an oversized streamed resource before buffering the whole response', async () => {
  let cancelled = false;
  const result = await fixture({ media: () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } })) });
  assert.equal(result.failures, 1);
  assert.match(result.logs[0], /failed at first_resource \(response_too_large\)/);
  assert.equal(cancelled, true);
});

test('MusicBrainz metadata remains independently checked when SoundCloud fails', async () => {
  const result = await fixture({ track: {} });
  assert.equal(result.failures, 1);
  assert.ok(result.logs.some(value => value.startsWith('MusicBrainz metadata request OK')));
});
