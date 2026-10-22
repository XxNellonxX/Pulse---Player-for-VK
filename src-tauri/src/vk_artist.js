/* Session-bound artist catalog. Only bounded public metadata leaves this
 * document. Website APIs retain credentials, resource keys and media URLs. */
(() => {
  'use strict';
  const w = window;
  if (w.top !== w || !['https://vk.com', 'https://vk.ru'].includes(location.origin)) return;
  if (w.__PULSE_VK_ARTISTS__?.version === 2) return;
  const requests = new Map(), releases = new Map(), hydrated = new Map();
  let runtime;
  const current = () => Number(w.vk?.id) || 0;
  const identity = value => typeof value === 'string' && /^\d{1,30}$/.test(value) ? value : Number.isSafeInteger(value) && value > 0 ? String(value) : '';
  const clean = (value, max = 500) => {
    if (typeof value !== 'string') return '';
    const node = document.createElement('textarea'); node.innerHTML = value;
    return node.value.replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, max);
  };
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const photo = value => {
    const candidate = typeof value === 'string' ? value : Array.isArray(value) ? [...value].sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url : value?.photo_600 || value?.photo_300 || value?.photo_200 || value?.photo_135;
    try { const u = new URL(candidate); return candidate.length <= 4096 && u.protocol === 'https:' && !u.username && !u.password && !/^(localhost|\d+\.\d+\.\d+\.\d+)$/.test(u.hostname) && !u.hostname.endsWith('.localhost') && !u.hostname.endsWith('.local') && !u.hostname.includes(':') && (!u.port || u.port === '443') ? u.href : undefined; } catch { return undefined; }
  };
  function services() {
    if (!runtime) w.webpackChunkvkweb?.push([[`pulse-artists-${Date.now()}-${Math.random()}`], {}, require => { runtime = require; }]);
    if (!runtime?.m?.[217528] || !runtime.m[518943] || !runtime.m[751716]) throw new Error('Интерфейс артистов VK изменился. Обновите приложение.');
    const container = runtime(217528).ensureDIRootWebContainer();
    return { audio: container.resolve(runtime(518943).AudioApi), catalog: container.resolve(runtime(751716).CatalogApi) };
  }
  function artist(raw) {
    const id = identity(raw?.id), name = clean(raw?.name, 200);
    if (!id || !name) return null;
    return { id, name, ...(photo(raw.photo) ? { photo: photo(raw.photo) } : {}), ...(typeof raw.is_followed === 'boolean' ? { followed: raw.is_followed } : {}), ...(typeof raw.can_follow === 'boolean' ? { canFollow: raw.can_follow } : {}) };
  }
  function release(raw) {
    if (!Number.isSafeInteger(raw?.owner_id) || !raw.owner_id || !Number.isSafeInteger(raw.id) || raw.id < 1) return null;
    const id = `vk-playlist-${raw.owner_id}-${raw.id}`;
    releases.delete(id); releases.set(id, raw);
    while (releases.size > 1000) releases.delete(releases.keys().next().value);
    const refs = (raw.main_artists || []).map(artist).filter(Boolean).slice(0, 20);
    const type = raw.album?.type;
    return { id, ownerId: raw.owner_id, playlistId: raw.id, title: clean(raw.title) || 'Без названия', artist: refs.map(item => item.name).join(', ') || clean(raw.subtitle), ...(refs.length ? { artistRefs: refs } : {}), ...(photo(raw.photo) ? { artwork: photo(raw.photo) } : {}), kind: type === 'album' ? 'album' : type === 'ep' ? 'ep' : type === 'single' ? 'single' : type === 'collection' ? 'compilation' : 'release', trackCount: count(raw.count) || 0, ...(count(raw.plays) != null ? { plays: raw.plays } : {}), ...(Number.isSafeInteger(raw.year) && raw.year > 1800 && raw.year < 2200 ? { year: raw.year } : {}), ...(count(raw.create_time) ? { releasedAt: raw.create_time * 1000 } : {}) };
  }
  function register(rows) {
    if (!Array.isArray(rows) || rows.length > 500) throw new Error('VK вернул некорректный список треков.');
    const account = current(), { audio } = services();
    const toTuple = raw => {
      if (Array.isArray(raw)) return raw;
      const tuple = [];
      tuple[0] = raw.id; tuple[1] = raw.owner_id; tuple[2] = raw.url; tuple[3] = raw.title; tuple[4] = raw.artist; tuple[5] = raw.duration;
      tuple[6] = raw.album?.id; tuple[9] = raw.has_lyrics; tuple[10] = 0; tuple[12] = { audio_streams: raw.audio_streams || [] }; tuple[13] = '';
      tuple[14] = photo(raw.thumb) || photo(raw.album?.thumb) || ''; tuple[16] = raw.subtitle; tuple[17] = raw.main_artists; tuple[18] = raw.featured_artists;
      tuple[19] = raw.album; tuple[20] = raw.track_code; tuple[21] = raw.restriction_status || 0; tuple[24] = raw.access_key;
      Object.defineProperty(tuple, '__pulseRecordingMetadata', { value: {
        ...(typeof raw.is_explicit === 'boolean' ? { is_explicit: raw.is_explicit } : typeof raw.explicit === 'boolean' ? { explicit: raw.explicit } : {}),
        ...(typeof raw.isrc === 'string' ? { isrc: raw.isrc } : {}),
      } });
      // API audio objects do not carry the website's old reload hashes. Keep
      // their exact source refresh inside this account-bound document so a
      // queued artist track can recover after its signed URL expires.
      Object.defineProperty(tuple, '__pulseResolveSource', { value: async () => {
        if (!account || current() !== account) throw new Error('Аккаунт VK изменился. Повторите запуск.');
        const result = await audio.getById({ audios: `${raw.owner_id}_${raw.id}${raw.access_key ? `_${raw.access_key}` : ''}` });
        if (current() !== account) throw new Error('Аккаунт VK изменился. Повторите запуск.');
        const refreshed = Array.isArray(result) && result.find(item => item.owner_id === raw.owner_id && item.id === raw.id);
        if (!refreshed) throw new Error('VK не подтвердил источник выбранного трека.');
        return toTuple(refreshed);
      } });
      return tuple;
    };
    for (const raw of rows) if (!Array.isArray(raw)) {
      const id = `vk-${raw.owner_id}-${raw.id}`;
      hydrated.delete(id); hydrated.set(id, { account, at: Date.now(), raw });
      while (hydrated.size > 500) hydrated.delete(hydrated.keys().next().value);
    }
    const tuples = rows.map(toTuple);
    return w.__PULSE_VK_WEB__.acceptSearch(tuples);
  }
  async function run(input, expected, valid) {
    const { audio, catalog } = services();
    const call = async task => { valid(); const result = await task(); valid(); return result; };
    const expandReleases = async data => {
      const rows = [...(data.playlists || [])], seen = new Set(); let hasMore = false;
      for (const initial of data.section?.blocks || []) {
        if (initial.data_type !== 'music_playlists' || !initial.next_from) continue;
        let block = initial;
        while (block.next_from && rows.length < 200) {
          const cursor = `${block.id}:${block.next_from}`;
          if (seen.has(cursor) || typeof block.id !== 'string' || typeof block.next_from !== 'string') { hasMore = true; break; }
          seen.add(cursor);
          const next = await call(() => catalog.getBlockItems({ block_id: block.id, start_from: block.next_from, count: Math.min(100, 200 - rows.length) }));
          if (!Array.isArray(next.playlists) || !next.block) { hasMore = true; break; }
          rows.push(...next.playlists); block = next.block;
        }
        if (block.next_from) hasMore = true;
      }
      return { rows: rows.slice(0, 200), hasMore };
    };
    const resolve = async query => {
      const result = await call(() => audio.searchArtists({ q: query, count: 20 }));
      if (!Array.isArray(result?.items)) throw new Error('VK не подтвердил результаты поиска артистов.');
      return result.items.map(artist).filter(Boolean).slice(0, 20);
    };
    if (input.action === 'hydrate') {
      // This action is emitted only by native code after validating its
      // account-scoped public cache. Recreate the page-owned exact tuple
      // registry after a restart without refetching artist/catalog sections.
      if (!Array.isArray(input.ids) || input.ids.length > 500 || input.ids.some(id => typeof id !== 'string' || !/^vk--?\d+-\d+$/.test(id))) throw new Error('Некорректный сохранённый каталог.');
      const ids = [...new Set(input.ids)], rows = [], missing = [], allowed = new Set(ids);
      for (const id of ids) {
        const entry = hydrated.get(id);
        if (entry?.account === expected && Date.now() - entry.at < 600_000) rows.push(entry.raw);
        else missing.push(id);
      }
      for (let offset = 0; offset < missing.length; offset += 100) {
        const part = missing.slice(offset, offset + 100);
        const raw = await call(() => audio.getById({ audios: part.map(id => /^vk-(-?\d+)-(\d+)$/.exec(id)).map(match => `${match[1]}_${match[2]}`).join(',') }));
        if (!Array.isArray(raw)) throw new Error('VK не подтвердил сохранённые треки.');
        rows.push(...raw.filter(item => allowed.has(`vk-${item.owner_id}-${item.id}`)));
      }
      const unique = [...new Map(rows.map(item => [`vk-${item.owner_id}-${item.id}`, item])).values()];
      if (unique.length !== ids.length) throw new Error('VK не подтвердил все сохранённые треки. Обновите карточку.');
      return { tracks: register(unique), checkedAt: Date.now() };
    }
    if (input.action === 'resolve') return { artists: await resolve(input.query), checkedAt: Date.now() };
    if (input.action === 'artist' || input.action === 'follow') {
      if (!identity(input.artistId)) throw new Error('Выберите артиста из каталога VK.');
      if (input.action === 'follow') {
        if (typeof input.follow !== 'boolean') throw new Error('Некорректное состояние подписки.');
        await call(() => input.follow ? audio.followArtist({ artist_id: input.artistId }) : audio.unfollowArtist({ artist_id: input.artistId }));
      }
      const initial = await call(() => catalog.getAudioArtist({ artist_id: input.artistId }));
      const sectionId = initial?.catalog?.default_section;
      if (typeof sectionId !== 'string' || sectionId.length > 4000) throw new Error('VK не предоставил страницу артиста.');
      const data = await call(() => catalog.getSection({ section_id: sectionId }));
      const raw = data.artists?.find(item => identity(item.id) === input.artistId), summary = artist(raw);
      if (!summary || !Array.isArray(data.section?.blocks)) throw new Error('VK изменил формат карточки артиста.');
      if (input.action === 'follow' && summary.followed !== input.follow) throw new Error('VK пока не подтвердил подписку. Обновите страницу перед повтором.');
      const rawReleases = [...(data.playlists || [])]; let hasMore = false;
      const releaseHeader = data.section.blocks.find(block => /^(Релизы|Releases)$/i.test(block.title || '') && Array.isArray(block.actions));
      const allSection = releaseHeader?.actions?.find(action => typeof action.section_id === 'string')?.section_id;
      if (allSection) {
        const all = await call(() => catalog.getSection({ section_id: allSection }));
        if (Array.isArray(all.playlists)) { const expanded = await expandReleases(all); rawReleases.unshift(...expanded.rows); hasMore = expanded.hasMore; }
      }
      const all = [...new Map(rawReleases.map(item => [`${item.owner_id}_${item.id}`, item])).values()];
      const ownReleases = all.filter(item => item.type === 'album' && item.main_artists?.some(ref => identity(ref.id) === input.artistId)).map(release).filter(Boolean).slice(0, 200);
      const tracks = register((data.audios || []).slice(0, 100));
      return { artist: { ...summary, bio: clean(raw.bio, 3000), ...(count(raw.listeners_count) != null ? { listeners: raw.listeners_count } : {}), ...(count(raw.followers_count) != null ? { followers: raw.followers_count } : {}), tracks, releases: ownReleases, checkedAt: Date.now() }, checkedAt: Date.now(), hasMore };
    }
    if (input.action === 'release') {
      const match = /^vk-playlist-(-?\d+)-(\d+)$/.exec(input.releaseId || '');
      if (!match || !Number.isSafeInteger(Number(match[1])) || !Number.isSafeInteger(Number(match[2]))) throw new Error('Некорректный релиз.');
      const known = releases.get(input.releaseId);
      const raw = await call(() => audio.getPlaylistById({ owner_id: Number(match[1]), playlist_id: Number(match[2]), ...(known?.access_key ? { access_key: known.access_key } : {}) }));
      const card = release(raw);
      if (!card || card.id !== input.releaseId) throw new Error('VK не подтвердил выбранный релиз.');
      const rows = [], seen = new Set(), expectedCount = count(raw.count);
      if (expectedCount == null || expectedCount > 500) throw new Error('Слишком большой релиз. Откройте его в VK.');
      while (rows.length < expectedCount) {
        const page = await call(() => audio.get({ owner_id: raw.owner_id, album_id: raw.id, access_key: raw.access_key, count: 100, offset: rows.length }));
        if (!Array.isArray(page?.items) || !page.items.length || page.count !== expectedCount || rows.length + page.items.length > expectedCount) throw new Error('Релиз VK прочитан не полностью. Повторите запрос.');
        const signature = page.items.map(item => `${item.owner_id}_${item.id}`).join(',');
        if (seen.has(signature)) throw new Error('Релиз VK прочитан не полностью. Повторите запрос.');
        seen.add(signature);
        rows.push(...page.items);
      }
      return { release: card, tracks: register(rows), checkedAt: Date.now() };
    }
    if (input.action === 'updates') {
      const [base, followed] = await Promise.all([call(() => catalog.getAudio({})), call(() => audio.getFollowedArtists({ count: 200 }))]);
      const updates = base?.catalog?.sections?.find(item => typeof item.url === 'string' && /[?&]section=updates(?:&|$)/.test(item.url));
      if (!updates?.id) throw new Error('VK пока не предоставил раздел обновлений.');
      const data = await call(() => catalog.getSection({ section_id: updates.id }));
      if (!data.section || !Array.isArray(data.section.blocks)) throw new Error('VK не подтвердил ленту обновлений.');
      const expanded = await expandReleases(data);
      let nextFrom = data.section.next_from; const seen = new Set();
      while (nextFrom && expanded.rows.length < 200) {
        if (typeof nextFrom !== 'string' || seen.has(nextFrom)) break;
        seen.add(nextFrom);
        const page = await call(() => catalog.getSection({ section_id: updates.id, start_from: nextFrom, count: Math.min(100, 200 - expanded.rows.length) }));
        if (!page.section || !Array.isArray(page.playlists)) break;
        const extra = await expandReleases(page); expanded.rows.push(...extra.rows.slice(0, 200 - expanded.rows.length)); expanded.hasMore ||= extra.hasMore;
        nextFrom = page.section.next_from;
      }
      return { artists: (followed.artists || []).map(artist).filter(Boolean).slice(0, 500).map(item => ({ ...item, followed: true })), releases: [...new Map(expanded.rows.map(item => [`${item.owner_id}_${item.id}`, item])).values()].map(release).filter(Boolean), checkedAt: Date.now(), hasMore: Boolean(nextFrom) || expanded.hasMore || Boolean(followed.has_next) };
    }
    if (input.action === 'snippets') {
      const groups = await call(() => audio.getSnippets({ count: 12 }));
      if (!Array.isArray(groups)) throw new Error('VK не предоставил сниппеты.');
      const rows = [...new Map(groups.flatMap(group => Array.isArray(group.audios) ? group.audios : []).map(item => [`${item.owner_id}_${item.id}`, item])).values()].slice(0, 60);
      if (!rows.length) return { tracks: [], checkedAt: Date.now(), message: 'VK пока не подобрал сниппеты.' };
      // A snippet source must never replace a full track's source in the queue.
      const full = await call(() => audio.getById({ audios: rows.map(item => `${item.owner_id}_${item.id}${item.access_key ? `_${item.access_key}` : ''}`).join(',') }));
      if (!Array.isArray(full)) throw new Error('VK не подтвердил полные треки сниппетов.');
      const allowed = new Set(rows.map(item => `${item.owner_id}_${item.id}`));
      return { tracks: register(full.filter(item => allowed.has(`${item.owner_id}_${item.id}`)).slice(0, 60)), checkedAt: Date.now() };
    }
    if (input.action === 'snippet') {
      const match = /^vk-(-?\d+)-(\d+)$/.exec(input.trackId || '');
      if (!match) throw new Error('Для локального файла сниппет VK недоступен.');
      const clip = await call(() => audio.getAudioPreviewUrl({ audio_id: `${match[1]}_${match[2]}` }));
      const from = Number(clip?.clip_from) / 1000, to = Number(clip?.clip_to) / 1000;
      if (!photo(clip?.url) || !Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from || to - from > 120) throw new Error('Для этого трека VK не предоставил сниппет.');
      return { clip: { trackId: input.trackId, from, to }, checkedAt: Date.now() };
    }
    throw new Error('Неизвестный раздел музыки.');
  }
  Object.defineProperty(w, '__PULSE_VK_ARTISTS__', { configurable: true, value: Object.freeze({ version: 2,
    start(key, input, expected) {
      if (!expected || current() !== expected || typeof key !== 'string' || key.length > 100 || !input || typeof input !== 'object' || !w.__PULSE_VK_WEB__?.acceptSearch) return false;
      if (requests.has(key)) return true;
      if (requests.size >= 8) { const first = requests.keys().next().value; const old = requests.get(first); old.cancelled = true; clearTimeout(old.timer); requests.delete(first); }
      const state = { account: expected, complete: false, cancelled: false }; requests.set(key, state);
      const valid = () => { if (state.cancelled || current() !== expected || requests.get(key) !== state) throw new Error('Аккаунт VK изменился. Повторите запрос.'); };
      const timer = state.timer = setTimeout(() => { if (!state.complete) { state.complete = true; state.cancelled = true; state.error = input.action === 'follow' ? 'VK не подтвердил подписку вовремя. Обновите карточку перед повтором.' : 'VK не ответил вовремя. Попробуйте ещё раз.'; } }, 40000);
      Promise.resolve().then(() => { valid(); return run(input, expected, valid); }).then(result => { valid(); Object.assign(state, { complete: true, result }); }, error => { if (requests.get(key) === state && !state.complete) Object.assign(state, { complete: true, error: /^VK |^Для |^Выберите |^Некоррект|^Аккаунт|^Интерфейс|^Релиз|^Слишком/.test(error?.message || '') ? error.message : 'Не удалось получить данные VK. Проверьте соединение и повторите.' }); }).finally(() => clearTimeout(timer));
      return true;
    },
    read(key, expected) { const item = requests.get(key); if (!item || expected !== current() || item.account !== expected) return { complete: true, error: 'Аккаунт VK изменился. Повторите запрос.' }; if (!item.complete) return { complete: false }; requests.delete(key); return item.error ? { complete: true, error: item.error } : { complete: true, result: item.result }; },
  }) });
})();
