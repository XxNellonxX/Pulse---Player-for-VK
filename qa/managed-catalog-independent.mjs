// Actual full React App with isolated mocked native IPC. No real keys/profile.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const base = process.argv[2] || 'http://127.0.0.1:5173';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [];
const region = page => page.getByRole('region', { name: 'Каталог артистов', exact: true });

async function setup(options = {}) {
  const page = await browser.newPage({ viewport: { width: 1360, height: 940 } }); page.setDefaultTimeout(4000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(options => {
    const artist = id => ({ id, name: 'Artist ' + id.toUpperCase(), sortName: id, disambiguation: '', kind: 'Group', country: 'GB' });
    const release = index => ({ id: 'release-' + index, title: 'Release ' + index, firstReleaseDate: '2026-01', primaryType: 'Album', secondaryTypes: [] });
    const mock = window.__managedQa = {
      state: { version: 1, tracks: [], playlists: [], history: [], queue: [], currentTrackId: null, position: 0, settings: {} },
      watch: { artists: options.followed ? ['a', 'b'].map(id => ({ artist: artist(id), followed: true, openedAt: 1 })) : [], updates: [], refreshing: !!options.refreshing, revision: 0 },
      statusCalls: 0, routeCalls: 0, checkCalls: 0, imports: 0, configurations: 0, searches: [], artists: [], follows: [], refreshes: 0, listeners: new Set(), detached: [], pending: [], mode: options.mode || '', hold: options.hold || '',
    };
    mock.snapshot = () => structuredClone(mock.watch);
    mock.event = state => { mock.watch = state; for (const listener of mock.listeners) listener(mock.snapshot()); };
    mock.updates = count => Array.from({ length: count }, (_, index) => ({ artist: artist(index % 2 ? 'b' : 'a'), release: release(index), discoveredAt: Date.now() }));
    const gate = (name, value) => mock.hold === name ? new Promise((resolve, reject) => mock.pending.push({ name, resolve, reject })) : Promise.resolve(value);
    const off = () => () => {};
    window.desktop = {
      getState: async () => mock.state, saveState: async value => { mock.state = value; }, getVkStatus: async () => ({ state: 'disconnected', message: '', capabilities: [] }),
      onCommand: off, onVkUpdate: off, onVkPlayback: off, onAppNotice: off, onImportProgress: off, onCloseRequest: off,
      getVersion: async () => '0.5.0-preview.2', checkAppRelease: async () => ({ currentVersion: '0.5.0-preview.2', latestVersion: null, available: false, notes: '', releaseUrl: null, downloadUrl: null }),
      soundCloudStatus: async () => { mock.statusCalls++; return gate('status', { managed: true, configured: true, proxy: false, message: 'SoundCloud доступен через Pulse.' }); },
      checkSoundCloudConnection: async () => { mock.checkCalls++; if (mock.mode === 'error') throw 'Сервис SoundCloud временно недоступен.'; return { managed: true, configured: true, proxy: false, message: 'Авторизация и публичный поиск проверены.' }; },
      importSoundCloudCredentials: async () => { mock.imports++; return null; }, configureSoundCloud: async () => { mock.configurations++; },
      statusCatalogRoute: async () => { mock.routeCalls++; return { proxy: false, available: true, message: 'PRIVATE_ROUTE_STATUS' }; },
      configureCatalogRoute: async () => { mock.routeCalls++; },
      catalogWatchStatus: async () => gate('watch', mock.snapshot()),
      onCatalogUpdate: listener => { mock.listeners.add(listener); return () => { mock.listeners.delete(listener); mock.detached.push(listener); }; },
      setCatalogFollowed: async (id, followed) => {
        mock.follows.push({ id, followed });
        if (mock.mode === 'follow-error') throw 'Не удалось сохранить подписку.';
        if (mock.hold === 'follow') return gate('follow');
        const entry = mock.watch.artists.find(item => item.artist.id === id);
        if (entry) entry.followed = followed; else mock.watch.artists.push({ artist: artist(id), followed, openedAt: 1 });
        if (!followed) mock.watch.updates = mock.watch.updates.filter(item => item.artist.id !== id);
        mock.watch.revision++; return mock.snapshot();
      },
      refreshCatalog: async () => { mock.refreshes++; if (mock.hold === 'refresh') return gate('refresh'); if (mock.mode === 'refresh-error') throw 'PRIVATE_HEALTH_DETAIL'; return mock.snapshot(); },
      cancelCatalogRefresh: async () => { mock.watch.refreshing = false; return mock.snapshot(); },
      searchCatalogArtists: async (query, offset = 0) => { mock.searches.push({ query, offset }); return { artists: ['a', 'b'].map(artist), offset, hasMore: false, stale: mock.mode === 'stale', fetchedAt: Date.now() }; },
      getCatalogArtist: async (id, offset = 0) => { mock.artists.push({ id, offset }); return { artist: { ...artist(id), tags: [], links: [] }, releases: [release(0)], offset, hasMore: false, stale: mock.mode === 'stale', fetchedAt: Date.now() }; },
      openExternal: async () => {},
    };
  }, options);
  await page.goto(base); await page.locator('.app-shell').waitFor();
  return { page, errors };
}
async function run(name, options, action) {
  let f;
  try { f = await setup(options); await action(f.page); assert.deepEqual(f.errors, []); results.push({ name, ok: true }); console.log('PASS ' + name); }
  catch (error) { results.push({ name, ok: false, error: error.message }); console.log('FAIL ' + name + ': ' + error.message); }
  finally { await f?.page.close(); }
}
const catalog = async page => { await page.getByRole('button', { name: 'Каталог артистов', exact: true }).click(); await region(page).waitFor(); };
const updates = async page => { await region(page).getByRole('button', { name: /^Обновления/ }).click(); await region(page).getByRole('region', { name: 'Обновления каталога', exact: true }).waitFor(); };
const source = async page => { await page.getByRole('button', { name: 'Настройки', exact: true }).click(); await page.getByRole('button', { name: 'Источники музыки', exact: true }).click(); return page.getByRole('region', { name: 'SoundCloud', exact: true }); };
const openArtist = async (page, index = 0) => { await region(page).getByLabel('Имя артиста в каталоге').fill('Fixture'); await region(page).getByRole('button', { name: 'Найти артиста', exact: true }).click(); await region(page).locator('.catalog-artist-card').nth(index).click(); await region(page).getByRole('heading', { name: 'Artist ' + (index ? 'B' : 'A'), exact: true }).waitFor(); };

try {
  await run('managed SoundCloud hides keys, import and proxy controls before and after status resolves', { hold: 'status' }, async page => {
    const section = await source(page); await page.waitForFunction(() => window.__managedQa.pending.some(item => item.name === 'status'));
    assert.equal(await section.locator('input[type=password]').count(), 0); assert.equal(await section.getByText('Ключи из файла', { exact: true }).count(), 0);
    await page.evaluate(() => { for (const pending of window.__managedQa.pending) if (pending.name === 'status') pending.resolve({ managed: true, configured: true, proxy: false, message: 'SoundCloud доступен через Pulse.' }); });
    await section.getByText('SoundCloud через Pulse', { exact: true }).waitFor();
    assert.equal(await section.getByLabel('Client ID', { exact: true }).count(), 0); assert.equal(await section.getByLabel('Client Secret', { exact: true }).count(), 0);
    assert.equal(await section.getByRole('button', { name: /Импортировать|Сохранить подключение|Изменить маршрут/ }).count(), 0);
    assert.equal(/https?:\/\/|PRIVATE_|Client Secret|Прокси/.test(await section.innerText()), false);
  });
  await run('managed check failure stays simple and offers retry without exposing setup or claiming verified access', { mode: 'error' }, async page => {
    const section = await source(page); await section.getByText('SoundCloud через Pulse', { exact: true }).waitFor();
    await section.getByRole('button', { name: 'Проверить доступ', exact: true }).click(); await section.getByRole('alert').waitFor();
    assert.equal(await section.getByText('Авторизация и поиск проверены', { exact: true }).count(), 0); assert.equal(await section.locator('input[type=password]').count(), 0);
    await page.evaluate(() => { window.__managedQa.mode = ''; }); await section.getByRole('button', { name: 'Проверить доступ', exact: true }).click();
    await section.getByText('Авторизация и поиск проверены', { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => [window.__managedQa.checkCalls, window.__managedQa.imports, window.__managedQa.configurations]), [2, 0, 0]);
  });
  await run('a pending watch snapshot cannot block app startup or foreground artist search and never requests old proxy settings', { hold: 'watch', refreshing: true }, async page => {
    await page.getByRole('button', { name: 'Моя музыка', exact: true }).waitFor(); await catalog(page); await openArtist(page);
    assert.equal(await region(page).getByRole('heading', { name: 'Artist A', exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => window.__managedQa.routeCalls), 0); assert.equal(await region(page).getByText('Подключение каталога', { exact: true }).count(), 0);
  });
  await run('follow and unfollow update the actual artist card and local updates list without VK login', {}, async page => {
    await catalog(page); await openArtist(page);
    await region(page).getByRole('button', { name: 'Следить за релизами', exact: true }).click(); await region(page).getByRole('button', { name: 'Вы следите', exact: true }).waitFor();
    await updates(page); await region(page).getByRole('button', { name: 'Artist A', exact: true }).click();
    await region(page).getByRole('button', { name: 'Вы следите', exact: true }).click(); await region(page).getByRole('button', { name: 'Следить за релизами', exact: true }).waitFor();
    await updates(page); await region(page).getByRole('heading', { name: 'Выберите своих артистов', exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__managedQa.follows), [{ id: 'a', followed: true }, { id: 'a', followed: false }]);
  });
  await run('newer subscription event wins over an older initial status reply', { hold: 'watch' }, async page => {
    await catalog(page); await page.waitForFunction(() => window.__managedQa.pending.some(item => item.name === 'watch'));
    await page.evaluate(() => { const mock = window.__managedQa; mock.event({ artists: [{ artist: { id: 'a', name: 'Artist A', sortName: 'a', disambiguation: '' }, followed: true, openedAt: 1 }], updates: [], refreshing: false, revision: 5 }); for (const pending of mock.pending) if (pending.name === 'watch') pending.resolve({ artists: [], updates: [], refreshing: false, revision: 0 }); });
    await openArtist(page); await region(page).getByRole('button', { name: 'Вы следите', exact: true }).waitFor();
  });
  await run('out-of-order background events cannot remove a newer subscription', {}, async page => {
    await catalog(page); await page.evaluate(() => { const mock = window.__managedQa; const next = { artists: [{ artist: { id: 'a', name: 'Artist A', sortName: 'a', disambiguation: '' }, followed: true, openedAt: 1 }], updates: [], refreshing: false, revision: 8 }; mock.event(next); mock.event({ ...next, artists: [], revision: 7 }); });
    await openArtist(page); await region(page).getByRole('button', { name: 'Вы следите', exact: true }).waitFor();
  });
  await run('an artist switch during pending follow cannot toggle the wrong artist or issue duplicate requests', { hold: 'follow' }, async page => {
    await catalog(page); await openArtist(page);
    const button = region(page).getByRole('button', { name: 'Следить за релизами', exact: true }); await button.evaluate(element => { element.click(); element.click(); });
    await page.waitForFunction(() => window.__managedQa.pending.some(item => item.name === 'follow'));
    await region(page).getByRole('button', { name: 'К результатам поиска', exact: true }).click(); await region(page).locator('.catalog-artist-card').nth(1).click();
    await page.evaluate(() => { const mock = window.__managedQa; mock.pending.find(item => item.name === 'follow').resolve({ artists: [{ artist: { id: 'a', name: 'Artist A', sortName: 'a', disambiguation: '' }, followed: true, openedAt: 1 }], updates: [], refreshing: false, revision: 1 }); });
    await region(page).getByRole('heading', { name: 'Artist B', exact: true }).waitFor(); await region(page).getByRole('button', { name: 'Следить за релизами', exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__managedQa.follows), [{ id: 'a', followed: true }]);
  });
  await run('subscription failure preserves the previous state and supports a later successful retry', { mode: 'follow-error' }, async page => {
    await catalog(page); await openArtist(page); await region(page).getByRole('button', { name: 'Следить за релизами', exact: true }).click();
    await region(page).getByRole('alert').waitFor(); assert.equal(await region(page).getByRole('button', { name: 'Вы следите', exact: true }).count(), 0);
    await page.evaluate(() => { window.__managedQa.mode = ''; }); await region(page).getByRole('button', { name: 'Следить за релизами', exact: true }).click(); await region(page).getByRole('button', { name: 'Вы следите', exact: true }).waitFor();
  });
  await run('cached stale metadata is usable during offline refresh and refresh failure hides technical health details', { mode: 'stale', followed: true }, async page => {
    await catalog(page); await openArtist(page); await region(page).getByText(/Показана сохранённая копия/).waitFor();
    await updates(page); await page.evaluate(() => { window.__managedQa.mode = 'refresh-error'; }); await region(page).getByRole('button', { name: 'Проверить обновления', exact: true }).click();
    await region(page).getByRole('alert').filter({ hasText: 'Сохранённые данные доступны' }).waitFor();
    assert.equal((await region(page).innerText()).includes('PRIVATE_HEALTH_DETAIL'), false); await region(page).getByRole('button', { name: 'Artist A', exact: true }).waitFor();
  });
  await run('background refresh does not disable artist navigation or search', { followed: true, refreshing: true }, async page => {
    await catalog(page); await updates(page); assert.equal(await region(page).getByRole('button', { name: 'Проверяем в фоне', exact: true }).isDisabled(), true);
    await region(page).getByRole('button', { name: 'Artist B', exact: true }).click(); await region(page).getByRole('heading', { name: 'Artist B', exact: true }).waitFor();
    await region(page).getByLabel('Имя артиста в каталоге').fill('Another query'); assert.equal(await region(page).getByRole('button', { name: 'Найти артиста', exact: true }).isDisabled(), false);
  });
  await run('update rendering is paginated and artist filtering resets the visible batch', { followed: true }, async page => {
    await catalog(page); await page.evaluate(() => { const mock = window.__managedQa; mock.event({ ...mock.snapshot(), updates: mock.updates(75), revision: 3 }); }); await updates(page);
    assert.equal(await region(page).locator('.catalog-release').count(), 30); await region(page).getByRole('button', { name: 'Показать ещё', exact: true }).click(); assert.equal(await region(page).locator('.catalog-release').count(), 60);
    await region(page).getByLabel('Фильтр обновлений по артисту').selectOption('a'); assert.equal(await region(page).locator('.catalog-release').count(), 30);
    assert.equal(await region(page).locator('.catalog-update-artist').filter({ hasText: 'Artist B' }).count(), 0);
  });
  await run('a detached event listener cannot repopulate a reopened catalog with stale data', {}, async page => {
    await catalog(page); await page.getByRole('button', { name: 'Моя музыка', exact: true }).click(); await catalog(page);
    await page.evaluate(() => { const mock = window.__managedQa; for (const listener of mock.detached) listener({ artists: [{ artist: { id: 'a', name: 'STALE ARTIST', sortName: 'a', disambiguation: '' }, followed: true, openedAt: 1 }], updates: [], refreshing: false, revision: 99 }); });
    await updates(page); await region(page).getByRole('heading', { name: 'Выберите своих артистов', exact: true }).waitFor(); assert.equal((await region(page).innerText()).includes('STALE ARTIST'), false);
  });
  await run('Find in VK and browser back preserve the updates tab while artist back/forward restores its card', { followed: true }, async page => {
    await catalog(page); await page.evaluate(() => { const mock = window.__managedQa; mock.event({ ...mock.snapshot(), updates: mock.updates(2), revision: 3 }); }); await updates(page);
    await region(page).locator('.catalog-release').first().getByRole('button', { name: 'Найти в VK', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#global-search')?.value === 'Artist A Release 0');
    await page.keyboard.press('Alt+ArrowLeft'); await region(page).getByRole('region', { name: 'Обновления каталога', exact: true }).waitFor();
    await region(page).getByRole('heading', { name: 'Release 0', exact: true }).waitFor();
    await region(page).locator('.catalog-followed-list').getByRole('button', { name: 'Artist A', exact: true }).click();
    await region(page).getByRole('heading', { name: 'Artist A', exact: true }).waitFor();
    await page.keyboard.press('Alt+ArrowLeft'); await region(page).getByRole('region', { name: 'Обновления каталога', exact: true }).waitFor();
    await page.keyboard.press('Alt+ArrowRight'); await region(page).getByRole('heading', { name: 'Artist A', exact: true }).waitFor();
  });
  await run('unfollowing the selected filter removes its stale discoveries and recovers the remaining updates', { followed: true }, async page => {
    await catalog(page); await page.evaluate(() => { const mock = window.__managedQa; mock.event({ ...mock.snapshot(), updates: mock.updates(4), revision: 3 }); }); await updates(page);
    await region(page).getByLabel('Фильтр обновлений по артисту').selectOption('a');
    await page.evaluate(() => { const mock = window.__managedQa; mock.event({ ...mock.snapshot(), artists: mock.watch.artists.filter(item => item.artist.id === 'b'), revision: 4 }); });
    await page.waitForFunction(() => document.querySelector('[aria-label="Фильтр обновлений по артисту"]')?.value === '');
    assert.equal(await region(page).locator('.catalog-release').count(), 2); assert.equal(await region(page).locator('.catalog-update-artist').filter({ hasText: 'Artist A' }).count(), 0);
  });
  console.log(JSON.stringify({ results, limits: ['Actual full React App with mocked native IPC', 'Native watcher scheduling/persistence and public gateway deployment are separate checks', 'No real SoundCloud playback, Docker or physical macOS verification'] }));
  if (results.some(item => !item.ok)) process.exitCode = 1;
} finally { await browser.close(); }
