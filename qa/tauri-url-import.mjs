import { chromium } from 'playwright';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, stat, rm, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { assertIsolatedNativeBinary } from './assert-isolated-native.mjs';

// Uses a public 19-second video and an isolated native profile. No VK account
// is opened, no cookies are read, and no audio is uploaded or published.
const target = process.env.CARGO_TARGET_DIR || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'vk-player-build', 'target');
const exe = process.env.TAURI_QA_EXE || path.join(target, 'debug', 'vk-player.exe');
assert.ok(existsSync(exe), `Build the isolated QA binary first: ${exe}`);
await assertIsolatedNativeBinary(exe);
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'vk-player-url-native-'));
const profile = path.join(temporaryRoot, 'profile');
const port = Number(process.env.URL_IMPORT_QA_PORT || 9231);
const execFileAsync = promisify(execFile);
let child, browser, page;
const output = [], rendererErrors = [];
let failures = 0;

async function check(name, action) {
  try { await action(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.log(`FAIL ${name}: ${error.stack || error}`); }
}
async function start() {
  child = spawn(exe, [], {
    windowsHide: true,
    env: {
      ...process.env,
      VK_PLAYER_QA_PROFILE: profile,
      WEBVIEW2_USER_DATA_FOLDER: path.join(temporaryRoot, 'browser'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --autoplay-policy=no-user-gesture-required`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => output.push(String(chunk)));
  child.stderr.on('data', chunk => output.push(String(chunk)));
  child.on('error', error => output.push(error.message));
  browser = undefined;
  for (let retry = 0; retry < 100; retry++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 600 }); break; } catch {}
    if (child.exitCode !== null) throw new Error(`QA binary exited ${child.exitCode}: ${output.join('')}`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(browser, `No QA CDP connection: ${output.join('')}`);
  for (let retry = 0; retry < 100; retry++) {
    page = browser.contexts().flatMap(context => context.pages()).find(item => item.url().includes('tauri.localhost'));
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page, 'No QA main WebView');
  page.on('pageerror', error => rendererErrors.push(error.message));
  await page.locator('.app-shell').waitFor({ timeout: 20000 });
  await page.waitForFunction(() => typeof window.desktop?.importFromUrl === 'function');
}
async function stop() {
  if (page && !page.isClosed()) {
    await page.evaluate(async () => {
      await window.desktop.saveState(await window.desktop.getState());
      await window.__TAURI_INTERNALS__.invoke('finish_close');
    }).catch(() => {});
  }
  if (child && child.exitCode === null) {
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2500))]);
    if (child.exitCode === null) {
      await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
    }
  }
  await browser?.close().catch(() => {});
  browser = undefined; page = undefined; child = undefined;
}
const nativeError = url => page.evaluate(async url => {
  try { await window.desktop.importFromUrl(url, 'local'); return ''; }
  catch (error) { return String(error); }
}, url);
const report = () => page.getByRole('status', { name: 'Результаты загрузки' });
let importedId, importedPath;

try {
  await start();
  await check('private-address-url-is-rejected-with-no-registration', async () => {
    const error = await nativeError('https://127.0.0.1/never-requested.mp3');
    assert.match(error, /локальн|служебн/i);
    assert.equal((await page.evaluate(() => window.desktop.getState())).tracks.length, 0);
    assert.equal((await readdir(path.join(profile, 'imports'))).length, 0);
  });
  await check('youtube-playlist-cannot-be-treated-as-one-audio-file', async () => {
    const error = await nativeError('https://www.youtube.com/playlist?list=PL-no-fixture-download');
    assert.match(error, /плейлист|одно видео|отдельн/i);
    assert.equal((await page.evaluate(() => window.desktop.getState())).tracks.length, 0);
  });
  await check('unsupported-webpage-never-registers-fake-mp3', async () => {
    const error = await nativeError('https://example.com/');
    assert.ok(error, 'An HTML page was accepted as audio');
    assert.equal((await page.evaluate(() => window.desktop.getState())).tracks.length, 0);
    assert.equal((await readdir(path.join(profile, 'imports'))).length, 0);
  });
  await check('real-youtube-url-ui-imports-original-opus-with-native-metadata', async () => {
    await page.getByRole('button', { name: 'Загрузить в VK', exact: true }).click();
    await page.getByRole('textbox', { name: 'Ссылка на трек', exact: true }).fill('https://www.youtube.com/watch?v=jNQXAC9IVRw');
    await page.getByRole('combobox', { name: 'Куда добавить трек', exact: true }).selectOption('local');
    await page.getByRole('button', { name: 'Добавить по ссылке', exact: true }).click();
    await report().locator('.import-result-local').waitFor({ timeout: 180000 });
    const state = await page.evaluate(() => window.desktop.getState());
    assert.equal(state.tracks.length, 1);
    const track = state.tracks[0];
    assert.equal(track.source, 'local');
    assert.equal(track.title, 'Me at the zoo');
    assert.equal(track.artist, 'jawed');
    assert.ok(track.duration > 18 && track.duration < 21, `Duration: ${track.duration}`);
    assert.ok(track.available);
    assert.match(track.url, /asset\.localhost|^asset:/);
    importedId = track.id;
    const envelope = JSON.parse(await readFile(path.join(profile, 'library.json'), 'utf8'));
    importedPath = envelope.files.find(([id]) => id === importedId)[1];
    assert.equal(path.extname(importedPath), '.opus');
    assert.ok(path.resolve(importedPath).startsWith(path.resolve(profile, 'imports') + path.sep));
    assert.ok((await stat(importedPath)).size > 1000);
    assert.equal((await readdir(path.join(profile, 'imports'))).length, 1, 'Temporary yt-dlp folder or sidecar leaked');
  });
  await check('imported-youtube-audio-actually-plays-through-native-asset', async () => {
    assert.ok(importedId, 'Live import must pass first');
    await page.getByRole('button', { name: 'Моя музыка', exact: true }).click();
    await page.getByRole('button', { name: 'Воспроизвести Me at the zoo', exact: true }).click();
    await page.getByRole('button', { name: 'Пауза', exact: true }).waitFor({ timeout: 10000 });
    await page.waitForTimeout(1800);
    assert.ok(Number(await page.getByLabel('Позиция воспроизведения').inputValue()) > 0.8);
    await page.getByRole('button', { name: 'Пауза', exact: true }).click();
  });
  await check('imported-opus-track-survives-real-app-restart', async () => {
    assert.ok(importedId, 'Live import must pass first');
    await stop();
    await start();
    const state = await page.evaluate(() => window.desktop.getState());
    assert.equal(state.tracks.length, 1);
    assert.equal(state.tracks[0].id, importedId);
    assert.equal(state.tracks[0].title, 'Me at the zoo');
    assert.equal(state.tracks[0].artist, 'jawed');
    assert.ok(state.tracks[0].available);
    assert.equal((await readdir(path.join(profile, 'imports'))).length, 1);
    await stat(importedPath);
  });
  await check('url-import-has-no-unhandled-renderer-errors', async () => assert.deepEqual(rendererErrors, []));
} finally {
  await stop();
  const actual = await realpath(temporaryRoot);
  const expectedParent = await realpath(os.tmpdir());
  assert.equal(path.dirname(actual).toLowerCase(), expectedParent.toLowerCase());
  assert.ok(path.basename(actual).startsWith('vk-player-url-native-'));
  await rm(actual, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
}
if (failures) process.exitCode = 1;
