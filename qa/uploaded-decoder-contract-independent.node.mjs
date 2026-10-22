import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

// Real adapter + real transport, without account access or a native process.
// The exact API and legacy tuple deliberately grant different deliveries of
// one uploaded identity. Only the tuple's pure decoder grants a working file.
const [adapterSource, transportSource] = await Promise.all([
  readFile(new URL('../src-tauri/src/vk_web_adapter.js', import.meta.url), 'utf8'),
  readFile(new URL('../src-tauri/src/vk_direct_audio.js', import.meta.url), 'utf8'),
]);
const good = 'https://media.example.test/session-owned-upload.mp3';
const dead = 'https://media.example.test/unavailable-delivery.m3u8';
const masked = 'https://vk.com/audio_api_unavailable?extra=PRIVATE_DECODER_INPUT';
const saved = { id: 'vk-101-7', source: 'vk', url: 'vk-web://101/7', title: 'Own upload', artist: 'Artist', duration: 120, available: true, remote: { ownerId: 101, audioId: 7, inLibrary: true } };
const legacy = (url = masked) => [7, 101, url, 'Own upload', 'Artist', 120, null, null, null, null, 0, null, {}, 'x/y/PRIVATE_ACTION/z/a/PRIVATE_URL'];
const flush = async () => { for (let turn = 0; turn < 40; turn++) await Promise.resolve(); };

function fixture({ legacyUrl = masked, legacyDelay = 11000, legacyResult = input => ({ ...input, url: dead }) } = {}) {
  let now = 0, sequence = 0, apiCalls = 0, legacyCalls = 0;
  const timers = new Map(), media = [], requests = [], loaded = [];
  const later = (callback, delay) => { const id = ++sequence; timers.set(id, { callback, at: now + delay }); return id; };
  class ClockDate extends Date { static now() { return now; } }
  class Audio extends EventTarget {
    constructor() { super(); Object.assign(this, { src: '', currentTime: 0, duration: 120, readyState: 0, paused: true, ended: false, seeking: false, buffered: { length: 0 } }); media.push(this); }
    load() { if (this.src) loaded.push(this.src); if (this.src === good) later(() => { this.readyState = 4; this.dispatchEvent(new Event('canplay')); }, 10); }
    play() { this.paused = false; this.currentTime = .1; this.dispatchEvent(new Event('playing')); return Promise.resolve(); }
    pause() { this.paused = true; }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    canPlayType() { return ''; }
  }
  class Hls {
    static Events = { ERROR: 'error' };
    static isSupported() { return true; }
    on() {} loadSource() {} attachMedia() {} destroy() {}
  }
  const api = { async getById() { apiCalls++; return [{ id: 7, owner_id: 101, title: 'Own upload', artist: 'Artist', duration: 120, url: dead }]; } };
  const runtime = key => key === 217528 ? { ensureDIRootWebContainer: () => ({ resolve: () => api }) } : { AudioApi: 'audio' };
  runtime.m = { 217528: true, 518943: true };
  const player = {
    _impl: { _fixture__createAudio(input) { return { sources: input.sources.flatMap(source => source.url === masked ? [{ url: good, format: 'mp3' }] : [source]) }; } },
    _ensureHasURL(input) { legacyCalls++; return new Promise(resolve => later(() => resolve(legacyResult(input)), legacyDelay)); },
  };
  const context = {
    Audio, Hls, URL, Event, Date: ClockDate, setTimeout: later, clearTimeout: id => timers.delete(id),
    location: { href: 'https://vk.com/audio', origin: 'https://vk.com', pathname: '/audio' }, vk: { id: 101 },
    document: { querySelector: () => null, createElement: () => ({ set innerHTML(value) { this.value = value; }, value: '' }) },
    getAudioPlayer: () => player, webpackChunkvkweb: { push: chunk => chunk[2](runtime) },
    ajax: { post(url, params, callbacks) { requests.push({ url, params }); if (requests.length > 1) later(() => callbacks.onDone({ list: [legacy(legacyUrl)], totalCount: 1 }), 10); } },
  };
  context.window = context; context.top = context;
  vm.runInNewContext(transportSource, context);
  vm.runInNewContext(adapterSource, context);
  const adapter = context.__PULSE_VK_WEB__;
  adapter.start('uploaded-decoder-independent', { accountId: 101, tracks: [saved], playlists: [], index: {} });
  return {
    context, adapter, player, media, loaded, now: () => now, apiCalls: () => apiCalls, legacyCalls: () => legacyCalls,
    async runUntil(predicate) {
      for (let turn = 0; turn < 1000; turn++) {
        await flush(); if (predicate()) return;
        const next = [...timers].sort((left, right) => left[1].at - right[1].at)[0];
        assert.ok(next, 'pending playback has no timer'); assert.ok(next[1].at <= 60000, 'playback exceeded 60s');
        timers.delete(next[0]); now = next[1].at; next[1].callback();
      }
      assert.fail('clock did not settle');
    },
    async advance(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((left, right) => left[1].at - right[1].at)[0];
        if (!next) break;
        timers.delete(next[0]); now = next[1].at; next[1].callback(); await flush();
      }
      now = end; await flush();
    },
    close() { adapter.command({ operation: 'stop' }); timers.clear(); },
  };
}

test('control: transport decodes the synchronized masked upload directly without API or legacy URL resolver', async () => {
  const f = fixture(); const transport = f.context.__PULSE_CREATE_DIRECT_AUDIO__(); let settled = false;
  try {
    const pending = transport.load(legacy(), f.player).then(() => { settled = true; });
    await f.runUntil(() => settled); await pending; await transport.play();
    assert.equal(transport.read().playing, true); assert.equal(f.media.at(-1).src, good);
    assert.equal(f.apiCalls(), 0); assert.equal(f.legacyCalls(), 0); assert.ok(f.now() < 100);
  } finally { transport.destroy(); f.close(); }
});

test('synchronized masked upload keeps its immediately decodable source when exact API delivery is dead', async () => {
  const f = fixture();
  try {
    f.adapter.acceptSearch([legacy()]);
    const receipt = f.adapter.command({ operation: 'play', id: saved.id });
    await f.runUntil(() => !receipt.pending);
    assert.equal(receipt.accepted, true, `Playable session tuple was replaced; elapsed=${f.now()}ms, exact=${f.apiCalls()}, legacy=${f.legacyCalls()}, error=${receipt.error}`);
    assert.equal(f.adapter.playback().playing, true); assert.ok(f.now() < 1000);
  } finally { f.close(); }
});

test('cold exact API fallback preserves the complete original file returned by the requested legacy collection', async () => {
  const f = fixture({ legacyUrl: good });
  try {
    const receipt = f.adapter.command({ operation: 'play', id: saved.id });
    await f.runUntil(() => !receipt.pending);
    assert.equal(receipt.accepted, true, `Fresh legacy file was discarded; elapsed=${f.now()}ms, exact=${f.apiCalls()}, legacy=${f.legacyCalls()}, error=${receipt.error}`);
    assert.equal(f.adapter.playback().playing, true); assert.equal(f.legacyCalls(), 0);
  } finally { f.close(); }
});

test('a failed cold original delivery still has a second private legacy hash reload without retrying its URL', async () => {
  const stale = 'https://media.example.test/stale-own-upload.mp3';
  const f = fixture({ legacyUrl: stale, legacyDelay: 15, legacyResult: input => ({ ...input, url: good }) });
  try {
    const receipt = f.adapter.command({ operation: 'play', id: saved.id });
    await f.runUntil(() => !receipt.pending);
    assert.equal(receipt.accepted, true, receipt.error); assert.equal(f.adapter.playback().playing, true);
    assert.equal(f.legacyCalls(), 1); assert.equal(f.apiCalls(), 1);
    assert.equal(f.loaded.filter(url => url === stale).length, 1);
    assert.equal(f.loaded.at(-1), good);
  } finally { f.close(); }
});

for (const override of [{ id: 9999 }, { restrictionStatus: 1 }]) {
  test(`the second private hash reload cannot replace a confirmed ${override.id ? 'identity' : 'restriction'}`, async () => {
    const f = fixture({ legacyUrl: 'https://media.example.test/stale-upload.mp3', legacyDelay: 15, legacyResult: input => ({ ...input, ...override, url: good }) });
    try {
      const receipt = f.adapter.command({ operation: 'play', id: saved.id });
      await f.runUntil(() => !receipt.pending);
      assert.equal(receipt.accepted, false); assert.equal(f.adapter.playback().playing, false);
      assert.equal(f.loaded.includes(good), false); assert.equal(f.legacyCalls(), 1);
    } finally { f.close(); }
  });
}

test('the shared availability probe uses the same decoder while rejecting restricted or local-address output', () => {
  const f = fixture();
  try {
    const probe = f.context.__PULSE_CREATE_DIRECT_AUDIO__.canResolve;
    assert.equal(probe(legacy(), f.player), true);
    const restricted = legacy(); restricted[21] = 1;
    assert.equal(probe(restricted, f.player), false);
    assert.equal(probe(legacy(), { _impl: { _fixture__createAudio: () => ({ sources: [{ url: 'https://127.0.0.1/private.mp3', format: 'mp3' }] }) } }), false);
    assert.equal(Object.keys(f.context.__PULSE_CREATE_DIRECT_AUDIO__).includes('canResolve'), false);
  } finally { f.close(); }
});

for (const cancel of ['pause', 'account-switch']) {
  test(`${cancel} during the second private reload cannot install its late file`, async () => {
    const f = fixture({ legacyUrl: 'https://media.example.test/stale-upload.mp3', legacyDelay: 500, legacyResult: input => ({ ...input, url: good }) });
    try {
      const receipt = f.adapter.command({ operation: 'play', id: saved.id });
      await f.runUntil(() => f.legacyCalls() === 1);
      if (cancel === 'pause') f.adapter.command({ operation: 'pause' });
      else { f.context.vk.id = 202; f.adapter.read(false); }
      await f.runUntil(() => !receipt.pending);
      await f.advance(1000);
      assert.equal(f.adapter.playback().playing, false); assert.equal(f.loaded.includes(good), false);
      assert.equal(f.legacyCalls(), 1);
    } finally { f.close(); }
  });
}
