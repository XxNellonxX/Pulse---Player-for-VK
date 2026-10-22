import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Actual standalone production catalog view. Fake public metadata IPC only;
// no account, local library mutation, native launch, or external service.
const base = process.env.PULSE_QA_URL || 'http://127.0.0.1:5191';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [];
async function run(name, action, available = true) {
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } }); page.setDefaultTimeout(2500);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.route(base + '/__catalog-independent', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div>' }));
    await page.goto(base + '/__catalog-independent');
    await page.evaluate(async () => { const runtime = (await import('/@react-refresh')).default; runtime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true; });
    await page.evaluate(async available => {
      window.__searchCalls = []; window.__artistCalls = []; window.__vkSearch = []; window.__links = []; window.__gates = [];
      window.__holdSearch = []; window.__holdArtist = []; window.__failSearch = false; window.__failArtist = false;
      const summary = (id, name) => ({ id, name, sortName: name, disambiguation: id === 'a' ? 'One, UK' : 'Two, US', kind: 'Group', country: id === 'a' ? 'GB' : 'US' });
      window.__searchResult = (query, offset) => ({ artists: offset === 0 ? [summary('a', query + ' One'), summary('b', query + ' Two')] : [summary('c', query + ' Three')], hasMore: offset === 0, offset, stale: false, fetchedAt: Date.now() });
      window.__artistResult = (id, offset) => ({ artist: { ...summary(id, id === 'a' ? 'Artist One' : 'Artist Two'), tags: ['electronic', 'independent'], links: [{ label: 'Unsafe link', url: 'javascript:alert(1)' }, { label: 'Official site', url: 'https://example.org/artist' }] }, releases: offset === 0 ? [
        { id: 'album', title: 'First Album', firstReleaseDate: '2001', primaryType: 'Album', secondaryTypes: [] },
        { id: 'ep', title: 'Future EP', firstReleaseDate: '2099-04', primaryType: 'EP', secondaryTypes: ['Live'] },
        { id: 'single', title: 'New Single', primaryType: 'Single', secondaryTypes: [] },
      ] : [], hasMore: offset === 0, offset, stale: false, fetchedAt: Date.now() });
      window.desktop = { openExternal: async url => { window.__links.push(url); } };
      if (available) Object.assign(window.desktop, {
        searchCatalogArtists(query, offset) {
          window.__searchCalls.push({ query, offset });
          if (window.__holdSearch.includes(query)) return new Promise((resolve, reject) => window.__gates.push({ type: 'search', query, resolve, reject }));
          if (window.__failSearch) { window.__failSearch = false; return Promise.reject('Synthetic native catalog offline'); }
          return Promise.resolve(window.__searchResult(query, offset));
        },
        getCatalogArtist(id, offset) {
          window.__artistCalls.push({ id, offset });
          if (window.__holdArtist.includes(id)) return new Promise((resolve, reject) => window.__gates.push({ type: 'artist', id, resolve, reject }));
          if (window.__failArtist) { window.__failArtist = false; return Promise.reject('Synthetic native artist offline'); }
          return Promise.resolve(window.__artistResult(id, offset));
        },
      });
      const [react, dom, { CatalogView }] = await Promise.all([import('/node_modules/.vite/deps/react.js'), import('/node_modules/.vite/deps/react-dom_client.js'), import('/src/CatalogView.tsx')]);
      const { createElement } = react.default || react, { createRoot } = dom.default || dom;
      window.__root = createRoot(document.getElementById('root')); window.__root.render(createElement(CatalogView, { onSearchVk: query => window.__vkSearch.push(query) }));
    }, available);
    await page.getByRole('region', { name: 'Каталог артистов', exact: true }).waitFor();
    await action(page); assert.deepEqual(errors, []); results.push({ name, ok: true }); console.log('PASS ' + name);
  } catch (error) { results.push({ name, ok: false, error: error.message }); console.log('FAIL ' + name + ': ' + error.message); }
  finally { await page.close(); }
}
const search = async (page, query = 'Artist') => { await page.getByRole('textbox', { name: 'Имя артиста в каталоге' }).fill(query); await page.getByRole('button', { name: 'Найти артиста', exact: true }).click(); };
const openFirst = async page => { await search(page); await page.locator('.catalog-artist-card').first().click(); await page.getByRole('heading', { name: 'Artist One', exact: true }).waitFor(); };
try {
  await run('missing native catalog bridge is explicit and cannot launch an endless search', async page => {
    await search(page).catch(() => {}); assert.equal(await page.getByRole('button', { name: 'Найти артиста', exact: true }).isDisabled(), true);
    await page.getByRole('heading', { name: 'Каталог в desktop-версии', exact: true }).waitFor();
  }, false);
  await run('a late older search cannot replace a newer search or leave the spinner busy', async page => {
    await page.evaluate(() => window.__holdSearch.push('Old')); await search(page, 'Old');
    await page.waitForFunction(() => window.__gates.length === 1); await search(page, 'New'); await page.getByText('New One', { exact: true }).waitFor();
    await page.evaluate(() => window.__gates[0].resolve(window.__searchResult('Old', 0))); await page.waitForTimeout(30);
    assert.equal(await page.getByText('Old One', { exact: true }).count(), 0); assert.equal(await page.locator('.catalog-loading').count(), 0);
  });
  await run('leaving a pending artist request keeps the prior search and discards the late artist', async page => {
    await search(page); await page.evaluate(() => window.__holdArtist.push('a')); await page.locator('.catalog-artist-card').first().click();
    await page.waitForFunction(() => window.__gates.length === 1); await page.getByRole('button', { name: 'К результатам поиска', exact: true }).click();
    await page.evaluate(() => window.__gates[0].resolve(window.__artistResult('a', 0))); await page.waitForTimeout(30);
    await page.getByText('Artist One', { exact: true }).waitFor(); assert.equal(await page.getByRole('heading', { name: 'Artist One', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'К результатам поиска', exact: true }).count(), 0);
  });
  await run('artist search pagination advances by actual count and Previous restores the prior offset', async page => {
    await search(page); const nav = page.getByRole('navigation', { name: 'Страницы артистов', exact: true });
    await nav.getByRole('button', { name: 'Далее', exact: true }).click(); await page.getByText('Artist Three', { exact: true }).waitFor();
    assert.equal(await nav.getByRole('button', { name: 'Далее', exact: true }).isDisabled(), true);
    await nav.getByRole('button', { name: 'Назад', exact: true }).click(); await page.getByText('Artist One', { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__searchCalls.map(call => call.offset)), [0, 2, 0]);
  });
  await run('partial dates, future dates and unknown dates remain honest with distinct release groups', async page => {
    await openFirst(page);
    for (const name of ['Альбомы', 'EP', 'Синглы']) await page.getByRole('heading', { name, exact: true }).waitFor();
    await page.getByText('Дата не указана', { exact: true }).waitFor(); await page.getByText('Будущая дата в каталоге', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: /Воспроизвести/ }).count(), 0);
    await page.locator('.catalog-release').first().getByRole('button', { name: 'Найти в VK', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.__vkSearch), ['Artist One First Album']);
  });
  await run('empty release pagination retains a way back instead of trapping an artist at the end', async page => {
    await openFirst(page); const nav = page.getByRole('navigation', { name: 'Страницы релизов', exact: true });
    await nav.getByRole('button', { name: 'Далее', exact: true }).click(); await page.getByRole('heading', { name: 'Релизы не указаны', exact: true }).waitFor();
    assert.equal(await nav.getByRole('button', { name: 'Далее', exact: true }).isDisabled(), true);
    await nav.getByRole('button', { name: 'Назад', exact: true }).click(); await page.getByRole('heading', { name: 'First Album', exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__artistCalls.map(call => call.offset)), [0, 3, 0]);
  });
  await run('native string errors support retry without losing the submitted search', async page => {
    await page.evaluate(() => { window.__failSearch = true; }); await search(page, 'Artist');
    await page.getByRole('alert').getByText('Synthetic native catalog offline', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Повторить', exact: true }).click(); await page.getByText('Artist One', { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__searchCalls.map(call => call.query)), ['Artist', 'Artist']);
  });
  await run('stale saved results are visibly distinguished from fresh catalog data', async page => {
    await page.evaluate(() => { const original = window.__searchResult; window.__searchResult = (...args) => ({ ...original(...args), stale: true, fetchedAt: Date.UTC(2026, 0, 1) }); });
    await search(page); await page.getByText(/Показана сохранённая копия/).waitFor(); await page.getByText('Artist One', { exact: true }).waitFor();
  });
  await run('unmounting a request cannot insert its late results into a closed view', async page => {
    await page.evaluate(() => window.__holdSearch.push('Old')); await search(page, 'Old'); await page.waitForFunction(() => window.__gates.length === 1);
    await page.evaluate(() => window.__root.unmount()); await page.evaluate(() => window.__gates[0].resolve(window.__searchResult('Old', 0))); await page.waitForTimeout(30);
    assert.equal(await page.locator('#root').innerText(), '');
  });
  await run('unsafe provider links are not actionable while official HTTPS links work', async page => {
    await openFirst(page); assert.equal(await page.getByRole('button', { name: 'Unsafe link', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Official site', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.__links), ['https://example.org/artist']);
  });
  console.log(JSON.stringify({ results })); if (results.some(result => !result.ok)) process.exitCode = 1;
} finally { await browser.close(); }
