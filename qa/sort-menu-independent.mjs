import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const base = process.env.PULSE_QA_URL || 'http://127.0.0.1:5193';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const errors = [], checks = [];
const output = new URL('./theme-visual/', import.meta.url); await mkdir(output, { recursive: true });
const state = { version: 1, tracks: [
  { id: 'fixture-z', title: 'Zebra', artist: 'Alpha', album: '', duration: 180, source: 'local', url: '', available: true, addedAt: 2 },
  { id: 'fixture-a', title: 'Amber', artist: 'Zeta', album: '', duration: 180, source: 'local', url: '', available: true, addedAt: 1 },
], playlists: [], queue: [], history: [], currentTrackId: null, position: 0, settings: { theme: 'dark', palette: 'graphite', accent: '#bdff62', style: 'minimal', volume: 0, repeat: 'off', shuffle: false } };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(value => localStorage.setItem('pulse-preview', JSON.stringify(value)), state);
  await page.goto(base);
  const trigger = page.getByRole('combobox', { name: /^Сортировка:/ });
  await trigger.click();
  assert.equal(await page.getByRole('option').count(), 5);
  assert.equal(await page.getByRole('group', { name: 'Порядок коллекции' }).count(), 1);
  assert.equal(await page.getByRole('group', { name: 'По имени' }).count(), 1);
  await page.getByRole('option', { name: 'По названию', exact: true }).click();
  assert.equal(await page.getByRole('listbox').count(), 0);
  assert.deepEqual(await page.locator('.track-title-button strong').allTextContents(), ['Amber', 'Zebra']);
  assert.equal(await trigger.evaluate(element => document.activeElement === element), true);
  await trigger.press('ArrowDown'); await trigger.press('Home'); await trigger.press('ArrowDown'); await trigger.press('Enter');
  assert.equal(await trigger.getAttribute('aria-label'), 'Сортировка: Порядок импорта Spotify');
  await trigger.press('Space');
  assert.equal(await page.getByRole('option', { name: 'Порядок импорта Spotify', exact: true }).getAttribute('aria-selected'), 'true');
  await trigger.press('End'); await trigger.press('Enter');
  assert.equal(await trigger.getAttribute('aria-label'), 'Сортировка: По исполнителю');
  assert.deepEqual(await page.locator('.track-title-button strong').allTextContents(), ['Zebra', 'Amber']);
  await trigger.press('Enter'); await trigger.press('ArrowUp'); await trigger.press('Escape');
  assert.equal(await trigger.getAttribute('aria-label'), 'Сортировка: По исполнителю');
  assert.equal(await trigger.evaluate(element => document.activeElement === element), true);
  await trigger.click(); await page.getByRole('heading', { name: 'Моя музыка', exact: true }).click();
  assert.equal(await page.getByRole('listbox').count(), 0);
  await trigger.focus(); await trigger.press('Enter'); await trigger.press('Tab');
  assert.equal(await page.getByRole('listbox').count(), 0);
  assert.equal(await trigger.evaluate(element => document.activeElement === element), false);
  const letter = key => trigger.dispatchEvent('keydown', { key, bubbles: true });
  await trigger.focus(); await letter('я');
  assert.equal(await trigger.getAttribute('aria-label'), 'Сортировка: По исполнителю', 'Typing does not commit the value');
  await trigger.press('Escape'); await letter('п'); await letter('о'); await letter('р');
  assert.equal(await trigger.getAttribute('aria-activedescendant'), await page.getByRole('option', { name: 'Порядок импорта Spotify', exact: true }).getAttribute('id'));
  await trigger.press('Enter'); assert.equal(await trigger.getAttribute('aria-label'), 'Сортировка: Порядок импорта Spotify');
  await letter('п'); await letter('п');
  assert.equal(await trigger.getAttribute('aria-activedescendant'), await page.getByRole('option', { name: 'Порядок импорта Яндекс Музыки', exact: true }).getAttribute('id'), 'Repeated letter cycles prefix matches');
  await page.waitForTimeout(750); await letter('к');
  assert.equal(await trigger.getAttribute('aria-activedescendant'), await page.getByRole('option', { name: 'Как в VK', exact: true }).getAttribute('id'), 'Expired prefix resets before a new search');
  await trigger.press('Escape'); await trigger.dispatchEvent('keydown', { key: 'п', ctrlKey: true, bubbles: true });
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'Modified shortcuts are not consumed');
  checks.push('Cyrillic prefix typeahead opens without committing, repeated letters cycle, 700ms buffer resets and shortcuts are preserved');
  checks.push('Pointer sorting, selected checks, group labels, Home/End/arrows/Enter/Space/Escape, outside click, Tab and focus restore');

  for (const [name, palette] of [['Графит', 'graphite'], ['Фарфор', 'porcelain'], ['Y2K / 90-е', 'y2k'], ['Стекло', 'glass']]) {
    await page.getByRole('button', { name: 'Настройки', exact: true }).click();
    await page.getByRole('button', { name: 'Темы', exact: true }).click();
    await page.getByRole('button', { name: `Тема ${name}`, exact: true }).click();
    await page.getByRole('button', { name: 'Моя музыка', exact: true }).click();
    for (const width of [1440, 960]) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 620 });
      await trigger.click(); await page.getByRole('option', { name: 'По названию', exact: true }).hover();
      const report = await page.getByRole('listbox').evaluate(element => {
        const bounds = element.getBoundingClientRect(), style = getComputedStyle(element);
        return { x: bounds.x, right: bounds.right, y: bounds.y, bottom: bounds.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight, colour: style.color, background: style.backgroundColor, radius: style.borderRadius, palette: document.documentElement.dataset.palette, portal: element.parentElement === document.body };
      });
      assert.equal(report.palette, palette); assert.equal(report.portal, true);
      assert.ok(report.x >= 0 && report.right <= report.viewportWidth); assert.ok(report.y >= 0 && report.bottom <= report.viewportHeight);
      assert.notEqual(report.background, 'rgba(0, 0, 0, 0)'); assert.equal(report.radius, '13px');
      assert.equal(await page.evaluate(() => document.body.scrollWidth > innerWidth), false);
      await page.screenshot({ path: fileURLToPath(new URL(`sort-${palette}-${width}.png`, output)) });
      checks.push({ palette, width, ...report });
      await trigger.press('Escape');
    }
  }
  await page.emulateMedia({ reducedMotion: 'reduce' }); await trigger.click();
  assert.equal(await page.getByRole('listbox').evaluate(element => getComputedStyle(element).animationName), 'none'); await trigger.press('Escape');
  await page.getByRole('button', { name: 'История', exact: true }).click();
  if (await trigger.count()) { await trigger.click(); assert.equal(await page.getByRole('option').count(), 3); await trigger.press('Escape'); }
  const edge = await browser.newPage({ viewport: { width: 960, height: 620 } });
  edge.on('pageerror', error => errors.push(error.message));
  await edge.route(base + '/__sort-edge-qa', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root" style="position:fixed;bottom:10px;right:10px"></div>' }));
  await edge.goto(base + '/__sort-edge-qa');
  await edge.evaluate(async () => { const runtime = (await import('/@react-refresh')).default; runtime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true; });
  await edge.evaluate(async () => {
    const React = (await import('/node_modules/.vite/deps/react.js')).default, { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    const { SortMenu } = await import('/src/SortMenu.tsx'); await import('/src/styles.css');
    function Harness() { const [value, setValue] = React.useState('a'); return React.createElement(SortMenu, { value, onChange: setValue, options: [{ value: 'a', label: 'Alpha', group: 'Порядок' }, { value: 'b', label: 'Beta', group: 'По имени' }] }); }
    createRoot(document.getElementById('root')).render(React.createElement(Harness));
  });
  const bottom = edge.getByRole('combobox'); await bottom.click();
  const anchor = await bottom.boundingBox(), menu = await edge.getByRole('listbox').boundingBox();
  assert.ok(menu.y >= 0 && menu.y + menu.height <= anchor.y, 'Bottom-edge menu must flip upwards');
  await edge.setViewportSize({ width: 360, height: 420 });
  await edge.waitForTimeout(50);
  const small = await edge.getByRole('listbox').boundingBox(); assert.ok(small.x >= 0 && small.x + small.width <= 360);
  await bottom.press('Escape'); await bottom.press('b');
  assert.equal(await bottom.getAttribute('aria-label'), 'Сортировка: Alpha');
  assert.equal(await bottom.getAttribute('aria-activedescendant'), await edge.getByRole('option', { name: 'Beta' }).getAttribute('id'));
  await bottom.press('Enter'); assert.equal(await bottom.getAttribute('aria-label'), 'Сортировка: Beta');
  checks.push('Portaled popup flips above bottom edge and repositions inside the viewport after resize');
  await edge.close();
  assert.deepEqual(errors, []);
  await writeFile(new URL('sort-menu-result.json', output), JSON.stringify({ checks, errors }, null, 2));
  console.log(`PASS custom SortMenu: ${checks.length} checks; screenshots qa/theme-visual/sort-*.png`);
} finally { await browser.close(); }
