import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

// Read-only check of an explicitly debug-enabled installed instance. Keeps
// account metadata in memory and prints only counts and comparison results.
const browsers = [];
try {
  for (const address of ['http://127.0.0.1:9226', 'http://[::1]:9226']) {
    try { browsers.push(await chromium.connectOverCDP(address, { timeout: 1500 })); } catch {}
  }
  const pages = () => browsers.flatMap(browser => browser.contexts().flatMap(context => context.pages()));
  const main = pages().find(page => page.url().includes('tauri.localhost'));
  assert.ok(main, 'Installed player is not available on the test debug port');
  let remote, snapshot;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    remote = pages().find(page => /^https:\/\/vk\.(com|ru)(\/|$)/.test(page.url()));
    snapshot = await remote?.evaluate(() => window.__PULSE_VK_WEB__?.read(true)).catch(() => null);
    const native = await main.evaluate(() => window.desktop.getVkStatus());
    if (snapshot?.status === 'complete' && snapshot.complete && native.state === 'connected' && native.syncProgress?.phase === 'complete') break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(snapshot?.status, 'complete', 'VK did not complete the live synchronization');
  const state = await main.evaluate(() => window.desktop.getState());
  const sourceLibrary = snapshot.tracks.filter(track => track.remote?.inLibrary !== false);
  const persistedLibrary = state.tracks.filter(track => track.source === 'vk' && track.remote?.inLibrary !== false);
  assert.ok(persistedLibrary.length === sourceLibrary.length && persistedLibrary.every((track, index) => track.id === sourceLibrary[index].id), 'Native library order differs from the VK source');
  await main.locator('.track-row').first().waitFor();
  const rendered = await main.locator('.track-row .track-meta strong').allTextContents();
  assert.ok(rendered.length > 0);
  assert.ok(rendered.every((title, index) => title === sourceLibrary[index]?.title), 'Visible library order differs from VK');
  assert.equal(await main.locator('select').first().inputValue(), 'recent');
  const result = {
    checkedAt: new Date().toISOString(),
    runtime: 'installed Tauri release, signed-in official VK session',
    libraryTrackCount: sourceLibrary.length,
    fullNativeSequenceMatchesVk: true,
    renderedTrackCount: rendered.length,
    visibleSequenceMatchesVk: true,
  };
  await writeFile(new URL('order-window-live-result.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  for (const browser of browsers) await browser.close().catch(() => {});
}
