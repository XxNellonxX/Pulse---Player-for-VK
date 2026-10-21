import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../src-tauri/src/vk_playlist_actions.js', import.meta.url), 'utf8');
const settle = async () => { for (let n = 0; n < 15; n++) await new Promise(resolve => setImmediate(resolve)); };
const input = (operation, extra = {}) => ({ operation, playlistId: 'vk-playlist-42-3', title: 'Night mix', description: 'After hours', trackIds: [], ...extra });
function fixture({ defer = false, rejectReadback = false, missingModule = false } = {}) {
  const calls = [], timers = new Map(); let nextTimer = 0, release;
  let metadata = { owner_id: 42, id: 3, title: 'Old title', description: 'Old description' }, ids = ['42_1', '42_2'];
  const raws = [{ id: 1, ownerId: 42, accessKey: 'private-key' }, { id: 2, ownerId: 42 }];
  const repository = { authService: { ensureUserId: () => 42 }, async audioCreatePlaylist(args) { calls.push({ method: 'create', args }); metadata = { owner_id: 42, id: 5, title: args.title, description: args.description }; return metadata; }, async audioEditPlaylist(args) { calls.push({ method: 'edit', args }); metadata = { ...metadata, title: args.title, ...(args.description !== undefined ? { description: args.description } : {}) }; } };
  const api = { async getPlaylistById() { return metadata; }, async getIdsBySource() { return { audios: ids.map(audio_id => ({ audio_id })) }; }, async deletePlaylist(args) { calls.push({ method: 'delete', args }); }, async addToPlaylist(args) { calls.push({ method: 'add', args }); return [{ audio_id: 88 }]; }, async removeFromPlaylist(args) { calls.push({ method: 'remove', args }); } };
  const exports = { 217528: { ensureDIRootWebContainer: () => ({ resolve: token => token === 'repo' ? repository : api }) }, 65615: { AudioRepository: 'repo' }, 518943: { AudioApi: 'api' }, 640547: { audioTupleToAudioObject: raw => raw } };
  const require = key => exports[key]; require.m = missingModule ? {} : Object.fromEntries(Object.keys(exports).map(key => [key, true]));
  const w = { vk: { id: 42 }, webpackChunkvkweb: [], __PULSE_VK_WEB__: { async playlistAction(_input, _owner, perform) { if (defer) await new Promise(resolve => { release = resolve; }); const result = await perform(raws); if (rejectReadback) throw Error('playlist_not_verified'); return result; } } }; w.top = w;
  w.webpackChunkvkweb.push = value => value[2](require);
  vm.runInContext(source, vm.createContext({ window: w, location: { origin: 'https://vk.com' }, setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; }, clearTimeout(id) { timers.delete(id); } }));
  return { w, calls, raws, timers, api: w.__PULSE_VK_PLAYLIST_ACTIONS__, setIds(value) { ids = value; }, release() { release?.(); } };
}
test('playlist creation uses actual page repository, preserves selected order and keeps access keys in page', async () => {
  const f = fixture(); f.api.start('r', input('create'), 42); await settle(); const receipt = f.api.read('r', 42);
  assert.equal(receipt.verified, true); assert.equal(receipt.playlistId, 5); assert.deepEqual([...receipt.trackIds], ['vk-42-1', 'vk-42-2']);
  assert.equal(f.calls[0].args.audio_ids, '42_1_private-key,42_2'); assert.equal(f.calls[0].args.description, 'After hours'); assert.doesNotMatch(JSON.stringify(receipt), /private-key|authService/);
});
test('rename does not send a replacement description or composition and verifies previous order', async () => {
  const f = fixture(); f.raws.length = 0; f.api.start('r', input('rename'), 42); await settle(); const receipt = f.api.read('r', 42);
  assert.equal(receipt.verified, true); assert.equal(receipt.description, 'Old description'); assert.deepEqual([...receipt.trackIds], ['vk-42-1', 'vk-42-2']);
  assert.equal(Object.hasOwn(f.calls[0].args, 'audio_ids'), false); assert.equal(Object.hasOwn(f.calls[0].args, 'description'), false);
});
test('edit can retain an existing foreign track but cannot introduce a new foreign identity', async () => {
  const f = fixture(); f.raws[0].ownerId = 9; f.setIds(['9_1', '42_2']); f.api.start('r', input('edit'), 42); await settle(); assert.equal(f.api.read('r', 42).verified, true);
  const g = fixture(); g.raws[0].ownerId = 9; g.api.start('r', input('edit'), 42); await settle(); assert.equal(g.calls.length, 0); assert.match(g.api.read('r', 42).error, /доступные треки/);
});
test('add accepts returned canonical owner identity while remove sends full identity without access key', async () => {
  const f = fixture(); f.raws.splice(0, 2, { id: 55, ownerId: 9, accessKey: 'private-key' }); f.api.start('r', input('add-track'), 42); await settle(); const receipt = f.api.read('r', 42); assert.equal(receipt.addedId, 'vk-42-88'); assert.equal(f.calls[0].args.audio_ids, '9_55_private-key');
  const g = fixture(); g.raws.splice(1); g.api.start('r', input('remove-track'), 42); await settle(); assert.equal(g.calls[0].args.audio_ids, '42_1'); assert.deepEqual([...g.api.read('r', 42).trackIds], ['vk-42-2']);
});
test('void delete succeeds only after collector readback; failure remains uncertain', async () => {
  const f = fixture(); f.raws.length = 0; f.api.start('r', input('delete'), 42); await settle(); assert.equal(f.api.read('r', 42).verified, true);
  const g = fixture({ rejectReadback: true }); g.raws.length = 0; g.api.start('r', input('delete'), 42); await settle(); const receipt = g.api.read('r', 42); assert.notEqual(receipt.verified, true); assert.equal(receipt.uncertain, true);
});
test('duplicate add rejects before write and does not claim uncertainty', async () => {
  const f = fixture(); f.raws.splice(1); f.api.start('r', input('add-track'), 42); await settle(); const receipt = f.api.read('r', 42); assert.equal(f.calls.length, 0); assert.equal(receipt.uncertain, false); assert.match(receipt.error, /уже есть/);
});
test('parallel clicks and cancellation cannot produce delayed writes', async () => {
  for (const cancel of [false, true]) { const f = fixture({ defer: true }); assert.equal(f.api.start('r', input('create'), 42), true); assert.equal(f.api.start('r', input('create'), 42), true); assert.equal(f.api.start('s', input('create'), 42), false); await settle(); if (cancel) f.api.cancel('r', 42); else [...f.timers.values()][0].fn(); f.release(); await settle(); assert.equal(f.calls.length, 0); assert.notEqual(f.api.read('r', 42).verified, true); }
});
test('account changes or missing page services fail before a cloud write', async () => {
  const f = fixture({ defer: true }); f.api.start('r', input('create'), 42); await settle(); f.w.vk.id = 43; f.release(); await settle(); assert.equal(f.calls.length, 0); assert.notEqual(f.api.read('r', 42).verified, true);
  const g = fixture({ missingModule: true }); g.api.start('r', input('create'), 42); await settle(); assert.equal(g.calls.length, 0); assert.match(g.api.read('r', 42).error, /изменил интерфейс/);
});
