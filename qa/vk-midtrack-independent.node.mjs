import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

// Deliberately model browser events, rather than a perfect media source: a
// network `stalled` event is allowed while the buffered audio keeps advancing.
const source = await readFile(new URL('../src-tauri/src/vk_direct_audio.js', import.meta.url), 'utf8');
const adapterSource = await readFile(new URL('../src-tauri/src/vk_web_adapter.js', import.meta.url), 'utf8');

async function fixture() {
  const media = [];
  const playEvents = [];
  class Audio {
    constructor() {
      Object.assign(this, { listeners: new Map(), currentTime: 0, duration: 108, paused: true, ended: false, readyState: 0, src: '', volume: 1, seeking: false });
      this.buffered = { length: 1, start: () => 0, end: () => 90 };
      media.push(this);
    }
    addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(callback); }
    removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
    emit(type) { for (const callback of [...this.listeners.get(type) || []]) callback({ type }); }
    load() { if (this.src) queueMicrotask(() => { this.readyState = 4; this.emit('loadedmetadata'); this.emit('canplay'); }); }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    canPlayType() { return ''; }
    async play() { playEvents.push({ audio: this, position: this.currentTime }); this.playStartedAt = this.currentTime; this.paused = false; this.emit('playing'); }
    pause() { this.paused = true; this.emit('pause'); }
  }
  const context = { Audio, URL, Event, setTimeout, clearTimeout, location: { href: 'https://vk.com/audio' }, vk: { id: 101 } };
  context.window = context; context.top = context;
  vm.runInNewContext(source, context);
  const transport = context.__PULSE_CREATE_DIRECT_AUDIO__();
  await transport.load({ ownerId: 101, id: 1, url: 'https://cdn.example.test/song.mp3' }, {});
  await transport.play();
  return { audio: media.at(-1), transport, context, media, playEvents };
}

test('network stalled must not leave advancing buffered audio in a permanent buffering state', async () => {
  const f = await fixture();
  try {
    f.audio.currentTime = 29;
    f.audio.emit('stalled');
    // The browser can drain its buffer without issuing another canplay or
    // playing event. The app must observe real progress, not that stale event.
    for (const position of [30, 34, 38, 44]) {
      f.audio.currentTime = position;
      f.audio.emit('timeupdate');
      const status = f.transport.read();
      assert.equal(status.playing, true);
      assert.equal(status.position, position);
      assert.equal(status.buffering, false, `buffered playback at ${position}s was still called stalled`);
      assert.equal(status.error, null);
    }
  } finally { f.transport.destroy(); }
});

test('actual waiting without progress is still reported as buffering', async () => {
  const f = await fixture();
  try {
    f.audio.currentTime = 44;
    f.audio.readyState = 2;
    f.audio.buffered = { length: 0 };
    f.audio.emit('waiting');
    assert.equal(f.transport.read().buffering, true);
    assert.equal(f.transport.read().position, 44);
    assert.equal(f.transport.read().error, null);
  } finally { f.transport.destroy(); }
});

test('recovering from waiting by actual media progress needs no second playing event', async () => {
  const f = await fixture();
  try {
    f.audio.currentTime = 44;
    f.audio.readyState = 2;
    f.audio.emit('waiting');
    assert.equal(f.transport.read().buffering, true);
    f.audio.readyState = 4;
    f.audio.currentTime = 44.5;
    f.audio.emit('timeupdate');
    assert.equal(f.transport.read().buffering, false);
    assert.equal(f.transport.read().playing, true);
  } finally { f.transport.destroy(); }
});

test('native polling sees progress even when hidden-window timeupdate events are suppressed', async () => {
  const f = await fixture();
  try {
    f.audio.currentTime = 29;
    f.transport.read();
    f.audio.emit('stalled');
    // In a hidden WebView, the native poller may run when timeupdate delivery
    // is throttled. Observe the clock itself without dispatching any events.
    for (const position of [30, 34, 38, 44]) {
      f.audio.currentTime = position;
      const status = f.transport.read();
      assert.equal(status.position, position);
      assert.equal(status.buffering, false, 'poll-visible audio progress inherited a stale network event');
      assert.equal(status.playing, true);
    }
  } finally { f.transport.destroy(); }
});

test('backward seek resets the progress baseline and recovers without another playing event', async () => {
  const f = await fixture();
  try {
    f.audio.currentTime = 44;
    f.audio.emit('timeupdate');
    f.transport.read();
    f.transport.seek(10);
    f.audio.seeking = true;
    f.audio.emit('seeking');
    f.audio.readyState = 2;
    f.audio.emit('waiting');
    f.transport.read();
    f.audio.seeking = false;
    f.audio.emit('seeked');
    f.audio.readyState = 4;
    for (const position of [10.5, 11, 12]) {
      f.audio.currentTime = position;
      f.audio.emit('timeupdate');
      assert.equal(f.transport.read().buffering, false, 'backward seek had to reach the old 44s position before recovering');
    }
  } finally { f.transport.destroy(); }
});

test('forward seek jump is not itself proof that a waiting source recovered', async () => {
  const f = await fixture();
  try {
    f.audio.currentTime = 44;
    f.audio.emit('timeupdate');
    f.transport.read();
    f.transport.seek(80);
    f.audio.seeking = true;
    f.audio.emit('seeking');
    f.audio.readyState = 2;
    f.audio.buffered = { length: 0 };
    f.audio.emit('waiting');
    f.audio.seeking = false;
    f.audio.emit('seeked');
    assert.equal(f.transport.read().position, 80);
    assert.equal(f.transport.read().buffering, true, 'the seek target jump hid a genuinely waiting source');
  } finally { f.transport.destroy(); }
});

async function adapterFixture() {
  const f = await fixture();
  f.transport.destroy();
  const raw = [1, 101, 'https://cdn.example.test/song.mp3', 'Song', 'QA', 108];
  f.context.getAudioPlayer = () => ({});
  f.context.document = { querySelector: () => null, createElement: () => ({ set innerHTML(value) { this.value = value; }, value: '' }) };
  f.context.ajax = { post(url, params, callbacks) {
    queueMicrotask(() => String(url).includes('owner_playlists') ? callbacks.onDone([], 0) : callbacks.onDone({ list: [raw], totalCount: 1 }));
  } };
  vm.runInNewContext(adapterSource, f.context);
  const api = f.context.__PULSE_VK_WEB__;
  api.start('independent-offset');
  for (let turn = 0; turn < 12; turn++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(api.read(true).complete, true, 'adapter fixture did not finish initial account sync');
  return { ...f, api };
}

test('real adapter restores the requested offset before starting the real direct transport', async () => {
  const f = await adapterFixture();
  try {
    const receipt = f.api.command({ operation: 'play', id: 'vk-101-1', position: 44.6 });
    for (let turn = 0; turn < 12 && receipt.pending; turn++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(receipt.accepted, true);
    assert.equal(receipt.pending, false);
    assert.equal(f.api.playback().playing, true);
    assert.equal(f.api.playback().position, 44.6);
    assert.equal(f.media.at(-1).playStartedAt, 44.6, 'song became audible before its saved offset was applied');
  } finally { f.api.command({ operation: 'stop' }); }
});

test('pausing an offset restore before metadata arrives cannot start that audio later', async () => {
  const f = await adapterFixture();
  try {
    const previousPlayCount = f.playEvents.length;
    const receipt = f.api.command({ operation: 'play', id: 'vk-101-1', position: 44.6 });
    f.api.command({ operation: 'pause' });
    for (let turn = 0; turn < 12; turn++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(receipt.pending, false);
    assert.equal(f.api.playback().playing, false);
    assert.equal(f.api.playback().error, null);
    assert.equal(f.playEvents.length, previousPlayCount, 'cancelled saved-position playback resurrected after metadata');
    assert.ok(f.media.every(audio => audio.paused), 'a cancelled or previous media element stayed audible');
  } finally { f.api.command({ operation: 'stop' }); }
});
