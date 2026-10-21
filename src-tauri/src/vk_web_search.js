/* Read-only global search using the same signed-in website endpoint as VK's
 * AudioPlaylist.TYPE_SEARCH loader. Raw tuples stay inside this document. */
(() => {
  'use strict';
  const w = window;
  if (w.top !== w || !/^https:\/\/(vk\.com|vk\.ru)(?:\/|$)/.test(w.location.href)) return;
  if (w.__PULSE_VK_SEARCH__) return;
  const requests = new Map();
  const queryCache = new Map();
  const error = message => ({ complete: true, error: message });
  const owner = () => Number.isSafeInteger(Number(w.vk?.id)) && Number(w.vk.id) > 0 ? Number(w.vk.id) : 0;
  function start(key, query, expectedAccount) {
    if (typeof key !== 'string' || !key || key.length > 100 || typeof query !== 'string' || !query.trim() || query.length > 400 || !expectedAccount || expectedAccount !== owner()) return false;
    if (!w.__PULSE_VK_WEB__?.acceptSearch || typeof w.ajax?.post !== 'function') return false;
    if (requests.has(key)) return true;
    // Cap abandoned polls, not the user's music library.
    if (requests.size >= 8) {
      const abandonedKey = requests.keys().next().value;
      const abandoned = requests.get(abandonedKey);
      abandoned.complete = true;
      clearTimeout(abandoned.timer);
      requests.delete(abandonedKey);
    }
    const request = { complete: false, account: expectedAccount };
    requests.set(key, request);
    const cacheKey = `${expectedAccount}:${query.trim().toLocaleLowerCase()}`;
    const cached = queryCache.get(cacheKey);
    const finish = (rows, message) => {
      if (request.complete) return;
      clearTimeout(request.timer);
      delete request.timer;
      if (owner() !== expectedAccount) { Object.assign(request, error('Аккаунт VK изменился. Повторите поиск.')); return; }
      if (message) { Object.assign(request, error(message)); return; }
      try {
        if (!Array.isArray(rows) || rows.length > 1000) throw new Error('schema');
        const tracks = w.__PULSE_VK_WEB__.acceptSearch(rows.slice(0, 100));
        if (!Array.isArray(tracks)) throw new Error('schema');
        Object.assign(request, { complete: true, tracks });
        queryCache.set(cacheKey, { at: Date.now(), rows: rows.slice(0, 100) });
        while (queryCache.size > 20) queryCache.delete(queryCache.keys().next().value);
      } catch { Object.assign(request, error('VK изменил формат поиска. Обновите приложение.')); }
    };
    request.timer = setTimeout(() => finish(null, 'Поиск VK не ответил. Проверьте соединение и повторите.'), 20000);
    if (cached && Date.now() - cached.at < 60000) { finish(cached.rows); return true; }
    try {
      w.ajax.post('al_audio.php', {
        act: 'load_section', type: 'search', owner_id: expectedAccount,
        playlist_id: 0, offset: 0, context: 'search', access_hash: '',
        search_q: query.trim(), search_performer: 0, search_lyrics: 0,
        search_sort: 0, search_history: 0, claim: 0, track_type: 'default',
      }, {
        onDone(data) {
          if (data === false) { finish([]); return; }
          // VK currently wraps global search results as a `recoms` playlist
          // even though the requested loader type is `search`. Both wrappers
          // carry the same raw tuple list; unrelated playlist types still fail.
          if (!data || typeof data !== 'object' || !Array.isArray(data.list) || (data.type != null && !['search', 'recoms'].includes(data.type))) { finish(null, 'VK не подтвердил результаты поиска. Повторите запрос.'); return; }
          finish(data.list);
        },
        onFail() { finish(null, 'Не удалось выполнить поиск VK. Проверьте соединение.'); return true; },
      });
    } catch { finish(null, 'Поиск VK пока недоступен. Дождитесь подключения аккаунта.'); }
    return true;
  }
  Object.defineProperty(w, '__PULSE_VK_SEARCH__', { configurable: true, value: Object.freeze({
    start,
    read(key, expectedAccount) {
      if (owner() !== expectedAccount) { requests.delete(key); return error('Аккаунт VK изменился. Повторите поиск.'); }
      const value = requests.get(key);
      if (!value) return error('Поиск отменён. Повторите запрос.');
      if (value.account !== expectedAccount) { requests.delete(key); return error('Аккаунт VK изменился. Повторите поиск.'); }
      if (value.complete) { requests.delete(key); const { account, ...result } = value; return result; }
      return { complete: false };
    },
  }) });
})();
