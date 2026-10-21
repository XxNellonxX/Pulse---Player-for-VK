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
    if (createKey) {
      try {
        const value = impl[createKey]({ id: audio.fullId, sources });
        if (Array.isArray(value?.sources)) decoded = value.sources;
      } catch { throw failure('Интерфейс источников VK изменился. Обновите плеер.'); }
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
    function invalidate() { epoch++; action++; desired = false; recovering = false; recoveryTask = null; cancelWaiting(); disposeMedia(); buffering = false; }
    function bounded(promise, timeout, generation, message) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (ok, value) => {
          if (settled) return;
          settled = true; clearTimeout(timer); waiting.delete(cancel);
          if (!isCurrent(generation)) reject(cancelled()); else if (ok) resolve(value); else reject(value);
        };
        const cancel = () => finish(false, cancelled());
        const timer = setTimeout(() => finish(false, failure(message)), timeout);
        waiting.add(cancel);
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
    async function allowsEqualizer(source, generation) {
      // HLS.js only loads readable CORS responses and hands MSE a same-origin
      // blob. Native HLS requires a readable manifest check instead.
      const Hls = w.__PULSE_HLS__ || w.Hls;
      if (source.format === 'hls' && typeof Hls === 'function' && Hls.isSupported?.()) return true;
      if (new URL(source.url).origin === w.location.origin) return true;
      if (corsProbes.has(source.url)) return corsProbes.get(source.url);
      if (typeof w.fetch !== 'function' || typeof w.AbortController !== 'function') return false;
      const controller = new w.AbortController();
      const cancel = () => controller.abort(); waiting.add(cancel);
      const timer = setTimeout(cancel, 2500);
      let allowed = false;
      try {
        // Read a single range, never download/cache the song or export the
        // session-granted URL from this private document.
        const response = await w.fetch(source.url, { method: 'GET', mode: 'cors', credentials: 'omit', headers: { Range: 'bytes=0-0' }, signal: controller.signal });
        allowed = response.ok && response.type !== 'opaque';
        try { await response.body?.cancel(); } catch { /* response already closed */ }
      } catch { /* fail open to ordinary audio */ }
      finally { clearTimeout(timer); waiting.delete(cancel); }
      check(generation);
      if (corsProbes.size >= 32) corsProbes.delete(corsProbes.keys().next().value);
      corsProbes.set(source.url, allowed);
      return allowed;
    }
    async function applyEqualizer() {
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
        if (equalizerSettings.enabled) {
          let timer;
          try { await Promise.race([graph.prepare(), new Promise((_resolve, reject) => { timer = setTimeout(() => reject(failure('Эквалайзер не запустился.')), 1500); })]); }
          finally { clearTimeout(timer); }
        }
        if (media !== target || graph !== equalizerGraph) return;
        graph.apply(equalizerSettings);
        await graph.resume();
        if (media === target) equalizerError = null;
      } catch {
        if (media === target && equalizerGraph && !equalizerGraph.connected) { equalizerGraph.destroy(); equalizerGraph = null; }
        if (media === target) equalizerError = 'Эквалайзер недоступен в этом окне. Трек играет без обработки.';
      }
    }
    async function define(source, generation, timeout) {
      check(generation);
      disposeMedia();
      equalizerError = null;
      const readable = equalizerSettings.enabled ? await allowsEqualizer(source, generation) : false;
      check(generation);
      const target = new w.Audio(); media = target;
      equalizerSafe = readable;
      if (readable) target.crossOrigin = 'anonymous';
      target.preload = 'auto'; target.volume = currentVolume;
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
      let releaseLoad = () => {};
      const loaded = new Promise((resolve, reject) => {
        const offReady = listen(target, 'loadedmetadata', () => resolve(), generation);
        const offCanPlay = listen(target, 'canplay', () => resolve(), generation);
        const offError = listen(target, 'error', () => reject(failure('Источник VK не загрузился.')), generation);
        releaseLoad = () => { offReady(); offCanPlay(); offError(); };
      });
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
          hls = new Hls({ enableWorker: true, emeEnabled: false, backBufferLength: 30, maxBufferLength: 120, maxMaxBufferLength: 180, maxBufferSize: 8 * 1024 * 1024, manifestLoadingMaxRetry: 1, levelLoadingMaxRetry: 1, fragLoadingMaxRetry: 3 });
          const engine = hls;
          engine.on(Hls.Events.ERROR, (_event, data) => {
            if (!isCurrent(generation) || hls !== engine || !data?.fatal) return;
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
        await bounded(loaded, timeout, generation, 'Источник VK не ответил. Проверьте соединение и повторите запуск.');
      } finally { releaseLoad(); }
      check(generation); ready = true; buffering = false; error = null;
      await applyEqualizer();
      check(generation);
    }
    async function resolveSource(raw, player, generation, fallback = false, renewal = false) {
      const input = normalize(raw);
      let audio = input;
      // Artist/release APIs provide full streams and an access key rather
      // than website reload hashes. Their private closure refreshes those
      // exact sources inside the same signed-in VK document on every load
      // and renewal; URLs and credentials never cross the native bridge.
      if (typeof raw?.__pulseResolveSource === 'function') {
        const result = await bounded(raw.__pulseResolveSource(), RESOLVE_TIMEOUT, generation, 'VK не подтвердил источник трека. Повторите запуск.');
        check(generation);
        audio = normalize(result);
        if (audio.fullId !== input.fullId) throw failure('VK вернул другой трек. Обновите библиотеку.');
      } else if (!(Array.isArray(raw) && safeSource(input.url) && !input.actionHash && !input.urlHash && !renewal) && typeof player?._ensureHasURL === 'function') {
        const result = await bounded(player._ensureHasURL({ ...input, url: undefined }), RESOLVE_TIMEOUT, generation, 'VK не подтвердил источник трека. Повторите запуск.');
        check(generation);
        audio = normalize(result);
        if (audio.fullId !== input.fullId) throw failure('VK вернул другой трек. Обновите библиотеку.');
      }
      const sources = sourceList(audio, player);
      if (!sources.length) throw failure('VK не предоставил доступный аудиоисточник для этого трека.');
      // A repeatedly broken primary source may have a valid alternate stream.
      if (fallback && sources.length > 1) sources.push(sources.shift());
      let lastError;
      const deadline = Date.now() + LOAD_TIMEOUT;
      for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
        const source = sources[sourceIndex];
        check(generation);
        if (Date.now() >= deadline) break;
        const remainingSources = sources.length - sourceIndex;
        const remaining = Math.max(1, deadline - Date.now());
        // Do not let an unresponsive primary consume the entire retry budget;
        // each explicit VK fallback receives a bounded share of the deadline.
        const sourceTimeout = Math.max(2500, Math.floor(remaining / remainingSources));
        try { await define(source, generation, Math.min(remaining, sourceTimeout)); return; }
        catch (failureValue) { if (failureValue?.code === CANCELLED) throw failureValue; lastError = failureValue; }
      }
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
      healthyRecoverySeconds = 0;
      recovering = true; buffering = true; error = null; ended = false;
      disposeMedia();
      const task = (async () => {
        while (recoveryCount < 2) {
          recoveryCount++;
          try {
            await resolveSource(sourceInput, sourcePlayer, generation, recoveryCount > 1, true);
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
            await bounded(playing, LOAD_TIMEOUT, generation, 'VK не подтвердил восстановление трека.');
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
        try {
          if (account <= 0) throw failure('Войдите в VK для воспроизведения.');
          await resolveSource(raw, player, generation);
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
        desired = true; ended = false; error = null; buffering = target.readyState < 3;
        try {
          if (equalizerSettings.enabled || equalizerGraph) await applyEqualizer();
          if (!isCurrent(generation) || action !== revision || !desired || media !== target) throw cancelled();
          const playing = Promise.resolve(target.play()).then(() => {
            if (!isCurrent(generation) || action !== revision || !desired || media !== target) { if (!isCurrent(generation) || media !== target || !desired) target.pause(); throw cancelled(); }
          });
          await bounded(playing, LOAD_TIMEOUT, generation, 'Воспроизведение VK не началось. Повторите запуск.');
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
  Object.defineProperty(w, '__PULSE_CREATE_DIRECT_AUDIO__', { value: create, configurable: true });
})();
