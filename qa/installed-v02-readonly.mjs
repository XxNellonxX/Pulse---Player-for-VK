import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { captureInstalledStateForRestore, restoreInstalledStateBeforeClose } from './installed-state-restore.mjs';

// Installed release acceptance with the existing account. No add/delete/upload
// calls are made. Persisted preferences and playback references are restored.
const phase = process.argv.includes('--repeat') ? 'warm-repeat' : process.argv.includes('--warm') ? 'warm' : 'migration';
const browsers = [], endpoints = new Set();
const started = Date.now();
let main, remote, saved, result;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const pages = () => browsers.flatMap(browser => browser.contexts().flatMap(context => context.pages()));
async function discover() {
  for (const endpoint of ['http://127.0.0.1:9226', 'http://[::1]:9226']) {
    if (endpoints.has(endpoint)) continue;
    try { browsers.push(await chromium.connectOverCDP(endpoint, { timeout: 300 })); endpoints.add(endpoint); } catch {}
  }
  main ||= pages().find(page => page.url().includes('tauri.localhost'));
  remote ||= pages().find(page => /^https:\/\/vk\.(com|ru)(\/|$)/.test(page.url()));
}
try {
  while (!main && Date.now() - started < 40000) { await discover(); if (!main) await pause(150); }
  assert.ok(main, 'Installed main WebView unavailable');
  await main.waitForFunction(() => window.desktop?.getState);
  saved = await main.evaluate(captureInstalledStateForRestore);
  const initialRows = await main.locator('.track-row').count();
  const initialCatalog = saved.tracks.filter(track => track.source === 'vk').length;
  assert.ok(initialCatalog > 0, 'Saved library missing at startup');
  await main.locator('.track-row').first().waitFor({ timeout: 10000 });
  const cacheRenderedMs = Date.now() - started;
  let snapshot;
  while (Date.now() - started < 150000) {
    await discover();
    snapshot = await remote?.evaluate(() => window.__PULSE_VK_WEB__?.read(true)).catch(() => null);
    const status = await main.evaluate(() => window.desktop.getVkStatus());
    if (snapshot?.complete && snapshot.status === 'complete' && status.state === 'connected' && status.syncProgress?.phase === 'complete') break;
    await pause(250);
  }
  assert.equal(snapshot?.status, 'complete', 'Signed-in VK background verification did not complete');
  const state = await main.evaluate(() => window.desktop.getState());
  const own = snapshot.tracks.filter(track => track.remote?.inLibrary !== false);
  const nativeOwn = state.tracks.filter(track => track.source === 'vk' && track.remote?.inLibrary !== false);
  assert.deepEqual(nativeOwn.map(track => track.id), own.map(track => track.id), 'VK order/membership differs');
  const nativePlaylists = new Map(state.playlists.filter(playlist => playlist.remote).map(playlist => [playlist.id, playlist]));
  assert.equal(nativePlaylists.size, snapshot.playlists.length, 'Native registry contains missing or extra VK playlists');
  assert.ok(snapshot.playlists.every(playlist => JSON.stringify(nativePlaylists.get(playlist.id)?.trackIds) === JSON.stringify(playlist.trackIds)), 'Playlist membership differs');
  const status = await main.evaluate(() => window.desktop.getVkStatus());
  assert.equal(status.state, 'connected');
  assert.equal(status.syncProgress?.phase, 'complete', 'Native background commit did not complete');
  assert.ok(status.capabilities.some(cap => cap.id === 'track-mutations' && cap.status === 'verified'));
  assert.equal(await main.locator('.track-delete:enabled').count() > 0, true, 'Own-library delete is disabled');
  const sidebarFits = await main.locator('.sidebar-scroll').evaluate(element => element.scrollWidth <= element.clientWidth);
  assert.ok(sidebarFits, 'Long playlist names overflow the sidebar');
  const services = await remote.evaluate(() => {
    let runtime;
    window.webpackChunkvkweb?.push([[`pulse-readonly-probe-${Date.now()}`], {}, require => { runtime = require; }]);
    if (!runtime?.m?.[810213] || !runtime.m[522285] || !runtime.m[640547]) return { available: false };
    const service = runtime(810213).ensureAudioPageMusicService?.()?.audioOwning;
    return { available: typeof service?.add === 'function' && typeof service?.delete === 'function' && typeof runtime(522285).MusicAudioIdentity === 'function' && typeof runtime(640547).audioTupleToAudioObject === 'function', accountMatches: Number(service?.currentUserId) === Number(window.vk?.id) };
  });
  assert.ok(services.available && services.accountMatches, 'Expected VK website music services missing');
  const search = await main.evaluate(async () => {
    const tracks = await window.desktop.searchVk('Daft Punk');
    return { count: tracks.length, nonLibrary: tracks.filter(track => track.remote?.inLibrary === false).length, valid: tracks.every(track => track.source === 'vk' && track.id && track.title && track.artist && track.url.startsWith('vk-web://')) };
  });
  assert.ok(search.count > 0 && search.nonLibrary > 0 && search.valid, 'Global search did not produce valid external-library results');
  const cacheStats = snapshot.cacheStats;
  if (phase.startsWith('warm')) {
    assert.ok(cacheStats?.reusedPlaylists > 0, 'Warm start did not reuse verified playlist contents');
    assert.ok(cacheStats.playlistPages < snapshot.playlists.length, 'Warm start downloaded every playlist again');
  }
  result = { checkedAt: new Date().toISOString(), phase, installedVersion: await main.evaluate(() => window.desktop.getVersion()), cloudReadOnly: true, cachedRegistryTracksAtStartup: initialCatalog, initialRenderedRows: initialRows, cachedRowsObservedWithinMs: cacheRenderedMs, libraryCount: own.length, registryCount: snapshot.tracks.length, playlistCount: snapshot.playlists.length, exactOwnSequenceMatchesVk: true, playlistMembershipMatchesVk: true, sidebarFits, deleteEnabledWithoutInvoking: true, websiteMutationServicePresentWithoutInvoking: services.available, globalSearch: search, cacheStats, elapsedMs: Date.now() - started };
  console.log(JSON.stringify(result));
} finally {
  if (main && saved) {
    const restored = await main.evaluate(restoreInstalledStateBeforeClose, saved);
    assert.equal(restored.nativeReadbackMatched, true, 'Local preferences/queue were not restored');
    if (result) result.localStateRestore = restored;
    await main.evaluate(() => window.__TAURI_INTERNALS__.invoke('finish_close')).catch(() => {});
  }
  for (const browser of browsers) await browser.close().catch(() => {});
  if (result) await writeFile(new URL(`installed-v02-${phase}-result.json`, import.meta.url), JSON.stringify(result, null, 2) + '\n');
}
