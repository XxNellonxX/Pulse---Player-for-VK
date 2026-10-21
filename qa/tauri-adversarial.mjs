import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { assertIsolatedNativeBinary } from './assert-isolated-native.mjs';

const cargoTarget = process.env.CARGO_TARGET_DIR || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'vk-player-build', 'target');
const defaultExe = path.join(cargoTarget, 'debug', 'vk-player.exe');
const fallbackExe = fileURLToPath(new URL('../src-tauri/target/debug/vk-player.exe', import.meta.url));
const exe = process.env.TAURI_QA_EXE || (existsSync(defaultExe) ? defaultExe : fallbackExe);
assert.ok(existsSync(exe), `Build Tauri first; binary not found: ${exe}`);
await assertIsolatedNativeBinary(exe);
const root = await mkdtemp(path.join(os.tmpdir(), 'vk-player-qa-tauri-edge-'));
const profile = path.join(root, 'profile');
const sampleRate = 8000, samples = sampleRate * 30;
const wave = Buffer.alloc(44 + samples * 2);
wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVE', 8); wave.write('fmt ', 12); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(sampleRate, 24); wave.writeUInt32LE(sampleRate * 2, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(samples * 2, 40);
const fixture = path.join(root, 'QA adversarial Tauri.wav');
const outside = path.join(root, 'not-imported.wav');
await writeFile(fixture, wave);
await writeFile(outside, wave);
let child, browser, page;
const output = [], rendererErrors = [];
let failures = 0;

async function start() {
  child = spawn(exe, [], { windowsHide: true, env: { ...process.env, VK_PLAYER_QA_PROFILE: profile, VK_PLAYER_QA_FILES: JSON.stringify([fixture]), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9224 --autoplay-policy=no-user-gesture-required' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => output.push(String(chunk)));
  child.stderr.on('data', chunk => output.push(String(chunk)));
  child.on('error', error => output.push(error.message));
  for (let i = 0; i < 120; i++) {
    try { browser = await chromium.connectOverCDP('http://127.0.0.1:9224', { timeout: 1000 }); break; } catch {}
    if (child.exitCode !== null) throw new Error(`Tauri exited ${child.exitCode}: ${output.join('')}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(browser, `WebView2 CDP unavailable. ${output.join('')}`);
  for (let i = 0; i < 100; i++) {
    page = browser.contexts().flatMap(context => context.pages()).find(item => /localhost|127\.0\.0\.1|tauri/.test(item.url()));
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page, 'No Tauri renderer WebView');
  page.on('pageerror', error => rendererErrors.push(error.message));
  await page.locator('.app-shell').waitFor({ timeout: 20000 });
}
async function stop() {
  if (child && child.exitCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
  }
  if (browser) await browser.close().catch(() => {});
  browser = null; page = null;
  await new Promise(resolve => setTimeout(resolve, 1000));
}
async function requestWindowClose() {
  const processToClose = child;
  assert.ok(processToClose && processToClose.exitCode === null, 'no running test process');
  const exited = new Promise(resolve => processToClose.once('exit', resolve));
  const close = spawn('powershell.exe', ['-NoProfile', '-Command', `$qaProcess = Get-Process -Id ${processToClose.pid}; if (-not $qaProcess.CloseMainWindow()) { exit 1 }`], { windowsHide: true, stdio: 'ignore' });
  const closed = await new Promise(resolve => close.once('exit', resolve));
  assert.equal(closed, 0, 'Windows did not accept the close request');
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('native close handshake did not finish within 8 seconds')), 8000))]);
  assert.equal(processToClose.exitCode, 0);
  if (browser) await browser.close().catch(() => {});
  browser = null; page = null;
}
async function check(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.log(`FAIL ${name}: ${error.message}`); }
}
async function fileResponse(url, range) {
  // Exercise the same permitted Media request as real playback. fetch() is
  // deliberately denied by production CSP, so inspect the native response via
  // CDP instead of loosening connect-src in the product.
  const session = await page.context().newCDPSession(page);
  let finish;
  const response = new Promise(resolve => { finish = resolve; });
  const timeout = setTimeout(() => finish({ error: 'Media request did not return a response' }), 5000);
  await session.send('Fetch.enable', { patterns: [{ urlPattern: 'http://asset.localhost/*', requestStage: 'Request' }, { urlPattern: 'http://asset.localhost/*', requestStage: 'Response' }] });
  session.on('Fetch.requestPaused', async event => {
    try {
      if (event.responseStatusCode !== undefined) {
        const body = await session.send('Fetch.getResponseBody', { requestId: event.requestId }).catch(() => null);
        const headers = Object.fromEntries((event.responseHeaders || []).map(header => [header.name.toLowerCase(), header.value]));
        finish({ status: event.responseStatusCode, headers, bytes: body ? [...Buffer.from(body.body, body.base64Encoded ? 'base64' : 'utf8')] : [] });
        await session.send('Fetch.continueResponse', { requestId: event.requestId });
      } else {
        const headers = Object.entries(event.request.headers).filter(([name]) => name.toLowerCase() !== 'range').map(([name, value]) => ({ name, value }));
        if (range) headers.push({ name: 'Range', value: range });
        await session.send('Fetch.continueRequest', { requestId: event.requestId, headers });
      }
    } catch (error) { finish({ error: String(error) }); }
  });
  await page.evaluate(url => {
    const probe = new Audio();
    probe.preload = 'metadata';
    window.__qaMediaProbe = probe;
    probe.src = url;
    probe.load();
  }, url);
  const result = await response;
  clearTimeout(timeout);
  await page.evaluate(() => { const probe = window.__qaMediaProbe; if (probe) { probe.pause(); probe.removeAttribute('src'); probe.load(); delete window.__qaMediaProbe; } });
  await session.send('Fetch.disable').catch(() => {});
  await session.detach();
  return result;
}
try {
  await start();
  const beforeImport = await page.evaluate(() => window.desktop.getState());
  await page.getByRole('button', { name: 'Добавить файлы', exact: true }).first().click();
  await page.getByRole('button', { name: 'Воспроизвести QA adversarial Tauri', exact: true }).waitFor({ timeout: 15000 });
  let state = await page.evaluate(() => window.desktop.getState());
  let track = state.tracks[0];
  assert.ok(track?.url, 'native import returned no media URL');

  await check('stale-renderer-save-does-not-drop-native-import', async () => {
    await page.evaluate(snapshot => window.desktop.saveState(snapshot), beforeImport);
    const current = await page.evaluate(() => window.desktop.getState());
    assert.ok(current.tracks.some(item => item.id === track.id), 'older renderer snapshot discarded a native import');
  });

  await check('native-valid-range-returns-exact-bytes', async () => {
    const result = await fileResponse(track.url, 'bytes=0-15');
    assert.equal(result.error, undefined, result.error);
    assert.equal(result.status, 206);
    assert.deepEqual(result.bytes, [...wave.subarray(0, 16)]);
    assert.match(result.headers['content-range'] || '', /^bytes 0-15\//);
  });
  await check('native-unsatisfiable-range-is-rejected', async () => {
    const result = await fileResponse(track.url, `bytes=${wave.length + 5}-${wave.length + 20}`);
    if (result.error) assert.match(result.error, /Media request did not return|Failed to fetch/, 'unexpected invalid-range failure');
    else assert.equal(result.status ?? result.nativeStatus, 416);
  });
  await check('native-asset-scope-denies-unimported-file', async () => {
    const hiddenUrl = track.url.replace(encodeURIComponent(path.basename(fixture)), encodeURIComponent(path.basename(outside))).replace(path.basename(fixture), path.basename(outside));
    assert.notEqual(hiddenUrl, track.url, `cannot build sibling asset URL from ${track.url}`);
    const result = await fileResponse(hiddenUrl);
    assert.ok(result.error || [401, 403, 404].includes(result.status), `unimported file returned ${result.status}`);
    assert.notDeepEqual(result.bytes, [...wave], 'unimported media bytes leaked through the asset scope');
  });
  await check('remove-and-reimport-retains-real-playback', async () => {
    const staleRenderer = await page.evaluate(() => window.desktop.getState());
    const row = page.locator('.track-row').filter({ has: page.locator('.track-meta strong', { hasText: 'QA adversarial Tauri' }) });
    await row.getByRole('button', { name: 'Дополнительные действия' }).click();
    await row.getByRole('button', { name: /^(Удалить|Убрать из библиотеки)$/, exact: true }).click();
    // Submit a snapshot taken before removal, like an IPC save queued behind
    // the native command. The trusted registry must override this stale copy.
    await page.waitForTimeout(100);
    await page.evaluate(snapshot => window.desktop.saveState(snapshot), staleRenderer);
    assert.equal((await page.evaluate(() => window.desktop.getState())).tracks.length, 0);
    await page.waitForTimeout(600);
    const afterRemoveDisk = JSON.parse(await readFile(path.join(profile, 'library.json'), 'utf8'));
    assert.equal(afterRemoveDisk.state.tracks.length, 0, 'debounced save resurrected the removed track');
    await page.getByRole('button', { name: 'Добавить файлы', exact: true }).first().click();
    await page.getByRole('button', { name: 'Воспроизвести QA adversarial Tauri', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Воспроизвести QA adversarial Tauri', exact: true }).click();
    await page.getByRole('button', { name: 'Пауза', exact: true }).waitFor({ timeout: 10000 });
    await page.waitForTimeout(2300);
    assert.ok(Number(await page.getByLabel('Позиция воспроизведения').inputValue()) > 1, 'reimported media did not advance');
    await page.getByRole('button', { name: 'Пауза', exact: true }).click();
    await page.waitForTimeout(700);
  });
  const saved = await page.evaluate(() => window.desktop.getState());
  await check('native-state-survives-process-restart', async () => {
    assert.ok(saved.position > 1);
    await stop();
    await start();
    const restored = await page.evaluate(() => window.desktop.getState());
    assert.equal(restored.tracks.length, 1);
    assert.deepEqual(restored.queue, saved.queue);
    assert.equal(restored.currentTrackId, saved.currentTrackId);
    assert.ok(Math.abs(restored.position - saved.position) < .2, `position ${saved.position} restored as ${restored.position}`);
    assert.equal((await readFile(fixture)).length, wave.length, 'remove/reimport deleted the original media file');
    const disk = JSON.parse(await readFile(path.join(profile, 'library.json'), 'utf8'));
    assert.equal(disk.state.tracks.length, 1);
  });
  await check('immediate-playlist-edit-and-window-close-persists-latest-state', async () => {
    await page.getByRole('button', { name: 'Новый плейлист', exact: true }).first().click();
    await page.getByPlaceholder('Например, Вечерний драйв').fill('QA close immediately');
    await page.getByRole('button', { name: 'Создать', exact: true }).click();
    // Close at once: this must drain renderer saves through the native close
    // handshake, without relying on a fixed wait for the old debounce timer.
    await requestWindowClose();
    const disk = JSON.parse(await readFile(path.join(profile, 'library.json'), 'utf8'));
    assert.ok(disk.state.playlists.some(playlist => playlist.title === 'QA close immediately'), 'closing immediately lost the newly created playlist');
    await start();
    const restored = await page.evaluate(() => window.desktop.getState());
    assert.ok(restored.playlists.some(playlist => playlist.title === 'QA close immediately'));
    assert.equal(restored.tracks.length, 1);
  });
  await check('native-adversarial-has-no-renderer-errors', async () => assert.deepEqual(rendererErrors, []));
} finally {
  await stop();
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
console.log(`QA result: ${failures} failed checks`);
process.exitCode = failures ? 1 : 0;
