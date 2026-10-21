/* Original MP3 bytes are uploaded by VK's own authenticated page. Upload URLs,
 * response signatures and edit hashes never leave this closure. The official
 * new_audio/initUpload/done_add/edit_audio flow was inspected 2026-10-20. */
(() => {
  'use strict';
  const w = window;
  if (w.top !== w || !['https://vk.com', 'https://vk.ru'].includes(location.origin)) return;
  if (w.__PULSE_VK_UPLOAD__?.version === 1) return;
  const LIMIT = 209715200;
  const entries = new Map();
  let active = null;
  const messages = {
    session_changed: 'Аккаунт VK изменился. Загрузка отменена.',
    website_changed: 'Форма загрузки VK изменилась. Файл не отправлен.',
    website_request_failed: 'VK отклонил запрос. Обновите подключение и попробуйте снова.',
    request_timeout: 'VK не ответил вовремя.',
    invalid_file: 'Нужен непустой файл MP3 размером до 200 МБ.',
    upload_failed: 'VK не принял файл. Проверьте соединение и формат MP3.',
    save_failed: 'VK не сохранил файл. Он может не соответствовать ограничениям VK.',
    verify_failed: 'VK ещё не подтвердил трек в библиотеке. Обновите синхронизацию перед повторной загрузкой.',
    metadata_failed: 'Трек загружен, но VK не подтвердил название и исполнителя.',
    busy: 'Дождитесь окончания текущей загрузки.',
    cancelled: 'Загрузка отменена.',
  };
  function error(code) { return new Error(code); }
  function valid(entry) {
    if (Number(w.vk?.id) !== entry.account || active !== entry.id || entry.cancelled) throw error('session_changed');
  }
  function request(entry, params, timeout = 25000) {
    valid(entry);
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => finish(error('request_timeout')), timeout);
      const finish = (err, args) => {
        if (done) return;
        done = true; clearTimeout(timer);
        try { valid(entry); } catch (e) { reject(e); return; }
        err ? reject(err) : resolve(args);
      };
      try {
        if (typeof w.ajax?.post !== 'function') throw error('website_changed');
        w.ajax.post('al_audio.php', params, {
          onDone: (...args) => finish(null, args),
          onFail: () => { finish(error('website_request_failed')); return true; },
        });
      } catch { finish(error('website_request_failed')); }
    });
  }
  // Parse data arguments, never execute JavaScript returned in the box response.
  function parseArguments(script) {
    const marker = 'AudioUtils.initUpload(';
    if (typeof script !== 'string' || script.length > 100000) throw error('website_changed');
    let p = script.indexOf(marker);
    if (p < 0) throw error('website_changed');
    p += marker.length;
    const args = [];
    const ws = () => { while (/\s/.test(script[p] || '') && p < script.length) p++; };
    while (args.length < 20) {
      ws();
      if (script[p] === ')') break;
      const begin = p;
      let value;
      if (args.length === 0 && script.slice(p, p + 3) === 'box') { value = null; p += 3; }
      else if (script[p] === '"' || script[p] === "'") {
        const quote = script[p++]; let s = ''; let closed = false;
        while (p < script.length) {
          const c = script[p++];
          if (c === quote) { closed = true; break; }
          if (c !== '\\') { s += c; continue; }
          const escaped = script[p++];
          if (escaped === 'u') {
            const hex = script.slice(p, p + 4);
            if (!/^[0-9a-f]{4}$/i.test(hex)) throw error('website_changed');
            s += String.fromCharCode(parseInt(hex, 16)); p += 4;
          } else if ('\\\'"/'.includes(escaped)) s += escaped;
          else if (escaped === 'n') s += '\n';
          else if (escaped === 'r') s += '\r';
          else if (escaped === 't') s += '\t';
          else throw error('website_changed');
        }
        if (!closed) throw error('website_changed'); value = s;
      } else if (script[p] === '{' || script[p] === '[') {
        const stack = []; let quote = null; let escape = false;
        do {
          const c = script[p++];
          if (quote) {
            if (escape) escape = false;
            else if (c === '\\') escape = true;
            else if (c === quote) quote = null;
          } else if (c === '"') quote = c;
          else if (c === '{' || c === '[') stack.push(c);
          else if (c === '}' || c === ']') {
            if ((c === '}' ? '{' : '[') !== stack.pop()) throw error('website_changed');
          }
          if (p >= script.length) throw error('website_changed');
        } while (stack.length || quote);
        try { value = JSON.parse(script.slice(begin, p)); } catch { throw error('website_changed'); }
      } else {
        const token = script.slice(p).match(/^(true|false|null|-?\d+(?:\.\d+)?)/);
        if (!token) throw error('website_changed');
        value = JSON.parse(token[0]); p += token[0].length;
      }
      args.push(value); ws();
      if (script[p] === ')') break;
      if (script[p++] !== ',') throw error('website_changed');
    }
    if (args.length !== 12 || script[p] !== ')') throw error('website_changed');
    return args;
  }
  function uploadURL(value) {
    try {
      const u = new URL(value);
      if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || !/(^|\.)(vk\.com|vk\.ru|vkuseraudio\.net|vkuseraudio\.ru)$/.test(u.hostname)) throw 0;
      return u;
    } catch { throw error('website_changed'); }
  }
  function identity(tuple) {
    const owner = Number(Array.isArray(tuple) ? tuple[w.AudioUtils?.AUDIO_ITEM_INDEX_OWNER_ID ?? 1] : tuple?.owner_id ?? tuple?.ownerId);
    const id = Number(Array.isArray(tuple) ? tuple[w.AudioUtils?.AUDIO_ITEM_INDEX_ID ?? 0] : tuple?.id ?? tuple?.audio_id);
    if (!Number.isSafeInteger(owner) || !Number.isSafeInteger(id) || !owner || id <= 0) throw error('save_failed');
    return { owner, id, fullId: `${owner}_${id}`, trackId: `vk-${owner}-${id}` };
  }
  function field(tuple, key, index, objectKey) { return Array.isArray(tuple) ? tuple[w.AudioUtils?.[key] ?? index] : tuple?.[objectKey]; }
  const text = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 500) : '';
  const decodedText = value => {
    const raw = text(value);
    try { const el = document.createElement('textarea'); el.innerHTML = raw; return text(el.value); } catch { return raw; }
  };
  async function saveMetadata(entry, tuple) {
    const id = identity(tuple);
    const wantedTitle = entry.title || text(field(tuple, 'AUDIO_ITEM_INDEX_TITLE', 3, 'title'));
    const wantedArtist = entry.artist || text(field(tuple, 'AUDIO_ITEM_INDEX_PERFORMER', 4, 'artist'));
    if (!wantedTitle || !wantedArtist) return tuple;
    if (decodedText(field(tuple, 'AUDIO_ITEM_INDEX_TITLE', 3, 'title')) === wantedTitle && decodedText(field(tuple, 'AUDIO_ITEM_INDEX_PERFORMER', 4, 'artist')) === wantedArtist) return tuple;
    const response = await request(entry, { act: 'edit_audio_box', aid: id.fullId });
    const script = response.find(x => typeof x === 'string' && x.includes("act: 'edit_audio'"));
    if (!script) throw error('metadata_failed');
    const body = script.match(/var\s+query\s*=\s*\{([\s\S]*?)\};/)?.[1];
    const hash = body?.match(/\bhash:\s*'([a-zA-Z0-9_-]{8,256})'/)?.[1];
    const oid = Number(body?.match(/\boid:\s*(-?\d+)/)?.[1]);
    const aid = Number(script.match(/var\s+id\s*=\s*(\d+)\s*;/)?.[1]);
    const genre = Number(script.match(/selectedItems:\s*'(-?\d+)'/)?.[1] || 0);
    if (!hash || oid !== entry.account || aid !== id.id) throw error('metadata_failed');
    const [updated] = await request(entry, { act: 'edit_audio', aid, oid, hash, force_edit_hash: '', performer: wantedArtist, title: wantedTitle, genre });
    if (identity(updated).fullId !== id.fullId) throw error('metadata_failed');
    if (decodedText(field(updated, 'AUDIO_ITEM_INDEX_TITLE', 3, 'title')) !== wantedTitle || decodedText(field(updated, 'AUDIO_ITEM_INDEX_PERFORMER', 4, 'artist')) !== wantedArtist) throw error('metadata_failed');
    return updated;
  }
  async function verify(entry, id) {
    entry.phase = 'verify';
    for (let attempt = 0; attempt < 8; attempt++) {
      const [data] = await request(entry, { act: 'load_section', type: 'playlist', owner_id: entry.account, playlist_id: -1, access_hash: '', offset: 0, is_loading_all: 1, is_preload: 0, context: 'my', claim: 0 });
      if (!Array.isArray(data?.list)) throw error('verify_failed');
      if (data.list.some(tuple => { try { return identity(tuple).fullId === id.fullId; } catch { return false; } })) return;
      await new Promise(resolve => setTimeout(resolve, 1000 + attempt * 300)); valid(entry);
    }
    throw error('verify_failed');
  }
  function transmit(entry, url, file) {
    valid(entry); entry.phase = 'upload';
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest(); entry.xhr = xhr;
      xhr.open('POST', url.href, true); xhr.timeout = 600000;
      xhr.onload = () => {
        entry.xhr = null;
        try { valid(entry); } catch (e) { reject(e); return; }
        if (xhr.status < 200 || xhr.status >= 300 || xhr.responseText.length > 2000000) reject(error('upload_failed'));
        else resolve(xhr.responseText);
      };
      xhr.onerror = xhr.ontimeout = xhr.onabort = () => { entry.xhr = null; reject(error('upload_failed')); };
      xhr.upload.onprogress = event => { if (event.lengthComputable) entry.percent = Math.round(event.loaded / event.total * 100); };
      const form = new FormData(); form.append('file', file); xhr.send(form);
    });
  }
  async function commit(entry) {
    try {
      valid(entry);
      if (entry.received !== entry.size) throw error('invalid_file');
      entry.phase = 'prepare';
      const response = await request(entry, { act: 'new_audio', gid: 0 });
      const script = response.find(x => typeof x === 'string' && x.includes('AudioUtils.initUpload('));
      const args = parseArguments(script);
      const url = uploadURL(args[2]);
      const vars = args[3];
      if (!vars || typeof vars !== 'object' || vars.act !== 'load_audio' || Number(vars.mid) !== entry.account || Number(vars.gid) !== 0 || typeof args[11] !== 'boolean' || !Number.isFinite(args[4]) || entry.size > args[4]) throw error('website_changed');
      if (!args[11]) for (const [key, value] of Object.entries({ ...vars, ajx: 1 })) {
        if (!['string', 'number', 'boolean'].includes(typeof value)) throw error('website_changed');
        url.searchParams.set(key, String(value));
      }
      const file = new File(entry.parts, entry.name, { type: 'audio/mpeg' });
      entry.parts.length = 0;
      let raw = await transmit(entry, url, file);
      valid(entry);
      if (!args[11]) raw = raw.replace(/\+/g, ' ');
      let parsed; try { parsed = JSON.parse(raw); } catch { parsed = Object.fromEntries(new URLSearchParams(raw.replace(/\+/g, ' '))); }
      if (!parsed || typeof parsed !== 'object' || parsed.code) throw error('upload_failed');
      let params;
      if (args[11]) params = { act: 'done_add', upldr: 1, go_uploader_response: raw };
      else {
        try { parsed.title = decodeURIComponent(parsed.title || ''); parsed.artist = decodeURIComponent(parsed.artist || ''); } catch { throw error('upload_failed'); }
        params = { ...parsed, act: 'done_add', upldr: 1 };
      }
      // From this point a timeout can mean the server saved the file. Never
      // silently retry the mutation: report an uncertain result instead.
      entry.phase = 'save'; entry.saveStarted = true;
      const [tuple] = await request(entry, params);
      const id = identity(tuple);
      if (id.owner !== entry.account) throw error('save_failed');
      entry.trackId = id.trackId;
      let metadataWarning = false;
      try { await saveMetadata(entry, tuple); } catch (e) { if (e.message === 'session_changed') throw e; metadataWarning = true; }
      await verify(entry, id);
      entry.status = 'uploaded'; entry.phase = 'done'; entry.message = metadataWarning ? messages.metadata_failed : 'Загружен в VK и подтверждён в библиотеке.';
    } catch (e) {
      entry.parts.length = 0;
      entry.status = entry.saveStarted ? 'uncertain' : 'failed'; entry.phase = 'done';
      entry.message = messages[e?.message] || (entry.saveStarted ? messages.verify_failed : messages.upload_failed);
    } finally { entry.xhr = null; if (active === entry.id) active = null; }
  }
  const read = entry => entry ? { id: entry.id, status: entry.status, phase: entry.phase, percent: entry.percent, message: entry.message, ...(entry.trackId ? { trackId: entry.trackId } : {}) } : { status: 'failed', message: messages.cancelled };
  const api = {
    version: 1,
    start(input) {
      if (active) return { accepted: false, message: messages.busy };
      if (!input || !/^[a-f0-9]{48}$/.test(input.id) || !Number.isSafeInteger(input.account) || Number(w.vk?.id) !== input.account || !Number.isSafeInteger(input.size) || input.size <= 0 || input.size > LIMIT || !/\.mp3$/i.test(input.name) || input.name.length > 255) return { accepted: false, message: messages.invalid_file };
      const entry = { id: input.id, account: input.account, size: input.size, name: input.name, title: text(input.title), artist: text(input.artist), received: 0, parts: [], phase: 'read', status: 'pending', percent: 0, message: '' };
      entries.set(entry.id, entry); active = entry.id; return { accepted: true };
    },
    append(id, offset, base64) {
      const entry = entries.get(id);
      try {
        valid(entry);
        if (entry.phase !== 'read' || offset !== entry.received || typeof base64 !== 'string' || base64.length > 524288 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw error('invalid_file');
        const decoded = atob(base64); const bytes = Uint8Array.from(decoded, c => c.charCodeAt(0));
        if (entry.received + bytes.length > entry.size) throw error('invalid_file');
        entry.parts.push(bytes); entry.received += bytes.length; return { accepted: true, received: entry.received };
      } catch { return { accepted: false, message: messages.invalid_file }; }
    },
    commit(id) { const entry = entries.get(id); try { valid(entry); if (entry.phase !== 'read') throw 0; entry.phase = 'prepare'; commit(entry); return { accepted: true }; } catch { return { accepted: false, message: messages.session_changed }; } },
    read(id) { return read(entries.get(id)); },
    cancel(id) {
      const entry = entries.get(id); if (!entry) return;
      entry.cancelled = true; entry.xhr?.abort(); entry.parts.length = 0;
      if (active === id) active = null;
      entries.delete(id);
    },
  };
  Object.defineProperty(w, '__PULSE_VK_UPLOAD__', { value: api, configurable: true });
  setInterval(() => { const entry = entries.get(active); if (entry && Number(w.vk?.id) !== entry.account) api.cancel(entry.id); }, 300);
})();
