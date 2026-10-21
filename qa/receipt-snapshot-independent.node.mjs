import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const adapter = await readFile(new URL('../src-tauri/src/vk_web_adapter.js', import.meta.url), 'utf8');
const native = await readFile(new URL('../src-tauri/src/vk_web.rs', import.meta.url), 'utf8');
// Exercise the actual native guard, including any adapter calls it makes. A
// receipt poll may run between a catalog refresh and the next catalog poll.
const guardFormat = native.match(/let check = format!\("(.*)"\);/)[1];
const guard = JSON.parse(`"${guardFormat}"`).replaceAll('{account}', '42').replaceAll('{{', '{').replaceAll('}}', '}');
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };

function fixture() {
  let library = [[1, 42, 'https://fixture.invalid/1.mp3', 'Original', 'Artist', 60]];
  let nextTimer = 0;
  const timers = new Map();
  const window = { location: { href: 'https://vk.com/audio', origin: 'https://vk.com' }, vk: { id: 42 }, getAudioPlayer: () => ({}) };
  window.top = window; window.self = window;
  window.ajax = { post(url, params, callbacks) {
    queueMicrotask(() => {
      if (url.includes('owner_playlists')) callbacks.onDone([], 0);
      else callbacks.onDone({ list: library.slice(params.offset), totalCount: library.length, ownerId: 42, id: -1 });
    });
  } };
  const context = vm.createContext({ window, location: window.location, URL, Date,
    document: { querySelector: () => null, createElement: () => ({ set innerHTML(value) { this.value = value; }, value: '' }) },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(adapter, context);
  const api = window.__PULSE_VK_WEB__;
  api.start('same-session');
  return { api, window,
    receiptPoll() { return vm.runInContext(`(() => { ${guard} return { accepted: true }; })()`, context); },
    refresh() {
      library = [[2, 42, 'https://fixture.invalid/2.mp3', 'Newly added', 'Artist', 60], ...library];
      const scheduled = [...timers].find(([, task]) => task.delay === 300000);
      assert.ok(scheduled, 'The adapter did not schedule its ordinary five-minute refresh');
      timers.delete(scheduled[0]); scheduled[1].fn();
    },
  };
}

test('a command receipt poll cannot consume the first complete catalog snapshot', async () => {
  const f = fixture(); await settle();
  assert.equal(f.receiptPoll().accepted, true);
  const snapshot = f.api.read(false);
  assert.equal(snapshot.complete, true, 'The native receipt guard consumed the one-shot catalog result');
  assert.equal(snapshot.tracks.length, 1);
});

test('playback receipt polling during a periodic refresh preserves the newly added track for native sync', async () => {
  const f = fixture(); await settle();
  assert.equal(f.api.read(true).complete, true); // Initial native commit.
  assert.equal(f.api.read(false).complete, false);
  f.refresh(); await settle();
  for (let poll = 0; poll < 8; poll++) assert.equal(f.receiptPoll().accepted, true);
  const snapshot = f.api.read(false); // Native run is already committed: no force flag.
  assert.equal(snapshot.complete, true, 'Receipt polling lost the only background-update delivery');
  assert.deepEqual(Array.from(snapshot.tracks, track => track.title), ['Newly added', 'Original']);
});

test('the lightweight command guard still rejects a live account change', async () => {
  const f = fixture(); await settle();
  f.window.vk.id = 43;
  const receipt = f.receiptPoll();
  assert.equal(receipt.accepted, false);
  assert.match(receipt.error, /Аккаунт VK изменился/);
});
