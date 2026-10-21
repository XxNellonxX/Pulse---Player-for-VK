import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src-tauri/src/vk_direct_audio.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 3));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
// Resolver-specific cases start without a granted URL. Direct uploaded files
// are covered independently by uploaded-source-independent.node.mjs.
const tuple = (id = 7, url = '', extra = null) => { const raw = []; raw[0] = id; raw[1] = 42; raw[2] = url; raw[5] = 30; raw[12] = extra; raw[13] = 'add/edit/action/delete/replace/urlhash/restore'; return raw; };

function site({ holdLoad = false, playGate = null, url = 'https://vk.com/audio', hlsSupported = true } = {}) {
  const media = [], engines = [], calls = [];
  class Audio {
    constructor() { this.listeners = new Map(); this.src = ''; this.currentTime = 0; this.duration = 30; this.paused = true; this.ended = false; this.readyState = 0; this.volume = 1; this.loads = 0; media.push(this); }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    dispatchEvent(event) { for (const fn of [...this.listeners.get(event.type) || []]) fn(event); return true; }
    emit(type) { this.dispatchEvent({ type }); }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    load() { this.loads++; if (this.src && !holdLoad) queueMicrotask(() => { this.readyState = 4; this.emit('loadedmetadata'); this.emit('canplay'); }); }
    canPlayType() { return ''; }
    play() { calls.push('media.play'); return (playGate?.promise || Promise.resolve()).then(() => { this.paused = false; this.emit('playing'); }); }
    pause() { calls.push('media.pause'); this.paused = true; this.emit('pause'); }
  }
  class Hls {
    static Events = { ERROR: 'error' };
    static isSupported = () => hlsSupported;
    constructor(config) { this.config = config; this.listeners = new Map(); this.destroyed = false; engines.push(this); }
    on(type, fn) { this.listeners.set(type, fn); }
    loadSource(value) { this.source = value; }
    attachMedia(value) { this.media = value; if (!holdLoad) queueMicrotask(() => { value.readyState = 4; value.emit('loadedmetadata'); }); }
    destroy() { this.destroyed = true; }
  }
  const context = { setTimeout, clearTimeout, URL, Event, Audio, Hls, __PULSE_HLS__: Hls, vk: { id: 101 }, location: { href: url } };
  context.window = context; context.top = context;
  vm.runInNewContext(source, context, { timeout: 1000 });
  const player = { async _ensureHasURL(data) { calls.push(['resolve', data.fullId]); return { ...data, url: 'https://cdn.example.test/music.mp3' }; }, play() { throw new Error('site play must never run'); }, ads: { startPlay() { throw new Error('ad scheduler must never run'); } } };
  return { context, player, media, engines, calls, create: options => context.__PULSE_CREATE_DIRECT_AUDIO__(options) };
}

test('factory only exists in the top-level official VK document', () => {
  assert.equal(site({ url: 'https://example.test/' }).context.__PULSE_CREATE_DIRECT_AUDIO__, undefined);
  assert.equal(typeof site().context.__PULSE_CREATE_DIRECT_AUDIO__, 'function');
});

test('accessible file playback is independent from the site player and reports no source secrets', async () => {
  const s = site(); const transport = s.create();
  try {
    await transport.load(tuple(), s.player); await transport.play();
    assert.equal(transport.read().playing, true);
    assert.equal(transport.read().duration, 30);
    transport.seek(11); assert.equal(transport.read().position, 11);
    transport.volume(2); assert.equal(s.media[0].volume, 1);
    transport.pause(); assert.equal(transport.read().playing, false);
    await transport.play(); assert.equal(transport.read().playing, true);
    s.media[0].ended = true; s.media[0].emit('ended');
    assert.equal(transport.read().ended, true);
    assert.equal(transport.read().playing, false);
    assert.equal(JSON.stringify(transport.read()).includes('https:'), false);
    assert.equal(s.calls.filter(call => call === 'media.play').length, 2);
  } finally { transport.destroy(); }
});

test('restriction rejects before resolving an audio URL', async () => {
  const s = site(); const transport = s.create(); const raw = tuple(); raw[21] = 1;
  try { await assert.rejects(transport.load(raw, s.player), /ограничил/); assert.equal(s.calls.length, 0); assert.equal(s.media.length, 0); }
  finally { transport.destroy(); }
});

test('source hashes go only to the official resolver and a different returned identity fails', async () => {
  const s = site(); const transport = s.create(); let input;
  s.player._ensureHasURL = async data => { input = data; return { ...data, id: 9, url: 'https://cdn.example.test/a.mp3' }; };
  try {
    await assert.rejects(transport.load(tuple(), s.player), /другой трек/);
    assert.equal(input.actionHash, 'action'); assert.equal(input.urlHash, 'urlhash');
    assert.equal(s.media.length, 0);
  } finally { transport.destroy(); }
});

test('official pure source factory decodes a masked source without shared audio nodes', async () => {
  const s = site(); const transport = s.create(); let pureCalls = 0;
  s.player._ensureHasURL = async data => ({ ...data, url: 'https://vk.com/audio_api_unavailable?extra=masked' });
  s.player._impl = { _private_123__createAudio(data) { pureCalls++; assert.equal(data.id, '42_7'); return { sources: [{ url: 'https://cdn.example.test/original.mp3?signature=private', format: 'mp3' }] }; }, _private_124__ensureNodeProvider() { throw new Error('shared provider must not be used'); } };
  try { await transport.load(tuple(), s.player); assert.equal(pureCalls, 1); assert.match(s.media[0].src, /original.mp3/); assert.equal(JSON.stringify(transport.read()).includes('signature'), false); }
  finally { transport.destroy(); }
});

test('an undecodable masked source fails without trying the site player', async () => {
  const s = site(); const transport = s.create();
  s.player._ensureHasURL = async data => ({ ...data, url: 'https://vk.com/audio_api_unavailable?extra=masked' });
  try { await assert.rejects(transport.load(tuple(), s.player), /не предоставил доступный/); assert.equal(s.media.length, 0); }
  finally { transport.destroy(); }
});

test('pause cancels an unresolved load and a late resolver cannot install audio', async () => {
  const s = site(); const transport = s.create(); const gate = deferred();
  s.player._ensureHasURL = data => gate.promise.then(() => ({ ...data, url: 'https://cdn.example.test/late.mp3' }));
  const load = transport.load(tuple(), s.player); transport.pause();
  await assert.rejects(load, error => error.code === 'PULSE_DIRECT_CANCELLED');
  gate.resolve(); await tick();
  assert.equal(s.media.length, 0); assert.equal(transport.read().error, null); assert.equal(transport.read().buffering, false);
  transport.destroy();
});

test('an account switch while resolving never creates a media element', async () => {
  const s = site(); const transport = s.create(); const gate = deferred();
  s.player._ensureHasURL = data => gate.promise.then(() => ({ ...data, url: 'https://cdn.example.test/private.mp3' }));
  const load = transport.load(tuple(), s.player); s.context.vk.id = 202; gate.resolve();
  await assert.rejects(load, error => error.code === 'PULSE_DIRECT_CANCELLED');
  assert.equal(s.media.length, 0); assert.equal(transport.read().playing, false);
  transport.destroy();
});

test('replacing a pending track cancels the previous load without overwriting the new one', async () => {
  const s = site(); const transport = s.create(); const gate = deferred();
  s.player._ensureHasURL = data => data.id === 7 ? gate.promise.then(() => ({ ...data, url: 'https://cdn.example.test/old.mp3' })) : Promise.resolve({ ...data, url: 'https://cdn.example.test/new.mp3' });
  const oldLoad = transport.load(tuple(7), s.player);
  const rejected = assert.rejects(oldLoad, error => error.code === 'PULSE_DIRECT_CANCELLED');
  await transport.load(tuple(8), s.player); await rejected; gate.resolve(); await tick();
  assert.equal(s.media.length, 1); assert.match(s.media[0].src, /new.mp3/);
  transport.destroy();
});

test('late play completion after pause cannot resurrect playback', async () => {
  const gate = deferred(); const s = site({ playGate: gate }); const transport = s.create();
  await transport.load(tuple(), s.player);
  const play = transport.play(); transport.pause(); gate.resolve();
  await assert.rejects(play, error => error.code === 'PULSE_DIRECT_CANCELLED');
  assert.equal(s.media[0].paused, true); assert.equal(transport.read().playing, false); assert.equal(transport.read().error, null);
  transport.destroy();
});

test('HLS uses an independent engine and releases it on stop', async () => {
  const s = site(); const transport = s.create();
  s.player._ensureHasURL = async data => ({ ...data, extra: JSON.stringify({ audio_streams: [{ type: 'hls_ts', url: 'https://cdn.example.test/index.m3u8' }] }) });
  await transport.load(tuple(), s.player); await transport.play();
  assert.equal(s.engines.length, 1); assert.equal(s.engines[0].config.emeEnabled, false); assert.equal(s.engines[0].config.enableWorker, true);
  transport.stop();
  assert.equal(s.engines[0].destroyed, true); assert.equal(s.media[0].src, ''); assert.equal(transport.read().playing, false);
  transport.destroy();
});

test('missing HLS support fails explicitly and does not start the official player', async () => {
  const s = site({ hlsSupported: false }); const transport = s.create();
  s.player._ensureHasURL = async data => ({ ...data, url: 'https://cdn.example.test/index.m3u8' });
  try { await assert.rejects(transport.load(tuple(), s.player), /модуль HLS/); assert.equal(s.calls.includes('media.play'), false); }
  finally { transport.destroy(); }
});

test('DRM-only or local-address sources cannot be installed', async () => {
  for (const result of [
    { url: 'http://cdn.example.test/track.mp3' },
    { url: 'https://127.0.0.1/private.mp3' },
    { extra: { audio_streams: [{ type: 'hls_ts', drm: true, url: 'https://cdn.example.test/protected.m3u8' }] } },
    { extra: { audio_streams: [{ type: 'dash', url: 'https://cdn.example.test/protected.mpd' }] } },
  ]) {
    const s = site(); const transport = s.create();
    s.player._ensureHasURL = async data => ({ ...data, ...result });
    try { await assert.rejects(transport.load(tuple(), s.player), /не предоставил доступный/); assert.equal(s.media.length, 0); }
    finally { transport.destroy(); }
  }
});

test('raw resolver error details never reach user-visible playback state', async () => {
  const s = site(); const transport = s.create();
  s.player._ensureHasURL = async () => { throw new Error('https://cdn.example.test/private?token=secret'); };
  try { await assert.rejects(transport.load(tuple(), s.player), /не подтвердил доступный/); assert.equal(transport.read().error.includes('secret'), false); }
  finally { transport.destroy(); }
});

test('destroy cancels loading and prevents future use', async () => {
  const s = site({ holdLoad: true }); const transport = s.create();
  const load = transport.load(tuple(), s.player); await tick(); transport.destroy();
  await assert.rejects(load, error => error.code === 'PULSE_DIRECT_CANCELLED');
  await assert.rejects(transport.load(tuple(), s.player), error => error.code === 'PULSE_DIRECT_CANCELLED');
  assert.equal(s.media[0].src, '');
});
