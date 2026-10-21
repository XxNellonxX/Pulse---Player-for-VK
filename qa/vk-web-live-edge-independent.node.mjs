import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

// Independent controlled review of the followed/restricted-playlist additions.
// This fixture never opens a website, reads a real account or uses credentials.
const source = await readFile(new URL('../src-tauri/src/vk_web_adapter.js', import.meta.url), 'utf8');
const song = (id = 1, owner = 42) => [id, owner, '', `Song ${id}`, 'Artist', 60];
const card = extra => ({ owner_id: 42, id: 3, title: 'Saved mix', size: 159, ...extra });
const settle = async () => { for (let n = 0; n < 12; n++) await new Promise(resolve => setImmediate(resolve)); };

function site(playlistCard, response) {
  const requests = [];
  const timers = new Set();
  const window = {
    vk: { id: 42 }, location: { href: 'https://vk.com/audio' },
    getAudioPlayer: () => ({}),
    ajax: { post(url, params, callbacks) {
      requests.push({ url, params });
      queueMicrotask(() => {
        if (String(url).includes('owner_playlists')) return callbacks.onDone([playlistCard], 1);
        if (params.playlist_id === -1) return callbacks.onDone({ list: [song()], totalCount: 1 });
        response(params, callbacks);
      });
    } },
  };
  window.top = window;
  const context = vm.createContext({ window, URL,
    document: { querySelector: () => null, createElement: () => ({ set innerHTML(value) { this.value = value; }, value: '' }) },
    setTimeout(callback, delay) { const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay); timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
  });
  vm.runInContext(source, context);
  const api = window.__PULSE_VK_WEB__;
  api.start('independent-live-edge');
  return { requests, api, read: () => JSON.parse(JSON.stringify(api.read(true))),
    dispose() { for (const timer of timers) clearTimeout(timer); } };
}

for (const [label, permissions] of [['missing', undefined], ['true', { play: true }], ['numeric zero', { play: 0 }]]) {
  test(`false playlist response with ${label} play permission is an error, never a restricted success`, async () => {
    const f = site(card({ permissions }), (_, cb) => cb.onDone(false));
    try {
      await settle(); const value = f.read();
      assert.equal(value.status, 'error'); assert.equal(value.complete, false);
      assert.equal(value.playlists, undefined);
    } finally { f.dispose(); }
  });
}

test('a declared restriction plus explicit false retains metadata without claiming empty content', async () => {
  const f = site(card({ permissions: { play: false }, description: 'Saved description',
    thumb: 'https://images.example.test/art.jpg', create_time: 1700000000 }), (_, cb) => cb.onDone(false));
  try {
    await settle(); const value = f.read(); const p = value.playlists[0];
    assert.equal(value.complete, true); assert.equal(value.tracks.length, 1);
    assert.equal(p.contentUnavailable, true); assert.equal(p.remoteTrackCount, 159);
    assert.equal(p.description, 'Saved description'); assert.equal(p.artwork, 'https://images.example.test/art.jpg');
    assert.equal(p.createdAt, 1700000000000); assert.deepEqual(p.trackIds, []);
    assert.match(value.message, /ограничил/);
  } finally { f.dispose(); }
});

for (const [label, response] of [
  ['network failure', (_, cb) => cb.onFail()],
  ['malformed response', (_, cb) => cb.onDone({ error: 'unknown' })],
  ['truncated response', (_, cb) => cb.onDone({ list: [], totalCount: 159 })],
]) test(`a play:false card does not turn ${label} into successful restriction`, async () => {
  const f = site(card({ permissions: { play: false } }), response);
  try { await settle(); assert.equal(f.read().status, 'error'); }
  finally { f.dispose(); }
});

test('play:false is not enough to discard readable composition or mark it unavailable', async () => {
  const f = site(card({ permissions: { play: false } }), (_, cb) => cb.onDone({ list: [song(8)], totalCount: 1 }));
  try {
    await settle(); const value = f.read();
    assert.equal(value.complete, true);
    assert.deepEqual(value.playlists[0].trackIds, ['vk-42-8']);
    assert.equal(value.playlists[0].contentUnavailable, undefined);
    assert.equal(value.playlists[0].remoteTrackCount, undefined);
  } finally { f.dispose(); }
});

for (const [label, href] of [
  ['wrong source owner', '/music/playlist/98_8_wrongkey'],
  ['wrong source id', '/music/playlist/99_7_wrongkey'],
  ['untrusted domain', 'https://evil.example/music/playlist/99_8_wrongkey'],
  ['lookalike domain', 'https://vk.com.evil.test/music/playlist/99_8_wrongkey'],
  ['userinfo authority', 'https://vk.com@evil.test/music/playlist/99_8_wrongkey'],
  ['invalid key', '/music/playlist/99_8_key%2Ftail'],
]) test(`followed playlist ignores resource href with ${label}`, async () => {
  let used;
  const f = site(card({ original_identity: { owner_id: 99, playlist_id: 8 }, href }), (params, cb) => {
    used = params; cb.onDone({ list: [], totalCount: 0, ownerId: 99, id: 8 });
  });
  try {
    await settle(); assert.equal(f.read().complete, true);
    assert.equal(used.owner_id, 99); assert.equal(used.playlist_id, 8); assert.equal(used.access_hash, '');
  } finally { f.dispose(); }
});

test('followed source with a signed official href never exports its resource key', async () => {
  let used;
  const f = site(card({ original_identity: { owner_id: -99, playlist_id: 8 },
    href: 'https://vk.ru/audio_playlist-99_8_fixtureSecret', permissions: { play: false } }), (params, cb) => {
    used = params; cb.onDone(false);
  });
  try {
    await settle(); const value = f.read();
    assert.equal(value.complete, true); assert.equal(used.owner_id, -99); assert.equal(used.access_hash, 'fixtureSecret');
    assert.equal(value.playlists[0].id, 'vk-playlist--99-8');
    assert.doesNotMatch(JSON.stringify(value), /fixtureSecret/);
  } finally { f.dispose(); }
});

test('restriction removed on refresh replaces placeholder with real ordered composition', async () => {
  let restricted = true;
  const f = site(card({ permissions: { play: false } }), (_, cb) => cb.onDone(restricted ? false : { list: [song(8), song(8)], totalCount: 2 }));
  try {
    await settle(); assert.equal(f.read().playlists[0].contentUnavailable, true);
    restricted = false; f.api.start('restriction-lifted'); await settle(); const value = f.read();
    assert.equal(value.complete, true); assert.equal(value.playlists[0].contentUnavailable, undefined);
    assert.equal(value.playlists[0].remoteTrackCount, undefined);
    assert.deepEqual(value.playlists[0].trackIds, ['vk-42-8', 'vk-42-8']);
  } finally { f.dispose(); }
});

for (const [label, original_identity] of [
  ['missing source id', { owner_id: 99 }],
  ['missing source owner', { playlist_id: 8 }],
  ['empty source object', {}],
]) test(`partial original source identity (${label}) cannot be silently completed from a local alias`, async () => {
  const f = site(card({ original_identity }), (params, cb) =>
    cb.onDone({ list: [], totalCount: 0, ownerId: params.owner_id, id: params.playlist_id }));
  try {
    await settle(); const value = f.read();
    assert.equal(value.complete, false, 'partial source identity was combined with alias id and published as a verified playlist');
    assert.equal(value.status, 'error');
  } finally { f.dispose(); }
});
