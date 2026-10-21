import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// Independent renderer probes with separate contexts and controllable native
// promises. No VK account, network upload, or real user's profile is touched.
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const baseURL = process.env.QA_BASE_URL || 'http://127.0.0.1:5173';
const settings = { theme: 'dark', style: 'minimal', accent: '#bdff62', density: 'comfortable', textScale: 1, reducedMotion: true, volume: .01, repeat: 'off', shuffle: false, closeToTray: false, autoplay: false, autoSkip: false };
const local = { id: 'local-existing', title: 'Existing local', artist: 'QA', album: '', duration: 12, url: '', source: 'local', addedAt: 1, available: true };
const remote = { id: 'vk-101-1', title: 'Existing remote', artist: 'QA', album: '', duration: 12, url: 'vk-web://101/1', source: 'vk', addedAt: 2, available: true, remote: { ownerId: 101, audioId: 1, inLibrary: true } };
const uploaded = { ...remote, id: 'vk-101-2', title: 'Confirmed upload', url: 'vk-web://101/2', remote: { ownerId: 101, audioId: 2, inLibrary: true } };
const status = { state: 'connected', mode: 'web', message: '', user: { id: 101, name: 'Upload account A' }, capabilities: [{ id: 'upload', label: 'Upload', status: 'verified', detail: '' }] };
const state = { version: 1, tracks: [local, remote], playlists: [], history: [], queue: [], currentTrackId: null, position: 0, settings };
let failures = 0;

async function run(name, fn, mode = 'connected') {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.addInitScript(({ state, status, mode }) => {
    let currentStatus = mode === 'disconnected' ? { ...status, state: 'disconnected', user: undefined } : status;
    let nativeState = structuredClone(state);
    window.__uploadCalls = [];
    window.__uploadSaved = [];
    window.__uploadPending = [];
    window.__uploadRefreshCalls = 0;
    const pending = (method, input) => {
      window.__uploadCalls.push({ method, input });
      return new Promise((resolve, reject) => window.__uploadPending.push({ resolve, reject }));
    };
    window.__uploadReply = result => window.__uploadPending.shift().resolve(result);
    window.__uploadReject = error => window.__uploadPending.shift().reject(error);
    window.__uploadPublish = (tracks, nextStatus = currentStatus, clearRemote = false) => {
      currentStatus = nextStatus;
      nativeState = { ...nativeState, tracks: [...nativeState.tracks.filter(track => track.source === 'local'), ...tracks] };
      window.__uploadUpdate?.({ complete: true, mode: 'web', syncedAt: Date.now(), status: currentStatus, tracks, playlists: [], clearRemote });
    };
    window.desktop = {
      getState: async () => nativeState,
      saveState: async value => { window.__uploadSaved.push(structuredClone(value)); },
      getVkStatus: async () => currentStatus,
      connectVk: async () => currentStatus,
      disconnectVk: async () => { currentStatus = { ...currentStatus, state: 'disconnected', user: undefined }; nativeState.tracks = nativeState.tracks.filter(track => track.source === 'local'); return currentStatus; },
      refreshVk: async () => { window.__uploadRefreshCalls++; return { complete: true, mode: 'web', syncedAt: Date.now(), status: currentStatus, tracks: nativeState.tracks.filter(track => track.source === 'vk'), playlists: [] }; },
      importFiles: async () => { window.__uploadCalls.push({ method: 'local' }); return []; },
      uploadFilesToVk: async () => pending('files'),
      importFromUrl: async (url, destination) => pending('url', { url, destination }),
      onImportProgress: callback => { window.__uploadProgress = callback; return () => { delete window.__uploadProgress; }; },
      onVkUpdate: callback => { window.__uploadUpdate = callback; return () => { delete window.__uploadUpdate; }; },
      onCommand: callback => { window.__uploadCommand = callback; return () => { delete window.__uploadCommand; }; },
      searchVk: async () => [], removeTrack: async () => {}, openVkMusic: async () => {}, getVersion: async () => 'upload-independent-qa',
    };
  }, { state, status, mode });
  try {
    await page.goto(baseURL);
    await page.locator('.app-shell').waitFor();
    await page.waitForFunction(() => !!window.__uploadUpdate && !!window.__uploadCommand);
    await page.waitForTimeout(80);
    await fn(page);
    console.log(`PASS ${name}`);
  } catch (error) { failures++; console.log(`FAIL ${name}: ${error.stack}`); }
  finally { await context.close(); }
}
const report = page => page.getByRole('status', { name: 'Результаты загрузки' });
const titles = page => page.locator('.track-meta strong').allTextContents();
const uploadPage = page => page.getByRole('button', { name: 'Загрузить в VK', exact: true }).click();
const startFiles = async page => { await page.getByRole('button', { name: 'Добавить в VK', exact: true }).click(); await page.waitForFunction(() => window.__uploadPending.length === 1); };
const reply = async (page, value) => { await page.evaluate(value => window.__uploadReply(value), value); await report(page).waitFor(); };
const backToLibrary = page => page.getByRole('button', { name: 'Моя музыка', exact: true }).click();

await run('main-add-files-uses-vk-upload-and-cancel-has-no-success', async page => {
  await startFiles(page);
  assert.deepEqual(await page.evaluate(() => window.__uploadCalls.map(call => call.method)), ['files']);
  await reply(page, { cancelled: true, items: [] });
  assert.match(await report(page).innerText(), /отмен/);
  assert.equal(await report(page).locator('.import-result-uploaded').count(), 0);
  await backToLibrary(page);
  assert.deepEqual(await titles(page), ['Existing remote', 'Existing local']);
});

await run('bridge-rejection-is-persistent-and-does-not-create-track', async page => {
  await startFiles(page);
  await page.evaluate(() => window.__uploadReject('QA upload denied'));
  await report(page).waitFor();
  assert.match(await report(page).innerText(), /QA upload denied/);
  assert.equal(await report(page).locator('.import-result-failed').count(), 1);
  await page.waitForTimeout(3600);
  assert.equal(await report(page).count(), 1, 'error vanished with the transient toast');
  await backToLibrary(page);
  assert.deepEqual(await titles(page), ['Existing remote', 'Existing local']);
});

await run('partial-batch-preserves-every-status-and-only-authoritative-remote-data', async page => {
  await startFiles(page);
  await page.evaluate(({ remote, uploaded }) => window.__uploadPublish([uploaded, remote]), { remote, uploaded });
  await reply(page, { accountId: 101, cancelled: false, items: [
    { name: 'good.mp3', status: 'uploaded', message: 'VK confirmed.', trackId: uploaded.id },
    { name: 'bad.mp3', status: 'failed', message: 'Corrupt MP3.' },
    { name: 'pending.mp3', status: 'uncertain', message: 'Read-back unavailable. Check VK before retry.' },
    { name: 'duplicate.mp3', status: 'skipped', message: 'Already uploaded.' },
  ] });
  for (const outcome of ['uploaded', 'failed', 'uncertain', 'skipped']) assert.equal(await report(page).locator(`.import-result-${outcome}`).count(), 1);
  await backToLibrary(page);
  assert.deepEqual(await titles(page), ['Confirmed upload', 'Existing remote', 'Existing local']);
});

await run('local-track-returned-from-vk-upload-is-never-presented-as-remote', async page => {
  await startFiles(page);
  await reply(page, { accountId: 101, cancelled: false, items: [{ name: 'QA rogue local.mp3', status: 'uploaded', message: 'Remote confirmed.', track: { ...local, id: 'rogue-local', title: 'Unconfirmed rogue local' } }] });
  await backToLibrary(page);
  assert.deepEqual(await titles(page), ['Existing remote', 'Existing local']);
});

await run('duplicate-click-and-tray-event-cannot-start-a-second-job', async page => {
  await startFiles(page);
  await page.evaluate(() => { window.__uploadCommand('import'); window.__uploadCommand('import'); });
  assert.equal(await page.getByRole('button', { name: 'Выбрать MP3 и загрузить', exact: true }).isDisabled(), true);
  await page.locator('.main-nav button').filter({ hasText: 'Локальные файлы' }).click();
  await page.evaluate(() => window.__uploadCommand('import'));
  assert.deepEqual(await page.evaluate(() => window.__uploadCalls.map(call => call.method)), ['files']);
  await page.evaluate(() => window.__uploadReply({ cancelled: true, items: [] }));
  await uploadPage(page);
  await report(page).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Выбрать MP3 и загрузить', exact: true }).isEnabled(), true);
});

await run('explicit-local-page-keeps-local-import-path', async page => {
  await page.locator('.main-nav button').filter({ hasText: 'Локальные файлы' }).click();
  await page.getByRole('button', { name: 'Добавить файлы', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.__uploadCalls.map(call => call.method)), ['local']);
});

await run('url-default-destination-is-vk-and-failure-never-imports-local-fallback', async page => {
  await uploadPage(page);
  await page.getByRole('textbox', { name: 'Ссылка на трек', exact: true }).fill('https://soundcloud.com/qa/track');
  await page.getByRole('button', { name: 'Добавить по ссылке', exact: true }).click();
  await page.waitForFunction(() => window.__uploadPending.length === 1);
  assert.deepEqual(await page.evaluate(() => window.__uploadCalls), [{ method: 'url', input: { url: 'https://soundcloud.com/qa/track', destination: 'vk' } }]);
  await reply(page, { accountId: 101, cancelled: false, items: [{ name: 'Track', status: 'failed', message: 'Original download disabled.' }] });
  assert.match(await report(page).innerText(), /Original download disabled/);
  await backToLibrary(page);
  assert.deepEqual(await titles(page), ['Existing remote', 'Existing local']);
});

await run('url-local-destination-retains-original-track-title-and-artist', async page => {
  await uploadPage(page);
  await page.getByRole('textbox', { name: 'Ссылка на трек', exact: true }).fill('https://cdn.example.test/original.mp3');
  await page.getByRole('combobox', { name: 'Куда добавить трек', exact: true }).selectOption('local');
  await page.getByRole('button', { name: 'Добавить по ссылке', exact: true }).click();
  await page.waitForFunction(() => window.__uploadPending.length === 1);
  assert.equal(await page.evaluate(() => window.__uploadCalls[0].input.destination), 'local');
  await reply(page, { cancelled: false, items: [{ name: 'Original.mp3', status: 'local', message: 'Original bytes stored.', track: { ...local, id: 'local-url', title: 'Original ID3 title', artist: 'Original ID3 artist' } }] });
  await page.locator('.main-nav button').filter({ hasText: 'Локальные файлы' }).click();
  const row = page.locator('.track-row').filter({ hasText: 'Original ID3 title' });
  assert.equal(await row.count(), 1);
  assert.match(await row.innerText(), /Original ID3 artist/);
});

await run('logout-during-upload-rejects-late-success-and-does-not-refresh-old-account', async page => {
  await startFiles(page);
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('button', { name: 'Аккаунт VK', exact: true }).click();
  await page.getByRole('button', { name: 'Отключить', exact: true }).click();
  await page.evaluate(({ uploaded }) => window.__uploadReply({ accountId: 101, cancelled: false, items: [{ name: 'Late old-account track.mp3', status: 'uploaded', message: 'Old account mutation confirmed.', track: uploaded }] }), { uploaded });
  await uploadPage(page);
  await report(page).waitFor();
  assert.equal(await report(page).locator('.import-result-uploaded').count(), 0, 'old-account success survived logout');
  assert.match(await report(page).innerText(), /изменил|исходн/);
  assert.equal(await page.evaluate(() => window.__uploadRefreshCalls), 0, 'late upload refreshed after logout');
  await backToLibrary(page);
  assert.deepEqual(await titles(page), ['Existing local']);
});

await run('account-switch-during-upload-rejects-old-account-result', async page => {
  await startFiles(page);
  const otherStatus = { ...status, user: { id: 202, name: 'Upload account B' } };
  const otherTrack = { ...remote, id: 'vk-202-8', title: 'New account library', url: 'vk-web://202/8', remote: { ownerId: 202, audioId: 8, inLibrary: true } };
  await page.evaluate(({ otherTrack, otherStatus }) => window.__uploadPublish([otherTrack], otherStatus, true), { otherTrack, otherStatus });
  await reply(page, { accountId: 101, cancelled: false, items: [{ name: 'Late old-account track.mp3', status: 'uploaded', message: 'Old account confirmed.', track: uploaded }] });
  assert.equal(await report(page).locator('.import-result-uploaded').count(), 0);
  await backToLibrary(page);
  assert.deepEqual(await titles(page), ['New account library', 'Existing local']);
});

await run('url-local-import-is-available-without-vk-connection', async page => {
  await uploadPage(page);
  assert.equal(await page.getByRole('button', { name: 'Выбрать MP3 и загрузить', exact: true }).isDisabled(), true);
  await page.getByRole('textbox', { name: 'Ссылка на трек', exact: true }).fill('https://cdn.example.test/file.mp3');
  assert.equal(await page.getByRole('button', { name: 'Добавить по ссылке', exact: true }).isDisabled(), true);
  await page.getByRole('combobox', { name: 'Куда добавить трек', exact: true }).selectOption('local');
  assert.equal(await page.getByRole('button', { name: 'Добавить по ссылке', exact: true }).isEnabled(), true);
}, 'disconnected');

await browser.close();
console.log(`QA result: ${failures} failed checks`);
process.exitCode = failures ? 1 : 0;
