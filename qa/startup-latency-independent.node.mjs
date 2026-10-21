import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const transportSource = await readFile(process.env.PULSE_TRANSPORT_TEST_SOURCE || new URL('../src-tauri/src/vk_direct_audio.js', import.meta.url), 'utf8');
const adapterSource = await readFile(new URL('../src-tauri/src/vk_web_adapter.js', import.meta.url), 'utf8');
const flush = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };
const primary = 'https://media.example.test/granted.aac';
const alternate = 'https://media.example.test/granted.m3u8';
const track = { id: 'vk-101-7', title: 'Uploaded', artist: 'Artist', source: 'vk', url: 'vk-web://101/7', duration: 137, available: true, remote: { ownerId: 101, audioId: 7, inLibrary: true } };
const raw = { ownerId: 101, id: 7, title: 'Uploaded', artist: 'Artist', duration: 137, extra: { audio_streams: [{ type: 'aac', url: primary }, { type: 'hls_ts', url: alternate }] } };

function fixture({ metadataOnly = false, primaryHolds = false, hlsOnly = false } = {}) {
  let now = 0, sequence = 0, resolves = 0;
  const timers = new Map(), media = [], engines = [], requests = [];
  const later = (callback, delay) => { const id = ++sequence; timers.set(id, { callback, at: now + delay }); return id; };
  class Audio extends EventTarget {
    constructor() { super(); Object.assign(this, { src: '', currentTime: 0, duration: 137, readyState: 0, networkState: 2, paused: true, ended: false, seeking: false, ranges: [] }); media.push(this); }
    get buffered() { const ranges = this.ranges; return { length: ranges.length, start: i => ranges[i][0], end: i => ranges[i][1] }; }
    load() {
      if (!this.src || primaryHolds) return;
      later(() => { this.readyState = metadataOnly && this.src === primary ? 1 : 4; this.dispatchEvent(new Event('loadedmetadata')); if (this.readyState >= 3) this.dispatchEvent(new Event('canplay')); }, 20);
    }
    play() {
      if (this.readyState < 3) return new Promise(() => {});
      this.paused = false; this.currentTime += .1; this.dispatchEvent(new Event('playing')); return Promise.resolve();
    }
    pause() { this.paused = true; }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    canPlayType() { return ''; }
  }
  class Hls {
    static Events = { ERROR: 'error' };
    static ErrorTypes = { NETWORK_ERROR: 'networkError' };
    static isSupported() { return true; }
    constructor(config) { this.config = config; this.handlers = new Map(); this.repairs = 0; this.destroyed = false; engines.push(this); }
    on(type, fn) { this.handlers.set(type, fn); }
    loadSource(url) { this.url = url; }
    attachMedia(target) { this.media = target; later(() => { target.readyState = 4; target.ranges = [[0, 40]]; target.dispatchEvent(new Event('loadedmetadata')); target.dispatchEvent(new Event('canplay')); }, 30); }
    startLoad() { this.repairs++; }
    destroy() { this.destroyed = true; }
    fatalNetwork() { this.handlers.get('error')?.('error', { fatal: true, type: 'networkError' }); }
  }
  const resolved = hlsOnly ? { ...raw, extra: { audio_streams: [{ type: 'hls_ts', url: alternate }] } } : raw;
  const player = { _ensureHasURL: async () => { resolves++; return resolved; } };
  const sandbox = {
    Audio, Hls, URL, Event, Date: { now: () => now },
    setTimeout: later, clearTimeout: id => timers.delete(id),
    location: { href: 'https://vk.ru/audio', origin: 'https://vk.ru', pathname: '/audio' },
    vk: { id: 101 }, getAudioPlayer: () => player,
    document: { querySelector: () => null, createElement: () => ({ set innerHTML(value) { this.value = value; }, value: '' }) },
    ajax: { post(url, params, callbacks) {
      requests.push({ url, params });
      // Cold-start background synchronization is deliberately still running.
      // User playback restores only the requested identity from its saved row.
      if (requests.length === 1) return;
      later(() => callbacks.onDone({ list: [resolved], totalCount: 1 }), 15);
    } },
  };
  sandbox.window = sandbox; sandbox.top = sandbox;
  vm.runInNewContext(transportSource, sandbox);
  vm.runInNewContext(adapterSource, sandbox);
  const api = sandbox.__PULSE_VK_WEB__;
  api.start('startup-latency', { accountId: 101, tracks: [track], playlists: [], index: {} });
  return {
    api, sandbox, player, media, engines, requests, now: () => now, resolves: () => resolves,
    async runUntil(predicate, limit = 90000) {
      for (let n = 0; n < 1000; n++) {
        await flush(); if (predicate()) return;
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        assert.ok(next, 'pending operation has no timer'); assert.ok(next[1].at <= limit, `operation exceeded ${limit}ms`);
        timers.delete(next[0]); now = next[1].at; next[1].callback();
      }
      assert.fail('clock did not settle');
    },
    advance(ms) { now += ms; },
    close() { api.command({ operation: 'stop' }); timers.clear(); },
  };
}

test('cold saved-row play bypasses a metadata-only primary and starts its granted alternative', async () => {
  const f = fixture({ metadataOnly: true });
  try {
    await flush(); const receipt = f.api.command({ operation: 'play', id: track.id, position: 0 });
    await f.runUntil(() => !receipt.pending);
    assert.equal(receipt.accepted, true, receipt.error);
    assert.equal(f.api.playback().playing, true);
    assert.equal(f.engines.length, 1, 'healthy granted HLS was never tried after AAC metadata');
    assert.ok(f.now() < 5000, `metadata-only primary delayed the user ${f.now()}ms`);
    assert.equal(f.media[0].paused, true);
    assert.equal(f.resolves(), 0, 'available fallback unnecessarily depended on a separate URL refresh');
  } finally { f.close(); }
});

test('a healthy preferred source starts immediately without changing provider quality or format', async () => {
  const f = fixture();
  try {
    await flush(); const receipt = f.api.command({ operation: 'play', id: track.id });
    await f.runUntil(() => !receipt.pending);
    assert.equal(receipt.accepted, true, receipt.error);
    assert.ok(f.now() < 100);
    assert.equal(f.media.at(-1).src, primary);
    assert.equal(f.engines.length, 0);
    assert.equal(f.resolves(), 0);
  } finally { f.close(); }
});

test('pause while only metadata has arrived cancels the candidate and its late fallback', async () => {
  const f = fixture({ metadataOnly: true });
  try {
    await flush(); const receipt = f.api.command({ operation: 'play', id: track.id });
    await f.runUntil(() => f.media[0]?.readyState === 1);
    const candidate = f.media[0]; f.api.command({ operation: 'pause' });
    candidate.readyState = 4; candidate.dispatchEvent(new Event('canplay'));
    await flush();
    assert.equal(receipt.pending, false);
    assert.equal(f.api.playback().playing, false);
    assert.equal(f.media.every(item => item.paused), true);
    assert.equal(f.engines.length, 0);
  } finally { f.close(); }
});

test('a refresh returning the identical failed source does not download it twice in one startup', async () => {
  const f = fixture({ primaryHolds: true });
  // Exercise the public transport with an explicit file, rather than fabricate
  // a method stub: the website refresh grants exactly the same failed URL.
  const transport = f.sandbox.__PULSE_CREATE_DIRECT_AUDIO__();
  try {
    let settled = false;
    const result = transport.load({ ownerId: 101, id: 8, url: primary }, { _ensureHasURL: async input => ({ ...input, url: primary }) });
    const rejected = assert.rejects(result).then(() => { settled = true; });
    await f.runUntil(() => settled); await rejected;
    assert.equal(f.media.filter(item => item.src === primary || item.src === '').length, 1, 'identical failed URL consumed a second full load budget');
    assert.ok(f.now() <= 8000, `failed source was retried until ${f.now()}ms`);
  } finally { transport.destroy(); f.close(); }
});

test('a warm CDN failure privately refreshes the exact item without waiting on its legacy resolver', async () => {
  const f = fixture({ primaryHolds: true });
  const transport = f.sandbox.__PULSE_CREATE_DIRECT_AUDIO__();
  let refreshes = 0, legacy = 0, settled = false;
  try {
    const loading = transport.load({ ownerId: 101, id: 8, url: primary, __pulseRefreshSource: async () => {
      refreshes++; return { ownerId: 101, id: 8, extra: { audio_streams: [{ type: 'hls_ts', url: alternate }] } };
    } }, { _ensureHasURL() { legacy++; return new Promise(() => {}); } }).then(() => { settled = true; });
    await f.runUntil(() => settled); await loading; await transport.play();
    assert.equal(transport.read().playing, true);
    assert.equal(refreshes, 1); assert.equal(legacy, 0);
    assert.ok(f.now() < 8100, `fresh exact fallback delayed until ${f.now()}ms`);
  } finally { transport.destroy(); f.close(); }
});

test('an exact API source can privately fall back to the legacy working delivery for the same identity', async () => {
  const f = fixture({ primaryHolds: true }); const transport = f.sandbox.__PULSE_CREATE_DIRECT_AUDIO__();
  let legacy = 0, settled = false;
  try {
    const load = transport.load({ ownerId: 101, id: 8, __pulseResolveSource: async () => ({
      ownerId: 101, id: 8, url: primary,
      __pulseFallbackSource: async () => { legacy++; return { ownerId: 101, id: 8, extra: { audio_streams: [{ type: 'hls_ts', url: alternate }] } }; },
    }) }, { _ensureHasURL() { throw new Error('legacy resolver must stay private to the adapter'); } }).then(() => { settled = true; });
    await f.runUntil(() => settled); await load; await transport.play();
    assert.equal(legacy, 1); assert.equal(transport.read().playing, true); assert.equal(f.engines.length, 1);
  } finally { transport.destroy(); f.close(); }
});

test('the exact API fallback rejects a changed identity before installing any alternate source', async () => {
  const f = fixture({ primaryHolds: true }); const transport = f.sandbox.__PULSE_CREATE_DIRECT_AUDIO__();
  let settled = false;
  try {
    const load = transport.load({ ownerId: 101, id: 8, __pulseResolveSource: async () => ({
      ownerId: 101, id: 8, url: primary,
      __pulseFallbackSource: async () => ({ ownerId: 101, id: 9, url: alternate }),
    }) }, {}).then(() => { settled = true; });
    const rejected = assert.rejects(load).then(() => { settled = true; });
    await f.runUntil(() => settled); await rejected;
    assert.equal(f.engines.length, 0); assert.equal(f.media.every(item => item.src === ''), true);
  } finally { transport.destroy(); f.close(); }
});

test('an unavailable exact API refresh can use its independently authorized private legacy route', async () => {
  const f = fixture(); const transport = f.sandbox.__PULSE_CREATE_DIRECT_AUDIO__(); let fallback = 0, settled = false;
  try {
    const load = transport.load({ ownerId: 101, id: 8,
      __pulseResolveSource: async () => { throw new Error('API temporarily unavailable'); },
      __pulseFallbackSource: async () => { fallback++; return { ownerId: 101, id: 8, extra: { audio_streams: [{ type: 'hls_ts', url: alternate }] } }; },
    }, {}).then(() => { settled = true; });
    await f.runUntil(() => settled); await load; await transport.play();
    assert.equal(fallback, 1); assert.equal(transport.read().playing, true);
  } finally { transport.destroy(); f.close(); }
});

for (const resolved of [{ ownerId: 101, id: 9, url: primary }, { ownerId: 101, id: 8, url: primary, restrictionStatus: 1 }]) {
  test(`a confirmed API ${resolved.id === 9 ? 'identity change' : 'restriction'} cannot be reinterpreted as an API outage`, async () => {
    const f = fixture(); const transport = f.sandbox.__PULSE_CREATE_DIRECT_AUDIO__(); let fallback = 0;
    try {
      await assert.rejects(transport.load({ ownerId: 101, id: 8, __pulseResolveSource: async () => resolved,
        __pulseFallbackSource: async () => { fallback++; return { ownerId: 101, id: 8, url: primary }; },
      }, {}));
      assert.equal(fallback, 0); assert.equal(f.media.length, 0);
    } finally { transport.destroy(); f.close(); }
  });
}

for (const refreshed of [{ ownerId: 101, id: 9, url: primary }, { ownerId: 101, id: 8, url: primary, restrictionStatus: 1 }]) {
  test(`private fallback rejects refreshed ${refreshed.id === 9 ? 'different identity' : 'restriction'} before loading`, async () => {
    const f = fixture({ primaryHolds: true }); const transport = f.sandbox.__PULSE_CREATE_DIRECT_AUDIO__();
    let settled = false, legacy = 0;
    try {
      const loading = transport.load({ ownerId: 101, id: 8, url: primary, __pulseRefreshSource: async () => refreshed }, { _ensureHasURL() { legacy++; return new Promise(() => {}); } });
      const rejected = assert.rejects(loading).then(() => { settled = true; });
      await f.runUntil(() => settled); await rejected;
      assert.equal(legacy, 0); assert.equal(f.media.length, 1); assert.equal(transport.read().playing, false);
    } finally { transport.destroy(); f.close(); }
  });
}

test('unsupported optional exact refresh still preserves the authorized legacy fallback', async () => {
  const f = fixture({ primaryHolds: true }); const transport = f.sandbox.__PULSE_CREATE_DIRECT_AUDIO__();
  let settled = false, legacy = 0;
  try {
    const loading = transport.load({ ownerId: 101, id: 8, url: primary, __pulseRefreshSource: async () => null }, { _ensureHasURL: async input => {
      legacy++; return { ...input, extra: { audio_streams: [{ type: 'hls_ts', url: alternate }] } };
    } }).then(() => { settled = true; });
    await f.runUntil(() => settled); await loading; await transport.play();
    assert.equal(legacy, 1); assert.equal(transport.read().playing, true);
  } finally { transport.destroy(); f.close(); }
});

test('account switch during private exact refresh cancels before legacy fallback or late playback', async () => {
  const f = fixture({ primaryHolds: true }); const transport = f.sandbox.__PULSE_CREATE_DIRECT_AUDIO__();
  let release, refreshing = false, legacy = 0;
  try {
    const loading = transport.load({ ownerId: 101, id: 8, url: primary, __pulseRefreshSource: () => {
      refreshing = true; return new Promise(resolve => { release = resolve; });
    } }, { _ensureHasURL() { legacy++; return new Promise(() => {}); } });
    const rejected = assert.rejects(loading, error => error.code === 'PULSE_DIRECT_CANCELLED');
    await f.runUntil(() => refreshing);
    f.sandbox.vk.id = 202; transport.read();
    release({ ownerId: 101, id: 8, extra: { audio_streams: [{ type: 'hls_ts', url: alternate }] } });
    await rejected; await flush();
    assert.equal(legacy, 0); assert.equal(f.engines.length, 0); assert.equal(transport.read().playing, false);
  } finally { transport.destroy(); f.close(); }
});

test('all consecutive automatic renewal attempts share one deadline and retain the last audible position', async () => {
  const f = fixture(); const transport = f.sandbox.__PULSE_CREATE_DIRECT_AUDIO__();
  let renewals = 0;
  try {
    let settled = false;
    const loading = transport.load({ ownerId: 101, id: 8, url: primary }, { _ensureHasURL: async input => {
      renewals++; return { ...input, url: `https://media.example.test/dead-${renewals}.aac` };
    } }).then(() => { settled = true; });
    await f.runUntil(() => settled); await loading; await transport.play();
    const original = f.media[0]; original.currentTime = 44; original.dispatchEvent(new Event('timeupdate'));
    // The original source was healthy, then each renewed CDN stays silent.
    const load = f.sandbox.Audio.prototype.load;
    f.sandbox.Audio.prototype.load = function () { if (this.src === primary) load.call(this); };
    const started = f.now(); original.dispatchEvent(new Event('error'));
    await f.runUntil(() => Boolean(transport.read().error), started + 45000);
    assert.ok(f.now() - started <= 45000);
    assert.equal(renewals, 2); assert.equal(transport.read().position, 44);
    assert.equal(transport.read().recovering, false); assert.equal(transport.read().playing, false);
  } finally { transport.destroy(); f.close(); }
});

test('slow source resolution and loading cannot extend initial play beyond the native receipt budget', async () => {
  const f = fixture({ primaryHolds: true }); const transport = f.sandbox.__PULSE_CREATE_DIRECT_AUDIO__();
  let settled = false;
  try {
    const load = transport.load({ ownerId: 101, id: 8, __pulseResolveSource: () => new Promise(resolve => {
      f.sandbox.setTimeout(() => resolve({ ownerId: 101, id: 8, url: primary }), 19000);
    }) }, {});
    // The source is playable, but only after a slow resolver and decoder.
    f.sandbox.Audio.prototype.load = function () {
      if (this.src) f.sandbox.setTimeout(() => { this.readyState = 4; this.dispatchEvent(new Event('canplay')); }, 23000);
    };
    const loading = load.then(() => { settled = true; });
    await f.runUntil(() => settled); await loading;
    f.sandbox.Audio.prototype.play = function () { return new Promise(() => {}); };
    settled = false;
    const rejected = assert.rejects(transport.play()).then(() => { settled = true; });
    await f.runUntil(() => settled, 60000); await rejected;
    assert.equal(f.now(), 60000, 'first play received another unaccounted 25 seconds after source preparation');
  } finally { transport.destroy(); f.close(); }
});

test('a ready preloaded track can start after a long user pause without an expired startup timestamp', async () => {
  const f = fixture(); const transport = f.sandbox.__PULSE_CREATE_DIRECT_AUDIO__();
  let settled = false;
  try {
    const load = transport.load({ ownerId: 101, id: 8, url: primary }, {}).then(() => { settled = true; });
    await f.runUntil(() => settled); await load;
    f.advance(300000); await transport.play();
    assert.equal(transport.read().playing, true); assert.equal(transport.read().error, null);
  } finally { transport.destroy(); f.close(); }
});

test('a future HLS download failure preserves audible buffered audio and retries the same engine', async () => {
  const f = fixture({ hlsOnly: true });
  try {
    await flush(); const receipt = f.api.command({ operation: 'play', id: track.id });
    await f.runUntil(() => !receipt.pending);
    assert.equal(receipt.accepted, true, receipt.error);
    const audio = f.media.at(-1), engine = f.engines[0]; audio.currentTime = 10;
    engine.fatalNetwork(); await flush();
    assert.equal(engine.destroyed, false, 'recoverable prefetch failure threw away 30s of already buffered audio');
    assert.equal(engine.repairs, 1);
    for (let second = 1; second <= 20; second++) {
      f.advance(1000); audio.currentTime = 10 + second;
      const state = f.api.playback();
      assert.equal(state.recovering, false); assert.equal(state.playing, true);
    }
    assert.equal(f.engines.length, 1); assert.equal(f.resolves(), 0);
  } finally { f.close(); }
});

test('media-clock progress survives absent timeupdate events and a temporary waiting event', async () => {
  const f = fixture({ hlsOnly: true });
  try {
    await flush(); const receipt = f.api.command({ operation: 'play', id: track.id });
    await f.runUntil(() => !receipt.pending);
    const audio = f.media.at(-1);
    for (let second = 1; second <= 30; second++) {
      f.advance(1000); audio.currentTime = second;
      if (second === 7) audio.dispatchEvent(new Event('waiting'));
      const status = f.api.playback();
      assert.equal(status.recovering, false); assert.equal(status.error, null); assert.equal(status.playing, true);
    }
    assert.equal(f.engines.length, 1);
  } finally { f.close(); }
});
