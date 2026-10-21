import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src-tauri/src/vk_library_actions.js', import.meta.url), 'utf8');
const settle = async () => { for (let n = 0; n < 12; n++) await new Promise(resolve => setImmediate(resolve)); };
function fixture({ missingModule = false, readbackError = false, defer = false } = {}) {
  const calls = [], timers = new Map(); let sequence = 0, complete;
  const audio = { id: 7, ownerId: 42, accessKey: 'stays-in-page', trackCode: 'local-context' };
  const owning = { currentUserId: 42, async add(input) { calls.push({ method: 'add', input }); return { ownerId: 42, id: 88 }; }, async delete(input) { calls.push({ method: 'delete', input }); } };
  const exports = {
    810213: { ensureAudioPageMusicService: () => ({ audioOwning: owning }) },
    522285: { MusicAudioIdentity: class { constructor(value) { Object.assign(this, value); } } },
    640547: { audioTupleToAudioObject: () => audio },
  };
  const require = key => exports[key]; require.m = missingModule ? {} : { 810213: true, 522285: true, 640547: true };
  const w = { vk: { id: 42 }, webpackChunkvkweb: [], __PULSE_VK_WEB__: { async libraryAction(operation, id, owner, perform) {
    if (defer) await new Promise(resolve => { complete = resolve; });
    const result = await perform([7, 42]);
    if (readbackError) throw new Error('mutation_not_verified');
    return { ownerId: owner, audioId: operation === 'add' ? result.id : 7 };
  } } }; w.top = w;
  w.webpackChunkvkweb.push = input => { input[2](require); };
  const context = vm.createContext({ window: w, location: { origin: 'https://vk.com' }, setTimeout(fn, delay) { const key = ++sequence; timers.set(key, { fn, delay }); return key; }, clearTimeout(key) { timers.delete(key); } });
  vm.runInContext(source, context);
  return { w, api: w.__PULSE_VK_LIBRARY_ACTIONS__, audio, owning, calls, timers, complete: () => complete?.() };
}
test('service add receives page-owned identity and only verified public identity leaves the document', async () => {
  const f = fixture(); assert.equal(f.api.start('r', 'add', 'vk-42-7', 42), true); await settle();
  const receipt = f.api.read('r', 42); assert.equal(receipt.verified, true); assert.equal(receipt.audioId, 88); assert.equal(receipt.ownerId, 42);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].input.identity.accessKey, 'stays-in-page'); assert.equal(f.calls[0].input.trackCode, 'local-context'); assert.equal(f.calls[0].input.targetOwnerId, 42);
  assert.doesNotMatch(JSON.stringify(receipt), /stays-in-page|local-context|identity/);
});
test('service delete accepts void response only after adapter readback confirms absence', async () => {
  const f = fixture(); f.api.start('r', 'delete', 'vk-42-7', 42); await settle();
  assert.equal(f.calls[0].method, 'delete'); assert.equal(f.api.read('r', 42).verified, true);
  const failed = fixture({ readbackError: true }); failed.api.start('r', 'delete', 'vk-42-7', 42); await settle();
  const receipt = failed.api.read('r', 42); assert.equal(receipt.verified, false); assert.equal(receipt.uncertain, true); assert.match(receipt.error, /не подтвердила/);
});
test('session changes before a deferred callback prevent the service write', async () => {
  const f = fixture({ defer: true }); f.api.start('r', 'add', 'vk-42-7', 42); await settle(); f.w.vk.id = 43; f.complete(); await settle();
  assert.equal(f.calls.length, 0); assert.match(f.api.read('r', 42).error, /Аккаунт VK изменился/);
});
test('loaded website module changes fail closed without a write', async () => {
  const f = fixture({ missingModule: true }); f.api.start('r', 'add', 'vk-42-7', 42); await settle();
  assert.equal(f.calls.length, 0); assert.match(f.api.read('r', 42).error, /Интерфейс изменения музыки VK изменился/);
});
test('duplicate/parallel requests cannot issue a second service write', async () => {
  const f = fixture({ defer: true }); assert.equal(f.api.start('r', 'add', 'vk-42-7', 42), true); assert.equal(f.api.start('r', 'add', 'vk-42-7', 42), true); assert.equal(f.api.start('s', 'delete', 'vk-42-7', 42), false); await settle(); f.complete(); await settle(); assert.equal(f.calls.length, 1);
});
test('cancellation and timeout before callback prevent delayed service writes', async () => {
  for (const timeout of [false, true]) {
    const f = fixture({ defer: true }); f.api.start('r', 'add', 'vk-42-7', 42); await settle();
    if (timeout) [...f.timers.values()][0].fn(); else f.api.cancel('r', 42);
    f.complete(); await settle(); assert.equal(f.calls.length, 0);
    assert.notEqual(f.api.read('r', 42).verified, true);
  }
});
