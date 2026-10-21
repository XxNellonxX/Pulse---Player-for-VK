import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { installDirectFixture } from './vk-direct-fixture.mjs';

const source = await readFile(new URL('../src-tauri/src/vk_web_adapter.js', import.meta.url), 'utf8');
const song = (owner = 101, id = 1, title = 'QA track') => {
  const tuple = [];
  tuple[0] = id; tuple[1] = owner; tuple[2] = ''; tuple[3] = title; tuple[4] = 'QA'; tuple[5] = 60;
  return tuple;
};
const settle = async () => { for (let turn = 0; turn < 12; turn++) await new Promise(resolve => setImmediate(resolve)); };

function fixture(route, options = {}) {
  const timers = new Set();
  const events = new Map();
  const requests = [];
  let current = null;
  let playing = false;
  const temp = { _list: [], getSelf() { return this; }, mergeWith(value) { this._list = value.list; } };
  const player = {
    getPlaylist: () => temp,
    getPlaylistQueue: () => ({ isPending: false, clean() {} }),
    getCurrentAudio: () => current,
    getCurrentDuration: () => 60,
    getCurrentProgress: () => .25,
    isPlaying: () => playing,
    isPaused: () => !playing,
    subscribe(event, callback) { events.set(event, callback); },
    play() { current = temp._list[0]; playing = true; },
    pause() { playing = false; }, resume() { playing = true; }, stop() { current = null; playing = false; },
    setRepeatState() {}, setVolume() {}, seekToTime() {},
  };
  const window = {
    location: { href: 'https://vk.com/audio' }, vk: { id: 101 },
    getAudioPlayer: () => player,
    ajax: { post(url, params, callbacks) {
      const request = { url, params, callbacks };
      requests.push(request);
      const result = route(request, requests.length);
      if (result !== undefined) queueMicrotask(() => callbacks.onDone(...result));
    } },
  };
  window.top = window;
  const direct = installDirectFixture(window);
  const context = vm.createContext({ window, URL, console,
    document: { querySelector: () => null, createElement: () => ({ set innerHTML(value) { this.value = value; }, value: '' }) },
    setTimeout(callback, delay) { const timer = setTimeout(() => { timers.delete(timer); callback(); }, options.timeout && delay === 20000 ? options.timeout : delay); timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
  });
  vm.runInContext(source, context);
  const api = window.__PULSE_VK_WEB__;
  return {
    window, api, requests, player, events, direct,
    setCurrent(raw, isPlaying = false) { current = raw; playing = isPlaying; },
    read: () => JSON.parse(JSON.stringify(api.read(true))),
    dispose() { for (const timer of timers) clearTimeout(timer); },
  };
}

test('a repeated library page never becomes an authoritative subset', async () => {
  const f = fixture(({ params }) => params.act === 'load_section' ? [{ list: [song()], totalCount: 2 }] : [[], 0]);
  try {
    f.api.start('repeated-page'); await settle();
    const snapshot = f.read();
    assert.equal(snapshot.complete, false);
    assert.equal(snapshot.status, 'error');
    assert.ok(f.requests.length <= 2, 'nonadvancing page caused a request loop');
  } finally { f.dispose(); }
});

test('an empty-string audio count cannot erase a previously populated library', async () => {
  const f = fixture(({ params }) => params.act === 'load_section' ? [{ list: [], totalCount: '' }] : [[], 0]);
  try {
    f.api.start('unknown-audio-count'); await settle();
    const snapshot = f.read();
    assert.equal(snapshot.complete, false, 'unknown total became an authoritative empty library');
    assert.equal(snapshot.status, 'error');
  } finally { f.dispose(); }
});

test('a boolean playlist count cannot erase the prior playlists', async () => {
  const f = fixture(({ params }) => params.act === 'load_section' ? [{ list: [], totalCount: 0 }] : [[], false]);
  try {
    f.api.start('unknown-playlist-count'); await settle();
    const snapshot = f.read();
    assert.equal(snapshot.complete, false, 'false was coerced into a verified zero playlist count');
    assert.equal(snapshot.status, 'error');
  } finally { f.dispose(); }
});

test('a completed old account callback cannot overwrite a new account run', async () => {
  let oldRequest;
  const f = fixture(request => {
    if (request.params.owner_id === 101 && request.params.act === 'load_section') { oldRequest = request; return undefined; }
    if (request.params.act === 'load_section') return [{ list: [song(202, 2)], totalCount: 1 }];
    return [[], 0];
  });
  try {
    f.api.start('account-a'); await settle();
    f.window.vk.id = 202; f.api.start('account-b'); await settle();
    assert.equal(f.read().user.id, 202);
    oldRequest.callbacks.onDone({ list: [song(101, 1)], totalCount: 1 }); await settle();
    const snapshot = f.read();
    assert.equal(snapshot.complete, true);
    assert.equal(snapshot.runId, 'account-b');
    assert.equal(snapshot.user.id, 202);
    assert.deepEqual(snapshot.tracks.map(track => track.id), ['vk-202-2']);
  } finally { f.dispose(); }
});

test('duplicate playlist cards never produce a falsely complete playlist set', async () => {
  const card = { ownerId: 101, id: 7, title: 'Same card' };
  const f = fixture(({ params }) => params.act === 'load_section' ? [{ list: [], totalCount: 0 }] : [[card], 2]);
  try {
    f.api.start('duplicate-card'); await settle();
    const snapshot = f.read();
    assert.equal(snapshot.complete, false);
    assert.equal(snapshot.status, 'error');
    assert.ok(f.requests.length <= 3);
  } finally { f.dispose(); }
});

test('a restricted playlist-only track stays identifiable but unavailable', async () => {
  const raw = song(303, 3); raw[21] = 1;
  const f = fixture(({ params }) => {
    if (params.act === 'load_section') return [{ list: params.playlist_id === -1 ? [] : [raw], totalCount: params.playlist_id === -1 ? 0 : 1 }];
    return [[{ ownerId: 101, id: 7, title: 'Restricted' }], 1];
  });
  try {
    f.api.start('restricted'); await settle();
    const snapshot = f.read();
    assert.equal(snapshot.complete, true);
    assert.equal(snapshot.tracks[0].available, false);
    assert.equal(snapshot.tracks[0].remote.inLibrary, false);
    assert.deepEqual(snapshot.playlists[0].trackIds, ['vk-303-3']);
  } finally { f.dispose(); }
});

test('an old-source ended event cannot claim the newly requested track ended', async () => {
  const a = song(101, 1), b = song(101, 2);
  const f = fixture(({ params }) => params.act === 'load_section' ? [{ list: [a, b], totalCount: 2 }] : [[], 0]);
  try {
    f.api.start('ended-race'); await settle();
    f.api.command({ operation: 'play', id: 'vk-101-1', requestId: 'a' });
    f.api.command({ operation: 'play', id: 'vk-101-2', requestId: 'b' });
    // A pending callback from the former source arrives while the official
    // player still exposes A. A command acknowledgment is not source identity.
    f.setCurrent(a, false);
    await settle();
    const playback = f.api.playback();
    assert.equal(playback.id, 'vk-101-2');
    assert.equal(playback.ended, false, 'old source ended incorrectly attributed to B');
  } finally { f.dispose(); }
});

test('one-shot full delivery can be reread after a lost native callback', async () => {
  const f = fixture(({ params }) => params.act === 'load_section' ? [{ list: [song()], totalCount: 1 }] : [[], 0]);
  try {
    f.api.start('delivery'); await settle();
    assert.equal(f.api.read().complete, true);
    assert.equal(f.api.read().complete, false);
    const recovered = f.read();
    assert.equal(recovered.complete, true);
    assert.deepEqual(recovered.tracks.map(track => track.id), ['vk-101-1']);
  } finally { f.dispose(); }
});

test('an expired response cannot overwrite a later successful run', async () => {
  let late;
  let first = true;
  const f = fixture(request => {
    if (request.params.act !== 'load_section') return [[], 0];
    if (first) { first = false; late = request; return undefined; }
    return [{ list: [song(101, 2)], totalCount: 1 }];
  }, { timeout: 15 });
  try {
    f.api.start('timed-out'); await settle();
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(f.read().status, 'error');
    f.api.start('new-run'); await settle();
    late.callbacks.onDone({ list: [song(101, 1)], totalCount: 1 }); await settle();
    const snapshot = f.read();
    assert.equal(snapshot.complete, true);
    assert.equal(snapshot.runId, 'new-run');
    assert.deepEqual(snapshot.tracks.map(track => track.id), ['vk-101-2']);
  } finally { f.dispose(); }
});

test('a failed playlist page never publishes a complete library-only result', async () => {
  const f = fixture(request => {
    if (request.params.act === 'load_section') return [{ list: [song()], totalCount: 1 }];
    queueMicrotask(() => request.callbacks.onFail());
  });
  try {
    f.api.start('incomplete-playlists'); await settle();
    const snapshot = f.read();
    assert.equal(snapshot.complete, false);
    assert.equal(snapshot.status, 'error');
    assert.equal(snapshot.tracks, undefined, 'partial library escaped as an authoritative payload');
  } finally { f.dispose(); }
});

test('sync does not invoke playback or mutate the official queue', async () => {
  let touched = 0;
  const f = fixture(({ params }) => params.act === 'load_section' ? [{ list: [song()], totalCount: 1 }] : [[], 0]);
  try {
    for (const name of ['play', 'pause', 'resume', 'stop', 'getPlaylist']) f.player[name] = () => { touched++; };
    f.api.start('sync-only'); await settle();
    assert.equal(f.read().complete, true);
    assert.equal(touched, 0, 'reading the library changed website playback');
  } finally { f.dispose(); }
});

test('a player rejection before loading reports the request without inventing a playing source', async () => {
  const f = fixture(({ params }) => params.act === 'load_section' ? [{ list: [song()], totalCount: 1 }] : [[], 0]);
  try {
    f.api.start('early-player-reject'); await settle();
    let rejectLoad;
    f.direct.nextLoad = new Promise((_resolve, reject) => { rejectLoad = reject; });
    const reply = f.api.command({ operation: 'play', id: 'vk-101-1', requestId: 'reject' });
    assert.equal(reply.pending, true);
    rejectLoad(new Error('private callback content must not escape'));
    await settle();
    const playback = f.api.playback();
    assert.equal(f.api.lastCommand.accepted, false);
    assert.equal(playback.id, 'vk-101-1');
    assert.equal(playback.requestedId, 'vk-101-1');
    assert.equal(playback.playing, false);
    assert.ok(playback.error);
    assert.doesNotMatch(playback.error, /private callback/);
  } finally { f.dispose(); }
});

test('a volume change cannot strand an earlier playback receipt forever', async () => {
  let acceptPlay;
  const f = fixture(({ params }) => params.act === 'load_section' ? [{ list: [song()], totalCount: 1 }] : [[], 0]);
  try {
    f.direct.nextLoad = new Promise(resolve => { acceptPlay = resolve; });
    f.api.start('play-volume-race'); await settle();
    const play = f.api.command({ operation: 'play', id: 'vk-101-1', requestId: 'pending-play' });
    assert.equal(play.pending, true);
    f.api.command({ operation: 'volume', volume: .6, requestId: 'later-volume' });
    acceptPlay(); await settle();
    assert.equal(play.pending, false, 'unrelated volume replaced the active receipt and stranded the native await');
    assert.equal(play.accepted, true);
    assert.equal(f.api.playback().playing, true, 'volume change cancelled a pending play');
  } finally { f.dispose(); }
});

test('refresh preserves confirmed tuples and end tracking while the new collection is pending', async () => {
  let held;
  let refreshing = false;
  const f = fixture(request => {
    if (request.params.act !== 'load_section') return [[], 0];
    if (refreshing) { held = request; return undefined; }
    return [{ list: [song()], totalCount: 1 }];
  });
  try {
    f.api.start('before-refresh'); await settle();
    f.api.command({ operation: 'play', id: 'vk-101-1', requestId: 'initial-play' });
    refreshing = true;
    f.api.start('during-refresh'); await settle();
    assert.ok(held);
    const replay = f.api.command({ operation: 'play', id: 'vk-101-1', requestId: 'play-during-read' });
    assert.equal(replay.accepted, true, 'refresh threw away the confirmed tuple cache before a new complete snapshot');
    await settle(); f.direct.instances[0].end();
    const playback = f.api.playback();
    assert.equal(playback.id, 'vk-101-1');
    assert.equal(playback.ended, true);
    assert.equal(playback.runId, 'during-refresh');
  } finally { f.dispose(); }
});

test('legitimate repeated playlist occurrences keep order while the registry stays unique', async () => {
  const a = song(101, 1), b = song(101, 2);
  const f = fixture(({ params }) => {
    if (params.act !== 'load_section') return [[{ ownerId: 101, id: 7, title: 'Intentional repeats' }], 1];
    if (params.playlist_id === -1) return [{ list: [a, b], totalCount: 2 }];
    return [{ list: [a, a, b], totalCount: 3 }];
  });
  try {
    f.api.start('legitimate-repeats'); await settle();
    const snapshot = f.read();
    assert.equal(snapshot.complete, true, 'a playlist with an intentional repeat was rejected');
    assert.equal(snapshot.tracks.length, 2);
    assert.deepEqual(snapshot.playlists[0].trackIds, ['vk-101-1', 'vk-101-1', 'vk-101-2']);
  } finally { f.dispose(); }
});

test('overlap across distinct playlist pages is preserved as an occurrence', async () => {
  const a = song(101, 1), b = song(101, 2), c = song(101, 3);
  const f = fixture(({ params }) => {
    if (params.act !== 'load_section') return [[{ ownerId: 101, id: 7, title: 'Cross-page repeats' }], 1];
    if (params.playlist_id === -1) return [{ list: [a, b, c], totalCount: 3 }];
    return [{ list: params.offset === 0 ? [a, b] : [b, c], totalCount: 4 }];
  });
  try {
    f.api.start('cross-page-occurrences'); await settle();
    const snapshot = f.read();
    assert.equal(snapshot.complete, true);
    assert.equal(snapshot.tracks.length, 3);
    assert.deepEqual(snapshot.playlists[0].trackIds, ['vk-101-1', 'vk-101-2', 'vk-101-2', 'vk-101-3']);
  } finally { f.dispose(); }
});

test('cancelled old Pulse source cannot resume after a newer Pulse source was stopped', async () => {
  const a = song(101, 1), b = song(101, 2);
  const f = fixture(({ params }) => params.act === 'load_section' ? [{ list: [a, b], totalCount: 2 }] : [[], 0]);
  try {
    f.api.start('source-intent-race'); await settle();
    f.api.command({ operation: 'play', id: 'vk-101-1', requestId: 'start-a' });
    f.api.command({ operation: 'play', id: 'vk-101-2', requestId: 'start-b' });
    f.api.command({ operation: 'stop', requestId: 'cancel-all' });
    // Simulate delayed site playback completion for A after B superseded it.
    f.setCurrent(a, true);
    const playback = f.api.playback();
    assert.equal(playback.playing, false, 'only the latest owned ID was cancelled; older Pulse-owned audio leaked after stop');
  } finally { f.dispose(); }
});

test('unrelated official-site playback is not suppressed by prior Pulse cancellation', async () => {
  const a = song(101, 1), external = song(909, 9);
  const f = fixture(({ params }) => params.act === 'load_section' ? [{ list: [a], totalCount: 1 }] : [[], 0]);
  try {
    f.api.start('external-respect'); await settle();
    f.api.command({ operation: 'play', id: 'vk-101-1', requestId: 'start' });
    f.api.command({ operation: 'stop', requestId: 'stop' });
    f.setCurrent(external, true);
    const playback = f.api.playback();
    assert.equal(playback.id, null);
    assert.equal(playback.playing, false, 'unrelated official audio leaked into Pulse playback state');
    assert.equal(f.player.isPlaying(), true, 'Pulse stopped unrelated official-site audio');
  } finally { f.dispose(); }
});
