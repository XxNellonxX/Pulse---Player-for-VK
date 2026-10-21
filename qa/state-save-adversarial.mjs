import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const baseURL = process.env.QA_BASE_URL || 'http://127.0.0.1:5173';
let failures = 0;

async function run(name, check, deferred = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(({ deferred }) => {
    window.__qaSaveCalls = [];
    window.__qaSaveWaiters = [];
    window.__qaSaveActive = 0;
    window.__qaMaxSaveActive = 0;
    window.__qaSaveFailure = false;
    window.__qaClosed = 0;
    const status = { state: 'disconnected', message: '', capabilities: [] };
    window.desktop = {
      getState: async () => null,
      saveState: async value => {
        window.__qaSaveCalls.push(JSON.parse(JSON.stringify(value)));
        window.__qaMaxSaveActive = Math.max(window.__qaMaxSaveActive, ++window.__qaSaveActive);
        try {
          if (deferred) await new Promise(resolve => window.__qaSaveWaiters.push(resolve));
          if (window.__qaSaveFailure) throw new Error('disk full');
        } finally { window.__qaSaveActive--; }
      },
      getVkStatus: async () => status,
      getVersion: async () => 'qa',
      onCommand: () => () => {},
      onCloseRequest(callback) {
        window.__qaClose = async () => {
          window.__qaCloseError = '';
          try { await callback(); window.__qaClosed++; }
          catch (error) { window.__qaCloseError = error.message; }
        };
        return () => { window.__qaClose = null; };
      },
    };
  }, { deferred });
  try {
    await page.goto(baseURL);
    await page.locator('.app-shell').waitFor();
    await page.waitForFunction(() => window.__qaSaveCalls.length > 0 && window.__qaClose);
    await check(page);
    console.log(`PASS ${name}`);
  } catch (error) { failures++; console.log(`FAIL ${name}: ${error.stack}`); }
  finally { await context.close(); }
}

await run('slow-disk-coalesces-edits-and-close-waits-for-latest-state', async page => {
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('button', { name: 'Тема Фарфор', exact: true }).click();
  await page.getByRole('button', { name: 'Тема Контраст', exact: true }).click();
  await page.waitForTimeout(450);
  assert.equal(await page.evaluate(() => window.__qaSaveCalls.length), 1, 'new writes overlap a pending older snapshot');
  await page.evaluate(() => { void window.__qaClose(); });
  assert.equal(await page.evaluate(() => window.__qaClosed), 0, 'close did not wait for disk');
  await page.evaluate(() => window.__qaSaveWaiters.shift()());
  await page.waitForFunction(() => window.__qaSaveCalls.length === 2);
  assert.equal(await page.evaluate(() => window.__qaSaveCalls.at(-1).settings.theme), 'high-contrast');
  assert.equal(await page.evaluate(() => window.__qaMaxSaveActive), 1, 'writes must never finish out of order');
  assert.equal(await page.evaluate(() => window.__qaClosed), 0, 'close acknowledged before final snapshot completed');
  await page.evaluate(() => window.__qaSaveWaiters.shift()());
  await page.waitForFunction(() => window.__qaClosed === 1);
}, true);

await run('save-failure-blocks-close-and-successful-retry-keeps-edit', async page => {
  await page.evaluate(() => { window.__qaSaveFailure = true; });
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('button', { name: 'Тема Фарфор', exact: true }).click();
  await page.getByText('Изменения пока не сохранены. Проверьте свободное место на диске.', { exact: true }).waitFor();
  await page.evaluate(() => window.__qaClose());
  assert.equal(await page.evaluate(() => window.__qaClosed), 0);
  assert.ok(await page.evaluate(() => window.__qaCloseError));
  await page.evaluate(() => { window.__qaSaveFailure = false; });
  await page.evaluate(() => window.__qaClose());
  assert.equal(await page.evaluate(() => window.__qaClosed), 1);
  assert.equal(await page.evaluate(() => window.__qaSaveCalls.at(-1).settings.theme), 'light');
  assert.equal(await page.getByText('Изменения пока не сохранены. Проверьте свободное место на диске.', { exact: true }).count(), 0);
});

await browser.close();
console.log(`QA result: ${failures} failed checks`);
process.exitCode = failures ? 1 : 0;
