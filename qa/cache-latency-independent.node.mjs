import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { installDirectFixture } from './vk-direct-fixture.mjs';

const source = await readFile(process.env.PULSE_ADAPTER_TEST_SOURCE || new URL('../src-tauri/src/vk_web_adapter.js', import.meta.url), 'utf8');
const settle = async () => { for (let turn = 0; turn < 12; turn++) await new Promise(resolve => setImmediate(resolve)); };
const raw = id => [id, 101, '', `Track ${id}`, 'Artist', 120];
const saved = id => ({ id: `vk-101-${id}`, title: `Track ${id}`, artist: 'Artist', duration: 120, available: true, source: 'vk', url: `vk-web://101/${id}`, remote: { ownerId: 101, audioId: id, inLibrary: true } });
const apiRow = (id = 9000) => ({ id, owner_id: 101, artist: 'Artist', title: `Track ${id}`, duration: 120, url: 'https://audio.example.test/full.mp3', audio_streams: [{ type: 'hls_ts', url: 'https://audio.example.test/full.m3u8' }], access_key: 'page-private-key' });

function fixture({ getById, route, player = {} } = {}) {
  let now = 0, timerId = 0;
  const timers = new Map(), requests = [], apiRequests = [];
  class ClockDate extends Date { static now() { return now; } }
  const window = {
    location: { href: 'https://vk.com/audio' }, vk: { id: 101 }, getAudioPlayer: () => player,
    ajax: { post(url, params, callbacks) {
      requests.push({ url, params });
      // A cold session is still rebuilding the full library. Playback must
      // not wait for the catalogue's held first request or any later page.
      if (requests.length === 1) return;
      const response = route?.(params, requests.length);
      if (response) queueMicrotask(() => callbacks.onDone(...response));
    } },
  };
  window.top = window;
  if (getById) {
    const audio = { getById(params) { apiRequests.push(params); return getById(params); } };
    const runtime = key => key === 217528
      ? { ensureDIRootWebContainer: () => ({ resolve: () => audio }) }
      : { AudioApi: 'audio' };
    runtime.m = { 217528: true, 518943: true };
    window.webpackChunkvkweb = { push: chunk => chunk[2](runtime) };
  }
  const direct = installDirectFixture(window);
  const sandbox = {
    window, URL, Date: ClockDate,
    document: { querySelector: () => null, createElement: () => ({ set innerHTML(value) { this.value = value; }, value: '' }) },
    setTimeout(callback, delay) { const timer = { id: ++timerId, at: now + delay, callback, unref() {} }; timers.set(timer.id, timer); return timer; },
    clearTimeout(timer) { if (timer) timers.delete(timer.id); },
  };
  vm.runInNewContext(source, sandbox);
  const api = window.__PULSE_VK_WEB__;
  api.start('cold-library', { accountId: 101, tracks: [saved(1), saved(9000)], playlists: [], index: {} });
  return {
    window, api, direct, requests, apiRequests,
    async advance(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers.values()].filter(timer => timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = next.at; timers.delete(next.id); next.callback(); await settle();
      }
      now = end; await settle();
    },
    dispose() { timers.clear(); },
  };
}

test('cold saved track starts from one exact API response while full catalogue is still pending', async () => {
  const f = fixture({ getById: async () => [apiRow()] });
  try {
    await settle();
    const receipt = f.api.command({ operation: 'play', id: 'vk-101-9000' });
    await settle();
    assert.equal(receipt.accepted, true, receipt.error);
    assert.equal(receipt.pending, false, 'Exact-track startup must not wait for a complete catalogue scan');
    assert.equal(f.direct.playCalls, 1);
    assert.equal(f.direct.loads[0][0], 9000);
    assert.equal(f.requests.length, 1, 'Only the already-running background catalogue request is needed');
    assert.deepEqual(f.apiRequests.map(request => request.audios), ['101_9000']);
  } finally { f.dispose(); }
});

test('a shifted saved offset stops at the page containing the exact track instead of reading the remaining library', async () => {
  const f = fixture({ route: params => params.offset === 1
    ? [{ list: [raw(77)], totalCount: 10000 }]
    : params.offset === 0 ? [{ list: [raw(1), raw(9000)], totalCount: 10000 }] : undefined });
  try {
    await settle();
    const receipt = f.api.command({ operation: 'play', id: 'vk-101-9000' });
    await settle();
    assert.equal(receipt.accepted, true, receipt.error);
    assert.equal(receipt.pending, false, 'The matching first page is enough for playback even if page two never arrives');
    assert.equal(f.direct.loads[0][0], 9000);
    assert.equal(f.direct.playCalls, 1);
    assert.deepEqual(f.requests.slice(1).map(request => request.params.offset), [1, 0]);
    assert.equal(f.api.status, 'syncing', 'A lookup must not falsely complete the independent catalogue snapshot');
  } finally { f.dispose(); }
});

test('initial transport resolution reuses the fresh exact response; renewal privately refreshes the same identity', async () => {
  const f = fixture({ getById: async () => [apiRow()] });
  try {
    await settle(); f.api.command({ operation: 'play', id: 'vk-101-9000' }); await settle();
    const tuple = f.direct.loads[0];
    assert.equal(typeof tuple?.__pulseResolveSource, 'function');
    assert.equal(Object.keys(tuple).includes('__pulseResolveSource'), false);
    assert.equal((await tuple.__pulseResolveSource())[0], 9000);
    assert.equal(f.apiRequests.length, 1, 'Do not issue a duplicate API request before the first source can start');
    assert.equal((await tuple.__pulseResolveSource())[0], 9000);
    assert.deepEqual(f.apiRequests.map(request => request.audios), ['101_9000', '101_9000_page-private-key']);
    const publicState = JSON.stringify(f.api.read(true));
    assert.equal(publicState.includes('page-private-key'), false);
    assert.equal(publicState.includes('full.mp3'), false);
    f.window.vk.id = 202;
    await assert.rejects(tuple.__pulseResolveSource(), /session_changed/);
  } finally { f.dispose(); }
});

test('wrong-identity exact API output cannot replace the requested cached track', async () => {
  const f = fixture({ getById: async () => [apiRow(9999)], route: () => [{ list: [raw(9000)], totalCount: 1 }] });
  try {
    await settle(); const receipt = f.api.command({ operation: 'play', id: 'vk-101-9000' }); await settle();
    assert.equal(receipt.accepted, true, receipt.error);
    assert.equal(receipt.pending, false);
    assert.equal(f.direct.loads[0][0], 9000);
    assert.equal(f.requests.length, 2, 'A wrong API identity must fall back to the authoritative collection');
  } finally { f.dispose(); }
});

test('a session switch during exact lookup cannot publish the old account source', async () => {
  let complete;
  const f = fixture({ getById: () => new Promise(resolve => { complete = resolve; }) });
  try {
    await settle(); f.api.command({ operation: 'play', id: 'vk-101-9000' }); await settle();
    assert.equal(typeof complete, 'function');
    f.window.vk.id = 202; f.api.read(false);
    complete([apiRow()]); await settle();
    assert.equal(f.direct.loads.length, 0);
    assert.equal(f.direct.playCalls, 0);
  } finally { f.dispose(); }
});

test('an unavailable API and hung collection cannot leave metadata lookup pending for minutes', async () => {
  let complete;
  const f = fixture({ getById: () => new Promise(resolve => { complete = resolve; }) });
  try {
    await settle(); const receipt = f.api.command({ operation: 'play', id: 'vk-101-9000' }); await settle();
    await f.advance(3000);
    assert.equal(receipt.pending, true);
    await f.advance(5000);
    assert.equal(receipt.pending, false, 'The full metadata phase has one eight-second budget');
    assert.equal(receipt.accepted, false);
    assert.equal(f.direct.loads.length, 0);
    complete([apiRow()]); await settle();
    assert.equal(f.direct.loads.length, 0, 'A late response cannot revive an expired play request');
  } finally { f.dispose(); }
});

test('exact API tuples preserve current restrictions and full sources without exporting them', async () => {
  const f = fixture({ getById: async () => [{ ...apiRow(), restriction_status: 7, available: false }] });
  try {
    await settle(); f.api.command({ operation: 'play', id: 'vk-101-9000' }); await settle();
    const tuple = f.direct.loads[0];
    assert.equal(tuple[21], 7);
    assert.equal(tuple.available, false);
    assert.equal(tuple[12].audio_streams[0].type, 'hls_ts');
    assert.equal(JSON.stringify(f.api.read(true)).includes('full.m3u8'), false);
  } finally { f.dispose(); }
});

test('a synchronized blank or masked tuple uses the current exact API source instead of legacy reload', async () => {
  for (const url of ['', 'https://vk.com/mp3/audio_api_unavailable.mp3']) {
    const f = fixture({ getById: async () => [apiRow()] });
    try {
      await settle(); const legacy = raw(9000); legacy[2] = url;
      f.api.acceptSearch([legacy]);
      const receipt = f.api.command({ operation: 'play', id: 'vk-101-9000' }); await settle();
      assert.equal(receipt.pending, false);
      assert.equal(receipt.accepted, true, receipt.error);
      assert.equal(f.apiRequests.length, 1, 'Warm tuples with no usable source still need the official exact lookup');
      assert.equal(f.direct.loads[0][2], 'https://audio.example.test/full.mp3');
      assert.equal(typeof f.direct.loads[0].__pulseResolveSource, 'function');
    } finally { f.dispose(); }
  }
});

test('a synchronized private tuple keeps legacy playback if the exact API cannot grant its source', async () => {
  for (const getById of [async () => [], async () => [{ ...apiRow(), url: '', audio_streams: [] }], async () => { throw new Error('Not available in API'); }]) {
    const f = fixture({ getById });
    try {
      await settle(); const legacy = raw(9000); legacy[13] = 'legacy/reload/hashes'; legacy[24] = 'private-existing-access';
      f.api.acceptSearch([legacy]);
      const receipt = f.api.command({ operation: 'play', id: 'vk-101-9000' }); await settle();
      assert.equal(receipt.pending, false);
      assert.equal(receipt.accepted, true, receipt.error);
      assert.equal(f.apiRequests.length, 1);
      assert.equal(f.direct.loads[0], legacy, 'Legacy tuple and its hashes must survive an optional API failure');
      assert.equal(f.direct.playCalls, 1);
    } finally { f.dispose(); }
  }
});

test('warm artist closures and existing full URLs are not replaced by redundant metadata requests', async () => {
  const f = fixture({ getById: async () => [apiRow()] });
  try {
    await settle();
    const artist = raw(9000); Object.defineProperty(artist, '__pulseResolveSource', { value: async () => artist });
    f.api.acceptSearch([artist]); f.api.command({ operation: 'play', id: 'vk-101-9000' }); await settle();
    assert.equal(f.direct.loads[0], artist);
    const direct = raw(9000); direct[2] = 'https://audio.example.test/current.mp3';
    f.api.acceptSearch([direct]); f.api.command({ operation: 'play', id: 'vk-101-9000' }); await settle();
    assert.equal(f.direct.loads[1][2], direct[2]);
    assert.equal(f.apiRequests.length, 0);
  } finally { f.dispose(); }
});

test('a warm usable source gets a private lazy exact refresh without a startup API request', async () => {
  const f = fixture({ getById: async () => [apiRow()] });
  try {
    await settle(); const original = raw(9000); original[2] = 'https://audio.example.test/existing.mp3'; original[24] = 'existing-resource-key';
    f.api.acceptSearch([original]); f.api.command({ operation: 'play', id: 'vk-101-9000' }); await settle();
    const tuple = f.direct.loads[0];
    assert.equal(tuple[2], original[2]);
    assert.equal(f.apiRequests.length, 0, 'A currently usable source must start without a metadata request');
    assert.equal(typeof tuple.__pulseRefreshSource, 'function');
    assert.equal(Object.keys(tuple).includes('__pulseRefreshSource'), false);
    assert.equal(typeof original.__pulseRefreshSource, 'undefined', 'Do not alter objects owned by the website');
    const refreshed = await tuple.__pulseRefreshSource();
    assert.equal(refreshed[0], 9000); assert.equal(refreshed[1], 101);
    assert.equal(refreshed[2], 'https://audio.example.test/full.mp3');
    assert.equal(f.apiRequests.length, 1);
    assert.equal(f.apiRequests[0].audios, '101_9000_existing-resource-key');
    f.window.vk.id = 202;
    await assert.rejects(tuple.__pulseRefreshSource(), /session_changed/);
  } finally { f.dispose(); }
});

test('private lazy refresh returns null on unavailable API so the transport can retain legacy hashes', async () => {
  for (const getById of [async () => [], async () => { throw new Error('API request failed'); }]) {
    const f = fixture({ getById });
    try {
      await settle(); const original = raw(9000); original[2] = 'https://audio.example.test/existing.mp3'; original[13] = 'private-reload-hashes';
      f.api.acceptSearch([original]); f.api.command({ operation: 'play', id: 'vk-101-9000' }); await settle();
      const tuple = f.direct.loads[0];
      assert.equal(await tuple.__pulseRefreshSource(), null);
      assert.equal(tuple[13], 'private-reload-hashes');
      assert.equal(f.apiRequests.length, 1);
    } finally { f.dispose(); }
  }
});

test('resume after unloaded source uses the same warm exact resolver rather than reloading the legacy tuple', async () => {
  const f = fixture({ getById: async () => [apiRow()] });
  try {
    await settle(); const first = raw(9000); first[2] = 'https://audio.example.test/current.mp3';
    f.api.acceptSearch([first]); f.api.command({ operation: 'play', id: 'vk-101-9000' }); await settle();
    f.direct.instances[0].stop();
    f.api.acceptSearch([raw(9000)]);
    const receipt = f.api.command({ operation: 'resume' }); await settle();
    assert.equal(receipt.pending, false);
    assert.equal(receipt.accepted, true, receipt.error);
    assert.equal(f.apiRequests.length, 1);
    assert.equal(f.direct.loads[1][2], 'https://audio.example.test/full.mp3');
    assert.equal(f.direct.playCalls, 2);
  } finally { f.dispose(); }
});

test('a failed exact CDN can use the original same-identity legacy hashes without exporting credentials', async () => {
  let received;
  const player = { async _ensureHasURL(input) {
    received = input;
    return { ...input, url: 'https://audio.example.test/legacy-full.mp3' };
  } };
  const f = fixture({ getById: async () => [apiRow()], player });
  try {
    await settle(); const original = raw(9000); original[13] = 'x/y/action-private/z/a/url-private';
    f.api.acceptSearch([original]); f.api.command({ operation: 'play', id: 'vk-101-9000' }); await settle();
    const exact = f.direct.loads[0];
    assert.equal(typeof exact.__pulseFallbackSource, 'function');
    assert.equal(Object.keys(exact).includes('__pulseFallbackSource'), false);
    assert.equal(typeof original.__pulseFallbackSource, 'undefined');
    assert.equal(received, undefined, 'Legacy metadata is not requested before the primary delivery fails');
    const alternate = await exact.__pulseFallbackSource();
    assert.equal(alternate.id, 9000); assert.equal(alternate.ownerId, 101);
    assert.equal(alternate.url, 'https://audio.example.test/legacy-full.mp3');
    assert.equal(received.actionHash, 'action-private'); assert.equal(received.urlHash, 'url-private');
    assert.equal(received.url, undefined);
    assert.equal(f.apiRequests.length, 1, 'Do not ask the same exact API for the same dead CDN again');
    assert.equal(JSON.stringify(f.api.read(true)).includes('action-private'), false);
  } finally { f.dispose(); }
});

test('a cold exact source resolves its legacy fallback from the requested collection without recursing into the API tuple', async () => {
  const legacy = raw(9000); legacy[13] = 'x/y/cold-action/z/a/cold-url';
  let received;
  const f = fixture({ getById: async () => [apiRow()], route: () => [{ list: [legacy], totalCount: 1 }], player: {
    async _ensureHasURL(input) { received = input; return { ...input, url: 'https://audio.example.test/cold-legacy.mp3' }; },
  } });
  try {
    await settle(); f.api.command({ operation: 'play', id: 'vk-101-9000' }); await settle();
    const alternate = await f.direct.loads[0].__pulseFallbackSource();
    assert.equal(alternate.id, 9000); assert.equal(received.actionHash, 'cold-action');
    assert.equal(f.requests.length, 2, 'Fetch one exact offset after the primary source actually fails');
    assert.equal(f.apiRequests.length, 1);
  } finally { f.dispose(); }
});

test('a lazy exact refresh preserves a separate legacy route if its replacement CDN also fails', async () => {
  let received;
  const f = fixture({ getById: async () => [apiRow()], player: {
    async _ensureHasURL(input) { received = input; return { ...input, url: 'https://audio.example.test/fresh-legacy.mp3' }; },
  } });
  try {
    await settle(); const original = raw(9000); original[2] = 'https://audio.example.test/expired.mp3'; original[13] = 'x/y/warm-action/z/a/warm-url';
    f.api.acceptSearch([original]); f.api.command({ operation: 'play', id: 'vk-101-9000' }); await settle();
    const exact = await f.direct.loads[0].__pulseRefreshSource();
    assert.equal(typeof exact.__pulseFallbackSource, 'function');
    assert.equal((await exact.__pulseFallbackSource()).id, 9000);
    assert.equal(received.actionHash, 'warm-action'); assert.equal(received.urlHash, 'warm-url');
  } finally { f.dispose(); }
});

test('the private legacy route rejects another identity and late results from another session', async () => {
  for (const changedSession of [false, true]) {
    let complete;
    const f = fixture({ getById: async () => [apiRow()], player: {
      _ensureHasURL: input => new Promise(resolve => { complete = () => resolve({ ...input, id: changedSession ? 9000 : 9999, url: 'https://audio.example.test/legacy.mp3' }); }),
    } });
    try {
      await settle(); f.api.acceptSearch([raw(9000)]); f.api.command({ operation: 'play', id: 'vk-101-9000' }); await settle();
      const pending = f.direct.loads[0].__pulseFallbackSource(); await settle();
      if (changedSession) { f.window.vk.id = 202; f.api.read(false); }
      complete();
      await assert.rejects(pending, changedSession ? /session_changed/ : /invalid_audio_identity/);
    } finally { f.dispose(); }
  }
});
