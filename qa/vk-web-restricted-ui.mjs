import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// Browser-only controlled fixture; never attaches to the user's VK WebView.
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const baseURL = process.env.QA_BASE_URL || 'http://127.0.0.1:5173';
let failures = 0;
async function run(name, check) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const settings = { theme: 'dark', style: 'minimal', accent: '#bdff62', density: 'comfortable', textScale: 1, reducedMotion: true, volume: .01, repeat: 'off', shuffle: false, closeToTray: false, autoplay: false, autoSkip: false };
    const track = { id: 'vk-42-1', title: 'Accessible fixture song', artist: 'QA', album: '', duration: 60, url: 'vk-web://42/1', source: 'vk', addedAt: 1, available: true, remote: { ownerId: 42, audioId: 1, inLibrary: true } };
    const playlists = Array.from({ length: 78 }, (_, i) => ({ id: `vk-playlist-42-${i + 1}`, title: i === 77 ? 'Restricted saved playlist' : i === 0 ? 'Truly empty playlist' : `Fixture mix ${i + 1}`, trackIds: [], createdAt: 1, remote: { ownerId: 42, playlistId: i + 1 }, ...(i === 77 ? { contentUnavailable: true, remoteTrackCount: 159, description: 'Saved metadata' } : {}) }));
    const state = { version: 1, tracks: [track], playlists, queue: [], history: [], currentTrackId: null, position: 0, settings };
    const status = { state: 'connected', mode: 'web', message: 'Imported fixture', capabilities: [], user: { id: 42, name: 'Fixture' }, syncProgress: { phase: 'complete', tracks: 1, playlists: 78, completedPlaylists: 78 } };
    window.__fixtureState = state; window.__fixtureStatus = status; window.__fixtureSaved = [];
    window.desktop = {
      getState: async () => state, saveState: async value => window.__fixtureSaved.push(value),
      getVkStatus: async () => status, getVersion: async () => 'qa',
      onVkUpdate(callback) { window.__fixtureUpdate = callback; return () => { if (window.__fixtureUpdate === callback) delete window.__fixtureUpdate; }; },
      onVkPlayback: () => () => {}, onCommand: () => () => {}, vkWebControl: async () => ({ accepted: true }),
    };
  });
  try {
    await page.goto(baseURL); await page.locator('.app-shell').waitFor();
    await check(page); assert.deepEqual(errors, []);
    console.log(`PASS ${name}`);
  } catch (error) { failures++; console.log(`FAIL ${name}: ${error.stack}`); }
  finally { await context.close(); }
}

await run('all 78 imported playlists remain reachable beyond 40 sidebar entries', async page => {
  await page.getByRole('button', { name: 'Все плейлисты (78)', exact: true }).click();
  assert.equal(await page.locator('.playlist-card').count(), 78);
  const restricted = page.locator('.playlist-card').filter({ hasText: 'Restricted saved playlist' });
  assert.match(await restricted.innerText(), /недоступен в VK/);
  assert.doesNotMatch(await restricted.innerText(), /0 треков/);
  await restricted.click();
  assert.equal(await page.locator('.empty-filter strong').innerText(), 'VK ограничил доступ к плейлисту');
  assert.equal(await page.getByRole('button', { name: 'Добавить треки из библиотеки', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Открыть в VK', exact: true }).count(), 1);
});

await run('an actually empty playlist keeps its separate message', async page => {
  await page.locator('.playlist-nav').filter({ hasText: 'Truly empty playlist' }).click();
  assert.equal(await page.locator('.empty-filter strong').innerText(), 'Плейлист пуст');
  assert.equal(await page.getByRole('button', { name: 'Добавить треки из библиотеки', exact: true }).count(), 1);
});

await run('placeholder metadata survives renderer saves and refresh replaces the restriction', async page => {
  await page.waitForFunction(() => window.__fixtureSaved.length > 0 && !!window.__fixtureUpdate);
  const persisted = await page.evaluate(() => window.__fixtureSaved.at(-1).playlists.at(-1));
  assert.equal(persisted.contentUnavailable, true); assert.equal(persisted.remoteTrackCount, 159);
  assert.equal(persisted.description, 'Saved metadata');
  await page.evaluate(() => {
    const state = window.__fixtureState;
    window.__fixtureUpdate({ complete: true, mode: 'web', status: window.__fixtureStatus, tracks: state.tracks,
      playlists: state.playlists.map((item, index) => index === 77 ? { id: item.id, title: item.title, remote: item.remote, createdAt: item.createdAt, trackIds: ['vk-42-1'] } : item) });
  });
  await page.getByRole('button', { name: 'Все плейлисты (78)', exact: true }).click();
  const restricted = page.locator('.playlist-card').filter({ hasText: 'Restricted saved playlist' });
  assert.match(await restricted.innerText(), /1 треков/);
  assert.doesNotMatch(await restricted.innerText(), /недоступен/);
  await restricted.click();
  assert.equal(await page.locator('.track-row').count(), 1);
  assert.equal(await page.locator('.track-meta strong').innerText(), 'Accessible fixture song');
});

await browser.close();
console.log(`QA result: ${failures} failed checks`);
process.exitCode = failures ? 1 : 0;
