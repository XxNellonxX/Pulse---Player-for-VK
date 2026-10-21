import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const baseURL = process.env.QA_BASE_URL || 'http://127.0.0.1:5173';
let failures = 0;
async function run(name, fn, slowRestore = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(({ slowRestore }) => {
    const settings = { theme: 'dark', style: 'minimal', accent: '#bdff62', density: 'comfortable', textScale: 1, reducedMotion: false, volume: .01, repeat: 'off', shuffle: false, closeToTray: false, autoplay: false, autoSkip: false };
    const track = { id: 'vk-101-1', title: 'Old playlist exclusive', artist: 'QA', album: '', duration: 60, url: 'vk-web://101/1', source: 'vk', addedAt: 1, available: true, remote: { ownerId: 101, audioId: 1, inLibrary: false } };
    const local = { ...track, id: 'local-one', source: 'local', title: 'Local retained', remote: undefined, url: '' };
    const state = { version: 1, tracks: [local, track], playlists: [{ id: 'local-playlist', title: 'Pinned local playlist', trackIds: [track.id], createdAt: 1 }], history: [track.id], queue: [track.id], currentTrackId: track.id, position: 4, settings };
    const status = { state: 'connected', mode: 'web', message: '', user: { id: 101, name: 'QA' }, capabilities: [] };
    window.__qaStatusCalls = 0; window.__qaSaved = []; window.__qaGetStateDone = !slowRestore;
    window.desktop = {
      getState: async () => slowRestore ? new Promise(resolve => { window.__qaRestore = () => { window.__qaGetStateDone = true; resolve(state); }; }) : state,
      saveState: async value => window.__qaSaved.push(value),
      getVkStatus: async () => {
        window.__qaStatusCalls++;
        if (!window.__qaGetStateDone) window.__qaStatusBeforeRestore = true;
        if (slowRestore) {
          queueMicrotask(() => window.__qaUpdate?.({ complete: true, mode: 'web', status, tracks: [{ ...track, id: 'vk-101-2', title: 'Newly restored web track', remote: { ownerId: 101, audioId: 2, inLibrary: true } }], playlists: [] }));
        }
        return status;
      },
      vkWebControl: async () => ({ accepted: true }),
      onVkUpdate(callback) { window.__qaUpdate = callback; return () => { if (window.__qaUpdate === callback) delete window.__qaUpdate; }; },
      onVkPlayback: () => () => {}, onCommand: () => () => {}, getVersion: async () => 'qa',
    };
  }, { slowRestore });
  try {
    await page.goto(baseURL);
    await fn(page);
    console.log(`PASS ${name}`);
  } catch (error) { failures++; console.log(`FAIL ${name}: ${error.stack}`); }
  finally { await context.close(); }
}

await run('slow-state-restore-does-not-overwrite-initial-web-import', async page => {
  await page.waitForFunction(() => !!window.__qaRestore && !!window.__qaUpdate);
  assert.equal(await page.evaluate(() => window.__qaStatusCalls), 0, 'restore_status ran before local state finished loading');
  await page.evaluate(() => window.__qaRestore());
  await page.locator('.app-shell').waitFor();
  await page.locator('.track-meta strong').filter({ hasText: 'Newly restored web track' }).waitFor();
  assert.equal(await page.evaluate(() => !!window.__qaStatusBeforeRestore), false);
}, true);

await run('web-refresh-removes-a-deleted-track-even-when-locally-pinned', async page => {
  await page.locator('.app-shell').waitFor();
  await page.waitForFunction(() => !!window.__qaUpdate);
  await page.evaluate(() => window.__qaUpdate({ complete: true, mode: 'web', status: { state: 'connected', mode: 'web', message: '', user: { id: 101, name: 'QA' }, capabilities: [] }, tracks: [], playlists: [] }));
  await page.waitForTimeout(80);
  const saved = await page.evaluate(() => window.__qaSaved.at(-1));
  assert.equal(saved.tracks.some(track => track.id === 'vk-101-1'), false);
  assert.deepEqual(saved.queue, []); assert.deepEqual(saved.history, []);
  assert.equal(saved.currentTrackId, null);
  assert.deepEqual(saved.playlists[0].trackIds, []);
  assert.equal(saved.tracks.some(track => track.id === 'local-one'), true);
});

await browser.close();
console.log(`QA result: ${failures} failed checks`);
process.exitCode = failures ? 1 : 0;
