import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Actual App + history + catalog route form, with isolated metadata IPC only.
const base = process.env.PULSE_QA_URL || 'http://127.0.0.1:5191';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [];
async function run(name, action) {
  const page = await browser.newPage({ viewport: { width: 1360, height: 940 } }); page.setDefaultTimeout(3000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.addInitScript(() => {
      const summary = id => ({ id, name: 'Artist ' + id.toUpperCase(), sortName: id, disambiguation: 'Fixture ' + id, kind: 'Group', country: 'GB' });
      const mock = window.__routeQa = { searches: [], artists: [], configurations: [], holdSearch: false, holdArtist: false, holdConfiguration: false, rejectConfiguration: false, proxy: false, statuses: 0,
        searchResult: (query, offset = 0) => ({ artists: (offset ? ['c'] : ['a', 'b']).map(summary), offset, hasMore: !offset, stale: false, fetchedAt: Date.now() }),
        artistResult: (id, offset = 0) => ({ artist: { ...summary(id), tags: [], links: [] }, releases: (offset ? ['Second page'] : ['First album', 'First single']).map((title, index) => ({ id: id + '-' + offset + '-' + index, title, firstReleaseDate: '2025', primaryType: 'Album', secondaryTypes: [] })), offset, hasMore: !offset, stale: false, fetchedAt: Date.now() }),
        state: { version: 1, tracks: [], playlists: [], queue: [], history: [], currentTrackId: null, position: 0, settings: {} },
      };
      const off = () => () => {};
      window.desktop = {
        getState: async () => mock.state, saveState: async state => { mock.state = state; }, getVkStatus: async () => ({ state: 'disconnected', capabilities: [], message: '' }),
        onCommand: off, onVkUpdate: off, onVkPlayback: off, onAppNotice: off, onImportProgress: off, onCloseRequest: off,
        getVersion: async () => '0.5.0-preview.1', checkAppRelease: async () => ({ currentVersion: '0.5.0-preview.1', latestVersion: null, available: false, notes: '', releaseUrl: null, downloadUrl: null }),
        searchCatalogArtists(query, offset = 0) { mock.searches.push({ query, offset }); if (mock.holdSearch) return new Promise(resolve => { mock.finishSearch = resolve; }); return Promise.resolve(mock.searchResult(query, offset)); },
        getCatalogArtist(id, offset = 0) { mock.artists.push({ id, offset }); if (mock.holdArtist) return new Promise(resolve => { mock.finishArtist = resolve; }); return Promise.resolve(mock.artistResult(id, offset)); },
        statusCatalogRoute: async () => { mock.statuses++; if (mock.holdStatus) return new Promise(resolve => { mock.finishStatus = resolve; }); return { proxy: mock.proxy, message: mock.proxy ? 'Прокси каталога сохранён.' : 'Прямое соединение.' }; },
        configureCatalogRoute(value) { mock.configurations.push(value); if (mock.holdConfiguration) return new Promise((resolve, reject) => { mock.finishConfiguration = () => { mock.proxy = Boolean(value); resolve(); }; mock.failConfiguration = reject; }); if (mock.rejectConfiguration) return Promise.reject('Synthetic route rejected'); mock.proxy = Boolean(value); return Promise.resolve(); },
        openExternal: async () => {},
      };
    });
    await page.goto(base); await page.getByRole('button', { name: 'Каталог артистов', exact: true }).click();
    await action(page); assert.deepEqual(errors, []); results.push({ name, ok: true }); console.log('PASS ' + name);
  } catch (error) { results.push({ name, ok: false, error: error.message }); console.log('FAIL ' + name + ': ' + error.message); console.log('DEBUG ' + JSON.stringify(await page.evaluate(() => ({ query: document.querySelector('[aria-label="Имя артиста в каталоге"]')?.value, searches: window.__routeQa.searches, artists: window.__routeQa.artists, state: history.state })).catch(() => null))); }
  finally { await page.close(); }
}
const view = page => page.getByRole('region', { name: 'Каталог артистов', exact: true });
const search = async page => { await view(page).getByLabel('Имя артиста в каталоге', { exact: true }).fill('Original query'); await view(page).getByRole('button', { name: 'Найти артиста', exact: true }).click(); await view(page).getByText('Artist A', { exact: true }).waitFor(); };
const albumPage = async page => { await search(page); await view(page).locator('.catalog-artist-card').first().click(); await view(page).getByRole('navigation', { name: 'Страницы релизов' }).getByRole('button', { name: 'Далее', exact: true }).click(); await view(page).getByRole('heading', { name: 'Second page', exact: true }).waitFor(); };
const mouseHistory = async (page, button) => page.evaluate(button => { for (const type of ['mousedown', 'mouseup', 'auxclick']) window.dispatchEvent(new MouseEvent(type, { button, bubbles: true, cancelable: true })); }, button);
const openRoute = async page => { await view(page).locator('summary').filter({ hasText: 'Подключение каталога' }).click(); await view(page).getByLabel('Прокси для MusicBrainz', { exact: true }).waitFor(); };
try {
  await run('Find VK restores exact artist and release offset through keyboard and side mouse history', async page => {
    await albumPage(page); await view(page).getByRole('button', { name: 'Найти в VK', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#global-search')?.value === 'Artist A Second page');
    await page.keyboard.press('Alt+ArrowLeft'); await view(page).getByRole('heading', { name: 'Second page', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('[aria-label="Имя артиста в каталоге"]')?.value === 'Original query');
    assert.equal(await view(page).getByLabel('Имя артиста в каталоге', { exact: true }).inputValue(), 'Original query');
    assert.deepEqual(await page.evaluate(() => window.__routeQa.artists.at(-1)), { id: 'a', offset: 2 });
    await page.keyboard.press('Alt+ArrowRight'); await page.waitForFunction(() => !document.querySelector('.catalog-view'));
    assert.equal(await page.locator('#global-search').inputValue(), 'Artist A Second page');
    await mouseHistory(page, 3); await view(page).getByRole('heading', { name: 'Second page', exact: true }).waitFor();
    await mouseHistory(page, 4); await page.waitForFunction(() => !document.querySelector('.catalog-view'));
    assert.equal(await page.locator('#global-search').inputValue(), 'Artist A Second page');
  });
  await run('forward navigation discards a pending restored artist response and Back requests it afresh', async page => {
    await albumPage(page); await view(page).getByRole('button', { name: 'Найти в VK', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.catalog-view')); await page.evaluate(() => { window.__routeQa.holdArtist = true; });
    await page.keyboard.press('Alt+ArrowLeft'); await page.waitForFunction(() => Boolean(window.__routeQa.finishArtist));
    await page.keyboard.press('Alt+ArrowRight'); await page.waitForFunction(() => !document.querySelector('.catalog-view'));
    await page.evaluate(() => { window.__routeQa.holdArtist = false; window.__routeQa.finishArtist(window.__routeQa.artistResult('a', 2)); }); await page.waitForTimeout(30);
    assert.equal(await page.locator('.catalog-view').count(), 0); assert.equal(await page.locator('#global-search').inputValue(), 'Artist A Second page');
    await page.keyboard.press('Alt+ArrowLeft'); await view(page).getByRole('heading', { name: 'Second page', exact: true }).waitFor();
  });
  await run('restoring an artist from search page two retains its search page when leaving the artist', async page => {
    await search(page); await view(page).getByRole('navigation', { name: 'Страницы артистов' }).getByRole('button', { name: 'Далее', exact: true }).click();
    await view(page).getByText('Artist C', { exact: true }).waitFor(); await view(page).locator('.catalog-artist-card').first().click();
    await view(page).getByRole('heading', { name: 'Artist C', exact: true }).waitFor();
    await view(page).getByRole('button', { name: 'Найти в VK', exact: true }).first().click(); await page.waitForFunction(() => !document.querySelector('.catalog-view'));
    await page.keyboard.press('Alt+ArrowLeft'); await view(page).getByRole('heading', { name: 'Artist C', exact: true }).waitFor();
    await view(page).getByRole('button', { name: 'К результатам поиска', exact: true }).click(); await view(page).getByText('Artist C', { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__routeQa.searches.at(-1)), { query: 'Original query', offset: 2 });
  });
  await run('a rejected route save clears typed credentials and never reads back an address or SoundCloud secret', async page => {
    await openRoute(page); await page.evaluate(() => { window.__routeQa.rejectConfiguration = true; });
    const input = view(page).getByLabel('Прокси для MusicBrainz', { exact: true }); await input.fill('http://qa-user:qa-password@proxy.example:8080');
    assert.equal(await input.getAttribute('type'), 'password'); await view(page).getByRole('button', { name: 'Сохранить', exact: true }).click();
    await view(page).getByRole('alert').getByText('Не удалось сохранить подключение. Проверьте адрес прокси и повторите попытку.', { exact: true }).waitFor();
    assert.equal(await input.inputValue(), ''); assert.equal((await page.locator('body').innerText()).includes('qa-password'), false);
    assert.equal(await page.getByLabel('Client Secret', { exact: true }).count(), 0);
  });
  await run('a pending route change invalidates an older in-flight metadata search', async page => {
    await openRoute(page); await page.evaluate(() => { window.__routeQa.holdSearch = true; window.__routeQa.holdConfiguration = true; });
    await view(page).getByLabel('Имя артиста в каталоге', { exact: true }).fill('Old route'); await view(page).getByRole('button', { name: 'Найти артиста', exact: true }).click();
    await page.waitForFunction(() => Boolean(window.__routeQa.finishSearch)); await view(page).getByLabel('Прокси для MusicBrainz', { exact: true }).fill('http://proxy.example:8080');
    await view(page).getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.evaluate(() => window.__routeQa.finishSearch(window.__routeQa.searchResult('Old route'))); await page.waitForTimeout(30);
    assert.equal(await view(page).locator('.catalog-artist-card').count(), 0);
    await page.evaluate(() => window.__routeQa.finishConfiguration()); await view(page).getByText(/Подключение сохранено/).waitFor();
    assert.equal(await view(page).getByLabel('Прокси для MusicBrainz', { exact: true }).inputValue(), '');
  });
  await run('a metadata search cannot publish results from the old route during a pending configuration', async page => {
    await openRoute(page); await page.evaluate(() => { window.__routeQa.holdConfiguration = true; });
    await view(page).getByLabel('Прокси для MusicBrainz', { exact: true }).fill('http://proxy.example:8080'); await view(page).getByRole('button', { name: 'Сохранить', exact: true }).click();
    await view(page).getByLabel('Имя артиста в каталоге', { exact: true }).fill('During route change');
    const button = view(page).getByRole('button', { name: 'Найти артиста', exact: true });
    if (!await button.isDisabled()) { await button.click(); await page.waitForTimeout(30); }
    await page.evaluate(() => window.__routeQa.finishConfiguration()); await view(page).getByText(/Подключение сохранено/).waitFor();
    assert.equal(await view(page).locator('.catalog-artist-card').count(), 0, 'Old-route results remained visible after configuring a new route');
  });
  await run('leaving a pending configuration cannot insert its old notice or credentials into a reopened catalog', async page => {
    await openRoute(page); await page.evaluate(() => { window.__routeQa.holdConfiguration = true; });
    await view(page).getByLabel('Прокси для MusicBrainz', { exact: true }).fill('http://qa-user:qa-password@proxy.example:8080'); await view(page).getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.getByRole('button', { name: 'Моя музыка', exact: true }).click(); await page.evaluate(() => window.__routeQa.finishConfiguration());
    await page.getByRole('button', { name: 'Каталог артистов', exact: true }).click(); await openRoute(page);
    await view(page).getByText('Прокси каталога сохранён.', { exact: true }).waitFor();
    assert.equal(await view(page).getByLabel('Прокси для MusicBrainz', { exact: true }).inputValue(), '');
    assert.equal(await view(page).getByText(/Подключение сохранено\. Повторите поиск/).count(), 0);
    assert.equal((await page.locator('body').innerText()).includes('qa-password'), false);
  });
  await run('a late status reply from a closed catalog cannot change the reopened route status', async page => {
    await page.getByRole('button', { name: 'Моя музыка', exact: true }).click(); await page.evaluate(() => { window.__routeQa.holdStatus = true; });
    await page.getByRole('button', { name: 'Каталог артистов', exact: true }).click(); await page.waitForFunction(() => Boolean(window.__routeQa.finishStatus));
    await page.getByRole('button', { name: 'Моя музыка', exact: true }).click(); await page.evaluate(() => { window.__routeQa.holdStatus = false; });
    await page.getByRole('button', { name: 'Каталог артистов', exact: true }).click(); await openRoute(page); await view(page).getByText('Прямое соединение.', { exact: true }).waitFor();
    await page.evaluate(() => window.__routeQa.finishStatus({ proxy: true, message: 'Obsolete secret route status' })); await page.waitForTimeout(30);
    assert.equal(await view(page).getByText('Obsolete secret route status', { exact: true }).count(), 0); await view(page).getByText('Прямое соединение.', { exact: true }).waitFor();
  });
  console.log(JSON.stringify({ results })); if (results.some(result => !result.ok)) process.exitCode = 1;
} finally { await browser.close(); }
