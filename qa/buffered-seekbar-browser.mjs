import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const results = [];
try {
  for (const width of [1440, 960]) {
    const page = await browser.newPage({ viewport: { width, height: width === 960 ? 620 : 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('http://127.0.0.1:5173/__bufferqa', route => route.fulfill({ contentType:'text/html', body:'<!doctype html><html><head><link rel="stylesheet" href="/src/styles.css"></head><body></body></html>' }));
    await page.goto('http://127.0.0.1:5173/__bufferqa');
    await page.evaluate(async () => { const runtime = (await import('/@react-refresh')).default; runtime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true; });
    await page.evaluate(async () => {
      const [react, reactDom, { BufferedSeekbar }, { applyTheme }] = await Promise.all([import('/node_modules/.vite/deps/react.js'), import('/node_modules/.vite/deps/react-dom_client.js'), import('/src/BufferedSeekbar.tsx'), import('/src/themes.ts')]);
      const {createElement} = react.default || react, {createRoot} = reactDom.default || reactDom;
      document.body.innerHTML = '<div id="buffered-qa" style="position:fixed;bottom:10px;left:20px;right:20px;padding:30px;background:var(--panel);border:1px solid var(--line);border-radius:16px"></div>';
      window.__qaSeeks = [];
      const root = createRoot(document.getElementById('buffered-qa'));
      window.__qaBufferProps = { trackId: 'one', position: 10, duration: 100, buffered: [[0,20],[60,80]], bufferedAhead: 10, network: 'ready', buffering: false, onSeek: position => window.__qaSeeks.push(position) };
      window.__qaRenderBuffer = patch => { Object.assign(window.__qaBufferProps, patch); root.render(createElement(BufferedSeekbar, window.__qaBufferProps)); };
      window.__qaApplyTheme = applyTheme;
      window.__qaRenderBuffer({});
    });
    await page.locator('.buffered-seekbar').waitFor();
    assert.equal(await page.locator('.seek-buffer-segment').count(), 2);
    const gap = await page.locator('.seek-buffer-segment').evaluateAll(elements => elements.map(element => ({ left: element.style.left, width: element.style.width })));
    assert.deepEqual(gap, [{left:'0%',width:'20%'},{left:'60%',width:'20%'}]);
    assert.match(await page.locator('.buffer-status').innerText(), /0:10/);
    const input = page.getByLabel('Позиция воспроизведения', { exact: true });
    await input.focus(); await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => window.__qaSeeks.at(-1)), 15);
    await page.keyboard.press('End'); assert.equal(await page.evaluate(() => window.__qaSeeks.at(-1)), 100);
    await page.keyboard.press('Home'); assert.equal(await page.evaluate(() => window.__qaSeeks.at(-1)), 0);
    await page.evaluate(() => { window.__qaSeeks = []; window.__qaRenderBuffer({ position: 0 }); });
    const rect = await input.boundingBox();
    await page.mouse.move(rect.x + rect.width * .1, rect.y + rect.height / 2); await page.mouse.down();
    await page.mouse.move(rect.x + rect.width * .8, rect.y + rect.height / 2, { steps: 30 });
    assert.equal(await page.evaluate(() => window.__qaSeeks.length), 0, 'Dragging flooded native seeks before release');
    await page.mouse.up(); assert.equal(await page.evaluate(() => window.__qaSeeks.length), 1); assert.ok(Math.abs(await page.evaluate(() => window.__qaSeeks[0]) - 80) < 2);
    await page.evaluate(() => window.__qaRenderBuffer({ network:'offline', buffering: true }));
    await page.getByText('Нет подключения', { exact: true }).waitFor();
    await page.evaluate(() => window.__qaRenderBuffer({ trackId: 'two', position: 0, duration: 0, buffered: [], network:'idle', buffering:false }));
    await page.waitForTimeout(30); assert.equal(await input.isDisabled(), true); assert.equal(await page.locator('.seek-buffer-segment').count(), 0);
    for (const palette of ['graphite', 'porcelain', 'cyberpunk', 'retro']) {
      await page.evaluate(palette => { window.__qaApplyTheme({ theme: palette === 'porcelain' ? 'light' : 'dark', palette, accent: palette === 'porcelain' ? '#366839' : '#bdff62', style:'minimal', reducedMotion:false, density:'comfortable', textScale:1 }); window.__qaRenderBuffer({ trackId:'one', position:35, duration:100, buffered:[[0,55],[70,100]], bufferedAhead:20, network:'ready', buffering:false }); }, palette);
      const layout = await page.evaluate(() => ({ overflow: document.body.scrollWidth > innerWidth, rail: document.querySelector('.seek-rail').getBoundingClientRect().width, input: document.querySelector('.seek-input').getBoundingClientRect().width }));
      assert.equal(layout.overflow, false); assert.ok(layout.rail > 100 && layout.input === layout.rail);
    }
    await page.emulateMedia({ reducedMotion:'reduce' });
    await page.evaluate(() => window.__qaRenderBuffer({ network:'recovering', buffering:true }));
    assert.equal(await page.locator('.buffer-status svg').evaluate(element => getComputedStyle(element).animationName), 'none');
    await mkdir(new URL('./artifacts/', import.meta.url), {recursive:true});
    await page.screenshot({ path:fileURLToPath(new URL(`./artifacts/buffered-seekbar-${width}.png`, import.meta.url)) });
    assert.deepEqual(errors, []); results.push({width,realIslands:true,keyboard:true,oneSeekPerDrag:true,emptyReset:true,themes:4,reducedMotion:true});
    await page.close();
  }
  await writeFile(new URL('./buffered-seekbar-browser-result.json',import.meta.url), JSON.stringify({checkedAt:new Date().toISOString(),results},null,2)+'\n');
  console.log('PASS buffer islands, keyboard, drag coalescing, track reset, offline/recovery, themes at960/1440');
} finally { await browser.close(); }
