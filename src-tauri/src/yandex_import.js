/* Read-only bridge to the first-party page's metadata resources. Never reads
 * passwords, cookies, storage, request headers, OAuth tokens or audio URLs. */
(() => {
  'use strict';
  const origins = ['https://music.yandex.ru', 'https://music.yandex.com', 'https://music.yandex.by', 'https://music.yandex.kz', 'https://music.yandex.uz'];
  if (window.top !== window.self || !origins.includes(location.origin) || window.__PULSE_YANDEX_IMPORT__) return;
  const MAX_TRACKS = 20000, MAX_PAGES = 200, PAGE = 100;
  let active = null;
  const clean = (value, max = 500) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';
  const id = value => /^(?:[1-9]\d{0,18}|0)$/.test(String(value)) ? String(value) : '';
  const alive = task => active === task && !task.cancelled && location.origin === task.origin;
  const check = task => { if (!alive(task)) throw new Error('Импорт отменён или страница Яндекса изменилась.'); };
  const bounded = async (task, work) => {
    let timer;
    try { const result = await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Яндекс не ответил на запрос метаданных.')), 20000); })]); check(task); return result; }
    catch (error) {
      check(task);
      if (error?.message === 'Яндекс не ответил на запрос метаданных.') throw error;
      const code = error?.statusCode;
      throw new Error(code === 401 ? 'Завершите обычный вход в Яндекс Музыку в открытом окне.' : code === 429 ? 'Яндекс ограничил частоту запросов. Повторите импорт позднее.' : 'Яндекс не разрешил прочитать эти метаданные. Повторите вход или используйте экспорт CSV/JSON.');
    } finally { clearTimeout(timer); }
  };
  // React context providers expose the same resources used by the site itself.
  // Only these four metadata interfaces are requested from a container. Their
  // internal transport/session state is neither inspected nor copied.
  const resources = () => {
    const starts = [];
    for (const element of [document, document.body, document.getElementById('__next'), ...document.querySelectorAll('main,header,nav')].filter(Boolean).slice(0, 12)) {
      for (const key of Object.keys(element)) if (/^__react(?:Fiber|Container)\$/.test(key)) { const fiber = element[key]; if (fiber) starts.push(fiber); }
    }
    const seen = new Set(), todo = starts;
    while (todo.length && seen.size < 8000) {
      const node = todo.pop(); if (!node || seen.has(node)) continue; seen.add(node);
      const value = node.memoizedProps?.value;
      if (value && typeof value.get === 'function') {
        try {
          const account = value.get('AccountResource'), users = value.get('UsersResource'), tracks = value.get('TracksResource');
          if (typeof account?.about === 'function' && typeof users?.getPlaylistWithTracksIds === 'function' && typeof tracks?.getTracksMeta === 'function') return { account, users, tracks };
        } catch { /* An unrelated React context is not a music container. */ }
      }
      if (node.return) todo.push(node.return); if (node.child) todo.push(node.child); if (node.sibling) todo.push(node.sibling);
    }
    throw new Error('Официальная страница Яндекс Музыки ещё не готова или изменила интерфейс метаданных.');
  };
  const about = async (task, api) => {
    const raw = await bounded(task, () => api.account.about());
    const uid = id(raw?.uid ?? raw?.account?.uid);
    if (!uid || uid === '0') throw new Error('Завершите обычный вход в Яндекс Музыку в открытом окне.');
    return { uid, userName: clean(raw.displayName ?? raw.fullName ?? raw.login ?? raw.account?.displayName ?? raw.account?.login, 200) || 'Яндекс Музыка' };
  };
  const total = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const unwrap = raw => raw?.result ?? raw;
  const image = raw => {
    let value = clean(raw?.coverUri ?? raw?.cover?.uri ?? raw?.ogImage, 2000).replace('%%', '200x200');
    if (!value) return null; if (!value.startsWith('https://')) value = 'https://' + value;
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && /(?:^|\.)yandex\.(?:net|ru)$/.test(url.hostname) ? url.href : null; } catch { return null; }
  };
  const descriptor = (raw, uid) => {
    const item = raw?.playlist ?? raw; const owner = id(item?.uid ?? item?.owner?.uid ?? uid), kind = id(item?.kind);
    if (!owner || !kind || !clean(item?.title)) return null;
    return { service: 'yandex', sourceId: `${owner}:${kind}`, sourceUrl: `pulse:yandex:playlist:${owner}:${kind}`, title: clean(item.title), total: total(item.trackCount), artwork: image(item) };
  };
  const list = async (task, api, account) => {
    if (typeof api.users.getCreatedPlaylists !== 'function' || typeof api.users.getLikedPlaylists !== 'function') throw new Error('Яндекс изменил интерфейс коллекции. Используйте экспорт CSV/JSON; неполный список не будет выдан за всю коллекцию.');
    const result = [{ service: 'yandex', sourceId: `${account.uid}:3`, sourceUrl: 'pulse:yandex:liked', title: 'Мне нравится — Яндекс Музыка', total: null, artwork: null }], keys = new Set([`${account.uid}:3`]);
    for (const mode of ['created', 'liked']) {
      let previous = '', complete = false, received = 0, declaredTotal = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        check(task);
        const raw = unwrap(await bounded(task, () => mode === 'created' ? api.users.getCreatedPlaylists({ userId: account.uid, page, pageSize: PAGE }) : api.users.getLikedPlaylists({ userId: account.uid, page, pageSize: PAGE, withTracks: false })));
        const rows = Array.isArray(raw) ? raw : mode === 'liked' ? raw?.likedPlaylists : raw?.playlists;
        if (!Array.isArray(rows) || rows.length > PAGE) throw new Error('Яндекс вернул неизвестный формат страницы плейлистов.');
        const fingerprint = rows.map(row => { const d = descriptor(row, account.uid); return d?.sourceId || '?'; }).join(',');
        if (rows.length && fingerprint === previous) throw new Error('Яндекс повторил страницу плейлистов. Вся коллекция ещё не подтверждена.'); previous = fingerprint;
        for (const row of rows) { const d = descriptor(row, account.uid); if (!d) throw new Error('Яндекс вернул плейлист без названия или идентификатора.'); if (!keys.has(d.sourceId)) { keys.add(d.sourceId); result.push(d); } }
        received += rows.length;
        const pager = raw?.pager, reported = total(pager?.total);
        if (reported !== null) {
          if (declaredTotal !== null && reported !== declaredTotal || total(pager.page) !== null && pager.page !== page) throw new Error('Порядок или размер коллекции Яндекса изменился во время чтения.');
          declaredTotal = reported;
          if (received > declaredTotal) throw new Error('Яндекс вернул больше плейлистов, чем указано в размере коллекции.');
          if (received === declaredTotal) { complete = true; break; }
          if (!rows.length || rows.length < PAGE && (total(pager.perPage) === null || pager.perPage !== rows.length)) throw new Error('Яндекс вернул неполную страницу до конца коллекции.');
        } else if (!rows.length) { complete = true; break; }
      }
      if (!complete) throw new Error('Коллекция превышает лимит 20 000 плейлистов. Экспортируйте её частями.');
    }
    await verifyAccount(task, api, account.uid); return result;
  };
  const verifyAccount = async (task, api, uid) => { if ((await about(task, api)).uid !== uid) throw new Error('Аккаунт Яндекса изменился. Повторите импорт.'); };
  const entry = (raw, position) => {
    const track = raw?.track ?? raw, sourceId = id(track?.id);
    const title = clean(track?.title), artists = Array.isArray(track?.artists) ? track.artists.map(item => clean(item?.name, 200)).filter(Boolean).slice(0, 30) : [];
    if (!sourceId || !title || !artists.length) return null;
    const version = clean(track.version, 200), duration = Number(track.durationMs);
    const isrc = clean(track.isrc, 30).replace(/[ -]/g, '').toUpperCase();
    const timestamp = typeof raw.timestamp === 'string' ? Date.parse(raw.timestamp) : NaN;
    return { sourceId, title: version ? `${title} (${version})` : title, artists, album: clean(track.albums?.[0]?.title), duration: Number.isFinite(duration) && duration >= 0 && duration <= 864000000 ? duration / 1000 : 0, position, artwork: image(track), ...(Number.isFinite(timestamp) ? { addedAt: timestamp } : {}), ...(/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(isrc) ? { isrc } : {}), ...(typeof track.explicit === 'boolean' ? { explicit: track.explicit } : track.contentWarning === 'explicit' ? { explicit: true } : {}) };
  };
  const read = async (task, api, account, input) => {
    const liked = input.url === 'pulse:yandex:liked', match = /^pulse:yandex:playlist:([1-9]\d{0,18}):(\d{1,19})$/.exec(input.url || '');
    if (!liked && !match) throw new Error('Выберите плейлист из подключённой коллекции Яндекса.');
    const owner = liked ? account.uid : match[1], kind = liked ? '3' : match[2];
    // A descriptor is validated natively against the current listed collection.
    if (!Number.isSafeInteger(Number(kind))) throw new Error('Идентификатор плейлиста Яндекса слишком большой.');
    const request = { userId: owner, playlistKind: Number(kind), resumeStream: false, ...(liked ? { trackMetaType: 'music' } : {}) };
    const raw = unwrap(await bounded(task, () => api.users.getPlaylistWithTracksIds(request)));
    const rows = raw?.tracks;
    if (!Array.isArray(rows) || rows.length > MAX_TRACKS) throw new Error('Яндекс не предоставил полный список идентификаторов либо в плейлисте больше 20 000 записей.');
    const expected = total(raw.trackCount), entries = [], warnings = [], metadata = new Map();
    for (let offset = 0; offset < rows.length; offset += PAGE) {
      check(task); const batch = rows.slice(offset, offset + PAGE);
      const ids = batch.map(row => { const r = row?.track ?? row; const trackId = id(r?.id ?? r); const albumId = id(r?.albumId); return trackId ? albumId ? `${trackId}:${albumId}` : trackId : ''; });
      if (ids.some(value => !value)) throw new Error('В списке Яндекса обнаружен трек без идентификатора.');
      const values = unwrap(await bounded(task, () => api.tracks.getTracksMeta({ trackIds: ids, withProgress: false })));
      if (!Array.isArray(values) || values.length > PAGE) throw new Error('Яндекс изменил формат метаданных треков.');
      for (const value of values) {
        const parsed = entry(value, 0); if (!parsed) continue;
        metadata.set(parsed.sourceId, value);
        for (const album of Array.isArray(value.albums) ? value.albums : []) { const albumId = id(album?.id); if (albumId) metadata.set(`${parsed.sourceId}:${albumId}`, { ...value, albums: [album] }); }
      }
      batch.forEach((row, index) => { const r = row?.track ?? row, sourceId = id(r?.id ?? r), albumId = id(r?.albumId); const value = metadata.get(albumId ? `${sourceId}:${albumId}` : sourceId); const parsed = value ? entry({ track: value, timestamp: row?.timestamp }, offset + index) : null; if (parsed) entries.push(parsed); });
      metadata.clear();
    }
    const after = unwrap(await bounded(task, () => api.users.getPlaylistWithTracksIds(request)));
    const rowKey = row => { const value = row?.track ?? row; return `${id(value?.id ?? value)}:${id(value?.albumId)}`; };
    if (!Array.isArray(after?.tracks) || after.tracks.length !== rows.length || after.tracks.some((row, index) => rowKey(row) !== rowKey(rows[index])) || after.revision !== raw.revision || total(after.trackCount) !== expected) throw new Error('Плейлист Яндекса изменился во время чтения. Повторите импорт, чтобы сохранить точный порядок.');
    await verifyAccount(task, api, account.uid);
    const complete = expected !== null && expected === rows.length && entries.length === rows.length;
    if (!complete) warnings.push(`Подтверждены метаданные ${entries.length} записей из ${expected ?? 'неизвестного количества'}. Неполный список не считается всей коллекцией.`);
    return { service: 'yandex', sourceId: `${owner}:${kind}`, sourceUrl: input.url, title: clean(raw.title) || (liked ? 'Мне нравится — Яндекс Музыка' : 'Плейлист Яндекса'), description: clean(raw.description, 2000), artwork: image(raw), total: expected, complete, warnings, entries };
  };
  window.__PULSE_YANDEX_IMPORT__ = {
    start(key, input) {
      if (typeof key !== 'string' || !/^[a-zA-Z0-9-]{8,100}$/.test(key) || !['connect', 'list', 'read'].includes(input?.action)) return false;
      if (active) active.cancelled = true;
      const task = { key, origin: location.origin, cancelled: false, complete: false }; active = task;
      (async () => { try { const api = resources(), account = await about(task, api); if (input.uid && input.uid !== account.uid) throw new Error('Аккаунт Яндекса изменился. Подключите его заново.'); task.result = input.action === 'connect' ? account : input.action === 'list' ? await list(task, api, account) : await read(task, api, account, input); } catch (error) { task.error = clean(error?.message, 500) || 'Не удалось прочитать метаданные Яндекса.'; } finally { task.complete = true; } })(); return true;
    },
    read(key) { return active?.key === key && alive(active) ? { complete: active.complete, result: active.result, error: active.error } : { complete: true, error: 'Окно Яндекса изменилось. Повторите импорт.' }; },
    cancel(key) { if (active?.key === key) { active.cancelled = true; active = null; } },
  };
})();
