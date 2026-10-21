import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { captureInstalledStateForRestore, restoreInstalledStateBeforeClose } from './installed-state-restore.mjs';

// Read-only cloud acceptance on our installed application. Temporarily changes
// local playback, then restores preferences/queue/position and exits cleanly.
// Never exports URLs, cookies, account identifiers or catalog contents.
const browsers = [];
const endpoints = new Set();
let main, remote, saved;
let result;
const samples = [];
const uiErrors = [];
try {
  for (let attempt = 0; attempt < 300; attempt++) {
    for (const endpoint of ['http://127.0.0.1:9226', 'http://[::1]:9226']) {
      if (endpoints.has(endpoint)) continue;
      try { browsers.push(await chromium.connectOverCDP(endpoint, { timeout: 500 })); endpoints.add(endpoint); } catch { /* VK's second endpoint can open later */ }
    }
    const pages = browsers.flatMap(browser => browser.contexts().flatMap(context => context.pages()));
    main = pages.find(page => page.url().includes('tauri.localhost'));
    remote = pages.find(page => /^https:\/\/vk\.(com|ru)(\/|$)/.test(page.url()));
    if (main && remote && await main.evaluate(async () => (await window.desktop?.getVkStatus())?.state === 'connected').catch(() => false)) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(main && remote, 'Installed main and VK WebViews were not available');
  saved = await main.evaluate(captureInstalledStateForRestore);
  assert.equal(await main.evaluate(async () => (await window.desktop.getVkStatus()).state), 'connected', 'The installed VK session needs authentication');
  const testSourceRecovery = process.env.QA_SOURCE_RECOVERY === '1';
  const chosen = saved.tracks.find(track => track.title === (testSourceRecovery ? 'Скоро лето' : 'А утро') && track.artist.includes('Три дня дождя') && track.available);
  assert.ok(chosen, 'The track from the reported failure was not synchronized');
  main.on('pageerror', error => uiErrors.push(error.name));
  await remote.evaluate(targetId => {
    const OriginalAudio = window.Audio;
    window.__qaMidtrack = { original: OriginalAudio, audio: null, created: 0, targetCreated: 0, events: {}, targetEvents: {}, targetEnded: null };
    window.Audio = function (...args) {
      const audio = new OriginalAudio(...args);
      const target = window.__PULSE_VK_WEB__?.playback()?.id === targetId;
      window.__qaMidtrack.audio = audio;
      window.__qaMidtrack.created++;
      if (target) window.__qaMidtrack.targetCreated++;
      for (const type of ['playing', 'waiting', 'stalled', 'ended', 'error']) audio.addEventListener(type, () => {
        const events = window.__qaMidtrack.events;
        events[type] = (events[type] || 0) + 1;
        if (target) {
          const targetEvents = window.__qaMidtrack.targetEvents;
          targetEvents[type] = (targetEvents[type] || 0) + 1;
          // Capture before the native poll and UI auto-next can replace it.
          if (type === 'ended') window.__qaMidtrack.targetEnded = {
            position: audio.currentTime, duration: audio.duration,
            nativeEnded: audio.ended, targetIdentityMatched: true,
          };
        }
      });
      return audio;
    };
    window.Audio.prototype = OriginalAudio.prototype;
  }, chosen.id);
  // Mute only this test playback. The original preference is restored below.
  await main.getByLabel('Громкость', { exact: true }).fill('0');
  await main.getByRole('button', { name: `Воспроизвести ${chosen.title}`, exact: true }).first().click();
  console.log('Started the reported track in the installed release');
  const budget = testSourceRecovery ? 285000 : 175000;
  const deadline = Date.now() + budget;
  let injectedStalled = false, injectedWaiting = false, injectedMediaError = false, renewedMedia = false, refreshed = false, reachedEnd = false;
  let failedMediaCount = 0, failedPosition = 0;
  while (Date.now() < deadline) {
    const sample = await remote.evaluate(targetId => {
      const status = window.__PULSE_VK_WEB__?.playback();
      const audio = window.__qaMidtrack?.audio;
      const qa = window.__qaMidtrack;
      return status && { targetIdentityMatched: status.id === targetId, position: status.position, duration: status.duration, playing: status.playing, buffering: status.buffering, recovering: status.recovering, ended: status.ended, hasError: Boolean(status.error), readyState: audio?.readyState, paused: audio?.paused, created: qa?.created || 0, targetCreated: qa?.targetCreated || 0, targetEnded: qa?.targetEnded, targetEvents: qa?.targetEvents };
    }, chosen.id);
    assert.ok(sample, 'Playback status disappeared');
    if (sample.targetIdentityMatched && sample.position > 1) samples.push({ ...sample, elapsed: Math.round((Date.now() - (deadline - budget)) / 1000) });
    if (sample.targetEnded) {
      assert.equal(sample.targetEnded.nativeEnded, true, 'Target ended event was synthetic or premature');
      assert.ok(sample.targetEnded.duration > 0 && sample.targetEnded.position >= sample.targetEnded.duration - 0.25, 'Target ended before its full duration');
      reachedEnd = true;
      // Auto-next is allowed. Do not attribute its clock or errors to target.
      result = { targetEnded: sample.targetEnded, targetEvents: sample.targetEvents, targetAudioElementsCreated: sample.targetCreated };
      break;
    }
    assert.equal(sample.hasError, false, 'Direct playback returned a source error');
    assert.equal(await main.locator('.player-error').count(), 0, 'Installed player showed a mid-song error');
    if (!sample.targetIdentityMatched) { await new Promise(resolve => setTimeout(resolve, 1000)); continue; }
    if (sample.position >= 29 && !injectedStalled) {
      await remote.evaluate(() => window.__qaMidtrack.audio.dispatchEvent(new Event('stalled')));
      injectedStalled = true;
      console.log('PASS injected network stalled into real buffered playback');
    }
    if (sample.position >= 35 && !injectedWaiting) {
      await remote.evaluate(() => window.__qaMidtrack.audio.dispatchEvent(new Event('waiting')));
      injectedWaiting = true;
    }
    if (testSourceRecovery && sample.position >= 48 && !injectedMediaError) {
      failedMediaCount = sample.targetCreated; failedPosition = sample.position;
      await remote.evaluate(() => window.__qaMidtrack.audio.dispatchEvent(new Event('error')));
      injectedMediaError = true;
      console.log('Injected media source failure during the real reported HLS track');
    }
    if (injectedMediaError && sample.targetCreated > failedMediaCount && sample.position > failedPosition + 3 && sample.playing) renewedMedia = true;
    if (sample.position >= 42 && !refreshed) {
      // Existing authorized same-account synchronization must preserve audio.
      void main.evaluate(() => window.desktop.refreshVk()).catch(() => {});
      refreshed = true;
    }
    if (samples.length % 15 === 0 && samples.length) console.log(`Playback reached ${Math.floor(sample.position)}s without error`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.ok(injectedStalled && injectedWaiting && refreshed, 'Did not exercise the original failure area');
  assert.ok(samples.some(sample => sample.position > 90), 'Track did not play past the reported middle section');
  assert.ok(reachedEnd, 'The complete track did not finish');
  if (testSourceRecovery) assert.ok(injectedMediaError && renewedMedia, 'The failed source did not renew and continue from the same position');
  if (testSourceRecovery) assert.ok(result.targetEvents.error >= 1 && result.targetAudioElementsCreated >= 2, 'The injected target error and replacement audio were not observed');
  assert.equal(uiErrors.length, 0, 'Renderer exceptions occurred');
  result = { ...result, checkedAt: new Date().toISOString(), installedRelease: true, cloudReadOnly: true, target: { title: chosen.title, artist: chosen.artist }, fullTrackReachedEnd: true, duration: result.targetEnded.duration, lastPosition: result.targetEnded.position, injectedStalled, injectedWaiting, injectedMediaError, renewedMedia, backgroundSyncDuringPlayback: refreshed, rendererExceptions: uiErrors.length, limitations: ['Playback was muted; audible continuity was not assessed.', 'Injected error was an Event, not an actual network outage or MediaError code.', 'Renderer exceptions cover the main player page only.', 'Background sync was requested; its completion was not asserted.', 'Restore readback covers local settings, queue, current track, position, history and local playlists; cloud metadata can refresh.'], samples, reportFile: testSourceRecovery ? 'installed-source-recovery-result.json' : 'installed-midtrack-result.json' };
  console.log('PASS installed release completed the real reported track with hidden VK, stalled/waiting events and background synchronization');
} finally {
  if (main && saved) {
    const restored = await main.evaluate(restoreInstalledStateBeforeClose, saved);
    assert.equal(restored.nativeReadbackMatched, true, 'Original local playback state was not restored on readback');
    if (result) { result.localStateRestoredOnReadback = true; result.localStateRestore = restored; }
  }
  if (remote) await remote.evaluate(() => {
    if (window.__qaMidtrack) window.Audio = window.__qaMidtrack.original;
    delete window.__qaMidtrack;
  }).catch(() => {});
  if (main && saved) await main.evaluate(() => window.__TAURI_INTERNALS__.invoke('finish_close')).catch(() => {});
  for (const browser of browsers) await browser.close().catch(() => {});
}
if (result) {
  const { reportFile, ...report } = result;
  await writeFile(new URL(reportFile, import.meta.url), JSON.stringify(report, null, 2) + '\n');
}
