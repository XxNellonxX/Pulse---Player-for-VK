import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// Isolated synthetic library: no real account, filesystem imports or native app.
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const baseURL = process.env.QA_BASE_URL || 'http://127.0.0.1:5173';
let failures = 0;
async function run(name, check) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await context.route(/^https:\/\//, route => route.abort());
  await page.addInitScript(() => {
    const artwork = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E';
    const tracks = Array.from({ length: 20_000 }, (_, index) => ({ id: `vk-101-${index + 1}`, title: `Queue track ${index + 1}`, artist: 'Independent QA', album: '', duration: 60, url: `vk-web://101/${index + 1}`, artwork, source: 'vk', addedAt: 0, available: true, remote: { ownerId: 101, audioId: index + 1, inLibrary: true } }));
    const settings = { theme: 'dark', style: 'minimal', accent: '#bdff62', density: 'comfortable', textScale: 1, reducedMotion: true, volume: .01, repeat: 'off', shuffle: false, closeToTray: false, autoplay: false, autoSkip: false };
    const state = { version: 1, tracks, playlists: [{ id: 'queue-qa-playlist', title: 'Queue QA', trackIds: [], createdAt: 1, artwork }], history: [], queue: tracks.map(track => track.id), currentTrackId: tracks[15_000].id, position: 0, settings };
    const status = { state: 'connected', mode: 'web', message: '', user: { id: 101, name: 'Synthetic QA' }, capabilities: [] };
    window.__queueState = state;
    window.__queueCommands = [];
    window.desktop = {
      getState: async () => state,
      saveState: async value => { window.__queueState = value; },
      getVkStatus: async () => status,
      refreshVk: async () => ({ status, complete: false, tracks: [], playlists: [] }),
      onVkUpdate: () => () => {}, onVkPlayback: () => () => {}, onCommand: () => () => {},
      vkWebControl: async command => { window.__queueCommands.push(command); return { accepted: true }; },
      getVersion: async () => 'queue-independent-qa',
    };
  });
  try {
    await page.goto(baseURL);
    await page.locator('.app-shell').waitFor();
    await page.waitForFunction(() => window.__queueState.queue.length === 20_000);
    await check(page);
    console.log(`PASS ${name}`);
  } catch (error) { failures++; console.log(`FAIL ${name}: ${error.stack}`); }
  finally { await context.close(); }
}
const open = async page => { await page.getByRole('button', { name: /Очередь/ }).click(); await page.locator('.queue-panel.open').waitFor(); };
const scrollTo = async (page, index) => {
  await page.locator('.queue-list').evaluate((element, index) => { element.scrollTop = index * 52; }, index);
  await page.locator(`.queue-row[aria-posinset="${index + 1}"]`).waitFor();
};
const bounded = async page => assert.ok(await page.locator('.queue-row').count() < 35, 'queue mounted a catalog-sized DOM');

await run('20k-queue-opens-at-current-and-scrolls-to-both-ends-with-bounded-dom', async page => {
  assert.equal(await page.locator('.queue-row').count(), 0);
  await open(page);
  await bounded(page);
  const current = page.locator('.queue-row.active');
  await current.waitFor();
  const inside = await current.evaluate(element => { const row = element.getBoundingClientRect(); const viewport = element.closest('.queue-list').getBoundingClientRect(); return row.top >= viewport.top && row.bottom <= viewport.bottom; });
  assert.ok(inside, 'current track is outside the initial queue viewport');
  await scrollTo(page, 0);
  await bounded(page);
  assert.ok(await page.locator('.queue-row[aria-posinset="1"]').getByRole('button', { name: 'Выше', exact: true }).isDisabled());
  await scrollTo(page, 19_999);
  await bounded(page);
  const last = page.locator('.queue-row[aria-posinset="20000"]');
  assert.equal(await last.locator('strong').textContent(), 'Queue track 20000');
  assert.ok(await last.getByRole('button', { name: 'Ниже', exact: true }).isDisabled());
});

await run('scrolled-queue-move-remove-and-play-use-original-identities-and-indices', async page => {
  await open(page);
  await scrollTo(page, 10_000);
  await page.locator('.queue-row[aria-posinset="10001"]').getByRole('button', { name: 'Ниже', exact: true }).click();
  await page.waitForFunction(() => window.__queueState.queue[10_001] === 'vk-101-10001');
  assert.equal(await page.evaluate(() => window.__queueState.queue[10_000]), 'vk-101-10002');
  await page.locator('.queue-row[aria-posinset="10002"]').getByRole('button', { name: 'Удалить', exact: true }).click();
  await page.waitForFunction(() => window.__queueState.queue.length === 19_999);
  assert.equal(await page.evaluate(() => window.__queueState.queue.includes('vk-101-10001')), false);
  assert.equal(await page.evaluate(() => window.__queueState.queue[10_000]), 'vk-101-10002');
  await scrollTo(page, 19_998);
  await page.locator('.queue-row[aria-posinset="19999"] .queue-track').click();
  await page.waitForFunction(() => window.__queueCommands.some(command => command.operation === 'play' && command.id === 'vk-101-20000'));
  assert.equal(await page.evaluate(() => window.__queueState.currentTrackId), 'vk-101-20000');
  await bounded(page);
  await page.getByRole('button', { name: 'Закрыть очередь', exact: true }).click();
  assert.equal(await page.locator('.queue-row').count(), 0);
  await open(page);
  await page.locator('.queue-row.active').waitFor();
  await page.getByRole('button', { name: 'Очистить очередь', exact: true }).click();
  await page.waitForFunction(() => window.__queueState.queue.length === 0);
  assert.equal(await page.locator('.queue-row').count(), 0);
  await page.getByText('Очередь пуста', { exact: true }).waitFor();
});

await run('offscreen-track-and-playlist-covers-use-lazy-asynchronous-decoding', async page => {
  const trackCover = page.locator('.track-cover img').first();
  assert.equal(await trackCover.getAttribute('loading'), 'lazy');
  assert.equal(await trackCover.getAttribute('decoding'), 'async');
  await page.getByRole('button', { name: 'Плейлисты', exact: true }).click();
  const playlistCover = page.locator('.playlist-card-art img').first();
  assert.equal(await playlistCover.getAttribute('loading'), 'lazy');
  assert.equal(await playlistCover.getAttribute('decoding'), 'async');
});

await run('tauri-save-omits-native-owned-catalog-and-keeps-renderer-owned-state', async page => {
  const proof = await page.evaluate(async () => {
    const original = { ...window.__queueState, playlists: [...window.__queueState.playlists, { id: 'remote-qa', title: 'Remote QA', trackIds: ['vk-101-1'], createdAt: 1, remote: { ownerId: 101, playlistId: 1 } }] };
    window.isTauri = true;
    let captured;
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => { if (command === 'save_state') captured = args.state; } };
    await import('/src/desktop.ts?queue-payload-qa');
    await window.desktop.saveState(original);
    return {
      sentTracks: captured.tracks.length,
      sentPlaylists: captured.playlists.map(playlist => playlist.id),
      queuePreserved: captured.queue === original.queue,
      currentPreserved: captured.currentTrackId === original.currentTrackId,
      settingsPreserved: captured.settings === original.settings,
      sourceUnchanged: original.tracks.length === 20_000 && original.playlists.length === 2,
      ratio: JSON.stringify(captured).length / JSON.stringify(original).length,
    };
  });
  assert.equal(proof.sentTracks, 0);
  assert.deepEqual(proof.sentPlaylists, ['queue-qa-playlist']);
  assert.ok(proof.queuePreserved && proof.currentPreserved && proof.settingsPreserved && proof.sourceUnchanged);
  assert.ok(proof.ratio < .2, `catalog still dominates IPC payload: ${proof.ratio}`);
});

await browser.close();
console.log(`QA result: ${failures} failed checks`);
process.exitCode = failures ? 1 : 0;
