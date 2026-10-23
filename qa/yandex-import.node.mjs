// Exercises the actual first-party metadata adapter with independent fixtures.
// No account, credentials, browser profile or audio is accessed.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
const script = fs.readFileSync(new URL('../src-tauri/src/yandex_import.js', import.meta.url), 'utf8');

function harness(options = {}) {
  const calls = { about: 0, tracks: [], lists: [] };
  const rows = Array.from({ length: options.count ?? 205 }, (_, i) => ({ id: String(1000 + i), albumId: 5 }));
  const users = {
    getCreatedPlaylists: async parameters => {
      calls.lists.push(parameters.page);
      if (options.repeatList) return [{ uid: '123', kind: 4, title: 'Repeat' }];
      return parameters.page === 0 ? [{ uid: '123', kind: 4, title: 'One' }] : [];
    },
    getLikedPlaylists: async parameters => options.shortPager
      ? { likedPlaylists: [{ playlist: { uid: '123', kind: 5, title: 'Short' } }], pager: { total: 1000, page: parameters.page, perPage: 100 } }
      : { likedPlaylists: [], pager: { total: 0, page: parameters.page } },
    getPlaylistWithTracksIds: async () => ({ title: 'Fixture', trackCount: options.unknownTotal ? undefined : rows.length, revision: 1,
      tracks: options.reorder && calls.tracks.length ? rows.slice().reverse() : rows }),
  };
  const tracks = { getTracksMeta: async parameters => {
    calls.tracks.push(parameters.trackIds);
    if (options.apiError) throw new Error('secret=https://host/?token=do-not-expose');
    return parameters.trackIds.slice(options.missingMeta ? 1 : 0).map(trackId => ({ id: trackId.split(':')[0], title: 'Track', artists: [{ name: 'Artist' }], durationMs: 123400, albums: [{ id: options.wrongAlbum ? 6 : 5, title: 'Album' }] }));
  } };
  const account = { about: async () => ({ uid: options.noAccount ? '0' : options.changeAccount && ++calls.about > 1 ? '456' : '123', login: 'QA' }) };
  const container = { get: name => ({ AccountResource: account, UsersResource: users, TracksResource: tracks }[name]) };
  const context = { window: {}, document: { body: { '__reactFiber$test': { memoizedProps: { value: container } } }, getElementById: () => null, querySelectorAll: () => [] },
    location: { origin: options.badOrigin ? 'https://evil.test' : 'https://music.yandex.ru' }, setTimeout, clearTimeout, URL };
  context.window.top = context.window; context.window.self = context.window;
  vm.createContext(context); vm.runInContext(script, context);
  return { api: context.window.__PULSE_YANDEX_IMPORT__, calls };
}
async function request(api, action) {
  assert.equal(api.start('fixture-key-123', { action, uid: '123', url: 'pulse:yandex:liked' }), true);
  for (let index = 0; index < 100; index++) {
    const result = api.read('fixture-key-123');
    if (result.complete) return result;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error('Adapter did not finish the fixture');
}
test('205 metadata records preserve provider order, album identity and batches of 100', async () => {
  const { api, calls } = harness(); const result = await request(api, 'read');
  assert.equal(result.error, undefined); assert.equal(result.result.complete, true); assert.equal(result.result.entries.length, 205);
  assert.deepEqual(calls.tracks.map(page => page.length), [100, 100, 5]);
  assert.equal(result.result.entries[204].position, 204); assert.equal(result.result.entries[0].album, 'Album');
});
for (const [name, options] of [['missing metadata', { missingMeta: true }], ['unknown total', { unknownTotal: true }], ['different album', { wrongAlbum: true }]]) {
  test(`${name} is never reported as a complete source`, async () => {
    const result = await request(harness(options).api, 'read'); assert.equal(result.result.complete, false);
  });
}
test('same-count playlist reorder during import is rejected', async () => {
  assert.match((await request(harness({ reorder: true }).api, 'read')).error, /изменился/u);
});
test('account switch before receipt is rejected', async () => {
  assert.match((await request(harness({ changeAccount: true }).api, 'read')).error, /Аккаунт/u);
});
test('short page before declared total is rejected', async () => {
  assert.match((await request(harness({ shortPager: true }).api, 'list')).error, /неполную страницу/u);
});
test('a backend ignoring the requested next page cannot claim a full collection', async () => {
  assert.match((await request(harness({ repeatList: true }).api, 'list')).error, /повторил страницу/u);
});
test('transport error details never enter exported metadata', async () => {
  const result = await request(harness({ apiError: true }).api, 'read');
  assert.ok(!result.error.includes('secret')); assert.ok(!result.error.includes('token'));
});
test('unsigned account requires ordinary first-party login', async () => {
  assert.match((await request(harness({ noAccount: true }).api, 'connect')).error, /вход/u);
});
test('adapter is never initialized outside a first-party top-level page', () => {
  assert.equal(harness({ badOrigin: true }).api, undefined);
});
test('explicit cancel fences a late result', async () => {
  const { api } = harness(); api.start('fixture-key-123', { action: 'read', uid: '123', url: 'pulse:yandex:liked' }); api.cancel('fixture-key-123');
  await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(api.read('fixture-key-123').error); assert.equal(api.read('fixture-key-123').result, undefined);
});
