import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 700 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('http://127.0.0.1:5173/__update-harness', route => route.fulfill({ contentType: 'text/html', body: '<html><head><link rel="stylesheet" href="/src/styles.css"></head><body><div id="root"></div></body></html>' }));
  await page.goto('http://127.0.0.1:5173/__update-harness');
  await page.evaluate(async () => {
    const runtime = (await import('/@react-refresh')).default;
    runtime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
    const [React, ReactDom, { UpdateCenter }, themes] = await Promise.all([import('/node_modules/.vite/deps/react.js'), import('/node_modules/.vite/deps/react-dom_client.js'), import('/src/UpdateCenter.tsx'), import('/src/themes.ts')]);
    themes.applyTheme({ theme: 'dark', palette: 'graphite', accent: '#bdff62', style: 'minimal', density: 'comfortable', textScale: 1, reducedMotion: true });
    window.__events = []; window.__checks = 0; window.__failed = false;
    window.__release = { currentVersion: '0.4.0', latestVersion: '0.5.0', available: true, notes: '<img src=x onerror="window.__unsafe=true">\nНовые жанры и улучшения воспроизведения.', releaseUrl: 'https://github.com/XxNellonxX/Pulse---Player-for-VK/releases/tag/v0.5.0', downloadUrl: 'https://github.com/XxNellonxX/Pulse---Player-for-VK/releases/download/v0.5.0/Pulse_x64-setup.exe' };
    window.desktop = { checkAppRelease: async () => { window.__checks++; if (window.__failed) throw new Error('Сеть недоступна'); return structuredClone(window.__release); }, openExternal: async url => { window.__events.push(['open', url]); } };
    const el = (React.default || React).createElement, createRoot = (ReactDom.default || ReactDom).createRoot;
    createRoot(document.getElementById('root')).render(el('div', { className: 'app-shell' }, el('aside', { className: 'sidebar' }, el('div', { className: 'brand' }, el('span', { style: { width: 38 } }, '◈'), el('div', {}, el('strong', {}, 'PULSE'), el('span', {}, 'VK music player')), el(UpdateCenter, { onBeforeInstall: async () => { window.__events.push(['save-start']); await new Promise(resolve => setTimeout(resolve, 200)); window.__events.push(['saved']); } }))), el('main', { className: 'main-content' })));
  });
  await page.getByRole('button', { name: 'Проверить обновления Pulse', exact: true }).click();
  await page.getByRole('dialog', { name: 'Обновления Pulse' }).waitFor();
  await page.getByRole('button', { name: 'Доступно обновление Pulse', exact: true }).waitFor();
  assert.equal(await page.locator('.update-notes img').count(), 0);
  assert.equal(await page.evaluate(() => window.__unsafe), undefined);
  const geometry = await page.locator('.update-popover').boundingBox();
  assert.ok(geometry.x >= 0 && geometry.x + geometry.width <= 960);
  await page.getByRole('button', { name: 'Скачать обновление', exact: true }).click();
  await page.waitForTimeout(300);
  assert.deepEqual((await page.evaluate(() => window.__events)).map(item => item[0]), ['save-start', 'saved', 'open']);
  await page.waitForTimeout(4100);
  assert.equal(await page.evaluate(() => window.__checks), 1, 'startup timer must not recheck after manual initial check');
  await mkdir(new URL('./artifacts/', import.meta.url), { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL('./artifacts/update-center.png', import.meta.url)) });
  await page.keyboard.press('Escape'); assert.equal(await page.locator('.update-popover').count(), 0);
  await page.getByRole('button', { name: 'Доступно обновление Pulse', exact: true }).click();
  await page.evaluate(() => { window.__failed = true; });
  await page.getByRole('button', { name: 'Проверить снова', exact: true }).click();
  await page.getByRole('alert').waitFor(); assert.match(await page.getByRole('alert').textContent(), /Сеть недоступна/);
  await page.evaluate(() => { window.__failed = false; window.__release.downloadUrl = 'https://evil.test/install.exe'; });
  await page.getByRole('button', { name: 'Проверить снова', exact: true }).click();
  await page.getByRole('button', { name: 'Скачать обновление', exact: true }).click();
  await page.getByRole('alert').waitFor(); assert.match(await page.getByRole('alert').textContent(), /адрес релиза/);
  assert.equal((await page.evaluate(() => window.__events)).filter(item => item[0] === 'open').length, 1);
  assert.deepEqual(errors, []);
  console.log('PASS update center: one check, plain notes, in-view popover, save-before-open, Escape, retry and unsafe URL rejection');
} finally { await browser.close(); }
