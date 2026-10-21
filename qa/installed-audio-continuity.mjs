import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { captureInstalledStateForRestore, restoreInstalledStateBeforeClose } from './installed-state-restore.mjs';

// Observes the installed player without mutating cloud music. No media URLs,
// account identifiers or credentials are collected. Synthetic PCM coverage is
// in hls-pcm-continuity-independent.mjs; music silence is not a reliable probe.
const browsers = [], endpoints = new Set();
let main, remote, saved, result;
const mainPageErrors = [];
const forceWorker = process.env.QA_FORCE_WORKER === '1';
const candidateTransport = process.env.QA_TRANSPORT_SOURCE === '1';
const expectProgressive = process.env.QA_EXPECT_PROGRESSIVE === '1';
const seconds = Math.min(240, Math.max(30, Number(process.env.QA_CONTINUITY_SECONDS) || 90));
try {
  for (let attempt = 0; attempt < 300; attempt++) {
    for (const endpoint of ['http://127.0.0.1:9226', 'http://[::1]:9226']) {
      if (endpoints.has(endpoint)) continue;
      try { browsers.push(await chromium.connectOverCDP(endpoint, { timeout: 500 })); endpoints.add(endpoint); } catch {}
    }
    const pages = browsers.flatMap(b => b.contexts().flatMap(c => c.pages()));
    main = pages.find(p => p.url().includes('tauri.localhost'));
    remote = pages.find(p => /^https:\/\/vk\.(com|ru)(\/|$)/.test(p.url()));
    if (main && remote && await main.evaluate(async () => (await window.desktop?.getVkStatus())?.state === 'connected').catch(() => false)) break;
    await new Promise(r => setTimeout(r, 500));
  }
  assert.ok(main && remote, 'Installed player WebViews unavailable');
  saved = await main.evaluate(captureInstalledStateForRestore);
  assert.equal(await main.evaluate(async () => (await window.desktop.getVkStatus()).state), 'connected');
  main.on('pageerror', error => mainPageErrors.push(error.name));
  const chosen = saved.tracks.find(t => t.title === 'Скоро лето' && t.artist.includes('Три дня дождя') && t.available);
  assert.ok(chosen, 'Reference track unavailable');
  await main.getByLabel('Громкость', { exact: true }).fill('0');
  // Clicking the current track resumes its saved position. Select a different
  // visible track first so the measured target loads from zero through the UI.
  if (saved.currentTrackId === chosen.id) {
    let alternate;
    for (const track of saved.tracks.filter(t => t.available && t.id !== chosen.id)) {
      const button = main.getByRole('button', { name: `Воспроизвести ${track.title}`, exact: true }).first();
      if (await button.isVisible().catch(() => false)) { alternate = { track, button }; break; }
    }
    assert.ok(alternate, 'No visible alternate track available to reset the target through the player UI');
    await alternate.button.click();
    await remote.waitForFunction(id => {
      const status = window.__PULSE_VK_WEB__?.playback();
      return status?.id === id && status.playing;
    }, alternate.track.id, { timeout: 80000 });
    await main.getByRole('button', { name: 'Пауза', exact: true }).click();
  }
  if (candidateTransport) await remote.evaluate(await readFile(new URL('../src-tauri/src/vk_direct_audio.js', import.meta.url), 'utf8'));
  await remote.evaluate(({ forceWorker, targetId, candidateTransport }) => {
    const original = { Audio: window.Audio, Hls: window.__PULSE_HLS__, Worker: window.Worker, directFactory: window.__PULSE_CREATE_DIRECT_AUDIO__ };
    const qa = window.__qaContinuity = { original, started: performance.now(), events: [], hlsErrors: [], clockGaps: [], longTasks: [], workers: { created: 0, responding: 0, errors: 0, constructorFailures: 0, firstResponseMs: [] }, mediaCreated: 0, hlsCreated: 0, audio: null, sourceErrors: 0, targetPositions: [] };
    const at = () => Math.round(performance.now() - qa.started);
    qa.candidateFactoryInstantiations = 0;
    if (candidateTransport) Object.defineProperty(window, '__PULSE_CREATE_DIRECT_AUDIO__', { configurable: true, value: function (...args) { qa.candidateFactoryInstantiations++; return original.directFactory(...args); } });
    qa.sourceDescriptors = [];
    const player = typeof window.getAudioPlayer === 'function' ? window.getAudioPlayer() : window.ap;
    if (typeof player?._ensureHasURL === 'function') {
      original.player = player; original.ensure = player._ensureHasURL;
      player._ensureHasURL = function (...args) {
        return Promise.resolve(original.ensure.apply(this, args)).then(raw => {
          let extra = raw?.extra ?? raw?.[Number.isInteger(window.AudioUtils?.AUDIO_ITEM_INDEX_EXTRA) ? window.AudioUtils.AUDIO_ITEM_INDEX_EXTRA : 12];
          try { if (typeof extra === 'string') extra = JSON.parse(extra); } catch { extra = null; }
          qa.sourceDescriptors.push((Array.isArray(extra?.audio_streams) ? extra.audio_streams : []).map(stream => ({ type: stream.type, bitrate: stream.bitrate ?? null, hasFallback: Boolean(stream.fallback_url), drm: Boolean(stream.drm || stream.key_system || stream.license_url) })));
          return raw;
        });
      };
    }
    const targetActive = () => window.__PULSE_VK_WEB__?.playback()?.id === targetId;
    window.Worker = function (...args) {
      const started = performance.now(); let worker;
      try { worker = Reflect.construct(original.Worker, args, original.Worker); }
      catch (error) { qa.workers.constructorFailures++; throw error; }
      qa.workers.created++;
      worker.addEventListener('message', () => { qa.workers.responding++; qa.workers.firstResponseMs.push(Math.round(performance.now() - started)); }, { once: true });
      worker.addEventListener('error', () => qa.workers.errors++);
      return worker;
    };
    Object.setPrototypeOf(window.Worker, original.Worker); window.Worker.prototype = original.Worker.prototype;
    window.Audio = function (...args) {
      const audio = new original.Audio(...args);
      if (!targetActive()) return audio;
      qa.audio = audio; qa.mediaCreated++;
      const audioSequence = qa.mediaCreated;
      let waitingSince = null, stalledSince = null;
      for (const type of ['loadedmetadata', 'playing', 'waiting', 'stalled', 'seeking', 'seeked', 'pause', 'ended', 'error']) audio.addEventListener(type, () => {
        if (!targetActive()) return;
        const now = at();
        if (type === 'playing' && qa.mediaCountAtFirstPlaying == null) {
          qa.mediaCountAtFirstPlaying = qa.mediaCreated;
          qa.firstPlayingAudioSequence = audioSequence;
        }
        if (type === 'loadedmetadata') {
          qa.sourceModes ||= [];
          const mode = audio.src.startsWith('blob:') ? 'mse' : /\.m3u8(?:[?#]|$)/i.test(audio.src) ? 'native-hls' : 'progressive';
          qa.sourceModes.push({ mode, duration: audio.duration });
        }
        if (type === 'ended') qa.targetEnded = { nativeEnded: audio.ended, position: audio.currentTime, duration: audio.duration };
        if (type === 'waiting' && waitingSince == null) waitingSince = now;
        if (type === 'stalled' && stalledSince == null) stalledSince = now;
        const resolved = ['playing', 'pause', 'ended', 'error'].includes(type);
        if (qa.events.length < 500) qa.events.push({ at: now, type, audioSequence, mediaCreated: qa.mediaCreated, position: audio.currentTime, duration: Number.isFinite(audio.duration) ? audio.duration : 0, ready: audio.readyState, code: audio.error?.code || 0, ...(resolved && waitingSince != null ? { waitingMs: now - waitingSince } : {}), ...(resolved && stalledSince != null ? { stalledMs: now - stalledSince } : {}) });
        if (resolved) { waitingSince = null; stalledSince = null; }
      });
      return audio;
    };
    window.Audio.prototype = original.Audio.prototype;
    window.__PULSE_HLS__ = class extends original.Hls {
      constructor(config) {
        super({ ...config, ...(forceWorker ? { enableWorker: true } : {}) });
        const target = targetActive();
        if (target) qa.hlsCreated++;
        this.on(original.Hls.Events.ERROR, (_event, data) => {
          if (!target || !targetActive()) return;
          const publicReason = value => String(value || '').replace(/https?:\/\/[^\s"'<>]+/gi, '[URL]').replace(/[A-Za-z0-9_=-]{50,}/g, '[VALUE]').slice(0, 240);
          if (qa.hlsErrors.length < 500) qa.hlsErrors.push({ at: at(), details: data.details, type: data.type, fatal: data.fatal, position: this.media?.currentTime || 0, reason: publicReason(data.reason), errorName: data.error?.name || null, errorMessage: publicReason(data.error?.message), fragmentSequence: typeof data.frag?.sn === 'number' ? data.frag.sn : null });
        });
      }
    };
    try { qa.observer = new PerformanceObserver(list => { for (const task of list.getEntries()) if (qa.longTasks.length < 500) qa.longTasks.push({ at: Math.round(task.startTime - qa.started), duration: task.duration }); }); qa.observer.observe({ type: 'longtask', buffered: false }); } catch {}
    let lastAudio, lastPosition = 0, lastAt = performance.now(), stagnant = 0, played = false;
    qa.timer = setInterval(() => {
      if (!targetActive()) return;
      const audio = qa.audio, now = performance.now();
      const status = window.__PULSE_VK_WEB__?.playback();
      if (status?.error) qa.sourceErrors++;
      if (qa.targetPositions.length < 10000 && audio) qa.targetPositions.push({ at: at(), position: audio.currentTime, mediaCreated: qa.mediaCreated });
      if (audio !== lastAudio) { lastAudio = audio; played = false; stagnant = 0; lastPosition = audio?.currentTime || 0; lastAt = now; return; }
      if (audio && !audio.paused && !audio.seeking && !audio.ended) {
        const elapsed = now - lastAt, progress = (audio.currentTime - lastPosition) * 1000;
        if (progress > 0) {
          if (played && stagnant >= 80 && qa.clockGaps.length < 200) qa.clockGaps.push({ at: at(), position: audio.currentTime, stagnantMs: Math.round(stagnant), ready: audio.readyState });
          played = true; stagnant = 0;
        } else if (played && elapsed < 250) stagnant += elapsed;
      } else stagnant = 0;
      lastPosition = audio?.currentTime || 0; lastAt = now;
    }, 25);
  }, { forceWorker, targetId: chosen.id, candidateTransport });
  await main.getByRole('button', { name: `Воспроизвести ${chosen.title}`, exact: true }).first().click();
  await remote.waitForFunction(targetId => window.__PULSE_VK_WEB__?.playback()?.id === targetId, chosen.id, { timeout: 80000 });
  console.log(`Observing installed playback for ${seconds}s; forceWorker=${forceWorker}`);
  for (let elapsed = 0; elapsed < seconds; elapsed += 15) {
    await new Promise(r => setTimeout(r, Math.min(15, seconds - elapsed) * 1000));
    console.log(JSON.stringify(await remote.evaluate(() => { const s = window.__PULSE_VK_WEB__.playback(); const q = window.__qaContinuity; return { position: s.position, buffering: s.buffering, recovering: s.recovering, error: Boolean(s.error), mediaCreated: q.mediaCreated, hlsErrors: q.hlsErrors.length, workers: q.workers }; })));
    if (await remote.evaluate(() => Boolean(window.__qaContinuity.targetEnded))) break;
  }
  result = await remote.evaluate(targetId => {
    const q = window.__qaContinuity, s = window.__PULSE_VK_WEB__.playback();
    return { events: q.events, hlsErrors: q.hlsErrors, clockGaps: q.clockGaps, longTasks: q.longTasks, sourceDescriptors: q.sourceDescriptors, sourceModes: q.sourceModes, candidateFactoryInstantiations: q.candidateFactoryInstantiations, workers: q.workers, mediaCreated: q.mediaCreated, mediaCountAtFirstPlaying: q.mediaCountAtFirstPlaying, firstPlayingAudioSequence: q.firstPlayingAudioSequence, hlsCreated: q.hlsCreated, sourceErrorPolls: q.sourceErrors, clockSamples: q.targetPositions, targetEnded: q.targetEnded, final: { targetIdentityMatched: Boolean(q.targetEnded?.nativeEnded) || s.id === targetId, position: q.targetEnded?.position ?? s.position, duration: q.targetEnded?.duration ?? s.duration, error: s.id === targetId && Boolean(s.error), recovering: s.id === targetId && s.recovering } };
  }, chosen.id);
  assert.ok(result.final.targetIdentityMatched, 'Observed playback changed to another track');
  assert.ok(result.final.position >= Math.min(20, seconds / 2), 'Target playback did not progress sufficiently');
  assert.equal(result.sourceErrorPolls, 0, 'Target source entered a terminal error during observation');
  assert.equal(result.final.error, false, 'Target playback ended in a source error');
  assert.equal(mainPageErrors.length, 0, 'The main player raised renderer exceptions');
  if (candidateTransport) assert.ok(result.candidateFactoryInstantiations >= 1, 'The adapter reused an existing transport; injected candidate code was not exercised');
  if (result.targetEnded) {
    assert.equal(result.targetEnded.nativeEnded, true, 'The target ended event was synthetic');
    assert.ok(result.targetEnded.duration > 0 && result.targetEnded.position >= result.targetEnded.duration - 0.25, 'The target did not reach its full duration');
  }
  if (expectProgressive) {
    assert.ok(result.mediaCountAtFirstPlaying >= 1, 'The first playing event did not capture the source count');
    assert.equal(result.mediaCreated, result.mediaCountAtFirstPlaying, 'Progressive playback replaced its audio element after the initial start');
    assert.equal(result.hlsCreated, 0, 'Progressive stream was not preferred');
    assert.equal(result.hlsErrors.length, 0, 'Unexpected HLS errors');
    assert.ok(result.sourceModes?.length > 0 && result.sourceModes.every(source => source.mode === 'progressive'), 'Metadata did not confirm a progressive source');
    const firstPlayingIndex = result.events.findIndex(e => e.type === 'playing');
    assert.ok(firstPlayingIndex >= 0, 'No playback start observed');
    assert.ok(result.events[firstPlayingIndex].position < 1, 'Target resumed from a saved position instead of starting from zero');
    assert.deepEqual(result.events.slice(firstPlayingIndex + 1).filter(e => ['waiting', 'stalled', 'seeking', 'error'].includes(e.type)), [], 'Playback interrupted after its initial start');
    if (seconds >= 210) assert.equal(result.targetEnded?.nativeEnded, true, 'The full progressive track did not finish');
  }
  result = { checkedAt: new Date().toISOString(), installedRelease: true, cloudReadOnly: true, forceWorker, observationSeconds: seconds, mainRendererExceptions: mainPageErrors, ...result, limitations: ['Muted playback; media-clock sampling is not a PCM continuity proof.', 'Clock resolution and hidden-page timer throttling can produce false positive clock gaps.', 'Worker totals and long tasks cover the VK document, not exclusively the media transport.', 'Renderer exception capture covers the main player only.', 'Local state restoration is verified on native readback, not after a subsequent restart.'] };
} finally {
  if (main && saved) {
    const restored = await main.evaluate(restoreInstalledStateBeforeClose, saved);
    assert.ok(restored.nativeReadbackMatched, 'User state restore failed');
    if (result) { result.localStateRestoredOnReadback = true; result.localStateRestore = restored; }
  }
  if (remote) await remote.evaluate(() => {
    const q = window.__qaContinuity;
    if (!q) return;
    clearInterval(q.timer); q.observer?.disconnect();
    window.Audio = q.original.Audio; window.Worker = q.original.Worker; window.__PULSE_HLS__ = q.original.Hls;
    Object.defineProperty(window, '__PULSE_CREATE_DIRECT_AUDIO__', { value: q.original.directFactory, configurable: true });
    if (q.original.player) q.original.player._ensureHasURL = q.original.ensure;
    delete window.__qaContinuity;
  }).catch(() => {});
  if (main && saved) await main.evaluate(() => window.__TAURI_INTERNALS__.invoke('finish_close')).catch(() => {});
  for (const browser of browsers) await browser.close().catch(() => {});
}
if (result) {
  await writeFile(new URL(expectProgressive ? 'installed-audio-continuity-release-result.json' : candidateTransport ? 'installed-audio-continuity-candidate-result.json' : forceWorker ? 'installed-audio-continuity-worker-result.json' : 'installed-audio-continuity-result.json', import.meta.url), JSON.stringify({ ...result, candidateTransport, expectProgressive }, null, 2) + '\n');
  console.log('PASS continuity telemetry collected; original state readback matched with renderer saves guarded until close');
}
