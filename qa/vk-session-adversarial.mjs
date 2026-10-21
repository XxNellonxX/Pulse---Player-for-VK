import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const baseURL = process.env.QA_BASE_URL || 'http://127.0.0.1:5173';
const settings = { theme: 'dark', style: 'minimal', accent: '#bdff62', density: 'comfortable', textScale: 1, reducedMotion: false, volume: .01, repeat: 'off', shuffle: false, closeToTray: false, autoplay: false, autoSkip: false };
const local = { id: 'qa-local', title: 'Local safe', artist: 'QA', album: '', duration: 12, url: '', source: 'local', addedAt: 1, available: true };
const remote = { id: 'vk-101-1', title: 'Remote safe', artist: 'QA', album: '', duration: 12, url: 'https://example.invalid/audio.mp3', source: 'vk', addedAt: 2, available: true, remote: { ownerId: 101, audioId: 1, inLibrary: true } };
const search = { ...remote, id: 'vk-202-2', title: 'Searched exclusive', remote: { ownerId: 202, audioId: 2, inLibrary: false } };
const status = { state: 'connected', message: '', user: { id: 101, name: 'QA account A' }, capabilities: [] };
const state = { version: 1, tracks: [local, remote], playlists: [], history: [], queue: [], currentTrackId: null, position: 0, settings };
const snapshot = { complete: true, syncedAt: 1, status, tracks: [remote], playlists: [] };
const wave = Buffer.alloc(44 + 8000 * 12 * 2);
wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVE', 8); wave.write('fmt ', 12); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(wave.length - 44, 40);
let failures = 0;

async function run(name, fn, mode = '') {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.route('https://example.invalid/audio.mp3', route => route.fulfill({ status: 200, contentType: 'audio/wav', body: wave }));
  await page.addInitScript(({ state, status, snapshot, search, mode }) => {
    window.__qaSaved = [];
    window.__qaPending = [];
    window.__qaApiCalls = [];
    let calls = 0;
    let disconnected = false;
    window.desktop = {
      getState: async () => state,
      saveState: async value => { window.__qaSaved.push(JSON.parse(JSON.stringify(value))); },
      getVkStatus: async () => mode === 'late-status' ? new Promise(resolve => { window.__qaPending.push(resolve); }) : disconnected ? { ...status, state: 'disconnected' } : status,
      connectVk: async () => status,
      disconnectVk: async () => { disconnected = true; return { ...status, state: 'disconnected' }; },
      refreshVk: async () => {
        calls++;
        if (mode === 'deferred-sync' && calls > 1) return new Promise(resolve => { window.__qaPending.push(resolve); });
        if (mode === 'partial') return { ...snapshot, complete: false, tracks: [], error: 'QA incomplete page' };
        return snapshot;
      },
      // Mirror the native trust boundary: a successful VK search registers the
      // server-returned track before the renderer can start playback. The
      // renderer's debounced save is intentionally independent of this cache.
      searchVk: async () => { if (!state.tracks.some(track => track.id === search.id)) state.tracks.push(search); return [search]; },
      resolveVkTrack: async id => { window.__qaApiCalls.push(['resolve', id]); if (mode === 'native-resolve-race' && !state.tracks.some(track => track.id === id)) throw new Error('native state has not received the search result yet'); return search; },
      importFiles: async () => [], removeTrack: async () => {},
      openExternal: async () => {}, openVkMusic: async () => {},
      addVkTrack: async () => snapshot, deleteVkTrack: async () => snapshot,
      vkPlaylistChange: async input => { window.__qaApiCalls.push(['playlist', input]); return snapshot; },
      getVersion: async () => 'qa', exportDiagnostics: async () => null,
      onCommand: () => () => {},
    };
  }, { state, status, snapshot, search, mode });
  try {
    await page.goto(baseURL);
    await page.locator('.app-shell').waitFor();
    await page.waitForTimeout(100);
    await fn(page);
    console.log(`PASS ${name}`);
  } catch (error) { failures++; console.log(`FAIL ${name}: ${error.stack}`); }
  finally { await context.close(); }
}

await run('partial-sync-preserves-existing-library', async page => {
  assert.equal(await page.locator('.track-meta strong').filter({ hasText: 'Remote safe' }).count(), 1);
  assert.equal(await page.locator('.track-meta strong').filter({ hasText: 'Local safe' }).count(), 1);
}, 'partial');

await run('search-exclusive-result-can-be-selected-and-resolved', async page => {
  await page.getByPlaceholder('Поиск музыки').fill('Searched');
  await page.getByRole('button', { name: 'Воспроизвести Searched exclusive', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Воспроизвести Searched exclusive', exact: true }).click();
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.now-meta strong').count(), 1, 'search result ID added without its Track, so player stays empty');
  assert.equal(await page.locator('.now-meta strong').innerText(), 'Searched exclusive');
  const calls = await page.evaluate(() => window.__qaApiCalls);
  assert.ok(calls.some(([op, id]) => op === 'resolve' && id === 'vk-202-2'), 'selected search result never reaches native resolve');
});

await run('search-result-play-does-not-race-native-save', async page => {
  await page.getByPlaceholder('Поиск музыки').fill('Searched');
  await page.getByRole('button', { name: 'Воспроизвести Searched exclusive', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Воспроизвести Searched exclusive', exact: true }).click();
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.now-meta strong').count(), 1, 'native resolve raced before the newly found track was persisted');
  assert.equal(await page.locator('.player-error').count(), 0, 'native resolve race surfaced an avoidable playback error');
}, 'native-resolve-race');

await run('search-exclusive-result-remains-visible-in-queue', async page => {
  await page.getByPlaceholder('Поиск музыки').fill('Searched');
  const row = page.locator('.track-row').filter({ hasText: 'Searched exclusive' });
  await row.getByRole('button', { name: 'Добавить в очередь', exact: true }).click();
  await page.getByRole('button', { name: /^Очередь/ }).click();
  assert.equal(await page.locator('.queue-track strong').filter({ hasText: 'Searched exclusive' }).count(), 1, 'queue has searched ID but filters out the missing Track');
});

await run('library-refresh-does-not-discard-current-search-track', async page => {
  await page.getByPlaceholder('Поиск музыки').fill('Searched');
  await page.getByRole('button', { name: 'Воспроизвести Searched exclusive', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Воспроизвести Searched exclusive', exact: true }).click();
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.now-meta strong').innerText(), 'Searched exclusive');
  await page.getByRole('button', { name: 'Синхронизировать VK', exact: true }).click();
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.now-meta strong').count(), 1, 'library refresh removed current search-only track and stopped playback');
  assert.equal(await page.locator('.now-meta strong').innerText(), 'Searched exclusive');
  await page.getByRole('button', { name: /^Очередь/ }).click();
  assert.equal(await page.locator('.queue-track strong').filter({ hasText: 'Searched exclusive' }).count(), 1);
});

await run('logout-discards-late-sync-response', async page => {
  await page.getByRole('button', { name: 'Синхронизировать VK', exact: true }).click();
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('button', { name: 'Аккаунт VK', exact: true }).click();
  await page.getByRole('button', { name: 'Отключить', exact: true }).click();
  await page.evaluate(() => window.__qaPending.splice(0).forEach(resolve => resolve({ complete: true, syncedAt: 1, status: { state: 'connected', message: '', user: { id: 101, name: 'QA account A' }, capabilities: [] }, tracks: [{ id: 'vk-101-1', title: 'Late private track', artist: 'QA', album: '', duration: 0, url: '', source: 'vk', addedAt: 1, available: false }], playlists: [] })));
  await page.getByRole('button', { name: 'Моя музыка', exact: true }).click();
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.track-meta strong').filter({ hasText: 'Late private track' }).count(), 0);
  assert.equal(await page.locator('.track-meta strong').filter({ hasText: 'Remote safe' }).count(), 0);
  assert.equal(await page.locator('.track-meta strong').filter({ hasText: 'Local safe' }).count(), 1);
}, 'deferred-sync');

await run('logout-discards-late-startup-status', async page => {
  await page.getByRole('button', { name: 'Подключить VK', exact: true }).click();
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('button', { name: 'Аккаунт VK', exact: true }).click();
  await page.getByRole('button', { name: 'Отключить', exact: true }).click();
  await page.evaluate(() => window.__qaPending.splice(0).forEach(resolve => resolve({ state: 'connected', message: '', user: { id: 101, name: 'Stale account A' }, capabilities: [] })));
  await page.waitForTimeout(120);
  assert.equal(await page.getByRole('button', { name: 'Отключить', exact: true }).count(), 0, 'stale startup getVkStatus resurrected the disconnected account');
  assert.equal(await page.getByText('Stale account A', { exact: true }).count(), 0);
}, 'late-status');

await browser.close();
console.log(`QA result: ${failures} failed checks`);
process.exitCode = failures ? 1 : 0;
