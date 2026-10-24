import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// Independent consumer tests: clean Edge and mocked narrow native bridge only.
// This process never starts a native Pulse executable or opens an OS registry.
const base = process.env.PULSE_QA_URL || 'http://127.0.0.1:5193';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [];
const label = 'Запускать Pulse при входе в систему';
const status = (enabled = false, extra = {}) => ({ supported: true, enabled, requiresApproval: false, message: enabled ? 'Pulse запускается при входе в систему.' : 'Автозапуск выключен.', ...extra });
async function scenario(name, run) {
  const page = await browser.newPage(); page.setDefaultTimeout(4000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.route(base + '/__autostart-ux-qa', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div>' }));
    await page.goto(base + '/__autostart-ux-qa');
    await page.evaluate(async () => {
      const runtime = (await import('/@react-refresh')).default;
      runtime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
      const [react, dom, view] = await Promise.all([import('/node_modules/.vite/deps/react.js'), import('/node_modules/.vite/deps/react-dom_client.js'), import('/src/AutostartSetting.tsx')]);
      const React = react.default || react, { createRoot } = dom.default || dom;
      const root = createRoot(document.getElementById('root'));
      window.__reads = []; window.__writes = []; window.__pendingReads = []; window.__pendingWrites = [];
      window.__status = { supported: true, enabled: false, requiresApproval: false, message: 'Автозапуск выключен.' };
      window.__readMode = 'ready'; window.__writeMode = 'ready';
      window.desktop = {
        getAutostart: () => {
          window.__reads.push(1);
          if (window.__readMode === 'pending') return new Promise((resolve, reject) => window.__pendingReads.push({ resolve, reject }));
          if (window.__readMode === 'error') return Promise.reject(Error('QA_READ_DENIED'));
          return Promise.resolve(window.__status);
        },
        setAutostart: enabled => {
          window.__writes.push(enabled);
          if (window.__writeMode === 'pending') return new Promise((resolve, reject) => window.__pendingWrites.push({ resolve, reject }));
          if (window.__writeMode === 'error') return Promise.reject(Error('QA_WRITE_DENIED'));
          window.__status = { ...window.__status, enabled };
          return Promise.resolve(window.__status);
        },
      };
      let key = 0;
      window.__mount = () => root.render(React.createElement(view.AutostartSetting, { key: ++key }));
      window.__unmount = () => root.render(null);
    });
    await run(page);
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => localStorage.length), 0, 'The UI must not persist a competing startup preference');
    results.push({ name, ok: true }); console.log('PASS ' + name);
  } catch (error) {
    results.push({ name, ok: false, error: error.message }); console.error('FAIL ' + name + ': ' + error.message);
  } finally { await page.close(); }
}
try {
  await scenario('opening and refocusing settings only reads OS state', async page => {
    await page.evaluate(() => window.__mount()); await page.getByRole('switch', { name: label }).waitFor();
    await page.waitForFunction(() => window.__reads.length >= 1);
    assert.equal(await page.getByRole('switch', { name: label }).getAttribute('aria-checked'), 'false');
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await page.waitForTimeout(70);
    assert.equal(await page.evaluate(() => window.__writes.length), 0);
  });

  await scenario('a pending initial status cannot accidentally enable startup', async page => {
    await page.evaluate(() => { window.__readMode = 'pending'; window.__mount(); });
    const toggle = page.getByRole('switch', { name: label }); await toggle.waitFor();
    assert.equal(await toggle.isDisabled(), true);
    await toggle.evaluate(element => element.click());
    assert.equal(await page.evaluate(() => window.__writes.length), 0);
    await page.evaluate(value => window.__pendingReads.shift().resolve(value), status(false));
    await page.waitForFunction(() => !document.querySelector('[role=switch]').disabled);
  });

  await scenario('external OS disabling remains disabled after focus and visibility refresh', async page => {
    await page.evaluate(value => { window.__status = value; window.__mount(); }, status(true));
    const toggle = page.getByRole('switch', { name: label }); await toggle.waitFor();
    await page.waitForFunction(() => document.querySelector('[role=switch]').getAttribute('aria-checked') === 'true');
    await page.evaluate(value => { window.__status = value; window.dispatchEvent(new Event('focus')); }, status(false));
    await page.waitForFunction(() => document.querySelector('[role=switch]').getAttribute('aria-checked') === 'false');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await page.waitForTimeout(70);
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    assert.equal(await page.evaluate(() => window.__writes.length), 0);
  });

  await scenario('explicit enable is serialized and only confirmed native state checks the switch', async page => {
    await page.evaluate(() => { window.__writeMode = 'pending'; window.__mount(); });
    const toggle = page.getByRole('switch', { name: label }); await toggle.waitFor();
    await page.waitForFunction(() => !document.querySelector('[role=switch]').disabled);
    await toggle.click();
    assert.equal(await toggle.isDisabled(), true);
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    await toggle.evaluate(element => { for (let i = 0; i < 10; i++) element.click(); });
    assert.deepEqual(await page.evaluate(() => window.__writes), [true]);
    await page.evaluate(value => { window.__status = value; window.__pendingWrites.shift().resolve(value); }, status(true));
    await page.waitForFunction(() => document.querySelector('[role=switch]').getAttribute('aria-checked') === 'true');
    assert.equal(await toggle.isDisabled(), false);
  });

  await scenario('failed enable is visible and never appears as a successful checked switch', async page => {
    await page.evaluate(() => { window.__writeMode = 'error'; window.__mount(); });
    const toggle = page.getByRole('switch', { name: label }); await toggle.waitFor();
    await page.waitForFunction(() => !document.querySelector('[role=switch]').disabled);
    await toggle.click(); await page.getByRole('alert').waitFor();
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    assert.match(await page.getByRole('alert').textContent(), /QA_WRITE_DENIED|не удалось|ошиб/i);
    assert.deepEqual(await page.evaluate(() => window.__writes), [true]);
  });

  await scenario('failed disable keeps the previously enabled OS state and reports the failure', async page => {
    await page.evaluate(value => { window.__status = value; window.__writeMode = 'error'; window.__mount(); }, status(true));
    const toggle = page.getByRole('switch', { name: label }); await toggle.waitFor();
    await page.waitForFunction(() => !document.querySelector('[role=switch]').disabled);
    await toggle.click(); await page.getByRole('alert').waitFor();
    assert.equal(await toggle.getAttribute('aria-checked'), 'true');
    assert.deepEqual(await page.evaluate(() => window.__writes), [false]);
  });

  await scenario('a focus event during an explicit change cannot race a stale status read over its receipt', async page => {
    await page.evaluate(() => { window.__writeMode = 'pending'; window.__mount(); });
    const toggle = page.getByRole('switch', { name: label }); await toggle.waitFor();
    await page.waitForFunction(() => !document.querySelector('[role=switch]').disabled);
    const readsBefore = await page.evaluate(() => window.__reads.length);
    await toggle.click();
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
    assert.equal(await page.evaluate(() => window.__reads.length), readsBefore);
    await page.evaluate(value => { window.__status = value; window.__pendingWrites.shift().resolve(value); }, status(true));
    await page.waitForFunction(() => document.querySelector('[role=switch]').getAttribute('aria-checked') === 'true');
  });

  await scenario('initial read failure is visible and an explicit retry restores the actual OS state', async page => {
    await page.evaluate(() => { window.__readMode = 'error'; window.__mount(); });
    const toggle = page.getByRole('switch', { name: label }); await page.getByRole('alert').waitFor();
    assert.equal(await toggle.isDisabled(), true);
    await page.evaluate(value => { window.__readMode = 'ready'; window.__status = value; }, status(true));
    await page.getByRole('button', { name: 'Повторить проверку', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[role=switch]').getAttribute('aria-checked') === 'true');
    assert.equal(await page.getByRole('alert').count(), 0); assert.equal(await page.evaluate(() => window.__writes.length), 0);
  });

  await scenario('a stale pending refresh cannot overwrite a newer OS status', async page => {
    await page.evaluate(() => window.__mount()); await page.getByRole('switch', { name: label }).waitFor();
    await page.waitForFunction(() => !document.querySelector('[role=switch]').disabled);
    await page.evaluate(() => { window.__readMode = 'pending'; window.dispatchEvent(new Event('focus')); });
    await page.waitForFunction(() => window.__pendingReads.length === 1);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => window.__pendingReads.length === 2);
    await page.evaluate(value => window.__pendingReads[1].resolve(value), status(false));
    await page.waitForTimeout(70);
    await page.evaluate(value => window.__pendingReads[0].resolve(value), status(true)); await page.waitForTimeout(70);
    assert.equal(await page.getByRole('switch', { name: label }).getAttribute('aria-checked'), 'false');
    assert.equal(await page.evaluate(() => window.__writes.length), 0);
  });

  await scenario('macOS approval is explained without presenting the app as enabled', async page => {
    await page.evaluate(value => { window.__status = value; window.__mount(); }, status(false, { requiresApproval: true, message: 'Разрешите Pulse в Системных настройках macOS: Основные → Объекты входа.' }));
    const toggle = page.getByRole('switch', { name: label }); await toggle.waitFor();
    await page.getByText(/Разрешите Pulse/).waitFor();
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    assert.equal(await page.evaluate(() => window.__writes.length), 0);
  });

  await scenario('unsupported QA/native mode has an explanatory disabled control', async page => {
    await page.evaluate(value => { window.__status = value; window.__mount(); }, status(false, { supported: false, message: 'Автозапуск недоступен в изолированной QA-сборке.' }));
    const toggle = page.getByRole('switch', { name: label }); await toggle.waitFor();
    await page.getByText(/изолированной QA/).waitFor(); assert.equal(await toggle.isDisabled(), true);
    await toggle.evaluate(element => element.click()); assert.equal(await page.evaluate(() => window.__writes.length), 0);
  });

  await scenario('missing desktop capabilities stay disabled in the browser preview', async page => {
    await page.evaluate(() => { delete window.desktop; window.__mount(); });
    const toggle = page.getByRole('switch', { name: label }); await toggle.waitFor();
    assert.equal(await toggle.isDisabled(), true); assert.equal(await page.evaluate(() => window.__writes.length), 0);
  });
} finally { await browser.close(); }
console.log(JSON.stringify({ passed: results.filter(result => result.ok).length, total: results.length, results, nativeRegistryAccess: false, nativeLoginItemsAccess: false }));
if (results.some(result => !result.ok)) process.exitCode = 1;
