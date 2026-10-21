import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const source = fs.readFileSync(new URL('../src-tauri/src/vk_web_search.js', import.meta.url), 'utf8');
function fixture() {
  const calls = [];
  const w = { vk: { id: 101 }, location: { href: 'https://vk.com/audio' }, __PULSE_VK_WEB__: { acceptSearch: rows => rows.map(raw => ({ id: `vk-${raw.owner_id}-${raw.id}`, title: raw.title })) }, ajax: { post: (...args) => calls.push(args) } };
  w.top = w;
  vm.runInNewContext(source, { window: w, Map, Object, Date, Number, Array, setTimeout, clearTimeout });
  return { w, calls, api: w.__PULSE_VK_SEARCH__ };
}
test('global search uses the actual website search loader, not ownlibrary filtering', () => {
  const { api, calls } = fixture();
  assert.equal(api.start('one', '  outsider track  ', 101), true);
  const [endpoint, params, handler] = calls[0];
  assert.equal(endpoint, 'al_audio.php'); assert.equal(params.type, 'search'); assert.equal(params.search_q, 'outsider track');
  handler.onDone({ type: 'search', list: [{ owner_id: 999, id: 45, title: 'Outsider' }] }, '', {}, 'throw new Error("must never eval")');
  const result = api.read('one', 101);
  assert.equal(result.tracks[0].id, 'vk-999-45'); assert.equal(result.complete, true);
  assert.equal('rows' in result, false);
});
test('an account change while searching cannot register results in the new session', () => {
  const { w, api, calls } = fixture(); let registrations = 0;
  w.__PULSE_VK_WEB__.acceptSearch = () => { registrations++; return []; };
  api.start('one', 'title', 101); w.vk.id = 202;
  calls[0][2].onDone({ list: [{ owner_id: 99, id: 4 }] });
  assert.equal(registrations, 0); assert.match(api.read('one', 101).error, /Аккаунт/);
  assert.equal(api.start('wrong-owner', 'title', 101), false);
});
test('false response is a valid empty search; an unknown schema is an error', () => {
  const { api, calls } = fixture();
  api.start('empty', 'nothing', 101); calls[0][2].onDone(false);
  assert.equal(api.read('empty', 101).tracks.length, 0);
  api.start('broken', 'other', 101); calls[1][2].onDone({ items: [] });
  assert.match(api.read('broken', 101).error, /не подтвердил/);
});
test('warm query cache re-registers through current adapter and never repeats network request', () => {
  const { api, calls, w } = fixture();
  api.start('one', 'title', 101); calls[0][2].onDone({ list: [{ owner_id: 9, id: 4, title: 'old' }] }); api.read('one', 101);
  w.__PULSE_VK_WEB__.acceptSearch = rows => rows.map(raw => ({ id: `vk-9-${raw.id}`, title: 'current mapper' }));
  api.start('two', 'TITLE', 101);
  assert.equal(calls.length, 1); assert.equal(api.read('two', 101).tracks[0].title, 'current mapper');
});

test('abandoned capped requests cannot overwrite current adapter tuples when they finally arrive', () => {
  const { api, calls, w } = fixture(); let registrations = 0;
  w.__PULSE_VK_WEB__.acceptSearch = () => { registrations++; return []; };
  for (let index = 0; index < 9; index++) api.start(`request-${index}`, `query-${index}`, 101);
  calls[0][2].onDone({ list: [{ owner_id: 8, id: 1 }] });
  assert.equal(registrations, 0, 'Evicted callback must be inert');
  assert.match(api.read('request-0', 101).error, /отменён/);
  for (let index = 1; index < 9; index++) { calls[index][2].onDone(false); api.read(`request-${index}`, 101); }
  assert.equal(registrations, 8);
});

test('search receipt cannot be consumed under another live account', () => {
  const { api, calls, w } = fixture();
  api.start('old-account', 'title', 101); calls[0][2].onDone(false);
  w.vk.id = 202;
  assert.match(api.read('old-account', 202).error, /Аккаунт/);
  w.vk.id = 0;
  assert.equal(api.start('logged-out', 'title', 0), false);
});

test('live VK search recommender envelope is accepted while unrelated playlists are rejected', () => {
  const { api, calls } = fixture();
  api.start('live-envelope', 'Daft Punk', 101);
  calls[0][2].onDone({ type: 'recoms', list: [{ owner_id: 9, id: 4, title: 'Search result' }] });
  assert.equal(api.read('live-envelope', 101).tracks.length, 1);
  api.start('unrelated', 'Metallica', 101);
  calls[1][2].onDone({ type: 'playlist', list: [{ owner_id: 9, id: 4 }] });
  assert.match(api.read('unrelated', 101).error, /не подтвердил/);
});
