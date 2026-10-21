import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src-tauri/src/vk_artist.js', import.meta.url), 'utf8');
const id = '6749485843676900230';
function setup({ accountChange = false, followConfirmed = true, repeatedPage = false, missingHydration = false, wrongHydration = false } = {}) {
  let followed = false, blockCalls = 0, resolveId, fullRequests = 0, catalogCalls = 0;
  const registered = [], row = { id: 1, owner_id: -200, artist: 'Daft Punk', title: 'Track', duration: 300, url: 'https://media.example/full.mp3', main_artists: [{ id, name: 'Daft Punk' }], access_key: 'secret' };
  const rawRelease = (n, type = 'single') => ({ id: n, owner_id: -200, title: `Release ${n}`, count: 1, type: 'album', album: { type }, main_artists: [{ id, name: 'Daft Punk' }], plays: 12345, access_key: 'release-secret', photo: { photo_600: 'https://cdn.example/image.jpg' } });
  let w;
  const audio = {
    searchArtists: async () => ({ items: [{ id, name: 'Daft Punk', photo: [{ url: 'https://x.local/image', width: 400 }] }] }),
    followArtist: async ({ artist_id }) => { resolveId = artist_id; followed = followConfirmed },
    unfollowArtist: async () => { followed = false },
    getFollowedArtists: async () => ({ artists: [{ id, name: 'Daft Punk' }], has_next: false }),
    getPlaylistById: async () => rawRelease(1),
    get: async () => ({ count: 1, items: [row] }),
    getSnippets: async () => [{ audios: [{ ...row, url: 'https://media.example/snippet.mp3' }] }],
    getById: async args => { fullRequests++; assert.equal(args.url_type, undefined); assert.ok(['-200_1_secret', '-200_1'].includes(args.audios)); if (missingHydration) return []; if (wrongHydration) return [{...row,id:999}]; return [row] },
    getAudioPreviewUrl: async () => ({ url: 'https://media.example/clip.mp3', clip_from: 12000, clip_to: 42000 }),
  };
  const catalog = {
    getAudioArtist: async ({ artist_id }) => { catalogCalls++; resolveId = artist_id; if (accountChange) w.vk.id = 999; return { catalog: { default_section: 'artist' } } },
    getAudio: async () => ({ catalog: { sections: [{ id: 'updates', url: '/audio?section=updates' }] } }),
    getSection: async args => {
      if (args.section_id === 'artist') return { artists: [{ id, name: 'Daft Punk', is_followed: followed, can_follow: true, bio: '<b>Artist</b>' }], audios: [row], section: { blocks: [{ title: 'Релизы', actions: [{ section_id: 'releases' }] }] } };
      if (args.section_id === 'releases') return { section: { blocks: [{ id: 'block', data_type: 'music_playlists', next_from: 'page2' }] }, playlists: [rawRelease(1, 'album')] };
      if (args.section_id === 'updates') return { section: { blocks: [], ...(args.start_from ? {} : { next_from: 'next-feed' }) }, playlists: [rawRelease(args.start_from ? 4 : 3, 'ep')] };
      throw Error('Unexpected section');
    },
    getBlockItems: async () => { blockCalls++; return { block: { id: 'block', ...(repeatedPage ? { next_from: 'page2' } : {}) }, playlists: [rawRelease(2)] } },
  };
  const runtime = index => index === 217528 ? { ensureDIRootWebContainer: () => ({ resolve: token => token === 'audio' ? audio : catalog }) } : index === 518943 ? { AudioApi: 'audio' } : { CatalogApi: 'catalog' };
  runtime.m = { 217528: true, 518943: true, 751716: true };
  w = { vk: { id: 42 }, webpackChunkvkweb: { push: entry => entry[2](runtime) }, __PULSE_VK_WEB__: { acceptSearch: tuples => { registered.push(...tuples); return tuples.map(t => ({ id: `vk-${t[1]}-${t[0]}`, source: 'vk', title: t[3], artist: t[4], duration: t[5], url: `vk-web://${t[1]}/${t[0]}`, remote: { ownerId: t[1], audioId: t[0], inLibrary: false } })) } } };
  w.top = w;
  const timers = new Set();
  const context = vm.createContext({ window: w, location: { origin: 'https://vk.ru' }, URL, Date, Math, Map, Set, Promise, Number, Object, Array, Error, String, document: { createElement: () => ({ set innerHTML(v) { this.value = v }, value: '' }) }, setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); timers.add(t); return t }, clearTimeout });
  vm.runInContext(source, context);
  async function request(input) {
    const key = `test-${Math.random()}`; assert.equal(w.__PULSE_VK_ARTISTS__.start(key, input, 42), true);
    for (let n = 0; n < 30; n++) { await new Promise(r => setImmediate(r)); const receipt = w.__PULSE_VK_ARTISTS__.read(key, 42); if (receipt.complete) return receipt; }
    throw Error('Fixture timed out');
  }
  return { request, registered, window: w, stats: () => ({ resolveId, blockCalls, fullRequests, catalogCalls }), cleanup: () => { for (const t of timers) clearTimeout(t) } };
}

let count = 0;
async function test(name, options, check) { const fixture = setup(options); try { await check(fixture); console.log(`PASS ${name}`); count++; } finally { fixture.cleanup() } }
await test('artist ID preserves every decimal digit, album categories and real plays paginate', {}, async f => { const r = await f.request({ action: 'artist', artistId: id }); assert.equal(r.error, undefined); assert.equal(r.result.artist.id, id); assert.equal(f.stats().resolveId, id); assert.equal(r.result.artist.releases.length, 2); assert.equal(r.result.artist.releases[0].plays, 12345); assert.equal(r.result.artist.releases[1].kind, 'single'); assert.equal(r.result.hasMore, false); assert.equal(JSON.stringify(r.result).includes('secret'), false); assert.equal(JSON.stringify(r.result).includes('.mp3'), false) });
await test('unsafe artwork is not exported', {}, async f => { const r = await f.request({ action: 'resolve', query: 'Daft Punk' }); assert.equal(r.result.artists[0].photo, undefined) });
await test('following needs an authoritative follow readback', { followConfirmed: false }, async f => { const r = await f.request({ action: 'follow', artistId: id, follow: true }); assert.match(r.error, /не подтвердил подписку/); assert.equal(r.result, undefined) });
await test('confirmed following returns the matching artist state', {}, async f => { const r = await f.request({ action: 'follow', artistId: id, follow: true }); assert.equal(r.result.artist.followed, true) });
await test('account switch rejects in-flight catalog and exports no tracks', { accountChange: true }, async f => { const r = await f.request({ action: 'artist', artistId: id }); assert.match(r.error, /Аккаунт/); assert.equal(f.registered.length, 0) });
await test('snippet discovery registers only refetched full tracks', {}, async f => { const r = await f.request({ action: 'snippets' }); assert.equal(r.result.tracks.length, 1); assert.equal(f.stats().fullRequests, 1); assert.equal(f.registered[0][2], 'https://media.example/full.mp3'); assert.equal(JSON.stringify(r.result).includes('secret'), false) });
await test('snippet milliseconds become exact public seconds without URLs', {}, async f => { const r = await f.request({ action: 'snippet', trackId: 'vk--200-1' }); assert.equal(r.result.clip.from, 12); assert.equal(r.result.clip.to, 42); assert.equal(JSON.stringify(r.result).includes('https:'), false) });
await test('repeated pagination stops with honest partial status', { repeatedPage: true }, async f => { const r = await f.request({ action: 'artist', artistId: id }); assert.equal(r.result.hasMore, true); assert.equal(f.stats().blockCalls, 1) });
await test('updates paginate section cursors and preserve followed artists', {}, async f => { const r = await f.request({ action: 'updates' }); assert.equal(r.result.releases.length, 2); assert.equal(r.result.artists[0].followed, true); assert.equal(r.result.hasMore, false) });
await test('private full-source refresh preserves identity and rejects changed account', {}, async f => { await f.request({ action: 'snippets' }); const tuple = f.registered[0]; assert.equal(typeof tuple.__pulseResolveSource, 'function'); assert.equal(Object.keys(tuple).includes('__pulseResolveSource'), false); const fresh = await tuple.__pulseResolveSource(); assert.equal(fresh[0], tuple[0]); assert.equal(fresh[1], tuple[1]); assert.equal(fresh[2], 'https://media.example/full.mp3'); f.window.vk.id = 77; await assert.rejects(tuple.__pulseResolveSource(), /Аккаунт/); });
await test('warm cache rehydrates exact tuples after a cold module without loading artist catalogs', {}, async f => { const r = await f.request({action:'hydrate',ids:['vk--200-1']}); assert.equal(r.result.tracks[0].id,'vk--200-1'); assert.equal(f.stats().fullRequests,1); assert.equal(f.stats().catalogCalls,0); assert.equal(f.registered.length,1); assert.equal(f.registered[0][24],'secret'); assert.equal(typeof f.registered[0].__pulseResolveSource,'function'); assert.equal(JSON.stringify(r.result).includes('secret'),false); assert.equal(JSON.stringify(r.result).includes('.mp3'),false) });
await test('repeat warm reads restore the tuple registry without redundant API reads', {}, async f => { await f.request({action:'hydrate',ids:['vk--200-1']}); const first = f.stats().fullRequests; await f.request({action:'hydrate',ids:['vk--200-1']}); assert.equal(f.stats().fullRequests,first); assert.equal(f.registered.length,2) });
await test('warm cache refuses missing tracks before claiming a ready registry', {missingHydration:true}, async f => { const r = await f.request({action:'hydrate',ids:['vk--200-1']}); assert.match(r.error,/не подтвердил все сохранённые/); assert.equal(f.registered.length,0) });
await test('warm cache refuses a response for a different exact track identity', {wrongHydration:true}, async f => { const r = await f.request({action:'hydrate',ids:['vk--200-1']}); assert.match(r.error,/не подтвердил все сохранённые/); assert.equal(f.registered.length,0) });
await test('release opens from exact public identity without a warmed release map', {}, async f => { const r = await f.request({action:'release',releaseId:'vk-playlist--200-1'}); assert.equal(r.error,undefined); assert.equal(r.result.release.id,'vk-playlist--200-1'); assert.equal(r.result.tracks.length,1) });
console.log(`${count} artist adapter checks passed`);
