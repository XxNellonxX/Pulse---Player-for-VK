import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const [adapterSource, artistSource] = await Promise.all([
  readFile(new URL('../src-tauri/src/vk_web_adapter.js', import.meta.url), 'utf8'),
  readFile(new URL('../src-tauri/src/vk_artist.js', import.meta.url), 'utf8'),
]);
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
const raw = extra => ({ id: 1, owner_id: 101, title: 'Song', artist: 'Artist', duration: 180, ...extra });

function fixture(rows = []) {
  const w = { vk: { id: 101 }, location: { href: 'https://vk.com/audio', origin: 'https://vk.com' }, ajax: { post() {} } };
  w.top = w;
  const audio = { getById: async () => rows };
  const runtime = key => key === 217528 ? { ensureDIRootWebContainer: () => ({ resolve: token => token === 'audio' ? audio : {} }) } : key === 518943 ? { AudioApi: 'audio' } : { CatalogApi: 'catalog' };
  runtime.m = { 217528: true, 518943: true, 751716: true };
  w.webpackChunkvkweb = { push: chunk => chunk[2](runtime) };
  const context = vm.createContext({ window: w, location: w.location, URL, Date,
    document: { querySelector: () => null, createElement: () => ({ set innerHTML(value) { this.value = value; }, value: '' }) },
    setTimeout: () => 1, clearTimeout() {},
  });
  vm.runInContext(adapterSource, context);
  w.__PULSE_VK_WEB__.start('metadata');
  return { w, context, map: row => w.__PULSE_VK_WEB__.acceptSearch([row])[0] };
}

test('public metadata preserves version, known explicit rating and normalized ISRC without private source fields', () => {
  const f = fixture(), result = f.map(raw({ subtitle: 'DJ One Remix', is_explicit: true, isrc: 'US-ABC-26-12345', main_artists: [], url: 'https://secret.invalid/signed.mp3?secret=value', access_key: 'private' }));
  assert.equal(result.version, 'DJ One Remix'); assert.equal(result.explicit, true); assert.equal(result.isrc, 'USABC2612345'); assert.equal(result.artistCard, 'absent');
  assert.equal(result.url, 'vk-web://101/1'); assert.equal(JSON.stringify(result).includes('secret'), false); assert.equal(JSON.stringify(result).includes('private'), false);
});

test('missing artist metadata and explicit flags stay unknown, with no guessed tuple slot', () => {
  const f = fixture();
  for (const row of [raw(), [1, 101, '', 'Song', 'Artist', 180]]) {
    const result = f.map(row); assert.equal(result.artistCard, 'unknown'); assert.equal(result.explicit, undefined); assert.equal(result.isrc, undefined);
  }
  assert.equal(f.map(raw({ is_explicit: false })).explicit, false);
  assert.equal(f.map(raw({ isrc: 'not a real isrc', is_explicit: 'false' })).isrc, undefined);
});

test('only a complete empty artist list signals absence; valid refs signal presence', () => {
  const f = fixture();
  assert.equal(f.map(raw({ main_artists: [] })).artistCard, 'absent');
  assert.equal(f.map(raw({ main_artists: [{}] })).artistCard, 'unknown');
  assert.equal(f.map(raw({ main_artists: [], featured_artists: [{}] })).artistCard, 'unknown');
  assert.equal(f.map(raw({ main_artists: [], featured_artists: [{ id: '../broken', name: 'Artist' }] })).artistCard, 'unknown');
  assert.equal(f.map(raw({ main_artists: [], featured_artists: [] })).artistCard, 'absent');
  const linked = f.map(raw({ main_artists: [{ id: '123', name: 'Artist' }] }));
  assert.equal(linked.artistCard, 'present'); assert.equal(linked.artistRefs[0].id, '123');
});

test('website tuple subtitle uses the configured index and ignores unrelated explicit-looking slots', () => {
  const f = fixture(); f.w.AudioUtils = { AUDIO_ITEM_INDEX_SUBTITLE: 33 };
  const tuple = [1, 101, '', 'Song', 'Artist', 180]; tuple[16] = 'Wrong version'; tuple[33] = 'Live'; tuple[32] = true;
  const result = f.map(tuple); assert.equal(result.version, 'Live'); assert.equal(result.explicit, undefined);
});

test('artist API object-to-tuple-to-track round trip keeps recording metadata and does not invent absent cards', async () => {
  for (const main of [undefined, [], [{ id: '123', name: 'Artist' }]]) {
    const f = fixture([raw({ subtitle: 'Live', is_explicit: true, isrc: 'USABC2612345', ...(main ? { main_artists: main } : {}) })]);
    vm.runInContext(artistSource, f.context);
    assert.equal(f.w.__PULSE_VK_ARTISTS__.start('hydrate', { action: 'hydrate', ids: ['vk-101-1'] }, 101), true);
    await settle();
    const response = f.w.__PULSE_VK_ARTISTS__.read('hydrate', 101); assert.equal(response.error, undefined);
    const result = response.result.tracks[0]; assert.equal(result.version, 'Live'); assert.equal(result.explicit, true); assert.equal(result.isrc, 'USABC2612345');
    assert.equal(result.artistCard, main === undefined ? 'unknown' : main.length ? 'present' : 'absent');
  }
});
