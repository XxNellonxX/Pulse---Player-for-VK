import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { installDirectFixture } from './vk-direct-fixture.mjs';
const source = await readFile(new URL('../src-tauri/src/vk_web_adapter.js', import.meta.url), 'utf8');
const song = (id, owner = 42) => [id, owner, `https://fixture.invalid/${id}.mp3`, `Song ${id}`, 'Artist', 60];
const settle = async () => { for (let n = 0; n < 20; n++) await new Promise(resolve => setImmediate(resolve)); };
function fixture() {
  const calls = [], timers = new Set(), cards = [{ owner_id: 42, id: 3, title: 'Mix', description: 'Old', size: 1, update_time: 2 }, { owner_id: 42, id: 7, title: 'Other', description: '', size: 1, update_time: 2 }];
  const playlists = new Map([[3, [song(2)]], [7, [song(3)]]]); let library = [song(1), song(2), song(3)], hold;
  const w = { location: { href: 'https://vk.com/audio' }, vk: { id: 42 }, getAudioPlayer: () => ({}) }; w.top = w;
  w.ajax = { post(url, params, cb) { calls.push({ url, params }); if (hold?.(url, params, cb)) return; queueMicrotask(() => { if (url.includes('owner_playlists')) return cb.onDone(cards, cards.length); const list = params.playlist_id === -1 ? library : playlists.get(params.playlist_id) || []; cb.onDone({ list: list.slice(params.offset), totalCount: list.length, ownerId: 42, id: params.playlist_id }); }); } };
  installDirectFixture(w);
  vm.runInContext(source, vm.createContext({ window: w, URL, Date, console, document: { querySelector: () => null, createElement: () => ({ set innerHTML(v) { this.value = v; }, value: '' }) }, setTimeout(fn, ms) { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; }, clearTimeout(id) { clearTimeout(id); timers.delete(id); } }));
  const api = w.__PULSE_VK_WEB__; api.start('r');
  return { api, w, calls, cards, playlists, hold(fn) { hold = fn; }, setLibrary(value) { library = value; }, close() { for (const timer of timers) clearTimeout(timer); } };
}
test('create returns verified exact composition and reuses every unchanged playlist interior', async () => {
  const f = fixture(); try { await settle(); f.calls.length = 0;
    const result = await f.api.playlistAction({ operation: 'create', title: 'New', description: 'Night', trackIds: ['vk-42-3', 'vk-42-1'] }, 42, async raws => { assert.deepEqual(Array.from(raws, raw => raw[0]), [3, 1]); f.cards.push({ owner_id: 42, id: 5, title: 'New', description: 'Night', size: 2, update_time: 2 }); f.playlists.set(5, [song(3), song(1)]); return { ownerId: 42, playlistId: 5, title: 'New', description: 'Night', trackIds: ['vk-42-3', 'vk-42-1'] }; });
    assert.equal(result.playlistKey, 'vk-playlist-42-5'); assert.deepEqual([...result.trackIds], ['vk-42-3', 'vk-42-1']); assert.equal(f.calls.filter(call => [3, 7].includes(call.params.playlist_id)).length, 0); assert.equal(f.calls.filter(call => call.params.playlist_id === 5).length, 1);
  } finally { f.close(); }
});
test('same revision edit still reloads the exact target and rejects reordered or stale contents', async () => {
  for (const correct of [true, false]) { const f = fixture(); try { await settle(); f.calls.length = 0;
    const pending = f.api.playlistAction({ operation: 'edit', playlistId: 'vk-playlist-42-3', trackIds: ['vk-42-3', 'vk-42-1'] }, 42, async () => { f.cards[0].size = 2; f.playlists.set(3, correct ? [song(3), song(1)] : [song(1), song(3)]); return { ownerId: 42, playlistId: 3, title: 'Mix', description: 'Old', trackIds: ['vk-42-3', 'vk-42-1'] }; });
    if (correct) assert.deepEqual([...(await pending).trackIds], ['vk-42-3', 'vk-42-1']); else await assert.rejects(pending, /playlist_not_verified/);
    assert.equal(f.calls.filter(call => call.params.playlist_id === 3).length, 1); assert.equal(f.calls.filter(call => call.params.playlist_id === 7).length, 0);
  } finally { f.close(); } }
});
test('add verifies canonical copied identity exactly once while preserving every previous position', async () => {
  for (const duplicate of [false, true]) { const f = fixture(); try { await settle(); f.api.acceptSearch([song(55, 9)]);
    const pending = f.api.playlistAction({ operation: 'add-track', playlistId: 'vk-playlist-42-3', trackIds: ['vk-9-55'] }, 42, async () => { const list = duplicate ? [song(88), song(2), song(88)] : [song(88), song(2)]; f.playlists.set(3, list); f.cards[0].size = list.length; return { ownerId: 42, playlistId: 3, title: 'Mix', description: 'Old', trackIds: ['vk-42-2'], addedId: 'vk-42-88' }; });
    if (duplicate) await assert.rejects(pending, /playlist_not_verified|incomplete/); else assert.deepEqual([...(await pending).trackIds], ['vk-42-88', 'vk-42-2']);
  } finally { f.close(); } }
});
test('delete succeeds only after authoritative playlist index no longer contains target', async () => {
  for (const remove of [true, false]) { const f = fixture(); try { await settle();
    const pending = f.api.playlistAction({ operation: 'delete', playlistId: 'vk-playlist-42-3', trackIds: [] }, 42, async () => { if (remove) f.cards.splice(0, 1); return { ownerId: 42, playlistId: 3, deleted: true }; });
    if (remove) assert.equal((await pending).deleted, true); else await assert.rejects(pending, /playlist_not_verified/);
  } finally { f.close(); } }
});
test('playlist mutation waits for an old collector and cannot be overwritten by its delayed snapshot', async () => {
  const f = fixture(); try { await settle(); let callback; f.hold((_url, params, cb) => { if (params.playlist_id === -1 && !callback) { callback = cb; return true; } return false; }); f.api.start('background'); await settle(); let writes = 0;
    const pending = f.api.playlistAction({ operation: 'edit', playlistId: 'vk-playlist-42-3', trackIds: ['vk-42-1'] }, 42, async () => { writes++; f.playlists.set(3, [song(1)]); return { ownerId: 42, playlistId: 3, title: 'Mix', description: 'Old', trackIds: ['vk-42-1'] }; }); await settle(); assert.equal(writes, 0); callback.onDone({ list: [song(1), song(2), song(3)], totalCount: 3, ownerId: 42, id: -1 }); await pending; assert.equal(writes, 1); assert.deepEqual([...f.api.read(true).playlists[0].trackIds], ['vk-42-1']);
  } finally { f.close(); }
});
test('foreign/new search track and wrong-account receipt reject; account switch never publishes success', async () => {
  const f = fixture(); try { await settle(); f.api.acceptSearch([song(55, 9)]); let writes = 0;
    await assert.rejects(f.api.playlistAction({ operation: 'create', trackIds: ['vk-9-55'] }, 42, async () => { writes++; }), /invalid_playlist_track/); assert.equal(writes, 0);
    await assert.rejects(f.api.playlistAction({ operation: 'rename', playlistId: 'vk-playlist-42-3', trackIds: [] }, 42, async () => ({ ownerId: 9, playlistId: 3 })), /playlist_not_verified/);
    await assert.rejects(f.api.playlistAction({ operation: 'delete', playlistId: 'vk-playlist-42-3', trackIds: [] }, 42, async () => { f.w.vk.id = 43; return { ownerId: 42, playlistId: 3, deleted: true }; }), /session_changed/);
  } finally { f.close(); }
});
