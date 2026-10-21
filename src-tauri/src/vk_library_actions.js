/* Account-bound add/delete using VK's own MusicAudioOwningService. Inspected
 * public common/audioplayer bundles, 2026-10-21. No credentials leave VK. */
(() => {
  'use strict';
  const w = window;
  if (w.top !== w || !['https://vk.com', 'https://vk.ru'].includes(location.origin)) return;
  if (w.__PULSE_VK_LIBRARY_ACTIONS__?.version === 1) return;
  const receipts = new Map();
  let runtime = null;
  let active = null;
  const account = () => Number.isSafeInteger(Number(w.vk?.id)) && Number(w.vk.id) > 0 ? Number(w.vk.id) : 0;
  const messages = {
    session_changed: 'Аккаунт VK изменился. Проверьте библиотеку перед повтором операции.',
    website_changed: 'Интерфейс изменения музыки VK изменился. Обновите приложение.',
    unknown_library_track: 'Трек VK не найден. Повторите поиск или синхронизацию.',
    not_owned_library_track: 'Удалять можно только треки из своей музыки VK.',
    already_in_library: 'Этот трек уже есть в вашей музыке VK.',
    mutation_not_verified: 'VK принял запрос, но библиотека ещё не подтвердила изменение. Обновите синхронизацию перед повтором.',
    invalid_mutation_receipt: 'VK не подтвердил идентификатор изменённого трека. Обновите библиотеку перед повтором.',
    request_timeout: 'VK не подтвердил изменение вовремя. Обновите библиотеку перед повтором.',
  };
  function valid(entry) {
    if (entry.cancelled || account() !== entry.account || active !== entry.key) throw new Error('session_changed');
  }
  function modules() {
    if (!runtime) {
      if (!Array.isArray(w.webpackChunkvkweb)) throw new Error('website_changed');
      // The normal chunk runtime callback exposes already-loaded modules;
      // never evaluate downloaded code or inspect/export API credentials.
      w.webpackChunkvkweb.push([[`pulse-library-${Date.now()}-${Math.random()}`], {}, require => { runtime = require; }]);
    }
    if (typeof runtime !== 'function' || !runtime.m?.[810213] || !runtime.m?.[522285] || !runtime.m?.[640547]) throw new Error('website_changed');
    const ensure = runtime(810213)?.ensureAudioPageMusicService;
    const Identity = runtime(522285)?.MusicAudioIdentity;
    const toAudio = runtime(640547)?.audioTupleToAudioObject;
    if (typeof ensure !== 'function' || typeof Identity !== 'function' || typeof toAudio !== 'function') throw new Error('website_changed');
    const owning = ensure()?.audioOwning;
    if (!owning || typeof owning.add !== 'function' || typeof owning.delete !== 'function') throw new Error('website_changed');
    return { Identity, toAudio, owning };
  }
  function start(key, operation, id, expectedAccount) {
    if (typeof key !== 'string' || !key || key.length > 100 || !['add', 'delete'].includes(operation) || typeof id !== 'string' || !/^vk--?\d+-\d+$/.test(id) || id.length > 100 || account() !== expectedAccount || !expectedAccount) return false;
    if (!w.__PULSE_VK_WEB__?.libraryAction) return false;
    if (receipts.has(key)) return true;
    if (active) return false;
    if (receipts.size >= 8) receipts.delete(receipts.keys().next().value);
    const entry = { key, account: expectedAccount, complete: false, cancelled: false, mayHaveChanged: false };
    receipts.set(key, entry);
    active = key;
    const finish = result => {
      if (entry.complete) return;
      clearTimeout(entry.timer);
      delete entry.timer;
      Object.assign(entry, result, { complete: true });
      if (active === key) active = null;
    };
    entry.timer = setTimeout(() => {
      entry.cancelled = true;
      finish({ error: messages.request_timeout, uncertain: entry.mayHaveChanged });
    }, 85000);
    Promise.resolve().then(async () => {
      valid(entry);
      const result = await w.__PULSE_VK_WEB__.libraryAction(operation, id, expectedAccount, async raw => {
        valid(entry);
        const { Identity, toAudio, owning } = modules();
        const audio = toAudio(raw);
        if (!audio || !Number.isSafeInteger(audio.id) || audio.id <= 0 || !Number.isSafeInteger(audio.ownerId) || !audio.ownerId || `vk-${audio.ownerId}-${audio.id}` !== id) throw new Error('website_changed');
        if (Number(owning.currentUserId) !== expectedAccount) throw new Error('session_changed');
        const identity = new Identity({ id: audio.id, ownerId: audio.ownerId, accessKey: audio.accessKey });
        valid(entry);
        entry.mayHaveChanged = true;
        const result = operation === 'add'
          ? await owning.add({ identity, trackCode: audio.trackCode, targetOwnerId: expectedAccount })
          : await owning.delete({ identity, targetOwnerId: expectedAccount });
        valid(entry);
        return result;
      });
      valid(entry);
      finish({ verified: true, ownerId: result.ownerId, audioId: result.audioId });
    }).catch(error => {
      const message = messages[error?.message] || 'VK не подтвердил изменение. Проверьте соединение и обновите библиотеку перед повтором.';
      finish({ error: message, uncertain: entry.mayHaveChanged });
    });
    return true;
  }
  Object.defineProperty(w, '__PULSE_VK_LIBRARY_ACTIONS__', { configurable: true, value: Object.freeze({
    version: 1, start,
    read(key, expectedAccount) {
      const entry = receipts.get(key);
      if (!entry || account() !== expectedAccount || entry.account !== expectedAccount) return { complete: true, error: messages.session_changed };
      if (!entry.complete) return { complete: false, mayHaveChanged: entry.mayHaveChanged };
      receipts.delete(key);
      return { complete: true, verified: entry.verified === true, ownerId: entry.ownerId, audioId: entry.audioId, error: entry.error, uncertain: entry.uncertain === true };
    },
    cancel(key, expectedAccount) {
      const entry = receipts.get(key);
      if (!entry || entry.account !== expectedAccount) return;
      entry.cancelled = true;
      clearTimeout(entry.timer);
      receipts.delete(key);
      if (active === key) active = null;
    },
  }) });
})();
