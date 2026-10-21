import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { captureInstalledStateForRestore, restoreInstalledStateBeforeClose } from './installed-state-restore.mjs';

// Read-only installed bridge smoke. Transport is muted independently of saved
// preferences; no cloud changes, URLs, account IDs or audio content are recorded.
const started = Date.now();
const browsers = [];
let main, remote, saved, report;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, ms, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}
try {
  for (const endpoint of ['http://127.0.0.1:9226', 'http://[::1]:9226']) {
    try { browsers.push(await chromium.connectOverCDP(endpoint, { timeout: 700 })); } catch {}
  }
  const pages = browsers.flatMap(browser => browser.contexts().flatMap(context => context.pages()));
  main = pages.find(page => page.url().includes('tauri.localhost'));
  remote = pages.find(page => /^https:\/\/vk\.(com|ru)(\/|$)/.test(page.url()));
  assert.ok(main && remote, 'Installed player unavailable');
  saved = await main.evaluate(captureInstalledStateForRestore);
  const own = saved.tracks.find(track => track.id !== saved.currentTrackId && track.source === 'vk' && track.remote?.inLibrary && track.available && track.duration > 30);
  assert.ok(own, 'No available own-library smoke track');
  assert.equal((await main.evaluate(() => window.desktop.vkWebControl({ operation: 'volume', volume: 0 }))).accepted, true);
  await main.evaluate(() => {
    window.__qaV02PlaybackSmoke = { wanted: null, events: 0, advanced: false, errored: false };
    window.__qaV02PlaybackSmoke.off = window.desktop.onVkPlayback(status => {
      const probe = window.__qaV02PlaybackSmoke;
      if (status.id !== probe.wanted) return;
      probe.events++;
      if (status.playing && status.position > .5) probe.advanced = true;
      if (status.error) probe.errored = true;
    });
  });
  const command = input => bounded(main.evaluate(input => window.desktop.vkWebControl(input), input), Math.min(4000, Math.max(100, 17000 - (Date.now() - started))), 'Native playback did not respond within smoke deadline');
  async function smoke(id) {
    await main.evaluate(id => Object.assign(window.__qaV02PlaybackSmoke, { wanted: id, events: 0, advanced: false, errored: false }), id);
    const play = await command({ operation: 'play', id, position: 0 });
    assert.equal(play.accepted, true, 'Native play rejected');
    const first = await remote.evaluate(id => { const status = window.__PULSE_VK_WEB__.playback(); return { matching: status.id === id, position: status.position, duration: status.duration, error: Boolean(status.error) }; }, id);
    await pause(2100);
    const advance = await remote.evaluate(({ id, baseline }) => { const status = window.__PULSE_VK_WEB__.playback(); return { matching: status.id === id, advanced: status.position > baseline + 1, playing: status.playing, error: Boolean(status.error), durationValid: status.duration > 30 }; }, { id, baseline: first.position });
    const events = await main.evaluate(() => { const probe = window.__qaV02PlaybackSmoke; return { observedNativeEvents: probe.events, nativeEventAdvanced: probe.advanced, nativeEventError: probe.errored }; });
    assert.ok(advance.matching && advance.advanced && advance.playing && !advance.error && advance.durationValid, 'Real audio clock did not advance');
    assert.ok(events.observedNativeEvents > 0 && events.nativeEventAdvanced && !events.nativeEventError, 'Native playback events did not confirm progress');
    const seek = await command({ operation: 'seek', position: 12 });
    assert.equal(seek.accepted, true, 'Native seek rejected');
    const paused = await command({ operation: 'pause' });
    assert.equal(paused.accepted, true, 'Native pause rejected');
    const final = await remote.evaluate(id => { const status = window.__PULSE_VK_WEB__.playback(); return { matching: status.id === id, paused: !status.playing, seekApplied: Math.abs(status.position - 12) < 1.5, error: Boolean(status.error) }; }, id);
    assert.ok(final.matching && final.paused && final.seekApplied && !final.error, 'Seek/pause did not reach real transport');
    return { nativePlayAccepted: true, clockAdvancedOverOneSecond: true, ...events, nativeSeekAccepted: true, seekApplied: true, nativePauseAccepted: true, paused: true };
  }
  const ownPlayback = await smoke(own.id);
  const found = await bounded(main.evaluate(async () => {
    const tracks = await window.desktop.searchVk('Daft Punk');
    const selected = tracks.find(track => track.remote?.inLibrary === false && track.available && track.duration > 30);
    return { count: tracks.length, selectedId: selected?.id };
  }), Math.min(4000, Math.max(100, 17000 - (Date.now() - started))), 'Global search exceeded smoke deadline');
  assert.ok(found.selectedId, 'No available nonlibrary global result');
  const globalPlayback = await smoke(found.selectedId);
  report = { checkedAt: new Date().toISOString(), installedVersion: await main.evaluate(() => window.desktop.getVersion()), cloudReadOnly: true, transportMutedWithoutChangingPreferences: true, ownLibrary: ownPlayback, globalSearch: { resultCount: found.count, usedNonLibraryResult: true, ...globalPlayback }, elapsedBeforeRestoreMs: Date.now() - started };
} finally {
  if (main && saved) {
    await main.evaluate(() => { window.__qaV02PlaybackSmoke?.off?.(); delete window.__qaV02PlaybackSmoke; }).catch(() => {});
    const restore = await main.evaluate(restoreInstalledStateBeforeClose, saved);
    assert.equal(restore.nativeReadbackMatched, true, 'Original local state did not restore');
    if (report) report.localStateRestore = restore;
    await main.evaluate(() => window.__TAURI_INTERNALS__.invoke('finish_close')).catch(() => {});
  }
  for (const browser of browsers) await browser.close().catch(() => {});
  if (report) {
    report.totalElapsedMs = Date.now() - started;
    await writeFile(new URL('installed-v02-playback-smoke-result.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  }
}
