import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// Independent UI probes: assert the sequence VK supplied, including deliberately
// conflicting import timestamps. Uses an isolated bridge and browser profile.
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const baseURL = process.env.QA_BASE_URL || 'http://127.0.0.1:5173';
const settings = { theme: 'dark', style: 'minimal', accent: '#bdff62', density: 'comfortable', textScale: 1, reducedMotion: false, volume: .01, repeat: 'off', shuffle: false, closeToTray: false, autoplay: false, autoSkip: false };
const remote = (id, addedAt, title = `Order ${id}`, inLibrary = true) => ({ id: `vk-101-${id}`, title, artist: `Artist ${20 - id}`, album: '', duration: 60, url: `vk-web://101/${id}`, source: 'vk', addedAt, available: true, remote: { ownerId: 101, audioId: id, inLibrary } });
const local = (id, addedAt) => ({ id: `local-${id}`, title: `Local ${id}`, artist: 'QA', album: '', duration: 60, url: '', source: 'local', addedAt, available: true });
const original = [remote(4, 100, 'Zulu'), remote(1, 900, 'Alpha'), remote(7, 1, 'Middle'), remote(9, 1000, 'Exclusive', false)];
const playlist = { id: 'vk-pl-101-10', title: 'Source order mix', trackIds: ['vk-101-9', 'vk-101-1', 'vk-101-4'], createdAt: 1, remote: { ownerId: 101, playlistId: 10 } };
const state = { version: 1, tracks: [local('older', 10), ...original, local('newer', 2000)], playlists: [playlist], history: [], queue: [], currentTrackId: null, position: 0, settings };
const status = { state: 'connected', mode: 'web', message: '', user: { id: 101, name: 'Order QA' }, capabilities: [] };
let failures = 0;

async function run(name, fn) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(({ state, status }) => {
    if (!localStorage.getItem('independent-order-state')) localStorage.setItem('independent-order-state', JSON.stringify(state));
    window.__orderSaved = [];
    window.__orderControls = [];
    window.desktop = {
      getState: async () => JSON.parse(localStorage.getItem('independent-order-state')),
      saveState: async value => { window.__orderSaved.push(value); localStorage.setItem('independent-order-state', JSON.stringify(value)); },
      getVkStatus: async () => status,
      refreshVk: async () => ({ status, complete: false, tracks: [], playlists: [] }),
      onVkUpdate: callback => { window.__orderUpdate = callback; return () => { if (window.__orderUpdate === callback) delete window.__orderUpdate; }; },
      onVkPlayback: callback => { window.__orderPlayback = callback; return () => { if (window.__orderPlayback === callback) delete window.__orderPlayback; }; },
      vkWebControl: async command => { window.__orderControls.push(command); return { accepted: true }; },
      onCommand: () => () => {}, getVersion: async () => 'order-qa',
    };
  }, { state, status });
  try {
    await page.goto(baseURL);
    await page.locator('.app-shell').waitFor();
    await page.waitForFunction(() => !!window.__orderUpdate);
    await fn(page);
    console.log(`PASS ${name}`);
  } catch (error) { failures++; console.log(`FAIL ${name}: ${error.stack}`); }
  finally { await context.close(); }
}
const titles = page => page.locator('.track-row .track-meta strong').allTextContents();
async function sync(page, tracks) {
  await page.evaluate(({ tracks, status, playlist }) => window.__orderUpdate({ status, complete: true, mode: 'web', syncedAt: Date.now(), tracks, playlists: [playlist] }), { tracks, status, playlist });
  await page.waitForFunction(expected => JSON.parse(localStorage.getItem('independent-order-state')).tracks.filter(track => track.source === 'vk').map(track => track.id).join() === expected, tracks.map(track => track.id).join());
}

await run('restored-library-honors-vk-source-sequence-over-import-timestamps', async page => {
  assert.deepEqual(await titles(page), ['Zulu', 'Alpha', 'Middle', 'Local newer', 'Local older']);
  assert.equal((await titles(page)).includes('Exclusive'), false, 'playlist-only track appeared in My Music');
});

await run('new-complete-sync-reorders-and-adds-in-the-authoritative-vk-sequence', async page => {
  await sync(page, [remote(8, 0, 'Fresh'), original[1], original[0], original[3]]);
  assert.deepEqual(await titles(page), ['Fresh', 'Alpha', 'Zulu', 'Local newer', 'Local older']);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('independent-order-state')));
  assert.equal(saved.tracks.some(track => track.id === 'vk-101-7'), false, 'deleted track survived the authoritative snapshot');
});

await run('subsequent-sync-can-reorder-the-same-ids-with-equal-timestamps', async page => {
  await sync(page, [remote(7, 777, 'Middle'), remote(4, 777, 'Zulu'), remote(1, 777, 'Alpha'), original[3]]);
  assert.deepEqual(await titles(page), ['Middle', 'Zulu', 'Alpha', 'Local newer', 'Local older']);
  await sync(page, [remote(1, 777, 'Alpha'), remote(7, 777, 'Middle'), remote(4, 777, 'Zulu'), original[3]]);
  assert.deepEqual(await titles(page), ['Alpha', 'Middle', 'Zulu', 'Local newer', 'Local older']);
});

await run('restart-preserves-latest-vk-order-despite-stale-original-import-times', async page => {
  await sync(page, [original[2], original[0], original[1], original[3]]);
  assert.deepEqual(await titles(page), ['Middle', 'Zulu', 'Alpha', 'Local newer', 'Local older']);
  await page.reload();
  await page.locator('.app-shell').waitFor();
  assert.deepEqual(await titles(page), ['Middle', 'Zulu', 'Alpha', 'Local newer', 'Local older']);
});

await run('playlist-retains-its-own-vk-order-including-exclusive-tracks', async page => {
  await page.getByRole('button', { name: /Source order mix/ }).click();
  assert.deepEqual(await titles(page), ['Exclusive', 'Alpha', 'Zulu']);
});

await run('explicit-title-sort-and-return-to-vk-default-both-work', async page => {
  await page.locator('.select-wrap select').selectOption('title');
  assert.deepEqual(await titles(page), ['Alpha', 'Local newer', 'Local older', 'Middle', 'Zulu']);
  await page.locator('.select-wrap select').selectOption('recent');
  assert.deepEqual(await titles(page), ['Zulu', 'Alpha', 'Middle', 'Local newer', 'Local older']);
});

await run('local-files-still-use-their-own-recent-import-order', async page => {
  await page.getByRole('button', { name: /Локальные файлы/ }).click();
  assert.deepEqual(await titles(page), ['Local newer', 'Local older']);
});

await run('play-next-follows-the-visible-vk-order', async page => {
  await page.getByRole('button', { name: 'Воспроизвести Zulu', exact: true }).click();
  await page.evaluate(() => window.__orderPlayback({ id: 'vk-101-4', requestedId: 'vk-101-4', playing: true, buffering: false, position: 0, duration: 60, error: null, ended: false, runId: 'qa-order' }));
  await page.getByRole('button', { name: 'Следующий трек', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.now-meta strong')?.textContent === 'Alpha');
  assert.equal(await page.locator('.now-meta strong').innerText(), 'Alpha');
});

await run('large-library-keeps-authoritative-order-across-show-more-boundaries', async page => {
  const supplied = Array.from({ length: 260 }, (_, index) => remote(500 - index, (index * 913) % 7919));
  await sync(page, supplied);
  assert.deepEqual(await titles(page), supplied.slice(0, 120).map(track => track.title));
  await page.getByRole('button', { name: /Показать ещё/ }).click();
  assert.deepEqual(await titles(page), supplied.slice(0, 240).map(track => track.title));
  await page.getByRole('button', { name: /Показать ещё/ }).click();
  assert.deepEqual(await titles(page), [...supplied.map(track => track.title), 'Local newer', 'Local older']);
});

await browser.close();
console.log(`Independent order QA: ${failures} failed checks`);
process.exitCode = failures ? 1 : 0;
