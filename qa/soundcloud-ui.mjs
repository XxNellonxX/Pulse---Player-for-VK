// Real React App, isolated browser profile, mocked native IPC. No user accounts.
// Run a Vite dev server, then: node qa/soundcloud-ui.mjs http://127.0.0.1:5173
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ channel: process.env.PULSE_BROWSER_CHANNEL || 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1360, height: 940 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => {
  const track = { id: 'vk-101-1', title: 'Song', artist: 'Artist', album: 'Album', version: 'Live', duration: 180, source: 'vk', url: 'vk-web://101/1', available: true, addedAt: 1, artistCard: 'absent', remote: { ownerId: 101, audioId: 1, inLibrary: true } };
  const mock = window.__soundcloudUi = {
    configured: false, binding: null, saves: [], searches: [], binds: [], links: [], resolves: [], holdResolve: false,
    state: { version: 1, tracks: [track], playlists: [], history: [], queue: [], currentTrackId: null, position: 0, settings: { preferSoundCloud: true, preferExplicit: true } },
    candidate: { id: 'soundcloud:tracks:123', title: 'Song (Live)', artist: 'Artist', duration: 180, explicit: true, streamable: true },
    linkedCandidate: { id: 'soundcloud:tracks:456', title: 'Song (Acoustic)', artist: 'Artist', duration: 180, streamable: true },
  };
  const off = () => () => {};
  window.desktop = {
    getState: async () => mock.state, saveState: async value => { mock.state = value; },
    getVkStatus: async () => ({ state: 'connected', message: 'Fixture', mode: 'web', user: { id: 101, name: 'QA account' }, capabilities: [] }),
    onCommand: off, onVkUpdate: off, onVkPlayback: off, onAppNotice: off, onImportProgress: off, onCloseRequest: off,
    getVersion: async () => '0.4.3',
    checkAppRelease: async () => ({ currentVersion: '0.4.3', latestVersion: '0.4.3', available: false, notes: '', releaseUrl: null, downloadUrl: null }),
    soundCloudStatus: async () => ({ configured: mock.configured, proxy: false, message: mock.configured ? 'Ключи сохранены' : 'Требуются ключи приложения' }),
    configureSoundCloud: async input => { mock.saves.push(input); mock.configured = true; },
    soundCloudBinding: async () => mock.binding,
    searchSoundCloud: async query => { mock.searches.push(query); return { collection: [mock.candidate] }; },
    resolveSoundCloudCandidate: async url => {
      mock.resolves.push(url);
      if (mock.holdResolve) return new Promise(resolve => { mock.finishResolve = resolve; });
      return mock.linkedCandidate;
    },
    bindSoundCloud: async (trackId, sourceId) => {
      mock.binds.push({ trackId, sourceId });
      mock.binding = [mock.candidate, mock.linkedCandidate].find(item => item.id === sourceId) || null;
    },
    resolveVkTrack: async () => track, vkWebControl: async () => ({ accepted: true }), resolveSoundCloud: async () => null, releaseSoundCloud: async () => {},
    openExternal: async url => { mock.links.push(url); },
  };
});

try {
  await page.goto(process.argv[2] || 'http://127.0.0.1:5173');
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('button', { name: 'Источники музыки', exact: true }).click();
  await page.getByText('Если у вас обычный аккаунт SoundCloud', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Открыть кабинет приложений', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.__soundcloudUi.links), ['https://soundcloud.com/you/apps']);
  await page.getByText(/платная подписка не гарантирует/).waitFor();
  await page.getByLabel('Client ID', { exact: true }).fill('fixture-app-id');
  await page.getByLabel('Client Secret', { exact: true }).fill('fixture-app-secret');
  await page.getByRole('button', { name: 'Сохранить подключение', exact: true }).click();
  await page.getByText('Настройки сохранены', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Client Secret', { exact: true }).inputValue(), '');
  assert.equal((await page.locator('body').innerText()).includes('fixture-app-secret'), false);

  await page.getByRole('button', { name: 'Моя музыка', exact: true }).click();
  const openInfo = async () => {
    await page.getByRole('button', { name: 'Дополнительные действия', exact: true }).click();
    await page.getByRole('button', { name: 'Информация о треке', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Song', exact: true });
    await modal.waitFor();
    return modal;
  };
  let modal = await openInfo();
  await modal.getByRole('button', { name: 'Найти в SoundCloud', exact: true }).click();
  await modal.getByRole('button', { name: 'Выбрать', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__soundcloudUi.binds.length), 0, 'Search must not confirm a binding');
  await modal.getByRole('button', { name: 'Использовать запись', exact: true }).click();
  await modal.getByText('Источник сохранён для этого трека.', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__soundcloudUi.binds[0]), { trackId: 'vk-101-1', sourceId: 'soundcloud:tracks:123' });
  assert.deepEqual(await page.evaluate(() => window.__soundcloudUi.searches), ['Artist Song Live']);
  await modal.getByRole('button', { name: 'Убрать источник SoundCloud', exact: true }).click();
  await modal.getByText('Привязка удалена.', { exact: true }).waitFor();

  await modal.getByRole('button', { name: 'По ссылке', exact: true }).click();
  await modal.getByLabel('Ссылка на трек SoundCloud', { exact: true }).fill('https://example.org/not-a-song');
  await modal.getByRole('button', { name: 'Проверить ссылку', exact: true }).click();
  await modal.getByText('Вставьте HTTPS-ссылку на трек SoundCloud.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__soundcloudUi.resolves.length), 0);
  await modal.getByLabel('Ссылка на трек SoundCloud', { exact: true }).fill('https://soundcloud.com/opaque-a/opaque-b');
  await modal.getByRole('button', { name: 'Проверить ссылку', exact: true }).click();
  await modal.getByText('Song (Acoustic)', { exact: true }).waitFor();
  assert.equal(await modal.getByText('opaque-b', { exact: true }).count(), 0, 'Never derive metadata from URL text');
  assert.equal(await page.evaluate(() => window.__soundcloudUi.binds.length), 2, 'URL resolution must not write a binding');
  await modal.getByRole('button', { name: 'Выбрать', exact: true }).click();
  await modal.getByText(/Обозначение версии отличается/).waitFor();
  await modal.getByRole('button', { name: 'Использовать запись', exact: true }).click();
  await modal.getByText('Источник сохранён для этого трека.', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__soundcloudUi.binds[2]), { trackId: 'vk-101-1', sourceId: 'soundcloud:tracks:456' });
  await modal.getByRole('button', { name: 'Убрать источник SoundCloud', exact: true }).click();
  await modal.getByText('Привязка удалена.', { exact: true }).waitFor();

  await page.evaluate(() => { window.__soundcloudUi.holdResolve = true; });
  await modal.getByRole('button', { name: 'Проверить ссылку', exact: true }).click();
  await page.waitForFunction(() => Boolean(window.__soundcloudUi.finishResolve));
  await modal.getByRole('button', { name: 'Закрыть информацию о треке', exact: true }).click();
  modal = await openInfo();
  await page.evaluate(() => window.__soundcloudUi.finishResolve(window.__soundcloudUi.linkedCandidate));
  await modal.getByRole('button', { name: 'Найти в SoundCloud', exact: true }).waitFor();
  assert.equal(await modal.getByText('Song (Acoustic)', { exact: true }).count(), 0, 'Old URL response must not populate a reopened dialog');
  await modal.getByRole('button', { name: 'Закрыть информацию о треке', exact: true }).click();
  await page.evaluate(() => { window.__soundcloudUi.configured = false; });
  modal = await openInfo();
  await modal.getByText('Если у вас обычный аккаунт SoundCloud', { exact: true }).waitFor();
  assert.equal(await modal.getByRole('button', { name: 'Найти в SoundCloud', exact: true }).isDisabled(), true);
  await modal.getByRole('button', { name: 'По ссылке', exact: true }).click();
  await modal.getByLabel('Ссылка на трек SoundCloud', { exact: true }).fill('https://soundcloud.com/artist/song');
  assert.equal(await modal.getByRole('button', { name: 'Проверить ссылку', exact: true }).isDisabled(), true, 'Missing API setup must not produce an endless resolve attempt');
  assert.deepEqual(errors, []);
  console.log('PASS: real App settings and account guidance, masked credentials, search, URL entity resolution, version warning, explicit confirm/unlink, late URL response cancellation.');
} finally {
  await browser.close();
}
