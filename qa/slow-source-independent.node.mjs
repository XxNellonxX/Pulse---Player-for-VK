import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

// User-visible regression: a session-granted HLS starts successfully after a
// slow first segment. A metadata refresh grants the same URL (or no usable
// alternative), so discarding that live attempt after 4s makes a working song
// fail. The real VK site reproduced this: first fragment retry, then canplay.
const source = await readFile(process.env.PULSE_SLOW_TRANSPORT_SOURCE || new URL('../src-tauri/src/vk_direct_audio.js', import.meta.url), 'utf8');
const primary = 'https://cdn.example.test/session-original.m3u8';
const alternate = 'https://cdn.example.test/session-alternate.m3u8';
const identity = { ownerId: 101, id: 7 };
const flush = async () => { for (let turn = 0; turn < 40; turn++) await Promise.resolve(); };

function fixture({ readyMs = 6800, fallback = 'same', fallbackDelay = 0, retry = false } = {}) {
  let now = 0, sequence = 0, liveDocument = true, fallbackCalls = 0, secondStageCalls = 0;
  const timers = new Map(), media = [], engines = [];
  const later = (callback, delay) => { const id = ++sequence; timers.set(id, { callback, at: now + delay }); return id; };
  class Audio extends EventTarget {
    constructor() { super(); Object.assign(this, { src: '', readyState: 0, currentTime: 0, duration: 120, paused: true, ended: false, seeking: false, networkState: 2, ranges: [] }); media.push(this); }
    get buffered() { const ranges = this.ranges; return { length: ranges.length, start: index => ranges[index][0], end: index => ranges[index][1] }; }
    load() {}
    play() { this.paused = false; this.currentTime = .1; this.dispatchEvent(new Event('playing')); return Promise.resolve(); }
    pause() { this.paused = true; }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    canPlayType() { return ''; }
  }
  class Hls {
    static Events = { ERROR: 'error' };
    static ErrorTypes = { NETWORK_ERROR: 'networkError' };
    static isSupported() { return true; }
    constructor(config) { this.config = config; this.handlers = new Map(); this.destroyed = false; this.retries = 0; engines.push(this); }
    on(type, callback) { this.handlers.set(type, callback); }
    loadSource(url) { this.url = url; }
    attachMedia(audio) {
      this.media = audio;
      const delay = this.url === alternate ? 20 : readyMs;
      if (retry && this.url === primary) later(() => { this.retries++; this.handlers.get('error')?.('error', { fatal: false, type: 'networkError', details: 'fragLoadTimeOut' }); }, 10000);
      // Deliver late readiness even to an obsolete element: cancellation must
      // protect against callbacks queued before an engine was destroyed.
      later(() => { audio.ranges = [[0, 70]]; audio.readyState = 4; audio.dispatchEvent(new Event('loadeddata')); audio.dispatchEvent(new Event('canplay')); }, delay);
    }
    destroy() { this.destroyed = true; }
  }
  const sandbox = { Audio, Hls, URL, Event, Date: { now: () => now }, vk: { id: 101 }, location: { href: 'https://vk.com/audio' }, setTimeout: later, clearTimeout: id => timers.delete(id) };
  sandbox.window = sandbox; sandbox.top = sandbox;
  vm.runInNewContext(source, sandbox);
  const transport = sandbox.__PULSE_CREATE_DIRECT_AUDIO__({ isCurrent: () => liveDocument });
  const raw = {
    ...identity,
    __pulseResolveSource: async () => ({ ...identity, url: primary }),
    __pulseFallbackSource: async () => {
      fallbackCalls++;
      if (fallback === 'hung') return new Promise(() => {});
      if (fallbackDelay) await new Promise(resolve => later(resolve, fallbackDelay));
      return fallback === 'same' ? { ...identity, url: primary } : fallback === 'empty' ? { ...identity } : fallback === 'second-stage' ? {
        ...identity, url: primary, __pulseFallbackSource: async () => { secondStageCalls++; return { ...identity, url: alternate }; },
      } : { ...identity, ...(fallback === 'wrong-identity' ? { id: 9999 } : fallback === 'restricted' ? { restrictionStatus: 1 } : {}), url: alternate };
    },
  };
  let outcome;
  const play = () => transport.load(raw, {}).then(() => transport.play()).then(() => { outcome = { ok: true }; }, error => { outcome = { ok: false, error }; });
  return {
    sandbox, transport, media, engines, play, now: () => now, outcome: () => outcome, fallbackCalls: () => fallbackCalls, secondStageCalls: () => secondStageCalls,
    leaveDocument() { liveDocument = false; transport.read(); },
    async advanceUntil(predicate, limit = 60000) {
      for (let count = 0; count < 2000; count++) {
        await flush(); if (predicate()) return;
        const next = [...timers].filter(([, timer]) => timer.at <= limit).sort((left, right) => left[1].at - right[1].at)[0];
        assert.ok(next, `operation has no pending timer before ${limit}ms; outcome=${outcome?.ok}`);
        timers.delete(next[0]); now = next[1].at; next[1].callback();
      }
      assert.fail('fake clock did not settle');
    },
    async advanceTo(end) {
      await flush();
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((left, right) => left[1].at - right[1].at)[0];
        if (!next) break;
        timers.delete(next[0]); now = next[1].at; next[1].callback(); await flush();
      }
      now = end; await flush();
    },
    close() { transport.destroy(); timers.clear(); },
  };
}

for (const fallback of ['same', 'empty', 'hung']) {
  test(`a 6.8s valid first fragment stays alive when refresh ${fallback === 'same' ? 'offers the identical URL' : fallback === 'empty' ? 'offers no alternate URL' : 'never responds'}`, async () => {
    const f = fixture({ fallback });
    try {
      const playback = f.play(); await f.advanceUntil(() => Boolean(f.outcome())); await playback;
      assert.equal(f.outcome().ok, true, `working source was discarded at ${f.now()}ms: ${f.outcome().error?.message}`);
      assert.equal(f.transport.read().playing, true); assert.ok(f.transport.read().position > .05);
      assert.equal(f.media.length, 1, 'same delivery should not create a second audio element');
      assert.equal(f.engines.length, 1, 'refreshing metadata must not restart the same live HLS attempt');
      assert.ok(f.now() < 8000, `working source did not start promptly after its data arrived: ${f.now()}ms`);
    } finally { f.close(); }
  });
}

test('a slow first HLS fragment can complete its own retry and start at 22s when no distinct source exists', async () => {
  const f = fixture({ readyMs: 22000, fallback: 'same', retry: true });
  try {
    const playback = f.play(); await f.advanceUntil(() => Boolean(f.outcome())); await playback;
    assert.equal(f.outcome().ok, true, `the initial fragment retry was cut short at ${f.now()}ms`);
    assert.equal(f.engines.length, 1); assert.equal(f.media.length, 1); assert.equal(f.engines[0].retries, 1);
    assert.equal(f.transport.read().playing, true); assert.ok(f.now() < 25000);
  } finally { f.close(); }
});

test('a distinct responsive alternative still starts near 4s while the original first fragment is slow', async () => {
  const f = fixture({ readyMs: 22000, fallback: 'distinct' });
  try {
    const playback = f.play(); await f.advanceUntil(() => Boolean(f.outcome())); await playback;
    assert.equal(f.outcome().ok, true); assert.equal(f.transport.read().playing, true);
    assert.equal(f.engines.at(-1).url, alternate); assert.ok(f.now() >= 3500 && f.now() < 6000, `responsive alternate was delayed until ${f.now()}ms`);
    assert.equal(f.media.filter(audio => !audio.paused).length, 1);
  } finally { f.close(); }
});

test('an immediately playable original starts without issuing optional fallback metadata requests', async () => {
  const f = fixture({ readyMs: 100, fallback: 'distinct' });
  try {
    const playback = f.play(); await f.advanceUntil(() => Boolean(f.outcome())); await playback;
    assert.equal(f.outcome().ok, true); assert.ok(f.now() < 1000); assert.equal(f.fallbackCalls(), 0);
    f.media[0].currentTime = 1; f.media[0].dispatchEvent(new Event('timeupdate')); await f.advanceTo(4500);
    assert.equal(f.fallbackCalls(), 0, 'the completed load left a metadata hedge timer behind');
    assert.equal(f.engines.length, 1); assert.equal(f.transport.read().playing, true);
  } finally { f.close(); }
});

test('same-URL metadata can expose a second private route whose distinct responsive delivery starts promptly', async () => {
  const f = fixture({ readyMs: 22000, fallback: 'second-stage' });
  try {
    const playback = f.play(); await f.advanceUntil(() => Boolean(f.outcome())); await playback;
    assert.equal(f.outcome().ok, true); assert.equal(f.transport.read().playing, true);
    assert.equal(f.fallbackCalls(), 1); assert.equal(f.secondStageCalls(), 1);
    assert.equal(f.engines.at(-1).url, alternate); assert.ok(f.now() >= 3500 && f.now() < 6000);
  } finally { f.close(); }
});

for (const action of ['pause', 'stop', 'account-change', 'document-navigation']) {
  test(`${action} while a slow first fragment is pending prevents late readiness from starting sound`, async () => {
    const f = fixture({ fallback: 'distinct', fallbackDelay: 3000 });
    try {
      const playback = f.play(); await f.advanceTo(4500);
      assert.equal(f.outcome(), undefined, 'the initial source must still be viable when there is no alternate');
      assert.equal(f.fallbackCalls(), 1, 'the metadata request must be in flight before cancellation');
      if (action === 'pause') f.transport.pause();
      else if (action === 'stop') f.transport.stop();
      else if (action === 'account-change') { f.sandbox.vk.id = 202; f.transport.read(); }
      else f.leaveDocument();
      await playback; await f.advanceTo(23000);
      assert.equal(f.outcome().ok, false); assert.equal(f.outcome().error?.code, 'PULSE_DIRECT_CANCELLED');
      assert.equal(f.transport.read().playing, false); assert.equal(f.media.some(audio => !audio.paused), false);
      assert.equal(f.engines.length, 1);
    } finally { f.close(); }
  });
}

for (const fallback of ['wrong-identity', 'restricted']) {
  test(`a concurrent metadata reply with ${fallback} cannot replace the pending account-authorized source`, async () => {
    const f = fixture({ fallback });
    try {
      const playback = f.play(); await f.advanceUntil(() => Boolean(f.outcome())); await playback;
      assert.equal(f.outcome().ok, false, 'a confirmed changed identity or restriction must remain final');
      assert.equal(f.engines.length, 1); assert.equal(f.engines[0].url, primary);
      await f.advanceTo(23000);
      assert.equal(f.transport.read().playing, false); assert.equal(f.media.some(audio => !audio.paused), false);
    } finally { f.close(); }
  });
}

test('a metadata hedge that finishes after the original starts cannot replace its healthy media', async () => {
  const f = fixture({ readyMs: 6800, fallback: 'distinct', fallbackDelay: 6000 });
  try {
    const playback = f.play(); await f.advanceUntil(() => Boolean(f.outcome())); await playback;
    assert.equal(f.outcome().ok, true); assert.equal(f.transport.read().playing, true);
    assert.equal(f.fallbackCalls(), 1); assert.equal(f.engines.length, 1);
    f.media[0].currentTime = 1.25; f.media[0].dispatchEvent(new Event('timeupdate'));
    await f.advanceTo(10500);
    assert.equal(f.engines.length, 1, 'a late optional reply replaced the already playing engine');
    assert.equal(f.transport.read().playing, true); assert.equal(f.media[0].currentTime, 1.25);
  } finally { f.close(); }
});
