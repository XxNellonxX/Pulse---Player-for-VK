import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const baseURL = process.env.QA_BASE_URL || 'http://127.0.0.1:5173';
const settings = { theme: 'dark', style: 'minimal', accent: '#bdff62', density: 'comfortable', textScale: 1, reducedMotion: false, volume: .01, repeat: 'off', shuffle: false, closeToTray: false, autoplay: false, autoSkip: false };
const remote = { id: 'vk-101-1', title: 'Remote safe', artist: 'QA', album: '', duration: 12, url: 'https://example.invalid/audio.mp3', source: 'vk', addedAt: 2, available: true, remote: { ownerId: 101, audioId: 1, inLibrary: true } };
const playlist = { id: 'vk-playlist-101-9', title: 'Server title', trackIds: [remote.id], createdAt: 1, remote: { ownerId: 101, playlistId: 9 }, description: 'server description', artwork: 'https://vk.com/art.jpg', syncedAt: 1 };
const state = { version: 1, tracks: [remote], playlists: [playlist], history: [], queue: [remote.id], currentTrackId: null, position: 0, settings };
const status = { state: 'connected', message: '', user: { id: 101, name: 'QA account' }, capabilities: [{ id: 'library', label: 'Моя музыка', status: 'verified', detail: '' }, { id: 'playlists', label: 'Плейлисты VK', status: 'verified', detail: '' }] };
let failures = 0;
async function run(name, fn, mode) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(({ state, status, mode }) => {
    window.__qaCalls = [];
    window.__qaSaved = [];
    const result = { ...state, tracks: state.tracks.map(x => ({ ...x, remote: x.remote && { ...x.remote } })), playlists: state.playlists.map(x => ({ ...x, remote: x.remote && { ...x.remote }, trackIds: [...x.trackIds] })) };
    window.desktop = {
      getState: async () => result,
      saveState: async value => { window.__qaSaved.push(JSON.parse(JSON.stringify(value))); },
      getVkStatus: async () => status,
      connectVk: async () => status,
      disconnectVk: async () => ({ ...status, state: 'disconnected' }),
      refreshVk: async () => ({ complete: true, syncedAt: 2, status, tracks: state.tracks, playlists: state.playlists }),
      searchVk: async () => [], resolveVkTrack: async () => state.tracks[0],
      importFiles: async () => [], removeTrack: async () => {}, openExternal: async () => {}, openVkMusic: async () => {},
      addVkTrack: async () => ({ complete: true, syncedAt: 2, status, tracks: state.tracks, playlists: state.playlists }),
      deleteVkTrack: async () => ({ complete: true, syncedAt: 2, status, tracks: [], playlists: state.playlists }),
      vkPlaylistChange: async input => {
        window.__qaCalls.push(input);
        if (mode === 'false-confirmation') return { complete: true, mutationConfirmed: false, syncedAt: 2, status, tracks: state.tracks, playlists: state.playlists };
        if (mode === 'missing-confirmation') return { complete: true, syncedAt: 2, status, tracks: state.tracks, playlists: state.playlists };
        return { complete: false, error: 'read-back failed', status: { ...status, message: 'read-back failed' }, tracks: [], playlists: [] };
      },
      getVersion: async () => 'qa', exportDiagnostics: async () => null, onCommand: () => () => {},
    };
  }, { state, status, mode });
  try {
    await page.goto(baseURL);
    await page.locator('.app-shell').waitFor();
    await page.waitForTimeout(120);
    await page.getByRole('button', { name: 'Плейлисты', exact: true }).click();
    await page.locator('.playlist-card').filter({ hasText: 'Server title' }).click();
    await page.getByRole('button', { name: 'Переименовать', exact: true }).click();
    await page.getByPlaceholder('Например, Вечерний драйв').fill('New title');
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.waitForTimeout(120);
    await fn(page);
    console.log(`PASS ${name}`);
  } catch (error) { failures++; console.log(`FAIL ${name}: ${error.message}`); }
  finally { await context.close(); }
}

await run('mutation-with-explicit-false-confirmation-is-not-success', async page => {
  assert.match(await page.locator('.toast').innerText(), /read-back|не подтверд/i, 'mutationConfirmed=false produced a success toast');
}, 'false-confirmation');

await run('mutation-without-confirmation-is-not-treated-as-success', async page => {
  assert.match(await page.locator('.toast').innerText(), /read-back|не подтверд/i, 'missing mutation confirmation produced a success toast');
}, 'missing-confirmation');

await run('incomplete-mutation-keeps-server-playlist-metadata', async page => {
  assert.match(await page.locator('.page-heading h1').innerText(), /Server title/);
  await page.waitForTimeout(450);
  const saved = await page.evaluate(() => window.__qaSaved.at(-1));
  assert.equal(saved.playlists[0].remote.ownerId, 101);
  assert.equal(saved.playlists[0].description, 'server description');
  assert.equal(saved.playlists[0].artwork, 'https://vk.com/art.jpg');
  assert.deepEqual(saved.playlists[0].trackIds, ['vk-101-1']);
}, 'incomplete');

await browser.close();
console.log(`QA result: ${failures} failed checks`);
process.exitCode = failures ? 1 : 0;
