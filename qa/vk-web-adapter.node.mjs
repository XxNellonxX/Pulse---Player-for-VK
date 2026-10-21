import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { installDirectFixture } from './vk-direct-fixture.mjs';

const source = await readFile(new URL('../src-tauri/src/vk_web_adapter.js', import.meta.url), 'utf8');

function makeSite({ account = 42, library = [], playlistItems = library, playlists = [] } = {}) {
  const calls = [];
  const events = new Map();
  const player = {
    current: null, playing: false, volume: 0.8,
    getPlaylist(_type, owner, id) {
      return { mergeWith(data) { this.list = data.list; }, getSelf() { return this; }, list: [] };
    },
    getPlaylistQueue() { return { clean() {}, isPending: false }; },
    setRepeatState() {},
    play(rawId) { this.current = rawId; this.playing = true; return Promise.resolve(); },
    pause() { this.playing = false; }, resume() { this.playing = true; }, stop() { this.playing = false; this.current = null; },
    setVolume(value) { this.volume = value; }, getCurrentAudio() { return this.current ? library.find(x => `${x[1]}_${x[0]}` === this.current) : null; },
    getCurrentDuration() { return 180; }, getCurrentProgress() { return 0.25; }, isPlaying() { return this.playing; }, isPaused() { return !this.playing; },
    subscribe(event, callback) { events.set(event, callback); },
  };
  const tuple = (id, title, owner = account) => [id, owner, `https://cdn.example.test/${id}.mp3`, title, 'Artist', 180, 99, null, null, 0, 0, '', '', '', `https://cdn.example.test/${id}.jpg`, 0, '', '', '', 'Album', '', 0, 0, 0, 'access'];
  const context = {
    console, setTimeout, clearTimeout, URL,
    window: null, document: { createElement: () => ({ set innerHTML(value) { this.value = value; }, value: '' }), querySelector: () => null },
  };
  context.window = context;
  context.top = context;
  context.location = { href: 'https://vk.com/audio' };
  context.vk = { id: account, user: { first_name: 'Test', last_name: 'User' } };
  context.AudioUtils = { AUDIO_ITEM_INDEX_ID: 0, AUDIO_ITEM_INDEX_OWNER_ID: 1, AUDIO_ITEM_INDEX_URL: 2, AUDIO_ITEM_INDEX_TITLE: 3, AUDIO_ITEM_INDEX_PERFORMER: 4, AUDIO_ITEM_INDEX_DURATION: 5, AUDIO_ITEM_INDEX_ALBUM: 19, AUDIO_ITEM_INDEX_COVER_URL: 14, AUDIO_ITEM_ACCESS_KEY: 24 };
  context.AudioPlaylist = { TYPE_TEMP: 'temp' };
  context.getAudioPlayer = () => player;
  const direct = installDirectFixture(context);
  context.ajax = { post(url, params, callbacks) {
    calls.push({ url, params });
    setTimeout(() => {
      if (String(url).includes('owner_playlists')) return callbacks.onDone(playlists, playlists.length, {});
      if (params.playlist_id === -1) return callbacks.onDone({ list: library, totalCount: library.length, hasMore: false });
      return callbacks.onDone({ list: playlistItems, totalCount: playlistItems.length, hasMore: false, ownerId: account, id: params.playlist_id });
    }, 0);
  } };
  return { context, calls, player, tuple, direct };
}

function load(site) {
  vm.runInNewContext('window.__PULSE_VK_WEB_RUN_ID = "run-1";\n' + source, site.context, { timeout: 1000 });
  return site.context.window.__PULSE_VK_WEB__;
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('adapter imports the complete library and playlist composition without auth material', async () => {
  const site = makeSite();
  const first = site.tuple(7, 'Song');
  const second = site.tuple(8, 'Second');
  site.context.ajax.post = (url, params, callbacks) => {
    site.calls.push({ url, params });
    setTimeout(() => {
      if (String(url).includes('owner_playlists')) return callbacks.onDone([{ id: 3, ownerId: 42, title: 'Mix', description: 'desc', accessHash: 'hash' }], 1, {});
      if (params.playlist_id === -1) return callbacks.onDone({ list: [first, second], totalCount: 2, hasMore: false });
      return callbacks.onDone({ list: [first], totalCount: 1, hasMore: false, ownerId: 42, id: 3 });
    }, 0);
  };
  const api = load(site);
  await wait(40);
  const snapshot = api.read(true);
  assert.equal(snapshot.status, 'complete');
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.user.id, 42);
  assert.equal(snapshot.tracks.length, 2);
  assert.deepEqual(Array.from(snapshot.playlists[0].trackIds), ['vk-42-7']);
  assert.equal(snapshot.tracks[0].url, 'vk-web://42/7');
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot, 'token'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot, 'cookies'), false);
  assert.equal(site.calls.some(c => String(c.url).includes('owner_playlists')), true);
});

test('malformed or truncated website page never becomes a successful empty sync', async () => {
  const site = makeSite();
  site.context.ajax.post = (url, params, callbacks) => setTimeout(() => {
    if (String(url).includes('owner_playlists')) return callbacks.onDone([], 1, {});
    return callbacks.onDone({ list: [], totalCount: 2, hasMore: true });
  }, 0);
  const api = load(site);
  await wait(40);
  const snapshot = api.read(true);
  assert.equal(snapshot.status, 'error');
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.tracks, undefined);
  assert.match(snapshot.message, /не подтвердил|не загрузился/i);
});

test('a followed playlist uses its original source identity and resource link inside the site', async () => {
  const site = makeSite();
  const item = site.tuple(7, 'Followed song');
  site.context.ajax.post = (url, params, callbacks) => setTimeout(() => {
    if (String(url).includes('owner_playlists')) return callbacks.onDone([{
      owner_id: 42, id: 3, title: 'Saved playlist', access_hash: '', size: 1,
      original_identity: { owner_id: 99, playlist_id: 8 },
      followed_identity: { owner_id: 42, playlist_id: 3 },
      href: '/music/playlist/99_8_resourcekey', thumb: 'https://cdn.example.test/cover.jpg',
    }], 1, {});
    if (params.playlist_id === -1) return callbacks.onDone({ list: [], totalCount: 0 });
    assert.equal(params.owner_id, 99);
    assert.equal(params.playlist_id, 8);
    assert.equal(params.access_hash, 'resourcekey');
    callbacks.onDone({ list: [item], totalCount: 1, ownerId: 99, id: 8 });
  }, 0);
  const api = load(site);
  await wait(40);
  const snapshot = api.read(true);
  assert.equal(snapshot.status, 'complete');
  assert.equal(snapshot.playlists[0].id, 'vk-playlist-99-8');
  assert.equal(snapshot.playlists[0].artwork, 'https://cdn.example.test/cover.jpg');
  assert.equal(snapshot.playlists[0].remote.accessKey, undefined);
  assert.equal(snapshot.tracks[0].remote.accessKey, undefined);
});

test('account logout removes the old account from subsequent reads and rejects commands', async () => {
  const site = makeSite();
  const api = load(site);
  await wait(40);
  assert.equal(api.read(true).status, 'complete');
  site.context.vk.id = 0;
  const loggedOut = api.read(true);
  assert.equal(loggedOut.status, 'waiting-login');
  assert.equal(loggedOut.user, null);
  assert.equal(loggedOut.tracks, undefined);
  assert.equal(api.command({ operation: 'pause', requestId: 'logout' }).accepted, false);
});

test('VK-declared restricted saved playlist remains visible without blocking the accessible library', async () => {
  const site = makeSite();
  const item = site.tuple(7, 'Accessible song');
  site.context.ajax.post = (url, params, callbacks) => setTimeout(() => {
    if (String(url).includes('owner_playlists')) return callbacks.onDone([{
      owner_id: 42, id: 3, title: 'Restricted saved mix', size: 159, permissions: { play: false },
    }], 1, {});
    if (params.playlist_id === -1) return callbacks.onDone({ list: [item], totalCount: 1 });
    callbacks.onDone(false, '<div>VK restriction</div>');
  }, 0);
  const api = load(site);
  await wait(40);
  const snapshot = api.read(true);
  assert.equal(snapshot.status, 'complete');
  assert.equal(snapshot.tracks.length, 1);
  assert.equal(snapshot.playlists.length, 1);
  assert.equal(snapshot.playlists[0].contentUnavailable, true);
  assert.equal(snapshot.playlists[0].remoteTrackCount, 159);
  assert.deepEqual(Array.from(snapshot.playlists[0].trackIds), []);
  assert.match(snapshot.message, /ограничил/);
});

test('playback commands use independent transport and never the website play or ad scheduler', async () => {
  const site = makeSite();
  const first = site.tuple(7, 'Song');
  site.player.getCurrentAudio = function () { return this.current === '42_7' ? first : null; };
  site.context.ajax.post = (url, params, callbacks) => setTimeout(() => {
    if (String(url).includes('owner_playlists')) return callbacks.onDone([], 0, {});
    return callbacks.onDone({ list: [first], totalCount: 1, hasMore: false });
  }, 0);
  const api = load(site);
  await wait(40);
  assert.equal(api.read(true).status, 'complete');
  const command = api.command({ operation: 'play', id: 'vk-42-7', requestId: 'play-1' });
  assert.equal(command.accepted, true);
  assert.equal(command.requestId, 'play-1');
  await wait(0);
  assert.equal(api.playback().id, 'vk-42-7');
  assert.equal(api.playback().playing, true);
  assert.equal(api.command({ operation: 'volume', volume: 4, requestId: 'volume' }).accepted, true);
  assert.equal(site.direct.instances[0].volumeValue, 1);
  assert.equal(site.player.current, null, 'official player was started');
});

test('resumed persisted VK playback seeks before starting and clamps to track end', async () => {
  const site = makeSite();
  const first = site.tuple(7, 'Song');
  site.context.ajax.post = (url, params, callbacks) => queueMicrotask(() => {
    if (String(url).includes('owner_playlists')) return callbacks.onDone([], 0, {});
    callbacks.onDone({ list: [first], totalCount: 1 });
  });
  const api = load(site);
  await wait(10);
  const command = api.command({ operation: 'play', id: 'vk-42-7', position: 999 });
  assert.equal(command.accepted, true);
  await wait(0);
  assert.deepEqual(site.direct.seeks, [179.9], 'saved position should clamp just before duration');
  assert.equal(site.direct.playCalls, 1);
  assert.equal(api.playback().position, 179.9);
});

test('fresh play and zero-offset play begin at zero without calling seek', async () => {
  const site = makeSite();
  const first = site.tuple(7, 'Song');
  const second = site.tuple(8, 'Second');
  site.context.ajax.post = (url, params, callbacks) => queueMicrotask(() => {
    if (String(url).includes('owner_playlists')) return callbacks.onDone([], 0, {});
    callbacks.onDone({ list: [first, second], totalCount: 2 });
  });
  const api = load(site);
  await wait(10);
  api.command({ operation: 'play', id: 'vk-42-7' });
  await wait(0);
  api.command({ operation: 'play', id: 'vk-42-8', position: 0 });
  await wait(0);
  assert.deepEqual(site.direct.seeks, [], 'new tracks must start at the beginning');
  assert.equal(api.playback().position, 0);
});

test('invalid saved offsets are rejected without changing current playback', async () => {
  const site = makeSite();
  const first = site.tuple(7, 'Song');
  site.context.ajax.post = (url, params, callbacks) => queueMicrotask(() => {
    if (String(url).includes('owner_playlists')) return callbacks.onDone([], 0, {});
    callbacks.onDone({ list: [first], totalCount: 1 });
  });
  const api = load(site);
  await wait(10);
  for (const position of [-1, Number.NaN, Number.POSITIVE_INFINITY, '10']) {
    const command = api.command({ operation: 'play', id: 'vk-42-7', position });
    assert.equal(command.accepted, false);
    assert.match(command.error, /Некорректная позиция/);
  }
  assert.equal(site.direct.loads.length, 0);
});

test('stale saved-position load cannot seek or start a newer track', async () => {
  const site = makeSite();
  const first = site.tuple(7, 'Song');
  const second = site.tuple(8, 'Second');
  site.context.ajax.post = (url, params, callbacks) => queueMicrotask(() => {
    if (String(url).includes('owner_playlists')) return callbacks.onDone([], 0, {});
    callbacks.onDone({ list: [first, second], totalCount: 2 });
  });
  const api = load(site);
  await wait(10);
  let release;
  site.direct.nextLoad = new Promise(resolve => { release = resolve; });
  const stale = api.command({ operation: 'play', id: 'vk-42-7', position: 54 });
  assert.equal(stale.pending, true);
  const current = api.command({ operation: 'play', id: 'vk-42-8', position: 27 });
  assert.equal(current.accepted, true);
  release();
  await wait(0);
  assert.deepEqual(site.direct.seeks, [27], 'late load for the old track must not apply its offset');
  assert.equal(api.playback().id, 'vk-42-8');
  assert.equal(api.playback().position, 27);
});

test('login landing on Feed loads Music instead of silently waiting for its lazy player', async () => {
  const site = makeSite();
  site.context.location.href = 'https://vk.com/feed';
  site.context.getAudioPlayer = () => null;
  let navigation;
  site.context.nav = { go(path) { navigation = path; } };
  const api = load(site);
  assert.equal(navigation, '/audio');
  assert.equal(api.read().status, 'syncing');
  site.context.getAudioPlayer = () => site.player;
  await wait(350);
  assert.equal(api.read(true).status, 'complete');
});

for (const operation of ['pause', 'stop']) test(`a late Pulse play cannot undo a later ${operation}`, async () => {
  const site = makeSite();
  const first = site.tuple(7, 'Song');
  site.context.ajax.post = (url, params, callbacks) => queueMicrotask(() => {
    if (String(url).includes('owner_playlists')) return callbacks.onDone([], 0, {});
    callbacks.onDone({ list: [first], totalCount: 1 });
  });
  site.player.getCurrentAudio = function () { return this.current === '42_7' ? first : null; };
  let finish;
  site.direct.nextLoad = new Promise(resolve => { finish = resolve; });
  const api = load(site);
  await wait(10);
  const receipt = api.command({ operation: 'play', id: 'vk-42-7', requestId: 'late' });
  assert.equal(receipt.pending, true);
  api.command({ operation });
  finish();
  await wait(0);
  api.playback();
  assert.equal(api.playback().playing, false, 'late completion started an explicitly paused/stopped track');
  assert.equal(site.player.current, null, 'official player was started');
  assert.equal(receipt.pending, false);
  if (operation === 'stop') assert.equal(api.playback().requestedId, null);
  else {
    api.command({ operation: 'resume' });
    await wait(0);
    assert.equal(api.playback().playing, true, 'explicit resume was suppressed by stale pause intent');
  }
});

test('polling does not pause an external source without a Pulse-owned play', async () => {
  const site = makeSite();
  const external = site.tuple(9, 'External');
  site.player.current = '42_9';
  site.player.playing = true;
  site.player.getCurrentAudio = () => external;
  const api = load(site);
  await wait(10);
  api.playback();
  assert.equal(site.player.playing, true);
});
