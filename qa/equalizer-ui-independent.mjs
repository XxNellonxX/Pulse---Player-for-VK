import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Independent UI/model QA. A synthetic React shell cannot touch a VK account.
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const results = [];
try {
  for (const width of [960, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 850 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://127.0.0.1:5173/__eq-independent', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/src/styles.css"></head><body><div id="root"></div></body></html>' }));
    await page.goto('http://127.0.0.1:5173/__eq-independent');
    await page.evaluate(async () => {
      const runtime = (await import('/@react-refresh')).default;
      runtime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
      const [React, ReactDom, { EqualizerSettings }, model, themes] = await Promise.all([import('/node_modules/.vite/deps/react.js'), import('/node_modules/.vite/deps/react-dom_client.js'), import('/src/EqualizerSettings.tsx'), import('/src/shared/equalizer.ts'), import('/src/themes.ts')]);
      const { createElement: el, useState } = React.default || React, { createRoot } = ReactDom.default || ReactDom;
      window.__model = model; window.__themes = themes.THEME_PALETTES; window.__saved = null; window.__changes = [];
      window.__theme = palette => themes.applyTheme({ theme: palette.mode, palette: palette.id, accent: palette.accent, style: 'minimal', density: 'comfortable', textScale: 1, reducedMotion: true });
      window.__theme(themes.THEME_PALETTES[0]);
      function Harness() {
        const [value, setValue] = useState(model.normalizeEqualizer(undefined)); window.__eq = value; window.__set = setValue;
        return el('div', { className: 'app-shell' }, el('aside', { className: 'sidebar' }), el('main', { className: 'main-content' }, el('div', { className: 'page-content' }, el('div', { className: 'settings-body' }, el('nav', { className: 'settings-nav' }), el('div', { className: 'settings-content' }, el(EqualizerSettings, { value, onChange: next => { window.__saved = structuredClone(next); window.__changes.push(structuredClone(next)); setValue(next); } }))))));
      }
      createRoot(document.getElementById('root')).render(el(Harness));
    });
    await page.locator('.equalizer-settings').waitFor();
    assert.equal(await page.locator('.eq-preset').count(), 8);
    assert.equal(await page.getByRole('button', { name: 'Эквалайзер', exact: true }).getAttribute('aria-pressed'), 'false');
    await page.getByRole('button', { name: /Рэп/ }).click();
    assert.equal(await page.getByRole('button', { name: 'Эквалайзер', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => window.__eq.preset), 'rap');
    const first = page.getByRole('slider', { name: '31 герц', exact: true });
    await first.focus(); await page.keyboard.press('ArrowUp');
    assert.equal(await first.inputValue(), '4.5');
    assert.equal(await page.evaluate(() => window.__eq.preset), 'custom');
    assert.equal(await page.locator('.eq-preset[aria-pressed="true"]').count(), 0);
    const beforeOff = await page.evaluate(() => structuredClone(window.__eq));
    await page.getByRole('button', { name: 'Эквалайзер', exact: true }).click();
    const afterOff = await page.evaluate(() => structuredClone(window.__eq));
    assert.deepEqual(afterOff, { ...beforeOff, enabled: false });
    await page.getByRole('button', { name: 'Эквалайзер', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.__eq), beforeOff);
    await page.evaluate(() => window.__set(window.__model.normalizeEqualizer(JSON.parse(JSON.stringify(window.__saved)))));
    assert.deepEqual(await page.evaluate(() => window.__eq), beforeOff);
    for (const palette of await page.evaluate(() => window.__themes)) {
      await page.evaluate(palette => window.__theme(palette), palette);
      const geometry = await page.evaluate(() => {
        const section = document.querySelector('.equalizer-settings').getBoundingClientRect();
        return { pageWidth: document.documentElement.scrollWidth, width: innerWidth, section: { left: section.left, right: section.right }, sliders: [...document.querySelectorAll('.eq-slider input')].map(input => { const r = input.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; }), clipped: [...document.querySelectorAll('.equalizer-settings button,.equalizer-settings input')].filter(node => { const r = node.getBoundingClientRect(); return r.right > innerWidth + 1 || r.left < -1; }).map(node => node.getAttribute('aria-label') || node.innerText) };
      });
      assert.ok(geometry.pageWidth <= width, `${width} ${palette.id}: page overflow ${geometry.pageWidth}`);
      assert.deepEqual(geometry.clipped, [], `${width} ${palette.id}: controls outside viewport`);
      for (const slider of geometry.sliders) assert.ok(slider.left >= geometry.section.left && slider.right <= geometry.section.right, `${width} ${palette.id}: slider outside section`);
    }
    await page.getByRole('button', { name: 'Сбросить настройки', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.__eq), await page.evaluate(() => window.__model.DEFAULT_EQUALIZER));
    // Corrupt profiles must never create nonfinite values or runaway gain.
    const malformed = await page.evaluate(() => [null, 1, 'rap', {}, { enabled: 'true', preset: 'rap', bands: Array(10).fill(1e99), preamp: 99 }, { enabled: true, preset: 'rock', bands: Array(10).fill(NaN), preamp: -Infinity }, { enabled: true, preset: '__proto__', bands: Array(10).fill(0), preamp: '5' }].map(value => window.__model.normalizeEqualizer(value)));
    assert.ok(malformed.every(value => typeof value.enabled === 'boolean' && value.bands.length === 10 && value.bands.every(number => Number.isFinite(number) && number >= -12 && number <= 12) && value.preamp <= 0 && value.preamp >= -12));
    await mkdir(new URL('./artifacts/', import.meta.url), { recursive: true });
    await page.screenshot({ path: fileURLToPath(new URL(`./artifacts/equalizer-independent-${width}.png`, import.meta.url)), fullPage: true });
    assert.deepEqual(errors, []);
    results.push({ width, themes: 15, presetAndCustom: true, keyboard: true, toggleRetainsCurve: true, normalizedReload: true, malformed: true });
    console.log(`PASS equalizer independent UI ${width}px / 15 themes / preset, custom, toggle, reload, keyboard, malformed profiles`);
    await page.close();
  }
} finally {
  await writeFile(new URL('./equalizer-ui-independent-results.json', import.meta.url), JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2) + '\n');
  await browser.close();
}
