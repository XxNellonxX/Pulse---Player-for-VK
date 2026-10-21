import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { installDirectFixture } from './vk-direct-fixture.mjs';

const source = await readFile(new URL('../src-tauri/src/vk_web_adapter.js', import.meta.url), 'utf8');
const song = (id, title = `Song ${id}`, owner = 42) => [id, owner, `https://cdn.example.test/${id}.mp3`, title, 'Artist', 60];
const settle = async () => { for (let i = 0; i < 18; i++) await new Promise(r => setImmediate(r)); };
function fixture(seed, options = {}) {
  const requests = [], timers = new Set();
  const cards = [{ owner_id: 42, id: 3, title: 'Mix', size: 1, update_time: 5 }];
  let library = [song(1)], playlist = [song(2)], hold = null;
  const window = { location: { href: 'https://vk.com/audio' }, vk: { id: options.account ?? 42 }, getAudioPlayer: () => ({}) };
  window.top = window;
  window.ajax = { post(url, params, callbacks) {
    requests.push({ url, params });
    if (hold?.(url, params, callbacks)) return;
    queueMicrotask(() => {
      if (url.includes('owner_playlists')) return callbacks.onDone(cards, cards.length);
      const list = params.playlist_id === -1 ? library : playlist;
      callbacks.onDone({ list: list.slice(params.offset), totalCount: list.length, ownerId: 42, id: params.playlist_id });
    });
  } };
  const direct = installDirectFixture(window);
  const context = vm.createContext({ window, URL, console, Date,
    document: { querySelector: () => null, createElement: () => ({ set innerHTML(v) { this.value = v; }, value: '' }) },
    setTimeout(fn, delay) { const t = setTimeout(() => { timers.delete(t); fn(); }, delay); timers.add(t); return t; },
    clearTimeout(t) { clearTimeout(t); timers.delete(t); },
  });
  vm.runInContext(source, context);
  const api = window.__PULSE_VK_WEB__;
  api.start('initial', seed, { full: options.full === true });
  return { window, api, requests, cards, direct,
    read: () => JSON.parse(JSON.stringify(api.read(true))),
    setLibrary(value) { library = value; }, setPlaylist(value) { playlist = value; },
    hold(fn) { hold = fn; },
    close() { for (const timer of timers) clearTimeout(timer); },
  };
}
function cache(snapshot) { return { accountId: 42, tracks: snapshot.tracks, playlists: snapshot.playlists, index: snapshot.cacheIndex }; }
async function coldCache() {
  const f = fixture();
  try { await settle(); assert.equal(f.read().status, 'complete'); return cache(f.read()); }
  finally { f.close(); }
}

test('warm restart reuses unchanged playlist content but checks authoritative library/index', async () => {
  const f = fixture(await coldCache());
  try {
    await settle(); const result = f.read();
    assert.equal(result.complete, true);
    assert.equal(result.tracks.length, 2);
    assert.deepEqual(result.playlists[0].trackIds, ['vk-42-2']);
    assert.equal(f.requests.filter(x => x.params.playlist_id === 3).length, 0);
    assert.equal(f.requests.filter(x => x.params.playlist_id === -1).length, 1);
    assert.equal(f.requests.filter(x => x.url.includes('owner_playlists')).length, 1);
    assert.equal(JSON.stringify(result.cacheIndex).includes('cdn.'), false);
  } finally { f.close(); }
});
test('changed playlist revision loads only changed content, own-library deletion/order is exact', async () => {
  const f = fixture(await coldCache());
  try {
    await settle(); f.requests.length = 0;
    f.setLibrary([song(4), song(3)]); f.cards[0].update_time = 6; f.setPlaylist([song(5)]);
    f.api.start('changed'); await settle();
    const result = f.read();
    assert.deepEqual(result.tracks.filter(t => t.remote.inLibrary).map(t => t.id), ['vk-42-4', 'vk-42-3']);
    assert.deepEqual(result.playlists[0].trackIds, ['vk-42-5']);
    assert.equal(result.tracks.some(t => t.id === 'vk-42-1'), false);
    assert.equal(f.requests.filter(x => x.params.playlist_id === 3).length, 1);
  } finally { f.close(); }
});
test('manual full refresh and stale manifests revalidate unchanged-count playlist interiors', async () => {
  const seed = await coldCache();
  for (const full of [false, true]) {
    const copy = structuredClone(seed);
    if (!full) copy.index['vk-playlist-42-3'].checkedAt -= 11 * 60 * 1000;
    const f = fixture(copy, { full });
    try { f.setPlaylist([song(99)]); await settle(); assert.deepEqual(f.read().playlists[0].trackIds, ['vk-42-99']); }
    finally { f.close(); }
  }
});
test('cache from another account is never used even when card identity matches', async () => {
  const seed = await coldCache(); seed.accountId = 7;
  const f = fixture(seed);
  try { await settle(); assert.equal(f.requests.filter(x => x.params.playlist_id === 3).length, 1); }
  finally { f.close(); }
});
test('cached playlist-only playback resolves fresh raw tuple on demand without full resync', async () => {
  const f = fixture(await coldCache());
  try {
    await settle(); f.requests.length = 0;
    const command = f.api.command({ operation: 'play', id: 'vk-42-2', requestId: 'play' });
    assert.equal(command.accepted, true); await settle();
    assert.equal(command.pending, false); assert.equal(command.accepted, true);
    assert.equal(f.direct.loads.at(-1)[0], 2); assert.equal(f.direct.playCalls, 1);
    assert.equal(f.requests.filter(x => x.params.playlist_id === 3).length, 1);
    assert.equal(f.requests.some(x => x.params.playlist_id === -1), false);
  } finally { f.close(); }
});
test('account switch during lazy tuple lookup cannot play the old cached track', async () => {
  const f = fixture(await coldCache());
  try {
    await settle(); let callback;
    f.hold((_url, params, cb) => { if (params.playlist_id === 3) { callback = cb; return true; } return false; });
    const command = f.api.command({ operation: 'play', id: 'vk-42-2', requestId: 'play' });
    f.window.vk.id = 43;
    callback.onDone({ list: [song(2)], totalCount: 1 }); await settle();
    assert.equal(f.direct.playCalls, 0); assert.equal(command.pending, false);
  } finally { f.close(); }
});
test('search acceptance registers playable metadata without leaking raw media URLs', async () => {
  const f = fixture();
  try {
    await settle(); const result = f.api.acceptSearch([song(55, 'Global', 9)]);
    assert.equal(result[0].remote.searchResult, true); assert.equal(result[0].url, 'vk-web://9/55');
    f.api.command({ operation: 'play', id: result[0].id }); await settle();
    assert.equal(f.direct.loads.at(-1)[0], 55);
    f.api.start('background'); await settle();
    f.api.command({ operation: 'play', id: result[0].id }); await settle();
    assert.equal(f.direct.loads.at(-1)[0], 55);
  } finally { f.close(); }
});
test('a pinned global-search result can resolve its exact identity after a process restart', async () => {
  const seed = await coldCache();
  seed.tracks.push({ id: 'vk-9-55', title: 'Global', artist: 'Artist', album: '', duration: 60,
    url: 'vk-web://9/55', source: 'vk', available: true, remote: { ownerId: 9, audioId: 55, inLibrary: false, searchResult: true } });
  const f = fixture(seed);
  try {
    await settle();
    f.hold((_url, params, cb) => { if (params.type === 'search') { queueMicrotask(() => cb.onDone({ list: [song(55, 'Global', 9)] })); return true; } return false; });
    const command = f.api.command({ operation: 'play', id: 'vk-9-55' }); await settle();
    assert.equal(command.accepted, true); assert.equal(command.pending, false);
    assert.equal(f.direct.loads.at(-1)[0], 55); assert.equal(f.direct.playCalls, 1);
    assert.equal(f.requests.filter(x => x.params.type === 'search').length, 1);
  } finally { f.close(); }
});
