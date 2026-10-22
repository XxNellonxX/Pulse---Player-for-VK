// Full React App with isolated native IPC fixtures; no VK account or real audio.
// Start Vite, then: node qa/catalog-ui.mjs http://127.0.0.1:5173
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ channel: process.env.PULSE_BROWSER_CHANNEL || 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1360, height: 940 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => {
  const summary = (id, name, country) => ({ id, name, sortName: name, disambiguation: country === 'RU' ? 'Советская рок-группа' : 'Одноимённый исполнитель', kind: country === 'RU' ? 'Group' : 'Person', country });
  const first = summary('artist-a', 'Кино', 'RU'), second = summary('artist-b', 'Кино', 'US');
  const mock = window.__catalogUi = {
    searches: [], artists: [], links: [], routeReads: 0, holdSearch: false, holdArtist: false, listeners: new Set(), follows: [],
    watch: { artists: [{ artist: first, followed: false, openedAt: 1 }, { artist: second, followed: false, openedAt: 1 }], updates: [], refreshing: false, revision: 0 },
    state: { version: 1, tracks: [], playlists: [], history: [], queue: [], currentTrackId: null, position: 0, settings: {} },
    searchResult: (offset = 0) => ({ artists: offset ? [summary('artist-c', 'Kino', 'DE')] : [first, second], offset, hasMore: !offset, stale: false, fetchedAt: Date.UTC(2026, 9, 22) }),
    artistResult: (id, offset = 0) => ({
      artist: { ...(id === 'artist-a' ? first : second), links: [{ label: 'Сайт артиста', url: 'https://example.org/artist' }, { label: 'Unsafe link', url: 'javascript:alert(1)' }], tags: ['rock', 'new wave'] },
      releases: id === 'artist-b' ? [] : offset ? [{ id: 'last', title: 'Последняя запись', firstReleaseDate: '1990-01-01', primaryType: 'Single', secondaryTypes: [] }] : [
        { id: 'album', title: 'Группа крови', firstReleaseDate: '1988', primaryType: 'Album', secondaryTypes: [] },
        { id: 'ep', title: 'Архив', firstReleaseDate: '2099-07', primaryType: 'EP', secondaryTypes: ['Live'] },
        { id: 'single', title: 'Сингл без даты', primaryType: 'Single', secondaryTypes: [] },
        { id: 'other', title: 'Остальные записи', primaryType: 'Other', secondaryTypes: ['Compilation'] },
      ], offset, hasMore: id === 'artist-a' && !offset, stale: id === 'artist-a', fetchedAt: Date.UTC(2026, 9, 22),
    }),
  };
  const off = () => () => {};
  window.desktop = {
    getState: async () => mock.state, saveState: async state => { mock.state = state; },
    getVkStatus: async () => ({ state: 'disconnected', message: '', capabilities: [] }),
    onCommand: off, onVkUpdate: off, onVkPlayback: off, onAppNotice: off, onImportProgress: off, onCloseRequest: off,
    getVersion: async () => '0.5.0-preview.1',
    checkAppRelease: async () => ({ currentVersion: '0.5.0-preview.1', latestVersion: '0.4.3', available: false, notes: '', releaseUrl: null, downloadUrl: null }),
    searchCatalogArtists: async (query, offset = 0) => {
      mock.searches.push({ query, offset });
      if (mock.holdSearch) return new Promise(resolve => { mock.finishSearch = resolve; });
      return mock.searchResult(offset);
    },
    getCatalogArtist: async (id, offset = 0) => {
      mock.artists.push({ id, offset });
      if (mock.holdArtist) return new Promise(resolve => { mock.finishArtist = resolve; });
      return mock.artistResult(id, offset);
    },
    openExternal: async url => { mock.links.push(url); },
    statusCatalogRoute: async () => { mock.routeReads++; throw new Error('Public catalog must never read proxy configuration'); },
    catalogWatchStatus: async () => mock.watch,
    onCatalogUpdate: callback => { mock.listeners.add(callback); return () => mock.listeners.delete(callback); },
    setCatalogFollowed: async (id, followed) => { mock.follows.push({ id, followed }); mock.watch = { ...mock.watch, revision: mock.watch.revision + 1, artists: mock.watch.artists.map(item => item.artist.id === id ? { ...item, followed } : item), updates: followed ? mock.watch.updates : mock.watch.updates.filter(item => item.artist.id !== id) }; for (const callback of mock.listeners) callback(mock.watch); return mock.watch; },
    refreshCatalog: async () => mock.watch,
    cancelCatalogRefresh: async () => mock.watch,
  };
});

try {
  await page.goto(process.argv[2] || 'http://127.0.0.1:5173');
  await page.getByRole('button', { name: 'Каталог артистов', exact: true }).click();
  const view = page.getByRole('region', { name: 'Каталог артистов', exact: true });
  await view.getByRole('heading', { name: 'Каталог артистов', exact: true }).waitFor();
  await page.getByText('VK не подключён', { exact: true }).waitFor();
  const search = async query => {
    await view.getByLabel('Имя артиста в каталоге', { exact: true }).fill(query);
    await view.getByRole('button', { name: 'Найти артиста', exact: true }).click();
  };
  await search('Кино');
  await view.getByText('Советская рок-группа', { exact: true }).waitFor();
  assert.equal(await view.locator('.catalog-artist-card').count(), 2, 'Same-name artists must remain separately selectable');
  let pagination = view.getByRole('navigation', { name: 'Страницы артистов', exact: true });
  await pagination.getByRole('button', { name: 'Далее', exact: true }).click();
  await view.getByText('Kino', { exact: true }).waitFor();
  assert.equal(await view.locator('.catalog-artist-card').count(), 1, 'Pages replace rendered records');
  await pagination.getByRole('button', { name: 'Назад', exact: true }).click();
  await view.getByText('Советская рок-группа', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__catalogUi.searches), [{ query: 'Кино', offset: 0 }, { query: 'Кино', offset: 2 }, { query: 'Кино', offset: 0 }]);
  await view.locator('.catalog-artist-card').first().click();
  await view.getByRole('heading', { name: 'Кино', exact: true }).waitFor();
  for (const label of ['Альбомы', 'EP', 'Синглы', 'Другие релизы']) await view.getByRole('heading', { name: label, exact: true }).waitFor();
  await view.getByText(/Показана сохранённая копия/).waitFor();
  await view.getByText('Будущая дата в каталоге', { exact: true }).waitFor();
  await view.getByText('Дата не указана', { exact: true }).first().waitFor();
  assert.equal(await view.getByRole('button', { name: /Воспроизвести|Слушать/ }).count(), 0, 'Metadata-only catalog must not invent audio');
  assert.equal(await view.getByRole('button', { name: 'Unsafe link', exact: true }).count(), 0);
  await view.getByRole('button', { name: 'Сайт артиста', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.__catalogUi.links), ['https://example.org/artist']);
  await mkdir('tmp', { recursive: true });
  await page.screenshot({ path: 'tmp/catalog-app-1360.png' });
  await page.setViewportSize({ width: 960, height: 800 });
  await page.screenshot({ path: 'tmp/catalog-app-960.png' });
  const overflow = await page.evaluate(() => ({ body: document.body.scrollWidth > innerWidth, content: document.querySelector('.content-scroll').scrollWidth > document.querySelector('.content-scroll').clientWidth + 1 }));
  assert.deepEqual(overflow, { body: false, content: false }, '960px minimum window must not have horizontal overflow');
  await page.setViewportSize({ width: 1360, height: 940 });
  pagination = view.getByRole('navigation', { name: 'Страницы релизов', exact: true });
  await pagination.getByRole('button', { name: 'Далее', exact: true }).click();
  await view.getByRole('heading', { name: 'Последняя запись', exact: true }).waitFor();
  assert.equal(await view.locator('.catalog-release').count(), 1);
  await pagination.getByRole('button', { name: 'Назад', exact: true }).click();
  await view.getByRole('heading', { name: 'Группа крови', exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__catalogUi.artists.map(item => item.offset)), [0, 4, 0]);
  await view.getByRole('button', { name: 'К результатам поиска', exact: true }).click();
  await page.evaluate(() => { window.__catalogUi.holdArtist = true; });
  await view.locator('.catalog-artist-card').first().click();
  await page.waitForFunction(() => Boolean(window.__catalogUi.finishArtist));
  await view.getByRole('button', { name: 'К результатам поиска', exact: true }).click();
  await page.evaluate(() => { window.__catalogUi.holdArtist = false; });
  await view.locator('.catalog-artist-card').nth(1).click();
  await view.getByRole('heading', { name: 'Релизы не указаны', exact: true }).waitFor();
  await page.evaluate(() => window.__catalogUi.finishArtist(window.__catalogUi.artistResult('artist-a')));
  assert.equal(await view.getByRole('heading', { name: 'Группа крови', exact: true }).count(), 0);
  await view.getByText('Одноимённый исполнитель', { exact: true }).waitFor();
  await page.evaluate(() => { window.__catalogUi.holdSearch = true; });
  await search('Старый запрос');
  await page.waitForFunction(() => Boolean(window.__catalogUi.finishSearch));
  await page.evaluate(() => { window.__catalogUi.holdSearch = false; });
  await search('Новый запрос');
  await view.getByText('Запрос: Новый запрос', { exact: true }).waitFor();
  await page.evaluate(() => window.__catalogUi.finishSearch({ artists: [], offset: 0, hasMore: false, stale: false, fetchedAt: Date.now() }));
  assert.equal(await view.locator('.catalog-artist-card').count(), 2, 'Late old response must not clear a newer search');
  await view.locator('.catalog-artist-card').first().click();
  await view.getByRole('heading', { name: 'Группа крови', exact: true }).waitFor();
  await view.locator('.catalog-release').first().getByRole('button', { name: 'Найти в VK', exact: true }).click();
  assert.equal(await page.locator('#global-search').inputValue(), 'Кино Группа крови');
  assert.equal(await page.getByRole('button', { name: 'Вся музыка VK', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.catalog-view').count(), 0, 'Release search must navigate into the real global VK search');
  await page.locator('.history-buttons').getByRole('button', { name: 'Назад', exact: true }).click();
  await view.getByRole('heading', { name: 'Группа крови', exact: true }).waitFor();
  assert.equal(await view.getByLabel('Имя артиста в каталоге', { exact: true }).inputValue(), 'Новый запрос');
  await page.locator('.history-buttons').getByRole('button', { name: 'Назад', exact: true }).click();
  await view.getByText('Запрос: Новый запрос', { exact: true }).waitFor();
  assert.equal(await view.locator('.catalog-artist-card').count(), 2, 'History restores the submitted search after leaving an artist');
  await page.locator('.history-buttons').getByRole('button', { name: 'Вперёд', exact: true }).click();
  await view.getByRole('heading', { name: 'Группа крови', exact: true }).waitFor();
  await page.locator('.history-buttons').getByRole('button', { name: 'Вперёд', exact: true }).click();
  assert.equal(await page.locator('#global-search').inputValue(), 'Кино Группа крови');
  await page.locator('.history-buttons').getByRole('button', { name: 'Назад', exact: true }).click();
  await view.getByRole('heading', { name: 'Группа крови', exact: true }).waitFor();
  await view.getByRole('button', { name: 'К результатам поиска', exact: true }).click();
  await view.getByText('Запрос: Новый запрос', { exact: true }).waitFor();
  assert.equal(await view.locator('.catalog-route-settings').count(), 0, 'Public catalog must not expose technical proxy settings');
  assert.equal(await page.evaluate(() => window.__catalogUi.routeReads), 0, 'Catalog searches must not depend on a route configuration IPC');
  await view.locator('.catalog-artist-card').first().click();
  await view.getByRole('button', { name: 'Следить за релизами', exact: true }).click();
  await view.getByRole('button', { name: 'Вы следите', exact: true }).waitFor();
  await view.getByRole('button', { name: 'Обновления', exact: true }).click();
  await view.getByRole('heading', { name: 'Пока без обнаруженных записей', exact: true }).waitFor();
  await page.evaluate(() => { const mock = window.__catalogUi; mock.watch = { ...mock.watch, revision: mock.watch.revision + 1, updates: [{ artist: mock.watch.artists[0].artist, release: { id: 'discovery-1', title: 'Новая запись в каталоге', firstReleaseDate: '2099', primaryType: 'Single', secondaryTypes: [] }, discoveredAt: Date.now() }] }; for (const callback of mock.listeners) callback(mock.watch); });
  await view.getByRole('heading', { name: 'Новая запись в каталоге', exact: true }).waitFor();
  await view.getByText('Будущая дата в каталоге', { exact: true }).waitFor();
  await page.setViewportSize({ width: 960, height: 800 });
  await view.locator('.catalog-updates').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'tmp/catalog-updates-960.png' });
  assert.equal(await page.evaluate(() => document.querySelector('.content-scroll').scrollWidth > document.querySelector('.content-scroll').clientWidth + 1), false);
  await page.setViewportSize({ width: 1360, height: 940 });
  await view.getByRole('button', { name: 'Кино', exact: true }).first().click();
  await view.getByRole('button', { name: 'Вы следите', exact: true }).click();
  await view.getByRole('button', { name: 'Следить за релизами', exact: true }).waitFor();
  await view.getByRole('button', { name: 'Обновления', exact: true }).click();
  await view.getByRole('heading', { name: 'Выберите своих артистов', exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__catalogUi.follows), [{ id: 'artist-a', followed: true }, { id: 'artist-a', followed: false }]);
  assert.equal(await view.locator('.catalog-release').count(), 0, 'Unfollow removes that artist from metadata discovery notifications');
  assert.deepEqual(errors, []);
  console.log('PASS: full App MusicBrainz nav, guest Unicode search, artist identity, pagination, stale/future labels, safe links, 960px layout, late results, VK search integration, back/forward route restoration, public UI without proxy configuration, local follow/unfollow, live metadata discoveries and 960px updates layout.');
} finally { await browser.close(); }
