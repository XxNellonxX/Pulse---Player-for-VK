/*
 * A separate audio transport inside the signed-in official VK document.
 * It consumes only sources VK already grants to that session. Authentication,
 * source hashes and signed URLs never leave this closure. No site play/ads API
 * is invoked. Unsupported, restricted and DRM sources fail explicitly.
 */
(() => {
  'use strict';
  const w = window;
  if (w.top !== w || !/^https:\/\/(vk\.com|vk\.ru)(?:\/|$)/.test(w.location.href)) return;
  const CANCELLED = 'PULSE_DIRECT_CANCELLED';
  const RESOLVE_TIMEOUT = 20000;
  const LOAD_TIMEOUT = 25000;
  const START_TIMEOUT = 60000;
  const failure = message => new Error(message);
  const cancelled = () => Object.assign(new Error('Команда воспроизведения отменена.'), { code: CANCELLED });
  const int = value => Number.isSafeInteger(Number(value)) ? Number(value) : 0;
  const index = (name, fallback) => Number.isInteger(w.AudioUtils?.[name]) ? w.AudioUtils[name] : fallback;
  function field(raw, name, fallback, keys) {
    if (Array.isArray(raw)) return raw[index(name, fallback)];
    for (const key of keys) if (raw?.[key] != null) return raw[key];
    return undefined;
  }
  function normalize(raw) {
    const owner = int(field(raw, 'AUDIO_ITEM_INDEX_OWNER_ID', 1, ['ownerId', 'owner_id']));
    const id = int(field(raw, 'AUDIO_ITEM_INDEX_ID', 0, ['id', 'audioId', 'audio_id']));
    if (!owner || id <= 0) throw failure('VK не подтвердил идентификатор трека. Обновите библиотеку.');
    const restriction = Number(field(raw, 'AUDIO_ITEM_INDEX_RESTRICTION', 21, ['restrictionStatus', 'restriction_status']) || 0);
    if (restriction || raw?.available === false || raw?.isRestricted === true) throw failure('VK ограничил воспроизведение этого трека для аккаунта.');
    const hashes = String(field(raw, 'AUDIO_ITEM_INDEX_HASHES', 13, ['hashes']) || '').split('/');
    return {
      fullId: `${owner}_${id}`, ownerId: owner, id,
      actionHash: typeof raw?.actionHash === 'string' ? raw.actionHash : hashes[2] || '',
      urlHash: typeof raw?.urlHash === 'string' ? raw.urlHash : hashes[5] || '',
      url: field(raw, 'AUDIO_ITEM_INDEX_URL', 2, ['url']),
      extra: field(raw, 'AUDIO_ITEM_INDEX_EXTRA', 12, ['extra']),
    };
  }
  function safeSource(value) {
    if (typeof value !== 'string' || value.length > 16384 || value.includes('audio_api_unavailable')) return null;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
      const host = url.hostname.toLowerCase();
      if (host === 'localhost' || host.endsWith('.localhost') || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return null;
      return url.href;
    } catch { return null; }
  }
  function sourceList(audio, player) {
    const sources = [];
    const fallbacks = [];
    if (typeof audio.url === 'string' && audio.url) sources.push({ url: audio.url, infrastructure: 'audio', format: 'unknown' });
    let extra = audio.extra;
    if (typeof extra === 'string') {
      try { extra = extra.length < 1024 * 1024 ? JSON.parse(extra) : null; } catch { extra = null; }
    }
    for (const stream of Array.isArray(extra?.audio_streams) ? extra.audio_streams.slice(0, 16) : []) {
      if (stream?.drm || stream?.key_system || stream?.license_url) continue;
      const format = { hls_ts: 'hls', hls_range: 'hls', mp3: 'mp3', aac: 'aac', flac: 'flac' }[stream?.type];
      if (format && typeof stream.url === 'string') {
        sources.push({ url: stream.url, infrastructure: 'video', format });
        // An alternate CDN is used only when VK explicitly supplied its URL.
        if (typeof stream.fallback_url === 'string') fallbacks.push({ url: stream.fallback_url, infrastructure: 'video', format });
      }
    }
    // VK's pure source factory invokes its own session-aware URL decoder.
    // Never share its AudioNodeProvider: that provider owns the site's player.
    const impl = player?._impl;
    const createKey = impl && Object.getOwnPropertyNames(impl).find(key => /(?:^|_)_createAudio$/.test(key) && typeof impl[key] === 'function');
    let decoded = sources;
    if (createKey && sources.length) {
      try {
        // The optional factory belongs to the changing website. Do not let
        // its in-place filtering/rewrite erase the original granted choices.
        const value = impl[createKey]({ id: audio.fullId, sources: sources.map(source => ({ ...source })) });
        if (Array.isArray(value?.sources)) decoded = value.sources;
      } catch {
        // This optional decoder can change independently of the audio API.
        // Keep explicit, session-granted files when they need no decoding.
        decoded = sources;
      }
    }
    const seen = new Set();
    // The website factory can collapse its choices to a single preference.
    // Retain the other unrestricted session-granted streams as fallbacks.
    // The website's legacy HLS preference can contain segments this browser
    // cannot decode. VK also supplies progressive audio for the same track:
    // use those streams directly, preserving VK's order and encoded bytes.
    // This avoids replacing a playing engine when an HLS prefetch fails.
    // The factory can rewrite AAC/FLAC formats to an unknown value while
    // keeping MP3 typed. Put the explicit provider list first so this rewrite
    // cannot silently promote MP3 ahead of VK's first progressive candidate.
    const progressive = sources.filter(source => ['aac', 'mp3', 'flac'].includes(source.format));
    const ordered = [...progressive, ...decoded.slice(0, 32), ...sources, ...fallbacks].slice(0, 81);
    const priority = source => ['aac', 'mp3', 'flac'].includes(source?.format) ? 0 : source?.format === 'hls' || /\.m3u8(?:[?#]|$)/i.test(source?.url || '') ? 1 : 2;
    ordered.sort((left, right) => priority(left) - priority(right));
    return ordered.flatMap(source => {
      const url = safeSource(source?.url);
      if (!url || seen.has(url) || source?.format === 'dash' || source?.drm) return [];
      seen.add(url);
      const format = source.format === 'hls' || /\.m3u8(?:[?#]|$)/i.test(url) ? 'hls' : 'file';
      return [{ url, format }];
    });
  }
  function create(options = {}) {
    let epoch = 0;
    let action = 0;
    let destroyed = false;
    let media = null;
    let hls = null;
    let account = 0;
    let desired = false;
    let currentVolume = 0.8;
    let error = null;
    let ended = false;
    let buffering = false;
    let ready = false;
    let observedPosition = 0;
    let resumePosition = 0;
    let knownDuration = 0;
    let recoveryCount = 0;
    let recovering = false;
    let recoveryTask = null;
    let sourceInput = null;
    let sourcePlayer = null;
    let lastProgressAt = Date.now();
    let healthyRecoverySeconds = 0;
    let hasPlayed = false;
    let initialPlayBudget = null;
    let equalizerSettings = { enabled: false, bands: Array(10).fill(0), preamp: 0 };
    let equalizerGraph = null;
    let equalizerError = null;
    let equalizerSafe = false;
    const corsProbes = new Map();
    const mediaPosition = () => Number.isFinite(media?.currentTime) ? media.currentTime : resumePosition;
    const position = () => recovering ? resumePosition : mediaPosition();
    function observeProgress() {
      const current = position();
      // Network `stalled` is not a playback pause. Hidden WebViews can also
      // throttle timeupdate, so sample the media clock on native reads too.
      if (!recovering && media && ready) {
        resumePosition = current;
        if (Number.isFinite(media.duration) && media.duration > 0) knownDuration = media.duration;
      }
      if (!recovering && desired && media && !media.paused && !media.seeking && current > observedPosition + 0.01) {
        // Two failed renewals in a row remain bounded. A successfully recovered
        // track earns a fresh budget after actual continuous media progress;
        // two unrelated expired URLs must not exhaust a long track forever.
        healthyRecoverySeconds += Math.min(current - observedPosition, Math.max(0, (Date.now() - lastProgressAt) / 1000));
        if (healthyRecoverySeconds >= 30) { recoveryCount = 0; healthyRecoverySeconds = 0; }
        buffering = false; lastProgressAt = Date.now();
      }
      observedPosition = current;
    }
    const waiting = new Set();
    const attached = [];
    const currentAccount = () => int(w.vk?.id);
    const isCurrent = generation => !destroyed && generation === epoch && currentAccount() === account && (typeof options.isCurrent !== 'function' || options.isCurrent());
    const check = generation => { if (!isCurrent(generation)) throw cancelled(); };
    function cancelWaiting() { for (const cancel of [...waiting]) cancel(); }
    function disposeMedia() {
      equalizerGraph?.destroy(); equalizerGraph = null; equalizerSafe = false;
      for (const off of attached.splice(0)) off();
      if (hls) { try { hls.destroy(); } catch { /* release best effort */ } hls = null; }
      if (media) {
        const previous = media; media = null;
        try { previous.pause(); previous.removeAttribute('src'); previous.load(); } catch { /* detached element */ }
      }
      ready = false;
      hasPlayed = false;
      observedPosition = 0;
    }
    function invalidate() { epoch++; action++; desired = false; recovering = false; recoveryTask = null; initialPlayBudget = null; cancelWaiting(); disposeMedia(); buffering = false; }
    function scope() { return { closed: false, error: null, waiting: new Set() }; }
    function closeScope(value) {
      if (value.closed) return;
      value.closed = true; value.error = cancelled();
      for (const cancel of [...value.waiting]) cancel();
    }
    function checkScope(value, generation) { check(generation); if (value?.closed) throw value.error; }
    function bounded(promise, timeout, generation, message, value = null) {
      return new Promise((resolve, reject) => {
        if (value?.closed) { reject(value.error); return; }
        let settled = false;
        const finish = (ok, value) => {
          if (settled) return;
          settled = true; clearTimeout(timer); waiting.delete(cancel); scopeValue?.waiting.delete(cancelScope);
          if (!isCurrent(generation)) reject(cancelled()); else if (ok) resolve(value); else reject(value);
        };
        const scopeValue = value;
        const cancel = () => finish(false, cancelled());
        const cancelScope = () => finish(false, scopeValue.error || cancelled());
        const timer = setTimeout(() => finish(false, failure(message)), timeout);
        waiting.add(cancel); scopeValue?.waiting.add(cancelScope);
        Promise.resolve(promise).then(value => finish(true, value), value => finish(false, value));
      });
    }
    function listen(target, type, callback, generation) {
      const handler = (...args) => { if (isCurrent(generation) && media === target) callback(...args); };
      target.addEventListener(type, handler);
      const off = () => target.removeEventListener(type, handler);
      attached.push(off);
      return off;
    }
    async function allowsEqualizer(source, generation, deadline, attempt = null) {
      // HLS.js only loads readable CORS responses and hands MSE a same-origin
      // blob. Native HLS requires a readable manifest check instead.
      const Hls = w.__PULSE_HLS__ || w.Hls;
      if (source.format === 'hls' && typeof Hls === 'function' && Hls.isSupported?.()) return true;
      if (new URL(source.url).origin === w.location.origin) return true;
      if (corsProbes.has(source.url)) return corsProbes.get(source.url);
      if (typeof w.fetch !== 'function' || typeof w.AbortController !== 'function') return false;
      const timeout = Math.min(2500, deadline - Date.now());
      if (timeout <= 0) return false;
      const controller = new w.AbortController();
      const cancel = () => controller.abort(); waiting.add(cancel); attempt?.waiting.add(cancel);
      let allowed = false;
      try {
        // Read a single range, never download/cache the song or export the
        // session-granted URL from this private document.
        const response = await bounded(w.fetch(source.url, { method: 'GET', mode: 'cors', credentials: 'omit', headers: { Range: 'bytes=0-0' }, signal: controller.signal }), timeout, generation, 'Проверка эквалайзера не завершилась.', attempt);
        allowed = response.ok && response.type !== 'opaque';
        try { void response.body?.cancel()?.catch(() => {}); } catch { /* response already closed */ }
      } catch { /* fail open to ordinary audio */ }
      finally { cancel(); waiting.delete(cancel); attempt?.waiting.delete(cancel); }
      checkScope(attempt, generation);
      if (corsProbes.size >= 32) corsProbes.delete(corsProbes.keys().next().value);
      corsProbes.set(source.url, allowed);
      return allowed;
    }
    async function applyEqualizer(deadline = Date.now() + 1500, attempt = null) {
      const target = media;
      if (!target) { equalizerError = null; return; }
      if (!equalizerSettings.enabled && !equalizerGraph) { equalizerError = null; return; }
      if (!equalizerSafe && !equalizerGraph) { equalizerError = 'Эквалайзер недоступен для этого источника VK. Трек играет без обработки; новые настройки применятся к следующему доступному треку.'; return; }
      try {
        if (!equalizerGraph) {
          if (typeof w.__PULSE_CREATE_EQUALIZER__ !== 'function') throw failure('Эквалайзер не загрузился. Перезапустите Pulse.');
          equalizerGraph = w.__PULSE_CREATE_EQUALIZER__(target);
        }
        const graph = equalizerGraph;
        const generation = epoch;
        const remaining = () => {
          const timeout = deadline - Date.now();
          if (timeout <= 0) throw failure('Эквалайзер не запустился.');
          return timeout;
        };
        if (equalizerSettings.enabled) {
          const timeout = Math.min(1500, remaining());
          await bounded(graph.prepare(), timeout, generation, 'Эквалайзер не запустился.', attempt);
        }
        checkScope(attempt, generation);
        if (media !== target || graph !== equalizerGraph) return;
        const timeout = remaining();
        graph.apply(equalizerSettings);
        await bounded(graph.resume(), timeout, generation, 'Эквалайзер не запустился.', attempt);
        checkScope(attempt, generation);
        if (media === target) equalizerError = null;
      } catch {
        if (attempt?.closed) throw attempt.error;
        if (media === target && equalizerGraph && !equalizerGraph.connected) { equalizerGraph.destroy(); equalizerGraph = null; }
        if (media === target) equalizerError = 'Эквалайзер недоступен в этом окне. Трек играет без обработки.';
      }
    }
    async function prepareCandidate(source, generation, timeout, attempt) {
      const deadline = Date.now() + timeout;
      const remaining = () => {
        const value = deadline - Date.now();
        if (value <= 0) throw failure('Источник VK не ответил. Проверьте соединение и повторите запуск.');
        return value;
      };
      checkScope(attempt, generation);
      const readable = equalizerSettings.enabled ? await allowsEqualizer(source, generation, deadline, attempt) : false;
      checkScope(attempt, generation);
      remaining();
      const target = new w.Audio();
      let engine = null, promoted = false, disposed = false;
      const preparationListeners = [];
      const preparationListen = (type, callback) => {
        const handler = (...args) => { if (!disposed && isCurrent(generation) && !attempt.closed) callback(...args); };
        target.addEventListener(type, handler);
        preparationListeners.push(() => target.removeEventListener(type, handler));
      };
      const releaseLoad = () => { for (const off of preparationListeners.splice(0)) off(); };
      const discard = () => {
        if (promoted || disposed) return;
        disposed = true; releaseLoad();
        try { engine?.destroy(); } catch { /* release best effort */ }
        try { target.pause(); target.removeAttribute('src'); target.load(); } catch { /* detached candidate */ }
      };
      attempt.waiting.add(discard);
      if (readable) target.crossOrigin = 'anonymous';
      target.preload = 'auto'; target.volume = currentVolume;
      const loaded = new Promise((resolve, reject) => {
        // Duration and headers do not establish that the decoder has audio.
        // Some dead CDN responses publish metadata and then never provide a
        // frame. Keep trying the other granted sources in that case.
        const playable = () => { if (target.readyState >= 3) resolve(); };
        preparationListen('loadedmetadata', playable);
        preparationListen('loadeddata', playable);
        preparationListen('canplay', playable);
        preparationListen('error', () => reject(failure('Источник VK не загрузился.')));
      });
      // A synchronous engine error can reject before the deadline check below.
      // Keep that promise observed even if the candidate has already expired.
      void loaded.catch(() => {});
      try {
        const Hls = w.__PULSE_HLS__ || w.Hls;
        // Chromium/WebView2 reports native HLS as "maybe" even for VK streams
        // it cannot actually decode. Prefer our MSE engine when supported.
        if (source.format === 'hls' && typeof Hls === 'function' && Hls.isSupported?.()) {
          // Audio needs little memory per buffered second. Keep enough ahead
          // to survive short network gaps without changing stream quality.
          // Keep TS/AAC transmuxing off the VK document's main thread. The
          // bundled HLS build can inject its worker from a blob and falls back
          // to inline transmuxing if the WebView CSP blocks worker creation.
          engine = new Hls({ enableWorker: true, emeEnabled: false, backBufferLength: 30, maxBufferLength: 120, maxMaxBufferLength: 180, maxBufferSize: 8 * 1024 * 1024, manifestLoadingMaxRetry: 1, levelLoadingMaxRetry: 1, fragLoadingMaxRetry: 3 });
          let networkRepairs = 0;
          let repairPosition = -1;
          engine.on(Hls.Events.ERROR, (_event, data) => {
            if (disposed || !isCurrent(generation) || (!promoted && attempt.closed) || !data?.fatal) return;
            if (!promoted) { target.dispatchEvent(new w.Event('error')); return; }
            if (hls !== engine) return;
            // A failed future fragment is not a failure of already buffered
            // audio. Retain those bytes while HLS retries the network in the
            // same engine; the media-clock watchdog still renews a genuinely
            // frozen source once playback actually stops progressing.
            const current = Number(target.currentTime) || 0;
            let ahead = 0;
            try {
              for (let index = 0; index < target.buffered.length; index++) {
                if (target.buffered.start(index) <= current + .05 && target.buffered.end(index) > current) ahead = target.buffered.end(index) - current;
              }
            } catch { /* Detached TimeRanges cannot prove playable audio. */ }
            if (data.type === (Hls.ErrorTypes?.NETWORK_ERROR || 'networkError') && ready && desired && !recovering && target.readyState >= 3 && ahead > 3) {
              if (current > repairPosition + 10) networkRepairs = 0;
              if (networkRepairs < 2 && typeof engine.startLoad === 'function') {
                networkRepairs++; repairPosition = current;
                try { engine.startLoad(-1); } catch { /* Keep draining valid buffered audio. */ }
              }
              return;
            }
            // A fatal segment/decoder error can be transient. Renew only the
            // account-authorized source, keeping the audible position and intent.
            if (ready && desired && !recovering) recoverSource();
            else target.dispatchEvent(new w.Event('error'));
          });
          engine.loadSource(source.url); engine.attachMedia(target);
        } else {
          if (source.format === 'hls' && !target.canPlayType?.('application/vnd.apple.mpegurl')) throw failure('Для этого источника VK нужен модуль HLS. Обновите плеер.');
          target.src = source.url; target.load();
        }
        await bounded(loaded, remaining(), generation, 'Источник VK не ответил. Проверьте соединение и повторите запуск.', attempt);
      } catch (failureValue) { discard(); throw failureValue; }
      finally { releaseLoad(); }
      checkScope(attempt, generation);
      return {
        async commit() {
          checkScope(attempt, generation);
          remaining();
          disposeMedia();
          promoted = true; attempt.waiting.delete(discard);
          media = target; hls = engine; equalizerSafe = readable; equalizerError = null;
          target.volume = currentVolume;
          listen(target, 'playing', () => { if (!desired) target.pause(); else { buffering = false; ended = false; hasPlayed = true; lastProgressAt = Date.now(); } }, generation);
          listen(target, 'waiting', () => { observedPosition = position(); buffering = desired; }, generation);
          listen(target, 'stalled', () => { observedPosition = position(); buffering = desired && target.readyState < 3; }, generation);
          listen(target, 'timeupdate', observeProgress, generation);
          listen(target, 'seeking', () => { observedPosition = position(); }, generation);
          listen(target, 'seeked', () => { observedPosition = position(); }, generation);
          listen(target, 'canplay', () => { buffering = false; }, generation);
          listen(target, 'ended', () => { resumePosition = mediaPosition(); ended = true; desired = false; buffering = false; }, generation);
          listen(target, 'error', () => {
            if (ready && desired && !recovering) recoverSource();
            else if (ready && !recovering) error = 'Не удалось воспроизвести доступный источник VK. Повторите запуск трека.';
          }, generation);
          ready = true; buffering = false; error = null;
          await applyEqualizer(Math.min(deadline, Date.now() + 1500), attempt);
          checkScope(attempt, generation);
          remaining();
        },
      };
    }
    async function resolveSource(raw, player, generation, fallback = false, renewal = false, hardDeadline = Infinity) {
      const input = normalize(raw);
      let audio = input;
      let lastError;
      let fallbackSource = typeof raw?.__pulseFallbackSource === 'function' ? () => raw.__pulseFallbackSource() : null;
      const attempted = new Set();
      // Keep the full source phase within the native receipt's existing
      // 20s resolve + 25s load budget, including an expired cached candidate.
      const deadline = Math.min(hardDeadline, Date.now() + RESOLVE_TIMEOUT + LOAD_TIMEOUT);
      const sourceResolver = typeof raw?.__pulseResolveSource === 'function';
      const refreshResolver = typeof raw?.__pulseRefreshSource === 'function';
      const websiteResolver = typeof player?._ensureHasURL === 'function';
      let refreshAttempted = false, websiteAttempted = false, fallbackStages = 0, resolved = false;
      function accept(result, value = null) {
        checkScope(value, generation);
        let grant;
        try {
          grant = normalize(result);
          if (grant.fullId !== input.fullId) throw failure('VK вернул другой трек. Обновите библиотеку.');
        } catch (failureValue) {
          if (value) value.terminal = failureValue;
          throw Object.assign(failureValue, { terminalGrant: true });
        }
        if (typeof result?.__pulseFallbackSource === 'function') fallbackSource = () => result.__pulseFallbackSource();
        return grant;
      }
      const request = (promise, value) => bounded(promise, Math.min(RESOLVE_TIMEOUT, Math.max(1, deadline - Date.now())), generation, 'VK не подтвердил источник трека. Повторите запуск.', value).catch(failureValue => {
        // The adapter can reject before returning a tuple after independently
        // confirming that its identity or restriction changed. Those grants
        // are final even when another delivery happens to become ready too.
        if (/^(?:invalid_audio_identity|VK ограничил|VK вернул другой трек)/.test(failureValue?.message || '')) {
          failureValue.terminalGrant = true;
          if (value && !value.closed) value.terminal = failureValue;
        }
        throw failureValue;
      });
      async function nextGrant(value) {
        checkScope(value, generation);
        if (refreshResolver && !refreshAttempted) {
          refreshAttempted = true;
          let result;
          try { result = await request(raw.__pulseRefreshSource(), value); }
          catch (failureValue) { checkScope(value, generation); if (failureValue?.code === CANCELLED || failureValue?.terminalGrant) throw failureValue; lastError = failureValue; }
          checkScope(value, generation);
          if (result != null) { audio = accept(result, value); resolved = true; return sourceList(audio, player); }
        }
        if (!resolved && websiteResolver && !websiteAttempted) {
          websiteAttempted = true;
          const result = await request(player._ensureHasURL({ ...input, url: undefined }), value);
          audio = accept(result, value); resolved = true;
          return sourceList(audio, player);
        }
        if (fallbackSource && fallbackStages < 2) {
          fallbackStages++;
          const result = await request(fallbackSource(), value);
          checkScope(value, generation);
          if (result == null) { fallbackSource = null; return []; }
          const grant = accept(result, value);
          fallbackSource = typeof result.__pulseFallbackSource === 'function' ? () => result.__pulseFallbackSource() : null;
          return sourceList(grant, player);
        }
        return null;
      }
      // Keep the original delivery alive while metadata is refreshed. A closure
      // can return the same URL, no usable alternative, or no response at all;
      // none of those justify destroying an HLS engine and its ongoing retry.
      // A distinct grant can still be dead. Prepare at most one extra delivery
      // in parallel and promote only a candidate that has actual playable data.
      async function loadSources(initial, hedgeDelay) {
        const pending = initial.filter(source => !attempted.has(source.url));
        if (fallback && pending.length > 1) pending.push(pending.shift());
        const metadata = scope();
        let metadataTask = null, startMetadata = null, metadataDone = false;
        let hedgeTimer = null, candidateTimer = null, hedgeAllowed = false;
        const candidates = new Set();
        const unique = sources => sources.filter(source => !attempted.has(source.url) && !pending.some(item => item.url === source.url));
        const prepare = async () => {
          while (Date.now() < deadline) {
            const sources = await nextGrant(metadata);
            checkScope(metadata, generation);
            if (sources == null) return [];
            const choices = unique(sources);
            if (choices.length) return choices;
          }
          return [];
        };
        const scheduleMetadata = delay => {
          metadataTask = null;
          return new Promise(resolve => {
            startMetadata = () => {
              if (metadataTask || metadataDone || metadata.closed) return;
              if (hedgeTimer != null) clearTimeout(hedgeTimer);
              hedgeTimer = null;
              metadataTask = prepare().then(sources => ({ type: 'grant', sources }), failureValue => ({ type: 'grantError', failureValue }));
              resolve(metadataTask);
            };
            hedgeTimer = setTimeout(startMetadata, delay);
          });
        };
        let nextMetadata = scheduleMetadata(hedgeDelay);
        const candidateHedge = pending.length > 1 ? new Promise(resolve => {
          candidateTimer = setTimeout(() => { candidateTimer = null; hedgeAllowed = true; resolve({ type: 'candidateHedge' }); }, 4000);
        }) : null;
        try {
          while (Date.now() < deadline) {
            check(generation);
            while (pending.length && (candidates.size === 0 || (hedgeAllowed && candidates.size < 2))) {
              const source = pending.shift();
              if (attempted.has(source.url)) continue;
              attempted.add(source.url);
              const candidate = { scope: scope(), task: null };
              const timeout = Math.min(deadline - Date.now(), LOAD_TIMEOUT);
              candidate.task = prepareCandidate(source, generation, timeout, candidate.scope).then(value => ({ type: 'loaded', candidate, value }), failureValue => ({ type: 'loadError', candidate, failureValue }));
              candidates.add(candidate);
            }
            if (!candidates.size) {
              if (metadataDone) return false;
              startMetadata();
            }
            const event = await Promise.race([...Array.from(candidates, candidate => candidate.task), ...(!metadataDone ? [nextMetadata] : []), ...(!hedgeAllowed && candidateHedge ? [candidateHedge] : [])]);
            check(generation);
            if (event.type === 'loaded') {
              if (metadata.terminal) throw metadata.terminal;
              // Readiness, not a different URL, chooses the winner. The other
              // candidate may still have the only viable slow first fragment;
              // never cancel it just because a metadata request returned.
              for (const candidate of candidates) if (candidate !== event.candidate) closeScope(candidate.scope);
              await event.value.commit();
              if (metadata.terminal) throw metadata.terminal;
              return true;
            }
            if (event.type === 'loadError') {
              if (event.failureValue?.code === CANCELLED) throw event.failureValue;
              lastError = event.failureValue;
              closeScope(event.candidate.scope); candidates.delete(event.candidate);
              if (!candidates.size && !pending.length && !metadataDone) startMetadata();
            } else if (event.type === 'grantError') {
              if (event.failureValue?.code === CANCELLED || event.failureValue?.terminalGrant) throw event.failureValue;
              lastError = event.failureValue; metadataDone = true;
            } else if (event.type === 'grant') {
              const choices = unique(event.sources);
              if (!choices.length) { metadataDone = true; continue; }
              hedgeAllowed = true;
              pending.push(...choices);
              nextMetadata = scheduleMetadata(4000);
            }
          }
          return false;
        } finally {
          if (hedgeTimer != null) clearTimeout(hedgeTimer);
          if (candidateTimer != null) clearTimeout(candidateTimer);
          closeScope(metadata);
          for (const candidate of candidates) closeScope(candidate.scope);
          // Underlying website promises may not expose an abort API. All their
          // results remain observed, and a closed scope cannot start a further
          // metadata stage or install/replace a media element after success.
        }
      }
      // Uploaded files and cached tuples start immediately without an API
      // round trip. A warm refresh is a soft hedge, never an eight-second cut.
      if (!renewal && !sourceResolver) {
        const supplied = sourceList(input, player);
        if (supplied.length) {
          if (await loadSources(supplied, 8000)) return;
          throw lastError || failure('Источник VK не загрузился.');
        }
      }
      // Artist/release APIs provide full streams and an access key rather
      // than website reload hashes. Their private closure refreshes those
      // exact sources inside the same signed-in VK document on every load
      // and renewal; URLs and credentials never cross the native bridge.
      if (sourceResolver) {
        let result;
        try { result = await bounded(raw.__pulseResolveSource(), Math.min(RESOLVE_TIMEOUT, Math.max(1, deadline - Date.now())), generation, 'VK не подтвердил источник трека. Повторите запуск.'); }
        catch (failureValue) {
          check(generation);
          if (!fallbackSource || failureValue?.code === CANCELLED) throw failureValue;
          lastError = failureValue;
        }
        check(generation);
        if (result != null) {
          // Validation is deliberately outside the recoverable request catch.
          // A changed identity/restriction is final, not permission to fall back.
          audio = accept(result);
        } else if (!fallbackSource) throw failure('VK не предоставил доступный аудиоисточник для этого трека.');
        resolved = true;
      } else {
        const initial = scope();
        try {
          const sources = await nextGrant(initial);
          if (sources?.length) {
            if (await loadSources(sources, 4000)) return;
            throw lastError || failure('Источник VK не загрузился.');
          }
        } finally { closeScope(initial); }
      }
      const sources = sourceResolver && lastError && audio === input ? [] : sourceList(audio, player);
      if (!sources.length && !fallbackSource) throw failure('VK не предоставил доступный аудиоисточник для этого трека.');
      if (await loadSources(sources, 4000)) return;
      throw lastError || failure('Источник VK не загрузился.');
    }
    function terminalFailure() {
      desired = false; buffering = false; recovering = false;
      try { media?.pause(); } catch { /* media unavailable */ }
      error = 'Не удалось восстановить загрузку трека. Проверьте соединение и нажмите «Повторить».';
    }
    function recoverSource() {
      if (recoveryTask || !desired || !sourceInput || !isCurrent(epoch)) return;
      resumePosition = mediaPosition();
      if (Number.isFinite(media?.duration) && media.duration > 0) knownDuration = media.duration;
      if (recoveryCount >= 2) { terminalFailure(); return; }
      const generation = epoch, revision = ++action;
      const recoveryDeadline = Date.now() + RESOLVE_TIMEOUT + LOAD_TIMEOUT;
      healthyRecoverySeconds = 0;
      recovering = true; buffering = true; error = null; ended = false;
      disposeMedia();
      const task = (async () => {
        while (recoveryCount < 2) {
          recoveryCount++;
          try {
            if (Date.now() >= recoveryDeadline) break;
            await resolveSource(sourceInput, sourcePlayer, generation, recoveryCount > 1, true, recoveryDeadline);
            check(generation);
            if (revision !== action || !desired) throw cancelled();
            const target = media;
            if (Number.isFinite(target.duration) && target.duration > 0) knownDuration = target.duration;
            target.currentTime = Math.min(resumePosition, Math.max(0, knownDuration - 0.1));
            observedPosition = target.currentTime;
            // pause/stop can cancel the await before a browser's play promise
            // resolves. A late completion must still pause its detached audio.
            const playing = Promise.resolve(target.play()).then(() => {
              if (!isCurrent(generation) || revision !== action || !desired || media !== target) { if (!isCurrent(generation) || media !== target || !desired) target.pause(); throw cancelled(); }
            });
            const remaining = recoveryDeadline - Date.now();
            if (remaining <= 0) throw failure('VK не подтвердил восстановление трека.');
            await bounded(playing, Math.min(LOAD_TIMEOUT, remaining), generation, 'VK не подтвердил восстановление трека.');
            check(generation);
            if (revision !== action || !desired || media !== target) { if (media !== target || !desired) target.pause(); throw cancelled(); }
            resumePosition = mediaPosition(); lastProgressAt = Date.now();
            recovering = false; buffering = false; error = null;
            return;
          } catch (failureValue) {
            if (failureValue?.code === CANCELLED || revision !== action || !isCurrent(generation)) return;
            disposeMedia();
          }
        }
        if (isCurrent(generation) && revision === action) terminalFailure();
      })();
      recoveryTask = task;
      void task.finally(() => { if (recoveryTask === task) recoveryTask = null; });
    }
    return {
      async load(raw, player) {
        if (destroyed) throw cancelled();
        invalidate(); account = currentAccount();
        sourceInput = raw; sourcePlayer = player; recoveryCount = 0;
        resumePosition = 0; knownDuration = 0; lastProgressAt = Date.now(); healthyRecoverySeconds = 0;
        const generation = epoch; error = null; ended = false; buffering = true;
        const started = Date.now();
        try {
          if (account <= 0) throw failure('Войдите в VK для воспроизведения.');
          await resolveSource(raw, player, generation);
          // Source resolution/loading and its first play share one budget.
          // Keep the remaining duration, not an absolute timestamp: a user
          // can legitimately leave a preloaded track paused before playing.
          initialPlayBudget = Math.max(1, Math.min(LOAD_TIMEOUT, START_TIMEOUT - (Date.now() - started)));
        } catch (failureValue) {
          if (failureValue?.code === CANCELLED || !isCurrent(generation)) throw cancelled();
          desired = false; buffering = false; disposeMedia();
          error = failureValue instanceof Error && /^VK |^Источник VK |^Для этого источника VK |^Войдите в VK|^Интерфейс источников VK/.test(failureValue.message) ? failureValue.message : 'VK не подтвердил доступный источник трека.';
          throw failure(error);
        }
      },
      async play() {
        const generation = epoch;
        check(generation);
        if (!media || !ready) throw failure('Сначала загрузите доступный трек VK.');
        const revision = ++action; const target = media;
        const deadline = Date.now() + (initialPlayBudget ?? LOAD_TIMEOUT);
        initialPlayBudget = null;
        desired = true; ended = false; error = null; buffering = target.readyState < 3;
        try {
          if (equalizerSettings.enabled || equalizerGraph) await applyEqualizer(Math.min(deadline, Date.now() + 1500));
          if (!isCurrent(generation) || action !== revision || !desired || media !== target) throw cancelled();
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw failure('Воспроизведение VK не началось. Повторите запуск.');
          const playing = Promise.resolve(target.play()).then(() => {
            if (!isCurrent(generation) || action !== revision || !desired || media !== target) { if (!isCurrent(generation) || media !== target || !desired) target.pause(); throw cancelled(); }
          });
          await bounded(playing, Math.min(LOAD_TIMEOUT, remaining), generation, 'Воспроизведение VK не началось. Повторите запуск.');
          if (!isCurrent(generation) || action !== revision || !desired || media !== target) { if (!isCurrent(generation) || media !== target || !desired) target.pause(); throw cancelled(); }
          buffering = false; lastProgressAt = Date.now();
        } catch (failureValue) {
          if (failureValue?.code === CANCELLED || action !== revision || !isCurrent(generation)) { if (!isCurrent(generation) || media !== target || !desired) target.pause(); throw cancelled(); }
          desired = false; buffering = false; target.pause();
          error = 'Не удалось начать воспроизведение доступного источника VK. Повторите запуск.';
          throw failure(error);
        }
      },
      pause() {
        if (!recovering) resumePosition = mediaPosition();
        action++; desired = false; buffering = false; cancelWaiting();
        if (recovering || !ready) { invalidate(); return; }
        try { media?.pause(); } catch { /* media unavailable */ }
      },
      stop() { invalidate(); error = null; ended = false; resumePosition = 0; knownDuration = 0; sourceInput = null; sourcePlayer = null; },
      seek(seconds) {
        if (!Number.isFinite(seconds) || seconds < 0) throw failure('Некорректная позиция трека.');
        check(epoch);
        if (recovering && knownDuration > 0) {
          resumePosition = Math.min(seconds, knownDuration);
          if (media && ready) { media.currentTime = Math.min(resumePosition, Math.max(0, knownDuration - 0.1)); observedPosition = media.currentTime; }
          ended = false; return;
        }
        if (!media || !ready || !Number.isFinite(media.duration) || media.duration <= 0) throw failure('Длительность трека ещё не определена.');
        media.currentTime = Math.min(seconds, media.duration);
        observedPosition = position();
        healthyRecoverySeconds = 0;
        resumePosition = mediaPosition(); lastProgressAt = Date.now();
        ended = false;
      },
      volume(value) {
        if (!Number.isFinite(value)) throw failure('Некорректная громкость.');
        currentVolume = Math.max(0, Math.min(1, value));
        if (media) media.volume = currentVolume;
      },
      async equalizer(value) {
        const bands = Array.isArray(value?.bands) && value.bands.length === 10 ? value.bands : [];
        equalizerSettings = { enabled: value?.enabled === true, bands: Array.from({ length: 10 }, (_, index) => typeof bands[index] === 'number' && Number.isFinite(bands[index]) ? Math.max(-12, Math.min(12, bands[index])) : 0), preamp: typeof value?.preamp === 'number' && Number.isFinite(value.preamp) ? Math.max(-12, Math.min(0, value.preamp)) : 0 };
        await applyEqualizer();
        return { equalizerEnabled: Boolean(equalizerGraph?.active), equalizerError };
      },
      read() {
        if (!destroyed && account && !isCurrent(epoch)) { invalidate(); error = 'Сеанс VK изменился. Подключите аккаунт заново.'; account = 0; }
        observeProgress();
        if (desired && ready && hasPlayed && !recovering && !ended && !media?.seeking && Date.now() - lastProgressAt >= 8000) recoverSource();
        const duration = Number.isFinite(media?.duration) && media.duration > 0 ? media.duration : knownDuration;
        const buffered = [];
        try {
          for (let index = 0; index < Math.min(media?.buffered?.length || 0, 64); index++) {
            const start = Math.max(0, media.buffered.start(index)), end = Math.min(duration, media.buffered.end(index));
            if (Number.isFinite(start) && Number.isFinite(end) && end > start) buffered.push([start, end]);
          }
        } catch { /* Media teardown can invalidate a TimeRanges snapshot. */ }
        const current = position();
        const range = buffered.find(([start, end]) => start <= current + .05 && end > current);
        const bufferedAhead = range ? Math.max(0, range[1] - current) : 0;
        const network = error ? 'error' : w.navigator?.onLine === false && desired ? 'offline' : recovering ? 'recovering' : !media ? (buffering ? 'loading' : 'idle') : buffering && desired ? (ready && hasPlayed ? 'stalled' : 'loading') : media.readyState >= 3 || bufferedAhead > .25 ? 'ready' : media.networkState === 2 ? 'loading' : 'idle';
        return { playing: Boolean(!recovering && media && desired && !media.paused && !media.ended), buffering: buffering || recovering, recovering, seeking: Boolean(media?.seeking), position: current, duration, buffered, bufferedAhead, network, ended, error, equalizerEnabled: Boolean(equalizerGraph?.active), equalizerError };
      },
      destroy() { invalidate(); destroyed = true; error = null; },
    };
  }
  // The adapter must not replace a masked tuple whose session-owned decoder
  // already provides a usable source. Reuse this exact source selection and
  // safety validation instead of duplicating its changing website schema.
  Object.defineProperty(create, 'canResolve', { value: (raw, player) => {
    try { return sourceList(normalize(raw), player).length > 0; } catch { return false; }
  } });
  Object.defineProperty(w, '__PULSE_CREATE_DIRECT_AUDIO__', { value: create, configurable: true });
})();
