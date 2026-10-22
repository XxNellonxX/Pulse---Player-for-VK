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
    searches: [], artists: [], links: [], routes: [], proxy: false, holdSearch: false, holdArtist: false,
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
    statusCatalogRoute: async () => ({ proxy: mock.proxy, available: true, message: mock.proxy ? 'Прокси каталога настроен.' : 'Каталог подключается напрямую.' }),
    configureCatalogRoute: async proxy => { mock.routes.push(proxy); mock.proxy = Boolean(proxy); },
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
  await page.evaluate(() => { window.__catalogUi.holdSearch = true; window.__catalogUi.finishSearch = null; });
  await search('Запрос до смены маршрута');
  await page.waitForFunction(() => Boolean(window.__catalogUi.finishSearch));
  await view.locator('.catalog-route-settings > summary').click();
  await view.getByText('Ключи SoundCloud не нужны.', { exact: false }).waitFor();
  const proxyInput = view.getByLabel('Прокси для MusicBrainz', { exact: true });
  await proxyInput.fill('http://fixture-user:fixture-secret@proxy.example:8080');
  assert.equal(await proxyInput.getAttribute('type'), 'password');
  await view.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await view.getByText('Подключение сохранено. Повторите поиск, чтобы проверить выбранный маршрут.', { exact: true }).waitFor();
  assert.equal(await proxyInput.inputValue(), '', 'Proxy credentials must clear after submission');
  assert.equal((await page.locator('body').innerText()).includes('fixture-secret'), false, 'Saved secret must not be displayed');
  assert.deepEqual(await page.evaluate(() => window.__catalogUi.routes), ['http://fixture-user:fixture-secret@proxy.example:8080']);
  await page.evaluate(() => window.__catalogUi.finishSearch(window.__catalogUi.searchResult()));
  assert.equal(await view.locator('.catalog-artist-card').count(), 0, 'Changing the route must discard a pending old-route response');
  await view.getByRole('button', { name: 'Подключаться напрямую', exact: true }).click();
  await view.getByText('Каталог подключается напрямую.', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__catalogUi.routes), ['http://fixture-user:fixture-secret@proxy.example:8080', '']);
  assert.equal(await page.getByText('VK не подключён', { exact: true }).count(), 1, 'Catalog route must work without VK or SoundCloud API credentials');
  assert.deepEqual(errors, []);
  console.log('PASS: full App MusicBrainz nav, guest Unicode search, artist identity, pagination, stale/future labels, safe links, 960px layout, late results, VK search integration, back/forward route restoration, masked catalog-only proxy settings and old-route cancellation without provider API keys.');
} finally { await browser.close(); }
