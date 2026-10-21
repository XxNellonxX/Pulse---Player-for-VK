import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

// A source already granted inside the current VK session must remain usable
// when the website's separate URL resolver cannot handle uploaded audio.
// Synthetic URLs/media only; no user account or real service is touched.
const source = await readFile(new URL('../src-tauri/src/vk_direct_audio.js', import.meta.url), 'utf8');
const granted = 'https://cdn.example.test/uploaded-original.mp3';
function tuple({ url = granted, hashes = '//////', extra = {} } = {}) {
  const raw = [];
  raw[0] = 7; raw[1] = 101; raw[2] = url; raw[5] = 137;
  raw[12] = extra; raw[13] = hashes;
  return raw;
}

function fixture() {
  const media = [];
  let now = 100000;
  class Audio {
    constructor() {
      this.listeners = new Map(); this.currentTime = 0; this.duration = 137;
      this.readyState = 0; this.paused = true; this.ended = false; this.src = '';
      media.push(this);
    }
    addEventListener(type, listener) { const listeners = this.listeners.get(type) || new Set(); listeners.add(listener); this.listeners.set(type, listeners); }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    emit(type) { for (const listener of this.listeners.get(type) || []) listener({ type }); }
    load() { if (this.src) queueMicrotask(() => { this.readyState = 4; this.emit('loadedmetadata'); this.emit('canplay'); }); }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    play() { this.paused = false; this.emit('playing'); return Promise.resolve(); }
    pause() { this.paused = true; }
    canPlayType() { return ''; }
  }
  const sandbox = {
    location: { href: 'https://vk.com/audio' }, vk: { id: 101 }, Audio, URL, Event,
    Date: { now: () => now },
    setTimeout: (callback, milliseconds) => setTimeout(() => { now += milliseconds; callback(); }, Math.min(milliseconds, 25)),
    clearTimeout,
  };
  sandbox.window = sandbox; sandbox.top = sandbox;
  vm.runInNewContext(source, sandbox);
  return { media, sandbox, transport: sandbox.__PULSE_CREATE_DIRECT_AUDIO__() };
}

async function assertPlays(raw, player) {
  const f = fixture();
  try {
    await f.transport.load(raw, player);
    await f.transport.play();
    assert.equal(f.transport.read().playing, true);
    assert.equal(f.media.at(-1).src, granted);
    assert.equal(JSON.stringify(f.transport.read()).includes('https:'), false);
  } finally { f.transport.destroy(); }
}

test('uploaded tuple retains its session-granted file when hashed URL resolver rejects', async () => {
  await assertPlays(tuple({ hashes: 'add/edit/action/delete/replace/urlhash/restore' }), {
    _ensureHasURL: async () => { throw new Error('temporary resolver failure'); },
  });
});

test('uploaded object source does not depend on an unresolved website resolver', async () => {
  await assertPlays({ id: 7, ownerId: 101, url: granted, duration: 137 }, {
    _ensureHasURL: () => new Promise(() => {}),
  });
});

test('explicit uploaded MP3 stream works when the legacy URL field is empty', async () => {
  await assertPlays(tuple({ url: '', extra: { audio_streams: [{ type: 'mp3', url: granted }] } }), {
    _ensureHasURL: () => new Promise(() => {}),
  });
});

test('optional website source factory failure cannot discard an explicit playable file', async () => {
  await assertPlays(tuple(), {
    _ensureHasURL: () => new Promise(() => {}),
    _impl: { _private__createAudio() { throw new Error('website factory changed'); } },
  });
});

test('unavailable masked upload terminates loading without exposing its source details', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.transport.load(tuple({ url: 'https://vk.com/audio_api_unavailable?extra=private' }), {
      _ensureHasURL: () => new Promise(() => {}),
    }));
    const status = f.transport.read();
    assert.equal(status.buffering, false);
    assert.equal(status.playing, false);
    assert.ok(status.error);
    assert.equal(JSON.stringify(status).includes('private'), false);
  } finally { f.transport.destroy(); }
});
