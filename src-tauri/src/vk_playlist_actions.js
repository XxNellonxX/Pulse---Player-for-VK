/* Uses the same page-owned AudioRepository/AudioApi as VK's playlist editor.
 * Request credentials and access keys stay inside the signed-in document. */
(() => {
  'use strict';
  const w = window;
  if (w.top !== w || !['https://vk.com', 'https://vk.ru'].includes(location.origin)) return;
  if (w.__PULSE_VK_PLAYLIST_ACTIONS__?.version === 1) return;
  const receipts = new Map();
  let runtime, active;
  const account = () => Number(w.vk?.id) || 0;
  const messages = {
    session_changed: 'Сеанс VK изменился. Проверьте плейлист перед повтором.',
    website_changed: 'VK изменил интерфейс плейлистов. Обновите приложение.',
    invalid_playlist_track: 'Для плейлиста VK выберите доступные треки из своей музыки.',
    foreign_playlist: 'Изменять можно только свои плейлисты VK.',
    playlist_not_verified: 'VK пока не подтвердил содержимое плейлиста. Обновите библиотеку перед повтором.',
    duplicate_playlist_track: 'Этот трек уже есть в плейлисте.',
    request_timeout: 'VK не подтвердил изменение вовремя. Проверьте плейлист перед повтором.',
  };
  const playlistIdentity = id => { const parts = /^vk-playlist-(\d+)-(\d+)$/.exec(id || ''); return parts ? { owner: Number(parts[1]), id: Number(parts[2]) } : null; };
  function valid(entry) { if (entry.cancelled || active !== entry.key || account() !== entry.account) throw new Error('session_changed'); }
  function services() {
    if (!runtime) {
      w.webpackChunkvkweb?.push([[`pulse-playlist-${Date.now()}-${Math.random()}`], {}, require => { runtime = require; }]);
    }
    if (![217528, 65615, 518943, 640547].every(id => runtime?.m?.[id])) throw new Error('website_changed');
    const container = runtime(217528).ensureDIRootWebContainer?.();
    const repository = container?.resolve(runtime(65615).AudioRepository);
    const api = container?.resolve(runtime(518943).AudioApi);
    const toAudio = runtime(640547).audioTupleToAudioObject;
    if (typeof repository?.audioCreatePlaylist !== 'function' || typeof repository?.audioEditPlaylist !== 'function'
      || !['deletePlaylist', 'getPlaylistById', 'getIdsBySource', 'addToPlaylist', 'removeFromPlaylist'].every(key => typeof api?.[key] === 'function')
      || typeof toAudio !== 'function') throw new Error('website_changed');
    return { repository, api, toAudio };
  }
  async function perform(entry, input, raws) {
    valid(entry);
    const { repository, api, toAudio } = services();
    if (Number(repository.authService?.ensureUserId?.()) !== entry.account) throw new Error('session_changed');
    const target = input.operation === 'create' ? { owner: entry.account, id: 0 } : playlistIdentity(input.playlistId);
    if (!target || target.owner !== entry.account || (input.operation !== 'create' && target.id <= 0)) throw new Error('foreign_playlist');
    const expected = [];
    const access = raws.map(raw => {
      const audio = toAudio(raw);
      if (!audio || !Number.isSafeInteger(audio.id) || audio.id <= 0 || !Number.isSafeInteger(audio.ownerId) || !audio.ownerId) throw new Error('invalid_playlist_track');
      expected.push(`vk-${audio.ownerId}-${audio.id}`);
      return [audio.ownerId, audio.id, audio.accessKey].filter(value => value !== undefined && value !== null && value !== '').join('_');
    });
    valid(entry);
    const params = { owner_id: target.owner, playlist_id: target.id };
    let previous, previousIds = [];
    if (input.operation !== 'create') {
      previous = await api.getPlaylistById(params);
      valid(entry);
      if (Number(previous?.owner_id) !== target.owner || Number(previous?.id) !== target.id) throw new Error('playlist_not_verified');
      if (input.operation !== 'delete') {
        const ids = await api.getIdsBySource({ source: 'playlist', entity_id: `${target.owner}_${target.id}` });
        valid(entry);
        if (!Array.isArray(ids?.audios)) throw new Error('playlist_not_verified');
        previousIds = ids.audios.map(item => {
          const match = /^(-?\d+)_(\d+)(?:_[a-zA-Z0-9]+)?$/.exec(item.audio_id || '');
          if (!match) throw new Error('playlist_not_verified');
          return `vk-${match[1]}-${match[2]}`;
        });
      }
    }
    if (['create', 'edit'].includes(input.operation) && expected.some(id => !id.startsWith(`vk-${entry.account}-`) && !previousIds.includes(id))) throw new Error('invalid_playlist_track');
    let expectedIds = expected, addedId, title = input.title, description = input.description;
    if (input.operation === 'create') {
      entry.mayHaveChanged = true;
      const created = await repository.audioCreatePlaylist({ owner_id: entry.account, title, description, audio_ids: access.join(',') });
      if (Number(created?.owner_id) !== entry.account || !Number.isSafeInteger(Number(created?.id)) || Number(created.id) <= 0) throw new Error('playlist_not_verified');
      target.id = Number(created.id);
    } else if (input.operation === 'edit' || input.operation === 'rename') {
      const edit = { ...params, title, ...(input.operation === 'edit' ? { description, audio_ids: access.join(',') } : {}) };
      if (input.operation === 'rename') expectedIds = previousIds;
      entry.mayHaveChanged = true;
      await repository.audioEditPlaylist(edit);
    } else if (input.operation === 'delete') {
      entry.mayHaveChanged = true;
      await api.deletePlaylist(params);
      valid(entry);
      return { ownerId: target.owner, playlistId: target.id, deleted: true };
    } else {
      expectedIds = previousIds;
      title = previous.title;
      description = previous.description || '';
      if (input.operation === 'add-track') {
        if (expectedIds.includes(expected[0])) throw new Error('duplicate_playlist_track');
        entry.mayHaveChanged = true;
        const result = await api.addToPlaylist({ ...params, audio_ids: access[0] });
        const audioId = Number(result?.[0]?.audio_id);
        if (!Number.isSafeInteger(audioId) || audioId <= 0) throw new Error('playlist_not_verified');
        // The API may copy an external identity to the playlist owner's music.
        addedId = `vk-${entry.account}-${audioId}`;
      } else {
        entry.mayHaveChanged = true;
        await api.removeFromPlaylist({ ...params, audio_ids: access[0].split('_').slice(0, 2).join('_') });
        expectedIds = expectedIds.filter(id => id !== expected[0]);
      }
    }
    valid(entry);
    const metadata = await api.getPlaylistById({ owner_id: target.owner, playlist_id: target.id });
    valid(entry);
    if (Number(metadata?.owner_id) !== target.owner || Number(metadata?.id) !== target.id
      || metadata.title !== title || (input.operation === 'edit' || input.operation === 'create') && (metadata.description || '') !== description) throw new Error('playlist_not_verified');
    return { ownerId: target.owner, playlistId: target.id, title, description: metadata.description || '',
      trackIds: expectedIds, ...(addedId ? { addedId } : {}), deleted: false };
  }
  function start(key, input, expectedAccount) {
    if (typeof key !== 'string' || !key || key.length > 100 || !input || !['create', 'edit', 'rename', 'delete', 'add-track', 'remove-track'].includes(input.operation)
      || expectedAccount !== account() || !expectedAccount || !w.__PULSE_VK_WEB__?.playlistAction) return false;
    if (receipts.has(key)) return true;
    if (active) return false;
    while (receipts.size >= 8) receipts.delete(receipts.keys().next().value);
    const entry = { key, account: expectedAccount, complete: false, cancelled: false, mayHaveChanged: false };
    active = key;
    receipts.set(key, entry);
    const finish = value => { if (entry.complete) return; clearTimeout(entry.timer); delete entry.timer; Object.assign(entry, value, { complete: true }); if (active === key) active = null; };
    entry.timer = setTimeout(() => { entry.cancelled = true; finish({ error: messages.request_timeout, uncertain: entry.mayHaveChanged }); }, 115000);
    Promise.resolve().then(async () => {
      valid(entry);
      const result = await w.__PULSE_VK_WEB__.playlistAction(input, expectedAccount, raws => perform(entry, input, raws));
      valid(entry);
      finish({ verified: true, ...result });
    }).catch(error => finish({ error: messages[error?.message] || 'VK не подтвердил изменение плейлиста. Проверьте библиотеку перед повтором.', uncertain: entry.mayHaveChanged }));
    return true;
  }
  Object.defineProperty(w, '__PULSE_VK_PLAYLIST_ACTIONS__', { configurable: true, value: Object.freeze({ version: 1, start,
    read(key, expectedAccount) { const entry = receipts.get(key); if (!entry || entry.account !== expectedAccount || account() !== expectedAccount) return { complete: true, error: messages.session_changed }; if (!entry.complete) return { complete: false }; receipts.delete(key); return { ...entry, timer: undefined, key: undefined, account: undefined }; },
    cancel(key, expectedAccount) { const entry = receipts.get(key); if (!entry || entry.account !== expectedAccount) return; entry.cancelled = true; clearTimeout(entry.timer); receipts.delete(key); if (active === key) active = null; },
  }) });
})();
