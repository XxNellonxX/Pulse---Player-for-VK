import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { installDirectFixture } from './vk-direct-fixture.mjs';

const source = await readFile(new URL('../src-tauri/src/vk_web_adapter.js', import.meta.url), 'utf8');
const song = id => [id, 101, '', `Song ${id}`, 'QA', 60];
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

function site(route) {
  const timers = new Set();
  const requests = [];
  const temporary = { list: [], getSelf() { return this; }, mergeWith(data) { this.list = data.list; } };
  const player = {
    getPlaylist: () => temporary,
    getPlaylistQueue: () => ({ clean() {}, isPending: false }),
    setRepeatState() {}, play() {}, subscribe() {},
  };
  const window = {
    location: { href: 'https://vk.com/audio' }, vk: { id: 101 },
    getAudioPlayer: () => player,
    ajax: { post(url, params, callbacks) {
      requests.push({ url, params });
      const response = route(params);
      queueMicrotask(() => callbacks.onDone(...response));
    } },
  };
  window.top = window;
  installDirectFixture(window);
  vm.runInNewContext(source, {
    window, URL, console,
    document: { querySelector: () => null, createElement: () => ({ value: '', set innerHTML(value) { this.value = value; } }) },
    setTimeout(callback, delay) {
      const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
      timers.add(timer); return timer;
    },
    clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
  });
  return {
    api: window.__PULSE_VK_WEB__, requests,
    read: () => JSON.parse(JSON.stringify(window.__PULSE_VK_WEB__.read(true))),
    close: () => { for (const timer of timers) clearTimeout(timer); },
  };
}

test('library pages retain VK sequence across numeric offsets and playlist metadata overlap', async () => {
  const f = site(params => {
    if (params.act !== 'load_section') return [[{ ownerId: 101, id: 7, title: 'Mix' }], 1];
    if (params.playlist_id === -1) return [{ list: params.offset === 0 ? [song(9), song(2)] : [song(7), song(1)], totalCount: 4 }];
    return [{ list: [song(1), song(11), song(9)], totalCount: 3 }];
  });
  try {
    f.api.start('ordered-library'); await settle();
    const snapshot = f.read();
    assert.equal(snapshot.complete, true);
    assert.deepEqual(snapshot.tracks.filter(track => track.remote.inLibrary).map(track => track.id), ['vk-101-9', 'vk-101-2', 'vk-101-7', 'vk-101-1']);
    assert.deepEqual(f.requests.filter(request => request.params.playlist_id === -1).map(request => request.params.offset), [0, 2]);
    assert.deepEqual(snapshot.playlists[0].trackIds, ['vk-101-1', 'vk-101-11', 'vk-101-9']);
  } finally { f.close(); }
});

test('same-count library page overlap rejects partial refresh while previous playback cache survives', async () => {
  let refreshing = false;
  const f = site(params => {
    if (params.act !== 'load_section') return [[], 0];
    const ids = refreshing
      ? (params.offset === 0 ? [8, 1] : [1, 2])
      : [1, 2, 3, 4];
    return [{ list: ids.map(song), totalCount: 4 }];
  });
  try {
    f.api.start('previous-complete'); await settle();
    assert.equal(f.read().complete, true);
    refreshing = true;
    f.api.start('shifted-offsets'); await settle();
    const failed = f.read();
    assert.equal(failed.status, 'error');
    assert.equal(failed.complete, false, 'a three-identity subset replaced the four-track library');
    assert.equal(failed.tracks, undefined, 'failed sync exposed a partial authoritative snapshot');
    assert.equal(failed.errorCode, 'repeated_library_audio');
    assert.equal(f.api.command({ operation: 'play', id: 'vk-101-4', requestId: 'previous-cache' }).accepted, true, 'failed refresh discarded the prior complete playback cache');
    assert.equal(f.api.command({ operation: 'play', id: 'vk-101-8', requestId: 'partial-source' }).accepted, false, 'an uncommitted partial tuple entered the playback cache');
  } finally { f.close(); }
});

test('legitimate playlist overlaps keep occurrence order while library overlaps are rejected', async () => {
  const f = site(params => {
    if (params.act !== 'load_section') return [[{ ownerId: 101, id: 7, title: 'Repeats' }], 1];
    if (params.playlist_id === -1) return [{ list: [song(1), song(2), song(3)], totalCount: 3 }];
    return [{ list: params.offset === 0 ? [song(1), song(2)] : [song(2), song(3)], totalCount: 4 }];
  });
  try {
    f.api.start('intentional-playlist-overlap'); await settle();
    const snapshot = f.read();
    assert.equal(snapshot.complete, true);
    assert.deepEqual(snapshot.playlists[0].trackIds, ['vk-101-1', 'vk-101-2', 'vk-101-2', 'vk-101-3']);
    assert.equal(snapshot.tracks.length, 3);
  } finally { f.close(); }
});
