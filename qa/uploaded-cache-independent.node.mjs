import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { installDirectFixture } from './vk-direct-fixture.mjs';

const source = await readFile(process.env.PULSE_ADAPTER_TEST_SOURCE || new URL('../src-tauri/src/vk_web_adapter.js', import.meta.url), 'utf8');
const settle = async () => { for (let n = 0; n < 12; n++) await new Promise(resolve => setImmediate(resolve)); };
const raw = id => [id, 101, '', `Track ${id}`, 'Artist', 137];
const track = id => ({ id: `vk-101-${id}`, source: 'vk', url: `vk-web://101/${id}`, title: `Track ${id}`, artist: 'Artist', duration: 137, available: true, remote: { ownerId: 101, audioId: id, inLibrary: true } });

function fixture({ moved = false } = {}) {
  const timers = new Set(), requests = [];
  const sandbox = {
    window: null, URL,
    document: { querySelector: () => null, createElement: () => ({ set innerHTML(value) { this.value = value; }, value: '' }) },
    setTimeout(callback, delay) { const timer = setTimeout(callback, delay); timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
  };
  const window = {
    location: { href: 'https://vk.com/audio' }, vk: { id: 101 }, getAudioPlayer: () => ({}),
    ajax: { post(url, params, callbacks) {
      requests.push({ url, params });
      // Keep the background catalogue read unresolved. User playback must use
      // its saved identity before a full catalogue re-read has completed.
      if (requests.length === 1) return;
      const page = moved && params.offset > 0
        ? { list: [raw(3)], totalCount: 2 }
        : { list: moved ? [raw(2), raw(1)] : [raw(2)], totalCount: moved ? 2 : 1 };
      queueMicrotask(() => callbacks.onDone(page));
    } },
  };
  sandbox.window = window; window.top = window;
  const direct = installDirectFixture(window);
  vm.runInNewContext(source, sandbox);
  const api = window.__PULSE_VK_WEB__;
  api.start('cold-saved-library', { accountId: 101, tracks: [track(1), track(2)], playlists: [], index: {} });
  return { api, direct, requests, dispose() { for (const timer of timers) clearTimeout(timer); } };
}

test('saved own uploaded track plays before background tuple restoration completes', async () => {
  const f = fixture();
  try {
    await settle();
    assert.equal(f.api.status, 'syncing');
    const receipt = f.api.command({ operation: 'play', id: 'vk-101-2', position: 0 });
    await settle();
    assert.equal(receipt.accepted, true, receipt.error);
    assert.equal(receipt.pending, false);
    assert.equal(f.direct.loads.length, 1);
    assert.equal(f.direct.loads[0][0], 2);
    assert.equal(f.direct.playCalls, 1);
    assert.equal(f.requests[1].params.offset, 1);
    assert.equal(f.requests[1].params.playlist_id, -1);
  } finally { f.dispose(); }
});

test('saved own track moved from its cached offset is found in the current own collection', async () => {
  const f = fixture({ moved: true });
  try {
    await settle();
    const receipt = f.api.command({ operation: 'play', id: 'vk-101-2' });
    await settle();
    assert.equal(receipt.accepted, true, receipt.error);
    assert.equal(receipt.pending, false);
    assert.equal(f.direct.loads[0][0], 2);
    assert.equal(f.direct.playCalls, 1);
    assert.deepEqual(f.requests.slice(1).map(request => request.params.offset), [1, 0]);
  } finally { f.dispose(); }
});
