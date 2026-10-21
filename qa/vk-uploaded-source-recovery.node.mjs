import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

// Uploaded-source renewal failures remain deterministic and isolated. No
// requests are made and no real account/profile is read or modified.
const source = await readFile(new URL('../src-tauri/src/vk_direct_audio.js', import.meta.url), 'utf8');
const stale = 'https://fixture.example.test/stale.mp3';
const fresh = 'https://fixture.example.test/fresh.mp3';
const raw = () => ({ ownerId: 101, id: 7, url: stale, actionHash: 'action', urlHash: 'hash' });

function fixture({ stalled = false, cachedPlays = false } = {}) {
  let now = 1000;
  const media = [], requests = [];
  class Audio extends EventTarget {
    constructor() { super(); Object.assign(this, { currentTime: 0, duration: 137, readyState: 0, paused: true, ended: false, src: '' }); media.push(this); }
    load() {
      if (!this.src) return;
      requests.push(this.src);
      if (this.src === stale && stalled) return;
      queueMicrotask(() => {
        if (this.src === stale && !cachedPlays) this.dispatchEvent(new Event('error'));
        else if (this.src) { this.readyState = 4; this.dispatchEvent(new Event('loadedmetadata')); }
      });
    }
    play() { this.paused = false; this.dispatchEvent(new Event('playing')); return Promise.resolve(); }
    pause() { this.paused = true; }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    canPlayType() { return ''; }
  }
  const context = { Audio, URL, Event, vk: { id: 101 }, location: { href: 'https://vk.com/audio' }, Date: { now: () => now }, clearTimeout,
    setTimeout(callback, milliseconds) { return setTimeout(() => { now += milliseconds; callback(); }, Math.min(milliseconds, 20)); } };
  context.window = context; context.top = context;
  vm.runInNewContext(source, context);
  return { transport: context.__PULSE_CREATE_DIRECT_AUDIO__(), media, requests, context };
}

for (const stalled of [false, true]) {
  test(`${stalled ? 'stalled' : 'expired'} granted upload refreshes the same identity before playing`, async () => {
    const f = fixture({ stalled }); let calls = 0;
    try {
      await f.transport.load(raw(), { _ensureHasURL: async input => {
        calls++; assert.equal(input.url, undefined); assert.equal(input.fullId, '101_7');
        return { ...input, url: fresh };
      } });
      await f.transport.play();
      assert.equal(calls, 1);
      assert.deepEqual(f.requests, [stale, fresh]);
      assert.equal(f.transport.read().playing, true);
      assert.equal(f.transport.read().error, null);
      assert.equal(f.media[0].paused, true);
    } finally { f.transport.destroy(); }
  });
}

for (const replacement of [{ id: 8 }, { restrictionStatus: 1 }]) {
  test(`failed upload cannot fall back to ${replacement.id ? 'a different identity' : 'restricted refreshed data'}`, async () => {
    const f = fixture();
    try {
      await assert.rejects(f.transport.load(raw(), { _ensureHasURL: async input => ({ ...input, url: fresh, ...replacement }) }));
      assert.deepEqual(f.requests, [stale]);
      assert.equal(f.transport.read().playing, false);
      assert.equal(f.transport.read().buffering, false);
      assert.ok(f.transport.read().error);
    } finally { f.transport.destroy(); }
  });
}

test('artist resolver remains authoritative even with an available cached file', async () => {
  const f = fixture();
  try {
    const track = { ...raw(), __pulseResolveSource: async () => ({ ownerId: 101, id: 8, url: fresh }) };
    await assert.rejects(f.transport.load(track, {}), /другой трек/);
    assert.equal(f.requests.length, 0);
  } finally { f.transport.destroy(); }
});

test('a playing uploaded file obtains a fresh URL on mid-song failure and preserves its offset', async () => {
  const f = fixture({ cachedPlays: true }); let calls = 0;
  try {
    await f.transport.load(raw(), { _ensureHasURL: async input => {
      calls++; assert.equal(input.url, undefined); return { ...input, url: fresh };
    } });
    await f.transport.play();
    assert.equal(calls, 0, 'initial playback unnecessarily depended on the website resolver');
    f.media[0].currentTime = 44;
    f.media[0].dispatchEvent(new Event('timeupdate'));
    f.media[0].dispatchEvent(new Event('error'));
    for (let n = 0; n < 20 && !f.transport.read().playing; n++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1, 'source failure did not force a fresh same-track resolution');
    assert.equal(f.media.at(-1).src, fresh);
    assert.equal(f.transport.read().position, 44);
    assert.equal(f.transport.read().playing, true);
    assert.equal(f.media[0].paused, true);
  } finally { f.transport.destroy(); }
});
