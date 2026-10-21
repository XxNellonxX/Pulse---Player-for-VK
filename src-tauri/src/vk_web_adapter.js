/*
 * Session-bound VK website adapter. This code runs only inside the user's VK
 * page. The site's ajax client keeps authentication and request hashes there;
 * neither cookies, auth tokens nor raw audio tuples leave this closure.
 *
 * Source schemas checked against VK's public website bundles on 2026-10-20:
 * audio.cb3b45b1.js: owner_playlists (50/page), AudioPage.loadPlaylists.
 * audioplayer-lib.37272c14.js: load_section, AudioPlaylist, AudioPlayer.
 * common.fcedce56.js: AUDIO_PLAYER_ENUMS / EAudioTupleIndex.
 * Website schemas may change. An incomplete/unknown response is an error,
 * never an authoritative empty library.
 */
(() => {
  'use strict';
  const w = window;
  if (w.top !== w || !/^https:\/\/(vk\.com|vk\.ru)(?:\/|$)/.test(w.location.href)) return;
  if (w.__PULSE_VK_WEB__?.version === 2) {
    if (w.__PULSE_VK_WEB_RUN_ID != null) w.__PULSE_VK_WEB__.start(w.__PULSE_VK_WEB_RUN_ID, w.__PULSE_VK_WEB_CACHE, { full: w.__PULSE_VK_WEB_FULL_REFRESH === true });
    return;
  }

  const MAX_ITEMS = 100000;
  const MAX_PAGES = 2000;
  const REQUEST_TIMEOUT = 20000;
  const UNVERSIONED_PLAYLIST_CACHE_MS = 10 * 60 * 1000;
  const tuples = new Map();
  const knownTracks = new Map();
  const searchTracks = new Map();
  const playlistCards = new Map();
  let catalogIds = new Set();
  let cached = null;
  // The website can publish vk.id after our first injection. Keep an inert,
  // account-scoped seed until a positive identity can validate it.
  let pendingSeed = null;
  let forceFull = false;
  let periodicTimer = null;
  let consecutiveFailures = 0;
  let generation = 0;
  let catalogTask = Promise.resolve();
  let account = 0;
  let delivered = false;
  let readyTimer = null;
  let desiredTrack = null;
  let ownedTrack = null;
  let desiredPlayback = null;
  let playbackError = null;
  let equalizerError = null;
  let playbackIntentSequence = 0;
  let direct = null;
  function directPlayer() {
    if (!direct) {
      if (typeof w.__PULSE_CREATE_DIRECT_AUDIO__ !== 'function') throw new Error('Прямой аудиоплеер не загрузился. Перезапустите Pulse.');
      direct = w.__PULSE_CREATE_DIRECT_AUDIO__();
    }
    return direct;
  }
  const publicCommandErrors = new Set([
    'Войдите в VK.', 'Плеер VK ещё загружается.',
    'Трек отсутствует в текущей библиотеке VK. Обновите синхронизацию.',
    'Интерфейс плеера VK изменился.', 'Некорректная громкость.',
    'Некорректная позиция.', 'Длительность трека ещё не определена.',
    'Неизвестная команда плеера.',
  ]);
  const state = {
    version: 1, runId: '', status: 'waiting-login', user: null,
    tracks: [], playlists: [], syncedAt: null,
    progress: { phase: 'auth', tracks: 0, playlists: 0, completedPlaylists: 0 },
    message: 'Войдите в VK. Музыка загрузится автоматически.',
    playbackMode: 'site', lastCommand: null,
    cacheStats: { libraryPages: 0, playlistPages: 0, reusedPlaylists: 0 },
  };
  const text = (value, limit = 500) => {
    const raw = typeof value === 'string' ? value : '';
    // Parse entities as text; do not run markup from playlist/title fields.
    try {
      const node = document.createElement('textarea');
      node.innerHTML = raw;
      return node.value.replace(/<[^>]*>/g, '').slice(0, limit);
    } catch { return raw.replace(/<[^>]*>/g, '').slice(0, limit); }
  };
  const integer = value => {
    if (typeof value !== 'number' && !(typeof value === 'string' && /^-?\d+$/.test(value))) return 0;
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : 0;
  };
  function https(value) {
    if (typeof value !== 'string' || value.length > 8192) return undefined;
    try {
      const u = new URL(value);
      if (u.protocol !== 'https:' || !u.hostname || u.username || u.password || (u.port && u.port !== '443')) return undefined;
      if (u.hostname === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname) || u.hostname.includes(':')) return undefined;
      return u.href;
    } catch { return undefined; }
  }
  function currentAccount() { return integer(w.vk?.id) > 0 ? integer(w.vk.id) : 0; }
  function valid(run, owner) {
    if (run !== generation || currentAccount() !== owner || account !== owner) throw new Error('session_changed');
  }
  function userInfo(id) {
    const nameEl = document.querySelector('.top_profile_name, .TopNavBtn__profileName, [data-testid="top_profile_name"]');
    const image = document.querySelector('img.top_profile_img, #top_profile_link img, .TopNavBtn__profileImg img, img[data-testid="top_profile_img"], header img[alt], #page_header img[alt]');
    const profile = w.vk?.user;
    const known = profile && typeof profile === 'object' ? [profile.first_name, profile.last_name].filter(x => typeof x === 'string').join(' ') : '';
    const name = text(nameEl?.textContent || known || image?.getAttribute?.('alt') || `VK ${id}`, 200);
    const avatar = https(image?.getAttribute?.('src') || profile?.photo_100 || profile?.photo_200);
    return { id, name, ...(avatar ? { avatar } : {}) };
  }
  function getPlayer() {
    try { return typeof w.getAudioPlayer === 'function' ? w.getAudioPlayer() : w.ap || null; } catch { return null; }
  }
  function tupleValue(raw, key, fallback, objectKeys) {
    if (Array.isArray(raw)) {
      const configured = w.AudioUtils?.[key];
      return raw[Number.isInteger(configured) ? configured : fallback];
    }
    if (raw && typeof raw === 'object') for (const field of objectKeys) if (raw[field] != null) return raw[field];
    return undefined;
  }
  function trackIdentity(raw) {
    const owner = integer(tupleValue(raw, 'AUDIO_ITEM_INDEX_OWNER_ID', 1, ['owner_id', 'ownerId']));
    const id = integer(tupleValue(raw, 'AUDIO_ITEM_INDEX_ID', 0, ['id', 'audio_id', 'audioId']));
    if (!owner || id <= 0) throw new Error('invalid_audio_identity');
    return { owner, id, key: `vk-${owner}-${id}`, fullId: `${owner}_${id}` };
  }
  function mapTrack(raw, inLibrary) {
    const identity = trackIdentity(raw);
    const album = tupleValue(raw, 'AUDIO_ITEM_INDEX_ALBUM', 19, ['album']);
    const covers = tupleValue(raw, 'AUDIO_ITEM_INDEX_COVER_URL', 14, ['coverUrl_l', 'coverUrl', 'cover_url']);
    const artwork = https(typeof covers === 'string' ? covers.split(/,(?!\d)/)[0] : undefined)
      || https(raw?.album?.thumb?.photo_300);
    const duration = Number(tupleValue(raw, 'AUDIO_ITEM_INDEX_DURATION', 5, ['duration']));
    if (!Number.isFinite(duration) || duration < 0 || duration > 604800) throw new Error('invalid_audio_duration');
    const restriction = Number(tupleValue(raw, 'AUDIO_ITEM_INDEX_RESTRICTION', 21, ['restrictionStatus', 'restriction_status']) || 0);
    const artists = tupleValue(raw, 'AUDIO_ITEM_INDEX_MAIN_ARTISTS', 17, ['main_artists', 'mainArtists']);
    const featured = tupleValue(raw, 'AUDIO_ITEM_INDEX_FEAT_ARTISTS', 18, ['featured_artists', 'featArtists']);
    const artistRefs = [...(Array.isArray(artists) ? artists : []), ...(Array.isArray(featured) ? featured : [])].flatMap(artist => {
      const id = typeof artist?.id === 'string' ? artist.id : Number.isSafeInteger(artist?.id) ? String(artist.id) : '';
      return /^\d{1,30}$/.test(id) && typeof artist?.name === 'string' ? [{ id, name: text(artist.name, 200) }] : [];
    }).filter((artist, index, all) => all.findIndex(item => item.id === artist.id) === index).slice(0, 20);
    const performer = tupleValue(raw, 'AUDIO_ITEM_INDEX_PERFORMER', 4, ['artist', 'performer']);
    return {
      id: identity.key, title: text(tupleValue(raw, 'AUDIO_ITEM_INDEX_TITLE', 3, ['title']) || 'Без названия'),
      artist: text(performer || (Array.isArray(artists) ? artists.map(a => a?.name).filter(Boolean).join(', ') : '') || 'Неизвестный исполнитель'),
      album: text(typeof album === 'string' ? album : album?.title || ''), duration,
      // Signed media URLs and raw source data stay in the website's runtime.
      // Its player refreshes URLs and preserves all access checks itself.
      ...(artwork ? { artwork } : {}), url: `vk-web://${identity.owner}/${identity.id}`,
      source: 'vk', addedAt: 0, available: !restriction,
      ...(artistRefs.length ? { artistRefs } : {}),
      remote: { ownerId: identity.owner, audioId: identity.id, inLibrary },
    };
  }
  function playlistIdentity(raw) {
    const original = raw?.original_identity;
    const source = original == null ? raw : original;
    const owner = integer(source?.ownerId ?? source?.owner_id);
    const id = integer(source?.id ?? source?.playlistId ?? source?.playlist_id ?? source?.albumId);
    if (!owner || id <= 0) throw new Error('invalid_playlist_identity');
    return { owner, id, key: `vk-playlist-${owner}-${id}` };
  }
  function playlistAccess(card, identity) {
    const direct = card.accessHash || card.access_hash || card.access_key || card.accessKey;
    if (typeof direct === 'string' && direct) return direct;
    // Followed playlists have an account-local alias. The source playlist and
    // its resource key are the same ones used by VK's own playlist link.
    // Keep the key in this website runtime, never in the native metadata.
    if (typeof card.href !== 'string') return '';
    try {
      const url = new URL(card.href, w.location.href);
      if (!['https://vk.com', 'https://vk.ru'].includes(url.origin)) return '';
      const match = url.pathname.match(/^\/(?:music\/playlist\/|audio_playlist)(-?\d+)_(\d+)_([a-zA-Z0-9]+)\/?$/);
      if (match && integer(match[1]) === identity.owner && integer(match[2]) === identity.id) return match[3];
    } catch { /* The source link is optional; VK will enforce access checks. */ }
    return '';
  }
  function request(url, params, run, owner) {
    valid(run, owner);
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => finish(new Error('request_timeout')), REQUEST_TIMEOUT);
      function finish(error, args) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { valid(run, owner); } catch (changed) { reject(changed); return; }
        if (error) reject(error); else resolve(args);
      }
      try {
        if (typeof w.ajax?.post !== 'function') throw new Error('website_not_ready');
        w.ajax.post(url, params, {
          onDone: (...args) => finish(null, args),
          onFail: () => { finish(new Error('website_request_failed')); return true; },
        });
      } catch { finish(new Error('website_request_failed')); }
    });
  }
  function count(value) {
    const n = integer(value);
    if ((typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) || n < 0 || n > MAX_ITEMS || Number(value) !== n) throw new Error('invalid_collection_count');
    return n;
  }
  async function readSongs(owner, playlistId, accessHash, run, sessionOwner, onPage, declaredRestricted = false) {
    let offset = 0;
    let expected = null;
    const all = [];
    const seenPages = new Set();
    const libraryIds = playlistId === -1 ? new Set() : null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const [data] = await request('al_audio.php', {
        act: 'load_section', type: 'playlist', owner_id: owner, playlist_id: playlistId,
        access_hash: accessHash || '', offset, is_loading_all: 1, is_preload: 0,
        context: 'my', claim: 0,
      }, run, sessionOwner);
      if (playlistId === -1) state.cacheStats.libraryPages++;
      else state.cacheStats.playlistPages++;
      if (data === false && declaredRestricted) throw new Error('playlist_restricted');
      if (!data || typeof data !== 'object' || !Array.isArray(data.list)) throw new Error('invalid_audio_page');
      const total = count(data.totalCount);
      if (expected !== null && expected !== total) throw new Error('collection_changed');
      expected = total;
      if (data.ownerId != null && integer(data.ownerId) !== owner) throw new Error('wrong_playlist_owner');
      if ((data.id ?? data.albumId) != null && integer(data.id ?? data.albumId) !== playlistId) throw new Error('wrong_playlist_id');
      // A playlist is an ordered list of occurrences, not a set. VK can
      // return the same identity more than once, even across offset pages.
      // Guard exact page replay while preserving all legitimate occurrences.
      const pageIds = data.list.map(raw => trackIdentity(raw).key);
      const pageSignature = pageIds.join('|');
      if (data.list.length && seenPages.has(pageSignature)) throw new Error('repeated_audio_page');
      if (data.list.length) seenPages.add(pageSignature);
      // The account library contains unique audio identities. A shifted
      // offset page can repeat one while omitting another without changing
      // totalCount; never publish that deduplicated subset as a full sync.
      // Saved playlists may intentionally repeat an audio occurrence.
      if (libraryIds) for (const id of pageIds) {
        if (libraryIds.has(id)) throw new Error('repeated_library_audio');
        libraryIds.add(id);
      }
      all.push(...data.list);
      if (all.length > total || all.length > MAX_ITEMS) throw new Error('contradictory_audio_count');
      onPage?.(all.length, total);
      if (all.length === total) return all;
      if (!data.list.length) throw new Error('incomplete_audio_page');
      // VK's own loadAllPlaylistAudios uses numeric offsets with
      // is_loading_all=1. nextOffset/hasMore belong to the interactive loader
      // and can describe a different window; totalCount is authoritative here.
      const next = all.length;
      if (next <= offset) throw new Error('nonadvancing_audio_page');
      offset = next;
    }
    throw new Error('page_limit');
  }
  async function readPlaylists(run, owner) {
    const cards = [];
    const seen = new Set();
    let expected = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const [items, rawCount] = await request('al_audio.php?act=owner_playlists', {
        owner_id: owner, group_id: 0, offset: cards.length, is_attach: 0,
      }, run, owner);
      if (!Array.isArray(items)) throw new Error('invalid_playlist_page');
      const total = count(rawCount);
      if (expected !== null && expected !== total) throw new Error('collection_changed');
      expected = total;
      for (const item of items) {
        const id = playlistIdentity(item).key;
        if (seen.has(id)) throw new Error('repeated_playlist_page');
        seen.add(id);
        cards.push(item);
      }
      state.progress.totalPlaylists = total;
      state.progress.playlists = cards.length;
      if (cards.length > total) throw new Error('contradictory_playlist_count');
      if (cards.length === total) return cards;
      if (!items.length) throw new Error('incomplete_playlist_page');
    }
    throw new Error('page_limit');
  }
  function playlistFingerprint(card) {
    // Only public metadata participates. Resource keys must stay in memory.
    const revision = card.update_time ?? card.updateTime ?? card.modified_time ?? card.last_updated ?? null;
    return JSON.stringify([card.size ?? null, revision, card.title ?? '', card.description ?? '',
      card.coverUrl ?? card.cover_url ?? card.photo?.photo_300 ?? '', card.permissions?.play !== false]).slice(0, 4000);
  }
  function reusablePlaylist(card, previous, index) {
    if (forceFull || !previous || previous.contentUnavailable || !index || index.fingerprint !== playlistFingerprint(card)) return false;
    if (!previous.trackIds.every(id => knownTracks.has(id))) return false;
    // VK doesn't always publish a reliable revision. Revalidate bounded cached
    // contents periodically so same-count edits cannot remain stale forever.
    const age = Date.now() - Number(index.checkedAt);
    return age >= 0 && age < UNVERSIONED_PLAYLIST_CACHE_MS;
  }
  function seedCache(value, owner) {
    if (!owner || integer(value?.accountId) !== owner || !Array.isArray(value.tracks) || !Array.isArray(value.playlists)) return null;
    const tracks = value.tracks.slice(0, MAX_ITEMS).filter(track => {
      const remote = track?.remote;
      return remote && integer(remote.ownerId) && integer(remote.audioId) > 0 && track.id === `vk-${remote.ownerId}-${remote.audioId}`
        && track.source === 'vk' && track.url === `vk-web://${remote.ownerId}/${remote.audioId}`;
    });
    knownTracks.clear();
    for (const track of tracks) {
      knownTracks.set(track.id, track);
      if (track.remote?.searchResult) searchTracks.set(track.id, track);
    }
    const playlists = value.playlists.slice(0, MAX_ITEMS).filter(item => item?.remote && Array.isArray(item.trackIds) && item.trackIds.every(id => knownTracks.has(id)));
    catalogIds = new Set(tracks.filter(track => !track.remote.searchResult || track.remote.inLibrary).map(track => track.id));
    for (const playlist of playlists) for (const id of playlist.trackIds) catalogIds.add(id);
    while (searchTracks.size > 500) {
      const oldest = searchTracks.keys().next().value;
      searchTracks.delete(oldest);
      forgetUnusedSearch(oldest);
    }
    return { accountId: owner, tracks, playlists, index: value.index && typeof value.index === 'object' ? value.index : {} };
  }
  function serializeCatalog(run, owner, operation) {
    const result = catalogTask.catch(() => {}).then(() => {
      valid(run, owner);
      return operation();
    });
    catalogTask = result.catch(() => {});
    return result;
  }
  function collect(run, owner) {
    return serializeCatalog(run, owner, () => collectCatalog(run, owner)).catch(() => {});
  }
  async function collectCatalog(run, owner) {
    try {
      state.status = 'syncing';
      state.cacheStats = { libraryPages: 0, playlistPages: 0, reusedPlaylists: 0 };
      delete state.error;
      delete state.errorCode;
      state.progress.phase = 'library';
      state.message = 'Загружаем вашу музыку VK…';
      const byId = new Map();
      const nextTuples = new Map();
      const rawLibrary = await readSongs(owner, -1, '', run, owner, (loaded, total) => {
        state.progress.tracks = loaded;
        state.progress.totalTracks = total;
      });
      for (const raw of rawLibrary) {
        const track = mapTrack(raw, true);
        byId.set(track.id, track);
        nextTuples.set(track.id, raw);
        tuples.set(track.id, raw);
      }
      state.progress.phase = 'playlists';
      state.message = 'Загружаем плейлисты и их состав…';
      const cards = await readPlaylists(run, owner);
      const playlists = [];
      const nextIndex = {};
      const previousPlaylists = new Map((cached?.playlists || []).map(item => [item.id, item]));
      for (const card of cards) {
        valid(run, owner);
        const identity = playlistIdentity(card);
        const access = playlistAccess(card, identity);
        playlistCards.set(identity.key, { identity, access });
        const previous = previousPlaylists.get(identity.key);
        if (reusablePlaylist(card, previous, cached?.index?.[identity.key])) {
          state.cacheStats.reusedPlaylists++;
          playlists.push(previous);
          nextIndex[identity.key] = cached.index[identity.key];
          for (const id of previous.trackIds) if (!byId.has(id)) byId.set(id, { ...knownTracks.get(id), remote: { ...knownTracks.get(id).remote, inLibrary: false } });
          state.progress.completedPlaylists = playlists.length;
          state.progress.tracks = byId.size;
          continue;
        }
        let rawSongs, contentUnavailable = false;
        try {
          rawSongs = await readSongs(identity.owner, identity.id, access, run, owner, undefined, card.permissions?.play === false);
        } catch (error) {
          if (error?.message !== 'playlist_restricted') throw error;
          // Keep a visible saved playlist when VK itself denies this account
          // access. Never disguise a failed/unknown response as an empty list.
          contentUnavailable = true;
          rawSongs = [];
        }
        const ids = [];
        for (const raw of rawSongs) {
          const track = mapTrack(raw, false);
          ids.push(track.id);
          if (!byId.has(track.id)) byId.set(track.id, track);
          nextTuples.set(track.id, raw);
          if (byId.size > MAX_ITEMS) throw new Error('library_limit');
        }
        const artwork = https(card.coverUrl || card.cover_url || card.photo?.photo_300 || (typeof card.thumb === 'string' ? card.thumb : card.thumb?.photo_300));
        const created = integer(card.create_time ?? card.createTime ?? 0);
        playlists.push({
          id: identity.key, title: text(card.title || 'Без названия'), description: text(card.description || '', 2000),
          trackIds: ids, createdAt: created > 0 && created <= 4102444800 ? created * 1000 : 0,
          ...(artwork ? { artwork } : {}), syncedAt: Date.now(),
          ...(contentUnavailable ? { contentUnavailable: true, remoteTrackCount: count(card.size ?? 0) } : {}),
          remote: { ownerId: identity.owner, playlistId: identity.id },
        });
        nextIndex[identity.key] = { fingerprint: playlistFingerprint(card), checkedAt: Date.now() };
        state.progress.completedPlaylists = playlists.length;
        state.progress.tracks = byId.size;
      }
      valid(run, owner);
      const searchTuples = [...tuples].filter(([id]) => searchTracks.has(id));
      tuples.clear();
      for (const [id, raw] of searchTuples) tuples.set(id, raw);
      for (const [id, raw] of nextTuples) tuples.set(id, raw);
      state.tracks = Array.from(byId.values());
      catalogIds = new Set(byId.keys());
      state.playlists = playlists;
      knownTracks.clear();
      for (const track of state.tracks) knownTracks.set(track.id, track);
      for (const [id, track] of searchTracks) if (!knownTracks.has(id)) knownTracks.set(id, track);
      state.cacheIndex = nextIndex;
      cached = { accountId: owner, tracks: state.tracks, playlists, index: nextIndex };
      state.syncedAt = Date.now();
      state.status = 'complete';
      state.progress.phase = 'complete';
      state.user = userInfo(owner);
      const restricted = playlists.filter(playlist => playlist.contentUnavailable).length;
      state.message = `Загружено: ${state.tracks.length} доступных треков, ${playlists.length} плейлистов.${restricted ? ` VK ограничил доступ к содержимому плейлистов: ${restricted}.` : ''}`;
      delivered = false;
      consecutiveFailures = 0;
      clearTimeout(periodicTimer);
      periodicTimer = setTimeout(() => {
        if (run === generation && currentAccount() === owner && account === owner) {
          forceFull = false;
          void collect(run, owner);
        }
      }, 5 * 60 * 1000);
      periodicTimer?.unref?.();
    } catch (error) {
      if (run !== generation || currentAccount() !== owner) return;
      state.status = 'error';
      state.tracks = [];
      state.playlists = [];
      state.error = 'VK не подтвердил полную загрузку. Проверьте соединение и повторите синхронизацию.';
      state.message = state.error;
      state.errorCode = error instanceof Error && /^[a-z_]{1,64}$/.test(error.message) ? error.message : 'website_changed';
      // A temporary outage must not permanently stop background updates.
      // Preserve the last successful cache and retry with bounded backoff.
      consecutiveFailures++;
      clearTimeout(periodicTimer);
      periodicTimer = setTimeout(() => {
        if (run === generation && currentAccount() === owner && account === owner) void collect(run, owner);
      }, Math.min(300000, 30000 * 2 ** Math.min(consecutiveFailures - 1, 4)));
      periodicTimer?.unref?.();
    }
  }
  function reset(runId, owner, seed = null, options = {}) {
    const candidateSeed = seed || pendingSeed;
    const changedAccount = owner !== account;
    generation++;
    // A new account/run must not wait for an obsolete network request. Old
    // tasks still validate their generation before publishing or writing.
    catalogTask = Promise.resolve();
    clearTimeout(readyTimer);
    clearTimeout(periodicTimer);
    readyTimer = null;
    consecutiveFailures = 0;
    account = owner;
    delivered = false;
    if (changedAccount || !owner) { tuples.clear(); knownTracks.clear(); searchTracks.clear(); playlistCards.clear(); catalogIds.clear(); cached = null; }
    forceFull = options.full === true;
    cached = seedCache(candidateSeed, owner) || (cached?.accountId === owner ? cached : null);
    pendingSeed = !owner && candidateSeed && integer(candidateSeed.accountId) > 0 ? candidateSeed : null;
    state.runId = String(runId).slice(0, 200);
    state.user = owner ? userInfo(owner) : null;
    state.status = owner ? 'syncing' : 'waiting-login';
    state.tracks = [];
    state.playlists = [];
    state.syncedAt = null;
    state.cacheIndex = null;
    state.cacheStats = { libraryPages: 0, playlistPages: 0, reusedPlaylists: 0 };
    state.progress = { phase: owner ? 'website' : 'auth', tracks: 0, playlists: 0, completedPlaylists: 0 };
    state.message = owner ? 'Подключаем музыкальную библиотеку VK…' : 'Войдите в VK. Музыка загрузится автоматически.';
    delete state.error;
    delete state.errorCode;
    if (changedAccount || !owner) {
      direct?.destroy(); direct = null;
      desiredTrack = null;
      ownedTrack = null;
      desiredPlayback = null;
      playbackError = null;
    }
    if (owner) waitForWebsite(generation, owner, 0);
  }
  function waitForWebsite(run, owner, attempt) {
    if (run !== generation || currentAccount() !== owner) return;
    if (typeof w.ajax?.post === 'function' && getPlayer()) { void collect(run, owner); return; }
    // VK can finish login on Feed/Profile. Its music bundle is loaded lazily;
    // open the site's Music route once instead of waiting for unavailable
    // player globals while the user sees a successful login elsewhere.
    if (attempt === 0 && !/^\/(?:audio(?:s-?\d+)?|music)(?:[/?#]|$)/.test(w.location.pathname || new URL(w.location.href).pathname)) {
      try { w.nav?.go?.('/audio'); } catch { /* Readiness timeout remains actionable. */ }
    }
    if (attempt >= 100) {
      state.status = 'error';
      state.error = state.message = 'Музыкальный интерфейс VK не загрузился. Откройте раздел «Музыка» и повторите синхронизацию.';
      return;
    }
    readyTimer = setTimeout(() => waitForWebsite(run, owner, attempt + 1), 300);
  }
  function refreshIdentity() {
    const live = currentAccount();
    if (live !== account) reset(state.runId, live, pendingSeed, { full: forceFull });
  }
  function playback() {
    refreshIdentity();
    const result = { id: null, requestedId: desiredTrack || null, playing: false, buffering: false, advertising: false, position: 0, duration: 0, buffered: [], bufferedAhead: 0, network: 'idle', error: playbackError, equalizerEnabled: false, equalizerError, ended: false, runId: state.runId };
    if (!account || !direct) return result;
    try {
      const audio = direct.read();
      return { ...result, ...audio, id: desiredTrack || null, requestedId: desiredTrack || null, advertising: false, error: playbackError || audio.error, equalizerError: audio.equalizerError || equalizerError };
    } catch { return { ...result, error: 'Не удалось прочитать состояние аудиоплеера.' }; }
  }
  async function resolveCachedTuple(id, run, owner) {
    if (tuples.has(id)) return tuples.get(id);
    const track = knownTracks.get(id);
    if (!track) throw new Error('Трек отсутствует в текущей библиотеке VK. Обновите синхронизацию.');
    if (track.remote?.searchResult === true && !track.remote.inLibrary) {
      const [result] = await request('al_audio.php', {
        act: 'load_section', type: 'search', search_q: `${track.artist} ${track.title}`.slice(0, 300),
        owner_id: owner, playlist_id: 0, offset: 0, context: 'search', access_hash: '',
        search_performer: 0, search_lyrics: 0, search_sort: 0, search_history: 0,
        claim: 0, track_type: 'default',
      }, run, owner);
      const list = Array.isArray(result?.list) ? result.list : [];
      const raw = list.slice(0, 500).find(raw => trackIdentity(raw).key === id);
      valid(run, owner);
      if (!raw) throw new Error('cached_search_track_unavailable');
      tuples.set(id, raw);
      return raw;
    }
    const playlist = !track.remote?.inLibrary && cached?.playlists.find(item => item.trackIds.includes(id) && !item.contentUnavailable);
    let card = playlist && playlistCards.get(playlist.id);
    if (playlist && !card) {
      for (const item of await readPlaylists(run, owner)) {
        const identity = playlistIdentity(item);
        playlistCards.set(identity.key, { identity, access: playlistAccess(item, identity) });
      }
      card = playlistCards.get(playlist.id);
    }
    const listOwner = card?.identity.owner ?? playlist?.remote.ownerId ?? owner;
    const listId = card?.identity.id ?? playlist?.remote.playlistId ?? -1;
    const offset = playlist ? playlist.trackIds.indexOf(id) : (cached?.tracks.filter(t => t.remote?.inLibrary).findIndex(t => t.id === id) ?? 0);
    const [page] = await request('al_audio.php', {
      act: 'load_section', type: 'playlist', owner_id: listOwner, playlist_id: listId,
      access_hash: card?.access || '', offset: Math.max(0, offset), is_loading_all: 1,
      is_preload: 0, context: 'my', claim: 0,
    }, run, owner);
    if (!page || !Array.isArray(page.list)) throw new Error('cached_track_unavailable');
    let raw = page.list.find(raw => trackIdentity(raw).key === id);
    // The playlist may have moved since its cached offset. Search only this
    // authoritative collection rather than loading all playlists again.
    if (!raw) {
      const songs = await readSongs(listOwner, listId, card?.access || '', run, owner);
      raw = songs.find(raw => trackIdentity(raw).key === id);
    }
    valid(run, owner);
    if (!raw) throw new Error('cached_track_unavailable');
    tuples.set(id, raw);
    return raw;
  }
  // The callback is supplied by our fixed website action adapter. Tuples and
  // access keys stay in this document; only verified identities leave it.
  function libraryAction(operation, id, expectedAccount, perform) {
    refreshIdentity();
    const owner = account;
    const run = generation;
    return serializeCatalog(run, owner, () => mutateLibrary(operation, id, expectedAccount, perform, run, owner));
  }
  async function mutateLibrary(operation, id, expectedAccount, perform, run, owner) {
    valid(run, owner);
    if (!owner || owner !== expectedAccount || !['add', 'delete'].includes(operation) || typeof perform !== 'function') throw new Error('session_changed');
    const track = knownTracks.get(id);
    if (!track || !track.remote) throw new Error('unknown_library_track');
    if (operation === 'delete' && (!track.remote.inLibrary || track.remote.ownerId !== owner)) throw new Error('not_owned_library_track');
    if (operation === 'add' && track.remote.inLibrary) throw new Error('already_in_library');
    const raw = await resolveCachedTuple(id, run, owner);
    valid(run, owner);
    const source = trackIdentity(raw);
    if (source.key !== id) throw new Error('invalid_audio_identity');
    const target = await perform(raw);
    valid(run, owner);
    const audioId = operation === 'delete' ? source.id : integer(target?.id);
    const targetOwner = operation === 'delete' ? source.owner : integer(target?.ownerId);
    if (targetOwner !== owner || audioId <= 0) throw new Error('invalid_mutation_receipt');
    // A resolved mutation Promise alone is insufficient: website service
    // caches can return an already-deleted identity or a stale owned state.
    for (let attempt = 0; attempt < 3; attempt++) {
      const library = await readSongs(owner, -1, '', run, owner);
      valid(run, owner);
      const found = library.some(item => {
        const identity = trackIdentity(item);
        return identity.owner === targetOwner && identity.id === audioId;
      });
      if (found === (operation === 'add')) {
        // Publish the verified own-library order immediately. Unchanged saved
        // playlists keep their contents and verification times; deleting an
        // own song does not imply permission to edit a followed playlist.
        const byId = new Map();
        for (const item of library) {
          const mapped = mapTrack(item, true);
          byId.set(mapped.id, mapped);
          tuples.set(mapped.id, item);
        }
        const playlists = cached?.playlists || state.playlists;
        for (const playlist of playlists) for (const itemId of playlist.trackIds) {
          if (byId.has(itemId)) continue;
          const previous = knownTracks.get(itemId);
          if (!previous) throw new Error('mutation_not_verified');
          byId.set(itemId, { ...previous, remote: { ...previous.remote, inLibrary: false } });
        }
        if (byId.size > MAX_ITEMS) throw new Error('mutation_not_verified');
        for (const [itemId, previous] of searchTracks) {
          const current = byId.get(itemId);
          if (current?.remote.inLibrary) searchTracks.delete(itemId);
          else searchTracks.set(itemId, { ...previous, remote: { ...previous.remote, inLibrary: false, searchResult: true } });
        }
        state.tracks = [...byId.values()];
        catalogIds = new Set(byId.keys());
        state.playlists = playlists;
        state.cacheIndex = cached?.index || state.cacheIndex || {};
        knownTracks.clear();
        for (const item of state.tracks) knownTracks.set(item.id, item);
        for (const [itemId, item] of searchTracks) if (!knownTracks.has(itemId)) knownTracks.set(itemId, item);
        for (const itemId of tuples.keys()) if (!knownTracks.has(itemId)) tuples.delete(itemId);
        cached = { accountId: owner, tracks: state.tracks, playlists, index: state.cacheIndex };
        state.syncedAt = Date.now();
        state.status = 'complete';
        state.progress = { phase: 'complete', tracks: state.tracks.length, totalTracks: library.length, playlists: playlists.length, totalPlaylists: playlists.length, completedPlaylists: playlists.length };
        state.message = `Загружено: ${state.tracks.length} доступных треков, ${playlists.length} плейлистов.`;
        delete state.error;
        delete state.errorCode;
        delivered = false;
        return { ownerId: targetOwner, audioId };
      }
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)));
      valid(run, owner);
    }
    throw new Error('mutation_not_verified');
  }
  function playlistAction(input, expectedAccount, perform) {
    refreshIdentity();
    const owner = account, run = generation;
    return serializeCatalog(run, owner, async () => {
      valid(run, owner);
      if (!owner || owner !== expectedAccount || typeof perform !== 'function' || !input || !['create', 'edit', 'rename', 'delete', 'add-track', 'remove-track'].includes(input.operation)) throw new Error('session_changed');
      const previous = input.playlistId && (cached?.playlists || state.playlists).find(item => item.id === input.playlistId);
      if (input.operation !== 'create' && (!previous || previous.remote?.ownerId !== owner || previous.contentUnavailable)) throw new Error('foreign_playlist');
      const ids = Array.isArray(input.trackIds) ? input.trackIds : [];
      if (ids.length > 5000 || ids.some(id => typeof id !== 'string')) throw new Error('invalid_playlist_track');
      if (['add-track', 'remove-track'].includes(input.operation) && ids.length !== 1) throw new Error('invalid_playlist_track');
      const raws = [];
      for (const id of ids) {
        const track = knownTracks.get(id);
        if (!track || !track.remote || (['create', 'edit'].includes(input.operation) && !(track.remote.ownerId === owner && track.remote.inLibrary !== false) && !previous?.trackIds.includes(id))) throw new Error('invalid_playlist_track');
        raws.push(await resolveCachedTuple(id, run, owner));
        valid(run, owner);
      }
      const receipt = await perform(raws);
      valid(run, owner);
      if (integer(receipt?.ownerId) !== owner || integer(receipt?.playlistId) <= 0) throw new Error('playlist_not_verified');
      const id = `vk-playlist-${owner}-${receipt.playlistId}`;
      // Reuse all other recently verified playlist compositions. The changed
      // one must be read again, even when VK did not advance its revision.
      if (cached?.index) delete cached.index[id];
      forceFull = false;
      await collectCatalog(run, owner);
      valid(run, owner);
      if (state.status !== 'complete') throw new Error('playlist_not_verified');
      const target = state.playlists.find(item => item.id === id);
      let verified = input.operation === 'delete' ? !target : target && target.title === receipt.title && (target.description || '') === (receipt.description || '');
      if (verified && input.operation !== 'delete' && Array.isArray(receipt.trackIds)) {
        const actual = receipt.addedId ? target.trackIds.filter(item => item !== receipt.addedId) : target.trackIds;
        verified = actual.length === receipt.trackIds.length && actual.every((item, index) => item === receipt.trackIds[index]);
        if (receipt.addedId) verified = verified && target.trackIds.filter(item => item === receipt.addedId).length === 1;
      }
      if (!verified) throw new Error('playlist_not_verified');
      return { ownerId: owner, playlistId: receipt.playlistId, playlistKey: id, deleted: input.operation === 'delete', ...(target ? { title: target.title, description: target.description || '', trackIds: target.trackIds } : {}) };
    });
  }
  function command(input) {
    refreshIdentity();
    if (['play', 'pause', 'resume', 'stop'].includes(input?.operation)) ++playbackIntentSequence;
    const playbackIntent = playbackIntentSequence;
    const reply = { requestId: typeof input?.requestId === 'string' ? input.requestId.slice(0, 200) : '', accepted: false, pending: false };
    state.lastCommand = reply;
    try {
      if (!input || typeof input !== 'object' || !account) throw new Error('Войдите в VK.');
      const player = getPlayer();
      if (!player) throw new Error('Плеер VK ещё загружается.');
      let action;
      if (input.operation === 'play') {
        if (input.position != null && (typeof input.position !== 'number' || !Number.isFinite(input.position) || input.position < 0)) throw new Error('Некорректная позиция.');
        // Native storage can retain a queued search result longer than this
        // document's bounded query LRU. Restore only inert, validated metadata
        // and resolve a fresh exact tuple through VK before playback.
        const metadata = input.cachedTrack;
        const remote = metadata?.remote;
        if (!knownTracks.has(input.id) && metadata?.id === input.id && metadata.source === 'vk' && remote?.searchResult === true && remote.inLibrary === false
          && integer(remote.ownerId) && integer(remote.audioId) > 0 && input.id === `vk-${remote.ownerId}-${remote.audioId}`
          && metadata.url === `vk-web://${remote.ownerId}/${remote.audioId}` && typeof metadata.title === 'string' && typeof metadata.artist === 'string') {
          knownTracks.set(input.id, { ...metadata, title: text(metadata.title), artist: text(metadata.artist), remote: { ownerId: remote.ownerId, audioId: remote.audioId, inLibrary: false, searchResult: true } });
        }
        if (!tuples.has(input.id) && !knownTracks.has(input.id)) throw new Error('Трек отсутствует в текущей библиотеке VK. Обновите синхронизацию.');
        const previousTrack = desiredTrack;
        desiredTrack = input.id;
        forgetUnusedSearch(previousTrack);
        ownedTrack = input.id;
        desiredPlayback = 'playing';
        playbackError = null;
        const transport = directPlayer();
        const requestedAccount = account;
        const commandRun = generation;
        action = (tuples.has(input.id) ? Promise.resolve(tuples.get(input.id)) : resolveCachedTuple(input.id, commandRun, requestedAccount)).then(raw => {
          if (playbackIntent !== playbackIntentSequence || requestedAccount !== account || currentAccount() !== account || desiredPlayback !== 'playing') return;
          return transport.load(raw, player);
        }).then(() => {
          if (playbackIntent !== playbackIntentSequence || requestedAccount !== account || currentAccount() !== account || desiredPlayback !== 'playing') return;
          if (input.position > 0) transport.seek(Math.min(input.position, Math.max(0, transport.read().duration - 0.1)));
          return transport.play();
        });
      } else if (input.operation === 'pause') { if (ownedTrack) desiredPlayback = 'paused'; action = direct?.pause(); }
      else if (input.operation === 'resume') {
        if (ownedTrack) desiredPlayback = 'playing';
        const transport = directPlayer();
        if (!transport.read().duration && desiredTrack && tuples.has(desiredTrack)) {
          const requestedAccount = account;
          action = transport.load(tuples.get(desiredTrack), player).then(() => {
            if (playbackIntent === playbackIntentSequence && requestedAccount === account && currentAccount() === account && desiredPlayback === 'playing') return transport.play();
          });
        } else action = transport.play();
      }
      else if (input.operation === 'stop') { if (ownedTrack) desiredPlayback = 'stopped'; const previousTrack = desiredTrack; desiredTrack = null; forgetUnusedSearch(previousTrack); playbackError = null; action = direct?.stop(); }
      else if (input.operation === 'volume') {
        if (typeof input.volume !== 'number' || !Number.isFinite(input.volume)) throw new Error('Некорректная громкость.');
        action = directPlayer().volume(Math.max(0, Math.min(1, input.volume)));
      } else if (input.operation === 'equalizer') {
        const value = input.equalizer;
        if (!value || !Array.isArray(value.bands) || value.bands.length !== 10 || value.bands.some(band => typeof band !== 'number' || !Number.isFinite(band)) || typeof value.preamp !== 'number' || !Number.isFinite(value.preamp)) throw new Error('Некорректные параметры эквалайзера.');
        action = Promise.resolve(directPlayer().equalizer(value)).then(result => { equalizerError = result?.equalizerError || null; reply.equalizerEnabled = result?.equalizerEnabled === true; reply.equalizerError = equalizerError; return result; });
      } else if (input.operation === 'seek') {
        if (typeof input.position !== 'number' || !Number.isFinite(input.position) || input.position < 0) throw new Error('Некорректная позиция.');
        const duration = playback().duration;
        if (!duration) throw new Error('Длительность трека ещё не определена.');
        action = directPlayer().seek(Math.min(duration, input.position));
      } else throw new Error('Неизвестная команда плеера.');
      reply.accepted = true;
      if (action && typeof action.then === 'function') {
        reply.pending = true;
        const commandAccount = account;
        Promise.resolve(action).then(() => {
          reply.pending = false;
        }, error => {
          if (error?.code === 'PULSE_DIRECT_CANCELLED' || playbackIntent !== playbackIntentSequence || commandAccount !== account) { reply.pending = false; return; }
          reply.accepted = false;
          reply.pending = false;
          if (input.operation === 'equalizer') { reply.equalizerError = equalizerError || 'Эквалайзер недоступен. Трек продолжит играть без обработки.'; return; }
          reply.error = error instanceof Error && /^(VK |Источник VK |Для этого источника VK |Интерфейс источников VK)/.test(error.message) ? error.message : 'Не удалось воспроизвести доступный источник VK.';
          if (playbackIntent === playbackIntentSequence && commandAccount === account) playbackError = reply.error;
        });
      }
    } catch (error) {
      reply.error = error instanceof Error && (publicCommandErrors.has(error.message) || error.message.startsWith('Прямой аудиоплеер')) ? error.message : 'Команда VK не выполнена.';
    }
    return reply;
  }
  function forgetUnusedSearch(id) {
    if (id && id !== desiredTrack && !catalogIds.has(id) && !searchTracks.has(id)) { knownTracks.delete(id); tuples.delete(id); }
  }
  const api = {
    version: 2,
    start(runId, seed = null, options = {}) {
      const id = String(runId ?? '').slice(0, 200);
      if (id === state.runId && account === currentAccount()) return;
      reset(id, currentAccount(), seed, options);
    },
    read(forceFull = false) {
      refreshIdentity();
      const full = state.status === 'complete' && (forceFull || !delivered);
      const result = {
        version: 1, runId: state.runId, status: state.status, user: state.user,
        progress: { ...state.progress }, message: state.message, complete: full,
        playbackMode: 'direct', syncedAt: state.syncedAt,
        cacheStats: { ...state.cacheStats },
        ...(state.error ? { error: state.error, errorCode: state.errorCode, requiresReauth: !account } : {}),
        ...(full ? { tracks: state.tracks, playlists: state.playlists, cacheIndex: state.cacheIndex } : {}),
      };
      if (full) delivered = true;
      return result;
    },
    command, playback, libraryAction, playlistAction,
    acceptSearch(raws) {
      refreshIdentity();
      const owner = account;
      const run = generation;
      if (!owner || !Array.isArray(raws) || raws.length > 500) throw new Error('invalid_search_result');
      const results = raws.map(raw => {
        const id = trackIdentity(raw).key;
        const track = mapTrack(raw, knownTracks.get(id)?.remote?.inLibrary === true);
        if (!track.remote.inLibrary) track.remote.searchResult = true;
        tuples.set(id, raw);
        knownTracks.set(id, track);
        if (track.remote.searchResult) {
          // Refresh recency without evicting an unrelated entry on repeat hits.
          searchTracks.delete(id);
          searchTracks.set(id, track);
          while (searchTracks.size > 500) {
            const oldest = searchTracks.keys().next().value;
            searchTracks.delete(oldest);
            forgetUnusedSearch(oldest);
          }
        }
        return track;
      });
      valid(run, owner);
      return results;
    },
    get lastCommand() { return state.lastCommand; },
    get status() { return state.status; },
    get runId() { return state.runId; },
  };
  Object.defineProperty(w, '__PULSE_VK_WEB__', { value: api, configurable: true });
  if (w.__PULSE_VK_WEB_RUN_ID != null) api.start(w.__PULSE_VK_WEB_RUN_ID, w.__PULSE_VK_WEB_CACHE, { full: w.__PULSE_VK_WEB_FULL_REFRESH === true });
})();
