import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src-tauri/src/vk_direct_audio.js', import.meta.url), 'utf8');
const supplied = 'https://media.example.test/supplied.mp3';
const fresh = 'https://media.example.test/fresh.mp3';
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
const raw = (url = supplied, extra = {}) => ({ ownerId: 101, id: 7, url, extra, hashes: 'add/edit/action/delete/replace/urlhash/restore' });

function fixture({ policy = () => 'ready', fetch, equalizer } = {}) {
  const media = [], timers = new Map();
  let now = 0, sequence = 0;
  class Audio {
    constructor() { this.listeners = new Map(); this.src = ''; this.currentTime = 0; this.duration = 137; this.paused = true; this.readyState = 0; this.ended = false; media.push(this); }
    addEventListener(type, fn) { const list = this.listeners.get(type) || new Set(); list.add(fn); this.listeners.set(type, list); }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    emit(type) { for (const fn of [...this.listeners.get(type) || []]) fn({ type }); }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    load() {
      if (!this.src) return;
      const result = policy(this.src, media.indexOf(this));
      queueMicrotask(() => { if (result === 'ready') { this.readyState = 4; this.emit('loadedmetadata'); this.emit('canplay'); } else if (result === 'error') this.emit('error'); });
    }
    play() { this.paused = false; this.emit('playing'); return Promise.resolve(); }
    pause() { this.paused = true; }
    canPlayType() { return ''; }
  }
  const sandbox = {
    Audio, URL, Event, AbortController, fetch,
    location: { href: 'https://vk.ru/audio', origin: 'https://vk.ru' }, vk: { id: 101 },
    Date: { now: () => now },
    setTimeout(callback, milliseconds) { const id = ++sequence; timers.set(id, { callback, at: now + milliseconds }); return id; },
    clearTimeout(id) { timers.delete(id); },
    ...(equalizer ? { __PULSE_CREATE_EQUALIZER__: equalizer } : {}),
  };
  sandbox.window = sandbox; sandbox.top = sandbox;
  vm.runInNewContext(source, sandbox);
  const transport = sandbox.__PULSE_CREATE_DIRECT_AUDIO__();
  return {
    media, sandbox, transport, timers,
    now: () => now,
    async nextTimer() {
      await flush();
      const next = [...timers].sort((left, right) => left[1].at - right[1].at)[0];
      assert.ok(next, 'no pending timer');
      timers.delete(next[0]); now = next[1].at; next[1].callback(); await flush();
    },
  };
}

test('masked session input uses its pure decoder before the hanging URL resolver', async () => {
  const f = fixture(); let resolutions = 0;
  const player = {
    _ensureHasURL() { resolutions++; return new Promise(() => {}); },
    _impl: { _private__createAudio() { return { sources: [{ url: supplied, format: 'mp3' }] }; } },
  };
  try { await f.transport.load(raw('https://vk.ru/audio_api_unavailable?extra=secret'), player); assert.equal(f.media.at(-1).src, supplied); assert.equal(resolutions, 0); }
  finally { f.transport.destroy(); }
});

for (const method of ['_private__createAudio', '__private_123_createAudio']) {
  test(`a masked upload uses the website prototype decoder ${method} with its owning instance`, async () => {
    const f = fixture(); let resolutions = 0, decodes = 0;
    class WebsiteImplementation { constructor() { this.granted = supplied; } }
    Object.defineProperty(WebsiteImplementation.prototype, method, { value(input) {
      decodes++; assert.equal(input.id, '101_7');
      return { sources: [{ url: this.granted, format: 'mp3' }] };
    } });
    const player = { _impl: new WebsiteImplementation(), _ensureHasURL() { resolutions++; return new Promise(() => {}); } };
    try {
      assert.equal(f.sandbox.__PULSE_CREATE_DIRECT_AUDIO__.canResolve(raw('https://vk.ru/audio_api_unavailable?extra=private'), player), true);
      await f.transport.load(raw('https://vk.ru/audio_api_unavailable?extra=private'), player);
      assert.equal(f.media.at(-1).src, supplied); assert.equal(resolutions, 0); assert.equal(decodes, 2);
    } finally { f.transport.destroy(); }
  });
}

test('decoder discovery never executes website getters or shares the official node provider', async () => {
  const f = fixture(); let getters = 0;
  class WebsiteImplementation {
    __private_123_createAudio() { return { sources: [{ url: supplied, format: 'mp3' }] }; }
    _private__ensureNodeProvider() { throw new Error('shared official audio must not be touched'); }
  }
  const impl = new WebsiteImplementation();
  Object.defineProperty(impl, '_private__createAudio', { get() { getters++; throw new Error('discovery invoked an accessor'); } });
  try {
    await f.transport.load(raw('https://vk.ru/audio_api_unavailable?extra=private'), { _impl: impl });
    assert.equal(getters, 0); assert.equal(f.media.at(-1).src, supplied);
  } finally { f.transport.destroy(); }
});

test('two silent uploaded-file deliveries cannot hide the responsive third source for 25 seconds', async () => {
  const urls = ['silent-first.aac', 'silent-second.mp3', 'responsive-third.mp3'].map(name => `https://media.example.test/${name}`);
  const f = fixture({ policy: url => url === urls[2] ? 'ready' : 'hold' });
  let settled = false;
  try {
    const load = f.transport.load(raw('', { audio_streams: urls.map(url => ({ type: 'mp3', url })) }), {}).then(() => { settled = true; });
    for (let turn = 0; turn < 8 && !settled; turn++) { await flush(); if (!settled) await f.nextTimer(); }
    await load; await f.transport.play();
    assert.ok(f.now() <= 3000, `responsive third source waited ${f.now()}ms`);
    assert.equal(f.media.length, 3); assert.equal(f.media.at(-1).src, urls[2]);
    assert.ok(f.media.slice(0, 2).every(audio => audio.src === '' && audio.paused));
    assert.equal(f.transport.read().playing, true);
  } finally { f.transport.destroy(); }
});

test('a fourth uploaded source uses a released slot without exceeding three active loads', async () => {
  const urls = ['silent-first.mp3', 'silent-second.mp3', 'silent-third.mp3', 'responsive-fourth.mp3'].map(name => `https://media.example.test/${name}`);
  let activePeak = 0;
  const f = fixture({ policy: url => { activePeak = Math.max(activePeak, f.media.filter(audio => audio.src).length); return url === urls[3] ? 'ready' : 'hold'; } });
  let settled = false;
  try {
    const load = f.transport.load(raw('', { audio_streams: urls.map(url => ({ type: 'mp3', url })) }), {}).then(() => { settled = true; });
    for (let turn = 0; turn < 12 && !settled; turn++) { await flush(); if (!settled) await f.nextTimer(); }
    await load;
    assert.ok(f.now() <= 25000, `responsive fourth source exceeded the first load deadline: ${f.now()}ms`);
    assert.equal(activePeak, 3); assert.equal(f.media.at(-1).src, urls[3]);
    assert.ok(f.media.slice(0, 3).every(audio => audio.src === '' && audio.paused));
  } finally { f.transport.destroy(); }
});

test('a slow secondary keeps its full load opportunity after the other alternatives are exhausted', async () => {
  const urls = ['silent-first.mp3', 'slow-second.mp3', 'broken-third.mp3'].map(name => `https://media.example.test/${name}`);
  const f = fixture({ policy: url => url === urls[2] ? 'error' : 'hold' });
  let settled = false;
  try {
    const load = f.transport.load(raw('', { audio_streams: urls.map(url => ({ type: 'mp3', url })) }), {}).then(() => { settled = true; });
    f.sandbox.setTimeout(() => { const slow = f.media[1]; slow.readyState = 4; slow.emit('canplay'); }, 9000);
    for (let turn = 0; turn < 12 && !settled; turn++) { await flush(); if (!settled) await f.nextTimer(); }
    await load;
    assert.equal(f.media[1].src, urls[1]); assert.equal(f.now(), 9000);
    assert.equal(f.media[0].src, ''); assert.equal(f.media[2].src, '');
  } finally { f.transport.destroy(); }
});

test('an early responsive secondary is never discarded merely because additional silent sources remain', async () => {
  const urls = ['silent-first.mp3', 'slow-second.mp3', 'silent-third.mp3', 'silent-fourth.mp3', 'silent-fifth.mp3'].map(name => `https://media.example.test/${name}`);
  const f = fixture({ policy: () => 'hold' });
  let settled = false;
  try {
    const load = f.transport.load(raw('', { audio_streams: urls.map(url => ({ type: 'mp3', url })) }), {}).then(() => { settled = true; });
    f.sandbox.setTimeout(() => { const slow = f.media[1]; slow.readyState = 4; slow.emit('canplay'); }, 9000);
    for (let turn = 0; turn < 16 && !settled; turn++) { await flush(); if (!settled) await f.nextTimer(); }
    await load;
    assert.equal(f.media[1].src, urls[1]); assert.equal(f.now(), 9000);
  } finally { f.transport.destroy(); }
});

for (const command of ['stop', 'account-change']) {
  test(`${command} cancels all three pending uploaded sources and prevents late readiness`, async () => {
    const urls = ['first.mp3', 'second.mp3', 'third.mp3'].map(name => `https://media.example.test/${name}`);
    const f = fixture({ policy: () => 'hold' });
    try {
      const load = f.transport.load(raw('', { audio_streams: urls.map(url => ({ type: 'mp3', url })) }), {});
      const rejected = assert.rejects(load, error => error.code === 'PULSE_DIRECT_CANCELLED');
      await f.nextTimer(); await f.nextTimer();
      assert.equal(f.media.length, 3);
      if (command === 'stop') f.transport.stop(); else { f.sandbox.vk.id = 202; f.transport.read(); }
      await rejected;
      for (const audio of f.media) { audio.readyState = 4; audio.emit('canplay'); }
      await flush();
      assert.equal(f.transport.read().playing, false); assert.ok(f.media.every(audio => audio.src === '' && audio.paused));
      assert.equal(f.timers.size, 0, 'cancelled source probes left timers running');
    } finally { f.transport.destroy(); }
  });
}

test('an optional decoder that mutates then throws cannot erase the granted original source', async () => {
  const f = fixture(); let resolutions = 0;
  const player = {
    _ensureHasURL() { resolutions++; return Promise.reject(new Error('resolver unavailable')); },
    _impl: { _private__createAudio(input) { input.sources.splice(0); throw new Error('decoder failed after normalizing'); } },
  };
  try { await f.transport.load(raw(), player); assert.equal(f.media.at(-1).src, supplied); assert.equal(resolutions, 0); }
  finally { f.transport.destroy(); }
});

test('optional decoder reordering cannot promote its MP3 over the first explicitly granted AAC', async () => {
  const aac = 'https://media.example.test/first.aac';
  const mp3 = 'https://media.example.test/second.mp3';
  const f = fixture();
  try {
    await f.transport.load(raw('', { audio_streams: [{ type: 'aac', url: aac }, { type: 'mp3', url: mp3 }] }), {
      _ensureHasURL() { throw new Error('granted sources do not require URL resolution'); },
      _impl: { _private__createAudio(input) { input.sources.reverse(); return { sources: [{ url: mp3, format: 'mp3' }, { url: aac, format: 'unknown' }] }; } },
    });
    assert.equal(f.media[0].src, aac);
  } finally { f.transport.destroy(); }
});

test('untrusted decoded URLs cannot replace a valid session source or leave source secrets in public state', async () => {
  const f = fixture();
  try {
    await f.transport.load(raw(), {
      _ensureHasURL() { throw new Error('granted sources do not require URL resolution'); },
      _impl: { _private__createAudio() { return { sources: [
        { url: 'https://user:secret@media.example.test/protected.mp3', format: 'mp3' },
        { url: 'https://127.0.0.1/private.mp3', format: 'mp3' },
        { url: 'https://media.example.test/protected.mpd', format: 'dash' },
        { url: 'https://media.example.test/protected.mp3', format: 'mp3', drm: true },
      ] }; } },
    });
    await f.transport.play();
    assert.equal(f.media[0].src, supplied); assert.equal(f.transport.read().playing, true);
    assert.equal(/secret|https:|127\.0\.0\.1/.test(JSON.stringify(f.transport.read())), false);
  } finally { f.transport.destroy(); }
});

test('stopping a pending supplied-file load prevents its late metadata from creating playback', async () => {
  const f = fixture({ policy: () => 'hold' }); let resolutions = 0;
  const load = f.transport.load(raw(), { _ensureHasURL() { resolutions++; return new Promise(() => {}); } });
  const rejected = assert.rejects(load, error => error.code === 'PULSE_DIRECT_CANCELLED');
  try {
    await flush(); const stale = f.media[0]; f.transport.stop(); await rejected;
    stale.readyState = 4; stale.emit('loadedmetadata'); stale.emit('canplay'); await flush();
    assert.equal(stale.src, ''); assert.equal(stale.paused, true); assert.equal(f.transport.read().playing, false); assert.equal(resolutions, 0);
  } finally { f.transport.destroy(); }
});

test('account switch while loading a supplied file cancels without falling through to URL resolution', async () => {
  const f = fixture({ policy: () => 'hold' }); let resolutions = 0;
  const load = f.transport.load(raw(), { _ensureHasURL() { resolutions++; return Promise.resolve(raw(fresh)); } });
  const rejected = assert.rejects(load, error => error.code === 'PULSE_DIRECT_CANCELLED');
  try {
    await flush(); f.sandbox.vk.id = 202; f.media[0].emit('loadedmetadata');
    f.transport.read(); await rejected;
    assert.equal(f.media[0].src, ''); assert.equal(f.transport.read().playing, false); assert.equal(resolutions, 0);
  } finally { f.transport.destroy(); }
});

test('late metadata from a timed-out supplied source cannot replace the freshly resolved file', async () => {
  const f = fixture({ policy: url => url === supplied ? 'hold' : 'ready' });
  let resolutions = 0;
  const load = f.transport.load(raw(), { _ensureHasURL() { resolutions++; return Promise.resolve(raw(fresh)); } });
  try {
    await f.nextTimer(); await load; const stale = f.media[0];
    stale.emit('loadedmetadata'); stale.emit('canplay'); await f.transport.play();
    assert.equal(resolutions, 1); assert.equal(f.media.at(-1).src, fresh); assert.equal(stale.src, ''); assert.equal(stale.paused, true); assert.equal(f.transport.read().playing, true);
  } finally { f.transport.destroy(); }
});

for (const result of [{ ...raw(fresh), id: 8 }, { ...raw(fresh), restrictionStatus: 1 }]) {
  test(`failed supplied source cannot bypass refreshed ${result.id === 8 ? 'identity' : 'restriction'} validation`, async () => {
    const f = fixture({ policy: () => 'error' });
    try {
      await assert.rejects(f.transport.load(raw(), { _ensureHasURL: async () => result }));
      assert.equal(f.media.length, 1); assert.equal(f.media[0].src, ''); assert.equal(f.transport.read().buffering, false); assert.ok(f.transport.read().error);
    } finally { f.transport.destroy(); }
  });
}

test('artist refresh remains authoritative even when the old supplied URL is immediately playable', async () => {
  const f = fixture(); let refreshes = 0;
  try {
    await f.transport.load({ ...raw(), __pulseResolveSource: async () => { refreshes++; return raw(fresh); } }, { _ensureHasURL() { throw new Error('must not use legacy resolver'); } });
    assert.equal(refreshes, 1); assert.equal(f.media.length, 1); assert.equal(f.media[0].src, fresh);
  } finally { f.transport.destroy(); }
});

test('source deadline includes per-candidate CORS probes after a stale supplied file', async () => {
  const f = fixture({
    policy: () => 'hold',
    fetch: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
  });
  try {
    await f.transport.equalizer({ enabled: true });
    let finished = false;
    const load = f.transport.load(raw(), {
      _ensureHasURL: () => new Promise(resolve => f.sandbox.setTimeout(() => resolve(raw(fresh)), 19999)),
    });
    const rejected = assert.rejects(load).then(() => { finished = true; });
    for (let count = 0; count < 12 && !finished; count++) { await flush(); if (!finished) await f.nextTimer(); }
    await rejected;
    assert.ok(f.now() <= 45000, `source phase exceeded its 45s budget: ${f.now()}ms`);
    assert.equal(f.transport.read().buffering, false);
  } finally { f.transport.destroy(); }
});
