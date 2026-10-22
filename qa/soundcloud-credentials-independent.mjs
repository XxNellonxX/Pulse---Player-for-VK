// Adversarial checks against the actual React App, with isolated mocked IPC.
// No real credentials, operating-system keychain writes or VK profile are used.
// Run: node qa/soundcloud-credentials-independent.mjs http://127.0.0.1:5173
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const base = process.argv[2] || 'http://127.0.0.1:5173';
const browser = await chromium.launch({ channel: process.env.PULSE_BROWSER_CHANNEL || 'chrome', headless: true });
const results = [];
const labels = { import: /^(Импортировать файл ключей|Выбираем файл)$/, check: /^(Проверить доступ|Проверяем доступ)$/, save: /^(Сохранить подключение|Сохраняем)$/ };
const inputNames = ['Client ID', 'Client Secret', 'Прокси для SoundCloud'];
const fake = ['independent-fixture-id', 'independent-fixture-secret', 'http://fixture-user:fixture-password@proxy.example:8080'];

async function fixture(options = {}) {
  const page = await browser.newPage({ viewport: { width: 1360, height: 940 } });
  page.setDefaultTimeout(5000);
  const errors = [], logs = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => logs.push(message.text()));
  await page.addInitScript(options => {
    const status = configured => ({ configured, proxy: !!options.proxy, message: configured ? 'Ключи сохранены' : 'Требуются ключи приложения' });
    const mock = window.__credentialsQa = {
      configured: !!options.configured, hold: options.hold || '', mode: options.mode || 'success',
      statusCalls: 0, imports: 0, checks: 0, saves: [], stateWrites: [], pending: {},
      state: { version: 1, tracks: [], playlists: [], history: [], queue: [], currentTrackId: null, position: 0, settings: { preferSoundCloud: true, preferExplicit: true } },
    };
    const result = async (name, action) => {
      if (mock.hold === name) return new Promise((resolve, reject) => { mock.pending[name] = { resolve, reject }; });
      return action();
    };
    const off = () => () => {};
    window.desktop = {
      getState: async () => mock.state,
      saveState: async value => { mock.state = value; mock.stateWrites.push(value); },
      getVkStatus: async () => ({ state: 'disconnected', message: '', capabilities: [] }),
      onCommand: off, onVkUpdate: off, onVkPlayback: off, onAppNotice: off, onImportProgress: off, onCloseRequest: off,
      getVersion: async () => '0.5.0-preview.2',
      checkAppRelease: async () => ({ currentVersion: '0.5.0-preview.2', latestVersion: null, available: false, notes: '', releaseUrl: null, downloadUrl: null }),
      soundCloudStatus: async () => { mock.statusCalls++; return result('status', () => status(mock.configured)); },
      configureSoundCloud: async input => {
        mock.saves.push(input);
        return result('save', () => { if (mock.mode === 'error') throw 'Не удалось сохранить настройки SoundCloud.'; mock.configured = true; });
      },
      importSoundCloudCredentials: async () => {
        mock.imports++;
        return result('import', () => {
          if (mock.mode === 'cancel') return null;
          if (mock.mode === 'error') throw 'Файл ключей SoundCloud имеет неверный формат.';
          mock.configured = true;
          return status(true);
        });
      },
      checkSoundCloudConnection: async () => {
        mock.checks++;
        return result('check', () => {
          if (mock.mode === 'error') throw 'SoundCloud отклонил ключи приложения. Проверьте Client ID и Client Secret.';
          return { configured: true, proxy: !!options.proxy, message: 'Авторизация SoundCloud и публичный поиск работают.' };
        });
      },
      openExternal: async () => {},
    };
    if (options.missingApis) {
      delete window.desktop.importSoundCloudCredentials;
      delete window.desktop.checkSoundCloudConnection;
    }
  }, options);
  await page.goto(base);
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('button', { name: 'Источники музыки', exact: true }).click();
  const section = page.getByRole('region', { name: 'SoundCloud', exact: true });
  await section.waitFor();
  if (options.hold !== 'status') await section.getByLabel('Client ID', { exact: true }).waitFor({ state: 'visible' });
  if (options.hold !== 'status') await page.waitForFunction(() => !document.querySelector('.sc-credential-fields input')?.disabled);
  return { page, section, errors, logs };
}
const action = (f, name) => f.section.getByRole('button', { name: labels[name], exact: true });
const input = (f, i) => i === 2 ? f.section.locator('.sc-proxy-field input') : f.section.getByLabel(inputNames[i], { exact: true });
const mock = f => f.page.evaluate(() => ({ imports: window.__credentialsQa.imports, checks: window.__credentialsQa.checks, saves: window.__credentialsQa.saves.length, statusCalls: window.__credentialsQa.statusCalls }));
async function fill(f) {
  if (!(await input(f, 2).count())) await f.section.getByRole('button', { name: 'Изменить маршрут', exact: true }).click();
  for (let i = 0; i < inputNames.length; i++) await input(f, i).fill(fake[i]);
}
async function retained(f) {
  for (let i = 0; i < inputNames.length; i++) assert.equal(await input(f, i).inputValue(), fake[i], 'An unsuccessful operation erased a draft field');
}
async function cleared(f) {
  assert.equal(await f.section.getByLabel('Client ID', { exact: true }).inputValue(), '');
  assert.equal(await f.section.getByLabel('Client Secret', { exact: true }).inputValue(), '');
  await f.section.getByRole('button', { name: 'Изменить маршрут', exact: true }).click();
  assert.equal(await input(f, 2).inputValue(), '');
}
async function noLeaks(f) {
  const data = await f.page.evaluate(() => ({ text: document.body.innerText, storage: [localStorage, sessionStorage].map(storage => Object.keys(storage).map(key => storage.getItem(key))), writes: window.__credentialsQa.stateWrites }));
  for (const value of fake) assert.equal(JSON.stringify([data, f.logs]).includes(value), false, 'Fixture credential appeared in rendered text, logs or persisted application state');
  assert.deepEqual(f.errors, []);
}
async function check(name, options, task) {
  let f;
  try {
    f = await fixture(options);
    await task(f);
    await noLeaks(f);
    results.push({ name, ok: true }); console.log('PASS ' + name);
  } catch (error) {
    // Never dump input values, DOM snapshots, fake secrets or an IPC request.
    const message = String(error.message).replaceAll(fake[0], '[fixture-id]').replaceAll(fake[1], '[fixture-secret]').replaceAll(fake[2], '[fixture-proxy]');
    results.push({ name, ok: false, error: message }); console.log('FAIL ' + name + ': ' + message);
  } finally { await f?.page.close(); }
}
async function settle(f, operation, value, reject = false) {
  await f.page.waitForFunction(operation => !!window.__credentialsQa.pending[operation], operation);
  await f.page.evaluate(({ operation, value, reject }) => {
    const pending = window.__credentialsQa.pending[operation];
    delete window.__credentialsQa.pending[operation];
    pending[reject ? 'reject' : 'resolve'](value);
  }, { operation, value, reject });
}
async function remount(f) {
  await f.page.getByRole('button', { name: 'Темы', exact: true }).click();
  await f.page.evaluate(() => { window.__credentialsQa.hold = ''; });
  await f.page.getByRole('button', { name: 'Источники музыки', exact: true }).click();
  await f.page.waitForFunction(() => !document.querySelector('.sc-credential-fields input')?.disabled);
}

try {
  await check('initial load never verifies or imports in the background', {}, async f => {
    await f.section.getByText('Если у вас обычный аккаунт SoundCloud', { exact: true }).waitFor();
    const before = await mock(f);
    await f.page.waitForTimeout(350);
    assert.deepEqual(await mock(f), before);
    assert.equal(before.imports, 0); assert.equal(before.checks, 0); assert.equal(before.saves, 0);
  });
  await check('cancelled file dialog retains every typed field and reports no success', { mode: 'cancel' }, async f => {
    await fill(f); await action(f, 'import').click();
    await f.page.waitForFunction(() => window.__credentialsQa.imports === 1 && !document.querySelector('.sc-credential-fields input')?.disabled);
    await retained(f);
    assert.equal(await f.section.getByText(/Файл ключей импортирован/).count(), 0);
    assert.equal((await mock(f)).checks, 0); assert.equal((await mock(f)).saves, 0);
  });
  await check('valid import clears input buffers without claiming tested access', {}, async f => {
    await fill(f); await action(f, 'import').click();
    await f.section.getByText(/Файл ключей импортирован/).waitFor();
    await cleared(f);
    await f.section.getByText('Ключи сохранены', { exact: true }).first().waitFor();
    assert.equal(await f.section.getByText('Авторизация и поиск проверены', { exact: true }).count(), 0);
    assert.equal((await mock(f)).checks, 0); assert.equal((await mock(f)).saves, 0);
  });
  await check('invalid file retains draft input and presents the safe native error', { mode: 'error' }, async f => {
    await fill(f); await action(f, 'import').click();
    await f.section.getByRole('alert').filter({ hasText: 'Файл ключей SoundCloud имеет неверный формат.' }).waitFor();
    await retained(f); assert.equal((await mock(f)).saves, 0);
    assert.equal(await f.section.getByText(/Файл ключей импортирован/).count(), 0);
  });
  await check('saving credentials clears all fields and does not verify automatically', {}, async f => {
    await fill(f); await action(f, 'save').click();
    await f.section.getByText('Настройки сохранены', { exact: true }).waitFor();
    await cleared(f); assert.equal((await mock(f)).checks, 0); assert.equal((await mock(f)).saves, 1);
    assert.equal(await f.section.getByText('Авторизация и поиск проверены', { exact: true }).count(), 0);
  });
  await check('failed manual save preserves fields and cannot claim success', { mode: 'error' }, async f => {
    await fill(f); await action(f, 'save').click();
    await f.section.getByRole('alert').filter({ hasText: 'Не удалось сохранить настройки SoundCloud.' }).waitFor();
    await retained(f); assert.equal(await f.section.getByText('Настройки сохранены', { exact: true }).count(), 0);
  });
  await check('verification requires saved credentials', {}, async f => {
    assert.equal(await action(f, 'check').isDisabled(), true);
    assert.equal((await mock(f)).checks, 0);
  });
  await check('successful check has a separate verified state and runs once', { configured: true }, async f => {
    await action(f, 'check').click();
    await f.section.getByText('Авторизация и поиск проверены', { exact: true }).waitFor();
    await f.page.waitForTimeout(350);
    const actual = await mock(f); assert.equal(actual.checks, 1); assert.equal(actual.imports, 0); assert.equal(actual.saves, 0);
  });
  await check('a failed check does not turn saved credentials into verified access', { configured: true, mode: 'error' }, async f => {
    await action(f, 'check').click();
    await f.section.getByRole('alert').filter({ hasText: /SoundCloud отклонил ключи/ }).waitFor();
    assert.equal(await f.section.getByText('Авторизация и поиск проверены', { exact: true }).count(), 0);
    await f.page.evaluate(() => { window.__credentialsQa.mode = 'success'; });
    await action(f, 'check').click(); await f.section.getByText('Авторизация и поиск проверены', { exact: true }).waitFor();
    assert.equal(await f.section.getByRole('alert').count(), 0); assert.equal((await mock(f)).checks, 2);
  });
  await check('a later failed check revokes the previous verified badge', { configured: true }, async f => {
    await action(f, 'check').click(); await f.section.getByText('Авторизация и поиск проверены', { exact: true }).waitFor();
    await f.page.evaluate(() => { window.__credentialsQa.mode = 'error'; });
    await action(f, 'check').click(); await f.section.getByRole('alert').waitFor();
    assert.equal(await f.section.getByText('Авторизация и поиск проверены', { exact: true }).count(), 0);
  });
  await check('in-flight import blocks repeated import, save and verification', { configured: true, hold: 'import' }, async f => {
    await action(f, 'import').click(); await f.page.waitForFunction(() => !!window.__credentialsQa.pending.import);
    for (const operation of ['import', 'save', 'check']) assert.equal(await action(f, operation).isDisabled(), true);
    await settle(f, 'import', null); await f.page.waitForFunction(() => !document.querySelector('.sc-credential-fields input')?.disabled);
    const actual = await mock(f); assert.equal(actual.imports, 1); assert.equal(actual.checks, 0); assert.equal(actual.saves, 0);
  });
  await check('a same-event-loop double import is guarded before React renders', { configured: true, hold: 'import' }, async f => {
    await action(f, 'import').evaluate(button => { button.click(); button.click(); });
    await f.page.waitForFunction(() => !!window.__credentialsQa.pending.import);
    assert.equal((await mock(f)).imports, 1); await settle(f, 'import', null);
  });
  await check('in-flight verification cannot start file import or save', { configured: true, hold: 'check' }, async f => {
    await action(f, 'check').click(); await f.page.waitForFunction(() => !!window.__credentialsQa.pending.check);
    for (const operation of ['import', 'save', 'check']) assert.equal(await action(f, operation).isDisabled(), true);
    await settle(f, 'check', { configured: true, proxy: false, message: 'Проверка завершена' });
    await f.section.getByText('Авторизация и поиск проверены', { exact: true }).waitFor();
    assert.equal((await mock(f)).imports, 0); assert.equal((await mock(f)).saves, 0);
  });
  await check('in-flight save cannot start import or verification', { hold: 'save' }, async f => {
    await fill(f); await action(f, 'save').click(); await f.page.waitForFunction(() => !!window.__credentialsQa.pending.save);
    for (const operation of ['import', 'save', 'check']) assert.equal(await action(f, operation).isDisabled(), true);
    await f.page.evaluate(() => { window.__credentialsQa.configured = true; });
    await settle(f, 'save', undefined); await f.section.getByText('Настройки сохранены', { exact: true }).waitFor();
    assert.equal((await mock(f)).imports, 0); assert.equal((await mock(f)).checks, 0);
  });
  await check('an import reply after unmount cannot alter reopened settings', { hold: 'import' }, async f => {
    await action(f, 'import').click(); await f.page.waitForFunction(() => !!window.__credentialsQa.pending.import);
    await remount(f);
    await settle(f, 'import', { configured: true, proxy: true, message: 'STALE_IMPORT_RESPONSE' });
    await f.page.waitForTimeout(80);
    assert.equal(await f.section.getByText(/STALE_IMPORT_RESPONSE|Файл ключей импортирован/).count(), 0);
    await f.section.getByText('Если у вас обычный аккаунт SoundCloud', { exact: true }).waitFor();
  });
  await check('a verification reply after unmount cannot verify the new component', { configured: true, hold: 'check' }, async f => {
    await action(f, 'check').click(); await f.page.waitForFunction(() => !!window.__credentialsQa.pending.check);
    await remount(f); await settle(f, 'check', { configured: true, proxy: false, message: 'STALE_CHECK_RESPONSE' });
    await f.page.waitForTimeout(80);
    assert.equal(await f.section.getByText(/STALE_CHECK_RESPONSE|Авторизация и поиск проверены/).count(), 0);
  });
  await check('late rejected IPC after unmount produces no stale error or exception', { hold: 'import' }, async f => {
    await action(f, 'import').click(); await f.page.waitForFunction(() => !!window.__credentialsQa.pending.import);
    await remount(f); await settle(f, 'import', 'STALE_SAFE_ERROR', true); await f.page.waitForTimeout(80);
    assert.equal(await f.section.getByText('STALE_SAFE_ERROR', { exact: true }).count(), 0);
  });
  await check('one incomplete credential pair cannot invoke save', {}, async f => {
    await f.section.getByLabel('Client ID', { exact: true }).fill(fake[0]);
    await action(f, 'save').click(); await f.section.getByRole('alert').filter({ hasText: 'Введите Client ID и Client Secret вместе.' }).waitFor();
    assert.equal((await mock(f)).saves, 0);
  });
  await check('absent native APIs disable unsupported actions', { missingApis: true, configured: true }, async f => {
    assert.equal(await action(f, 'import').isDisabled(), true); assert.equal(await action(f, 'check').isDisabled(), true);
  });
  console.log(JSON.stringify({ results, limits: ['Actual React App, mocked native IPC only', 'No real SoundCloud keys, token exchange, streaming or physical macOS verification'] }));
  if (results.some(result => !result.ok)) process.exitCode = 1;
} finally { await browser.close(); }
