import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

// Independent transport fault tests. They model browser MediaError events,
// rather than checking implementation helpers or retry counters.
const source = await readFile(new URL('../src-tauri/src/vk_direct_audio.js', import.meta.url), 'utf8');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
// These recovery cases explicitly exercise initial and renewed resolution.
// Already granted sources have separate vk-uploaded-source-recovery coverage.
const tuple = (id = 7) => ({ id, owner_id: 42, duration: 108 });
async function until(predicate, message, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() >= deadline) assert.fail(message); await sleep(5); }
}
function site({ recoveryPlayGate = null, publicPlayGate = null, holdRecoveryMetadata = false, failLoad = () => false, fakeClock = false } = {}) {
  const media = [], resolutions = [];
  class Audio {
    constructor() {
      this.listeners = new Map(); this.src = ''; this.currentTime = 0; this.duration = 108;
      this.paused = true; this.ended = false; this.seeking = false; this.readyState = 0; this.volume = 1;
      this.playOffsets = []; this.error = null; media.push(this);
    }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    dispatchEvent(event) { for (const fn of [...this.listeners.get(event.type) || []]) fn(event); return true; }
    emit(type) { this.dispatchEvent({ type }); }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    load() {
      if (this.src && !(holdRecoveryMetadata && media.indexOf(this) > 0)) queueMicrotask(() => {
        if (failLoad(this.src)) { this.fail(4); return; }
        this.readyState = 4; this.emit('loadedmetadata'); this.emit('canplay');
      });
    }
    canPlayType() { return ''; }
    async play() {
      this.playOffsets.push(this.currentTime);
      if (recoveryPlayGate && media.indexOf(this) > 0) await recoveryPlayGate.promise;
      if (publicPlayGate && media.indexOf(this) === 0 && this.playOffsets.length === 1) await publicPlayGate.promise;
      this.paused = false; this.emit('playing');
    }
    pause() { this.paused = true; this.emit('pause'); }
    fail(code = 2) { this.error = { code, message: 'private source URL must not leak' }; this.paused = true; this.emit('error'); }
  }
  const context = { setTimeout, clearTimeout, URL, Event, Audio, vk: { id: 101 }, location: { href: 'https://vk.ru/audio' } };
  let now = Date.now();
  if (fakeClock) context.Date = class extends Date { static now() { return now; } };
  context.window = context; context.top = context;
  vm.runInNewContext(source, context, { timeout: 1000 });
  let resolver = async (data, number) => ({ ...data, url: `https://cdn.example.test/fresh-${number}.mp3` });
  const player = { _ensureHasURL(data) { resolutions.push({ ...data }); return resolver(data, resolutions.length); } };
  const transport = context.__PULSE_CREATE_DIRECT_AUDIO__();
  return { context, media, resolutions, player, transport, advance: ms => { now += ms; }, setResolver: fn => { resolver = fn; } };
}
async function start(s, position = 44.6) {
  await s.transport.load(tuple(), s.player); await s.transport.play();
  s.media.at(-1).currentTime = position; s.media.at(-1).emit('timeupdate');
  assert.equal(s.transport.read().position, position);
}

test('mid-song file MediaError refreshes the session source and resumes the same offset before playing', async () => {
  const s = site();
  try {
    await start(s); s.media[0].fail();
    assert.equal(s.transport.read().error, null, 'a recoverable source fault was immediately exposed as terminal');
    await until(() => s.media.length >= 2 && !s.media.at(-1).paused, 'file playback never recovered automatically');
    assert.equal(s.resolutions.length, 2, 'expired URL was reused without consulting the signed-in resolver');
    assert.equal(s.resolutions[1].url, undefined, 'the fresh resolve was biased with the failed URL');
    assert.match(s.media.at(-1).src, /fresh-2\.mp3$/);
    assert.ok(s.media.at(-1).playOffsets[0] >= 44.5, 'replacement audio played a fragment from zero before restoring the offset');
    assert.ok(s.transport.read().position >= 44.5);
    assert.equal(s.transport.read().ended, false);
    assert.equal(s.transport.read().error, null);
  } finally { s.transport.destroy(); }
});

for (const command of ['pause', 'stop', 'destroy']) {
  test(`${command} cancels a pending automatic source refresh; late resolution cannot autoplay`, async () => {
    const s = site(); const gate = deferred();
    try {
      await start(s);
      s.setResolver((data, number) => gate.promise.then(() => ({ ...data, url: `https://cdn.example.test/recovered-${number}.mp3` })));
      s.media[0].fail();
      await until(() => s.resolutions.length === 2, 'mid-track error did not initiate source recovery');
      s.transport[command](); gate.resolve(); await sleep(40);
      assert.equal(s.media.length, 1, 'cancelled refresh installed a late audio element');
      assert.equal(s.transport.read().playing, false);
      assert.equal(s.transport.read().buffering, false);
      assert.equal(s.transport.read().error, null);
    } finally { gate.resolve(); s.transport.destroy(); }
  });
}

test('track replacement cancels recovery of the old track without changing new source or position', async () => {
  const s = site(); const gate = deferred();
  try {
    await start(s);
    s.setResolver((data, number) => data.id === 7
      ? gate.promise.then(() => ({ ...data, url: 'https://cdn.example.test/late-old.mp3' }))
      : Promise.resolve({ ...data, url: `https://cdn.example.test/new-${number}.mp3` }));
    s.media[0].fail();
    await until(() => s.resolutions.length === 2, 'source refresh did not start');
    await s.transport.load(tuple(8), s.player); await s.transport.play();
    s.media.at(-1).currentTime = 3; gate.resolve(); await sleep(40);
    assert.match(s.media.at(-1).src, /new-/);
    assert.equal(s.transport.read().position, 3);
    assert.equal(s.transport.read().playing, true);
    assert.equal(s.media.length, 2);
  } finally { gate.resolve(); s.transport.destroy(); }
});

test('account change during recovery never starts an old-account source', async () => {
  const s = site(); const gate = deferred();
  try {
    await start(s);
    s.setResolver(data => gate.promise.then(() => ({ ...data, url: 'https://cdn.example.test/old-account.mp3' })));
    s.media[0].fail();
    await until(() => s.resolutions.length === 2, 'source refresh did not start');
    s.context.vk.id = 202; gate.resolve(); await sleep(40);
    assert.equal(s.media.length, 1);
    assert.equal(s.transport.read().playing, false);
  } finally { gate.resolve(); s.transport.destroy(); }
});

test('duplicate error events while refreshing cause only one resolver request', async () => {
  const s = site(); const gate = deferred();
  try {
    await start(s);
    s.setResolver(data => gate.promise.then(() => ({ ...data, url: 'https://cdn.example.test/recovered.mp3' })));
    s.media[0].fail(); s.media[0].fail(); s.media[0].fail();
    await until(() => s.resolutions.length >= 2, 'source refresh did not start');
    await sleep(40); assert.equal(s.resolutions.length, 2);
    gate.resolve(); await until(() => s.media.length >= 2 && !s.media.at(-1).paused, 'refresh did not finish');
  } finally { gate.resolve(); s.transport.destroy(); }
});

test('failed replacement URLs have a bounded recovery budget and preserve the last audible offset', async () => {
  const s = site();
  try {
    await start(s, 67.25);
    // Every replacement metadata load works, but each subsequent play fails.
    // Recovery must eventually stop rather than endlessly recreating sources.
    for (let fault = 0; fault < 8; fault++) {
      const count = s.media.length;
      s.media.at(-1).fail();
      await until(() => s.media.length > count || Boolean(s.transport.read().error), 'recovery remained pending indefinitely');
      if (s.transport.read().error) break;
    }
    assert.ok(s.transport.read().error, 'eight consecutive media failures never exhausted recovery');
    assert.ok(s.resolutions.length <= 4, `source recovery loop made ${s.resolutions.length} resolver calls`);
    assert.equal(s.transport.read().playing, false);
    assert.equal(s.transport.read().buffering, false);
    assert.ok(s.transport.read().position >= 67.2, 'terminal source failure discarded the resume position');
    assert.equal(s.transport.read().ended, false, 'a network fault was misreported as natural track end');
    assert.equal(JSON.stringify(s.transport.read()).includes('private source'), false);
  } finally { s.transport.destroy(); }
});

test('an error from paused media cannot create a background auto-resume', async () => {
  const s = site();
  try {
    await start(s); s.transport.pause(); s.media[0].fail(); await sleep(40);
    assert.equal(s.resolutions.length, 1); assert.equal(s.transport.read().playing, false);
  } finally { s.transport.destroy(); }
});

test('seek accepted during source refresh replaces the saved recovery offset', async () => {
  const s = site(); const gate = deferred();
  try {
    await start(s);
    s.setResolver(data => gate.promise.then(() => ({ ...data, url: 'https://cdn.example.test/recovered.mp3' })));
    s.media[0].fail();
    await until(() => s.resolutions.length === 2, 'source refresh did not start');
    // A successfully accepted new intent must win over the captured fault
    // position; recovery may otherwise unexpectedly jump backwards.
    s.transport.seek(80); gate.resolve();
    await until(() => s.media.length >= 2 && !s.media.at(-1).paused, 'refresh did not finish');
    assert.ok(s.media.at(-1).playOffsets[0] >= 79.9, 'recovery replayed the old seek target');
    assert.ok(s.transport.read().position >= 79.9);
  } finally { gate.resolve(); s.transport.destroy(); }
});

test('seek after replacement metadata but before play confirmation cannot restore the old offset', async () => {
  const gate = deferred(); const s = site({ recoveryPlayGate: gate });
  try {
    await start(s); s.media[0].fail();
    await until(() => s.media.length >= 2 && s.media.at(-1).playOffsets.length > 0, 'replacement never requested playback');
    s.transport.seek(80); gate.resolve();
    await until(() => !s.transport.read().recovering && s.transport.read().playing, 'replacement never confirmed playback');
    assert.ok(s.transport.read().position >= 79.9, `pending-play recovery overwrote the accepted seek: ${s.transport.read().position}`);
  } finally { gate.resolve(); s.transport.destroy(); }
});

test('pause during replacement play keeps the detached media silent after a late play completion', async () => {
  const gate = deferred(); const s = site({ recoveryPlayGate: gate });
  try {
    await start(s); s.media[0].fail();
    await until(() => s.media.length >= 2 && s.media.at(-1).playOffsets.length > 0, 'replacement never requested playback');
    const replacement = s.media.at(-1);
    s.transport.pause(); gate.resolve(); await sleep(40);
    assert.equal(replacement.paused, true, 'late play completion resurrected a detached recovery audio element');
    assert.equal(s.transport.read().playing, false); assert.equal(s.transport.read().error, null);
  } finally { gate.resolve(); s.transport.destroy(); }
});

test('pause during replacement metadata loading releases that source and cannot autoplay later', async () => {
  const s = site({ holdRecoveryMetadata: true });
  try {
    await start(s); s.media[0].fail();
    await until(() => s.media.length >= 2, 'replacement metadata load never started');
    const replacement = s.media.at(-1);
    s.transport.pause(); replacement.readyState = 4; replacement.emit('loadedmetadata'); replacement.emit('canplay'); await sleep(40);
    assert.equal(replacement.playOffsets.length, 0); assert.equal(replacement.src, '');
    assert.equal(s.transport.read().playing, false); assert.equal(s.transport.read().buffering, false);
  } finally { s.transport.destroy(); }
});

test('cancelled public play stays silent when its original promise resolves after cancellation completed', async () => {
  const gate = deferred(); const s = site({ publicPlayGate: gate });
  try {
    await s.transport.load(tuple(), s.player);
    const pendingPlay = s.transport.play();
    const rejected = assert.rejects(pendingPlay, error => error.code === 'PULSE_DIRECT_CANCELLED');
    s.transport.pause(); await rejected;
    // Resolve only after the bounded wrapper has already rejected: a catch
    // outside that wrapper cannot intercept this late native completion.
    gate.resolve(); await sleep(40);
    assert.equal(s.media[0].paused, true); assert.equal(s.transport.read().playing, false);
  } finally { gate.resolve(); s.transport.destroy(); }
});

test('old public play completion cannot pause a newer valid resume on the same audio element', async () => {
  const gate = deferred(); const s = site({ publicPlayGate: gate });
  try {
    await s.transport.load(tuple(), s.player);
    const pendingPlay = s.transport.play();
    const rejected = assert.rejects(pendingPlay, error => error.code === 'PULSE_DIRECT_CANCELLED');
    s.transport.pause(); await rejected;
    await s.transport.play(); assert.equal(s.transport.read().playing, true);
    gate.resolve(); await sleep(40);
    assert.equal(s.transport.read().playing, true, 'the older cancelled play continuation paused the newer active play intent');
  } finally { gate.resolve(); s.transport.destroy(); }
});

test('a broken source selected by the site factory cannot hide the valid session-granted progressive MP3', async () => {
  const s = site({ failLoad: url => url.includes('factory-broken') });
  try {
    s.setResolver(data => ({ ...data, url: 'https://vk.ru/audio_api_unavailable?masked', extra: {
      audio_streams: [{ type: 'mp3', url: 'https://cdn.example.test/session-fallback.mp3' }],
    } }));
    s.player._impl = { _private_123__createAudio() { return { sources: [{ format: 'mp3', url: 'https://cdn.example.test/factory-broken.mp3' }] }; } };
    await s.transport.load(tuple(), s.player); await s.transport.play();
    assert.equal(s.media.length, 1, 'the provider-granted progressive source should play before attempting the broken factory preference');
    assert.match(s.media.at(-1).src, /session-fallback\.mp3$/);
    assert.equal(s.media.some(audio => audio.src.includes('factory-broken')), false, 'a broken factory preference was attempted before the valid progressive source');
    assert.equal(s.transport.read().playing, true); assert.equal(s.transport.read().error, null);
    assert.equal(JSON.stringify(s.transport.read()).includes('https:'), false, 'transport status leaked a raw session source URL');
  } finally { s.transport.destroy(); }
});

test('a silent decoder stall recovers without waiting for a browser error event', async () => {
  const s = site({ fakeClock: true });
  try {
    await start(s); const original = s.media[0];
    // paused=false is legal while HTML audio waits for data. Browser event
    // flags may all remain stale, so only the unchanged clock reveals it.
    assert.equal(original.paused, false);
    s.advance(8100); const stalled = s.transport.read();
    assert.equal(stalled.recovering, true); assert.equal(stalled.error, null);
    await until(() => s.media.length >= 2 && !s.media.at(-1).paused, 'silent stall never triggered automatic source refresh');
    assert.ok(s.transport.read().position >= 44.5); assert.equal(s.resolutions.length, 2);
    assert.equal(original.paused, true);
  } finally { s.transport.destroy(); }
});

test('regularly progressing playback cannot trigger automatic source renewal', async () => {
  const s = site({ fakeClock: true });
  try {
    await start(s);
    for (let second = 1; second <= 40; second++) {
      s.advance(1000); s.media[0].currentTime = 44.6 + second;
      s.transport.read();
    }
    assert.equal(s.resolutions.length, 1); assert.equal(s.transport.read().recovering, false);
    assert.equal(s.transport.read().playing, true);
  } finally { s.transport.destroy(); }
});

test('the no-progress recovery detector never interrupts a pending initial play before it has played once', async () => {
  const gate = deferred(); const s = site({ publicPlayGate: gate, fakeClock: true });
  try {
    await s.transport.load(tuple(), s.player); const pendingPlay = s.transport.play();
    for (let second = 0; second < 75; second++) {
      s.advance(1000); const status = s.transport.read();
      assert.equal(status.recovering, false); assert.equal(status.error, null);
    }
    assert.equal(s.resolutions.length, 1, 'no-progress detection replaced a source still in its initial startup phase');
    gate.resolve(); await pendingPlay;
    assert.equal(s.transport.read().playing, true);
  } finally { gate.resolve(); s.transport.destroy(); }
});
