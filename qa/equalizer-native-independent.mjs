import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { assertIsolatedNativeBinary } from './assert-isolated-native.mjs';

// Only a separately identified debug QA binary and temporary library are used.
const target = process.env.CARGO_TARGET_DIR || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'vk-player-build', 'target');
const exe = process.env.TAURI_QA_EXE || path.join(target, 'debug', 'vk-player.exe');
assert.ok(existsSync(exe), `Build isolated Tauri QA first: ${exe}`);
await assertIsolatedNativeBinary(exe);
const root = await mkdtemp(path.join(os.tmpdir(), 'pulse-equalizer-independent-'));
const profile = path.join(root, 'profile');
const samples = 48000 * 20, wave = Buffer.alloc(44 + samples * 2);
wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVE', 8); wave.write('fmt ', 12); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(48000, 24); wave.writeUInt32LE(96000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(samples * 2, 40);
// Quiet multi-tone samples exercise actual native-file audio without noise.
for (let index = 0; index < samples; index++) wave.writeInt16LE(Math.round((Math.sin(index / 48000 * 2 * Math.PI * 62) + Math.sin(index / 48000 * 2 * Math.PI * 1000)) * 80), 44 + index * 2);
const waveTwo = Buffer.from(wave);
for (let index = 0; index < samples; index++) waveTwo.writeInt16LE(Math.round((Math.sin(index / 48000 * 2 * Math.PI * 125) + Math.sin(index / 48000 * 2 * Math.PI * 2000)) * 80), 44 + index * 2);
const files = [path.join(root, 'EQ native one.wav'), path.join(root, 'EQ native two.wav')];
await Promise.all([writeFile(files[0], wave), writeFile(files[1], waveTwo)]);
let child, browser, page;
const output = [], errors = [], results = [];
async function launch() {
  child = spawn(exe, [], { windowsHide: true, env: { ...process.env, VK_PLAYER_QA_PROFILE: profile, VK_PLAYER_QA_FILES: JSON.stringify(files), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9247 --autoplay-policy=no-user-gesture-required' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => output.push(String(chunk))); child.stderr.on('data', chunk => output.push(String(chunk)));
  for (let retry = 0; retry < 100; retry++) {
    try { browser = await chromium.connectOverCDP('http://127.0.0.1:9247', { timeout: 500 }); break; } catch {}
    if (child.exitCode !== null) throw new Error(`Tauri exited ${child.exitCode}: ${output.join('')}`);
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  assert.ok(browser, `WebView2 CDP unavailable: ${output.join('')}`);
  for (let retry = 0; retry < 100; retry++) { page = browser.contexts().flatMap(context => context.pages()).find(item => /localhost|127\.0\.0\.1|tauri/.test(item.url())); if (page) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.ok(page); page.on('pageerror', error => errors.push(error.message)); await page.locator('.app-shell').waitFor({ timeout: 20000 });
}
async function close() {
  if (child && child.exitCode === null) child.kill(); if (browser) await browser.close().catch(() => {}); browser = null; await new Promise(resolve => setTimeout(resolve, 500));
}
async function settings() { await page.getByRole('button', { name: 'Настройки', exact: true }).click(); await page.locator('.settings-nav').getByRole('button', { name: 'Эквалайзер', exact: true }).click(); await page.locator('.equalizer-settings').waitFor(); }
try {
  await launch();
  await page.getByRole('button', { name: 'Локальные файлы', exact: true }).click();
  await page.getByRole('button', { name: 'Добавить файлы', exact: true }).first().click();
  await page.getByRole('button', { name: 'Воспроизвести EQ native one', exact: true }).waitFor({ timeout: 15000 });
  await settings();
  await page.getByRole('button', { name: /Хип-хоп/ }).click();
  const band = page.getByRole('slider', { name: '31 герц', exact: true });
  await band.focus(); await page.keyboard.press('ArrowDown');
  const preamp = page.getByRole('slider', { name: 'Общий уровень до обработки звука', exact: true });
  await preamp.focus(); await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(1300);
  const saved = (await page.evaluate(() => window.desktop.getState())).settings.equalizer;
  assert.equal(saved.enabled, true); assert.equal(saved.preset, 'custom'); assert.equal(saved.bands[0], 4.5); assert.equal(saved.preamp, -0.5);
  const disk = JSON.parse(await readFile(path.join(profile, 'library.json'), 'utf8'));
  assert.deepEqual((disk.state || disk).settings.equalizer, saved);
  results.push('native save and on-disk settings preserve custom EQ');
  await close(); await launch(); await settings();
  assert.equal(await page.locator('.eq-power').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByRole('slider', { name: '31 герц', exact: true }).inputValue(), '4.5');
  assert.equal(await page.getByRole('slider', { name: 'Общий уровень до обработки звука', exact: true }).inputValue(), '-0.5');
  results.push('process restart restores enabled custom curve and preamp');
  await page.getByRole('button', { name: 'Моя музыка', exact: true }).click();
  await page.getByRole('button', { name: 'Воспроизвести EQ native one', exact: true }).click();
  await page.getByRole('button', { name: 'Пауза', exact: true }).waitFor({ timeout: 10000 });
  await page.waitForTimeout(900);
  assert.ok(Number(await page.getByLabel('Позиция воспроизведения').inputValue()) > 0.4);
  await settings();
  for (const name of [/Рэп/, /Рок/, /Джаз/, /Электроника/, /Поп/, /Хип-хоп/]) await page.getByRole('button', { name }).click();
  await page.locator('.eq-power').click();
  await page.locator('.eq-power').click();
  await page.waitForTimeout(500);
  assert.equal(await page.locator('.eq-error').count(), 0, await page.locator('.eq-error').allTextContents());
  assert.equal(await page.getByRole('button', { name: 'Пауза', exact: true }).count(), 1);
  await page.getByRole('button', { name: 'Пауза', exact: true }).click();
  const paused = Number(await page.getByLabel('Позиция воспроизведения').inputValue()); await page.waitForTimeout(500);
  assert.ok(Math.abs(Number(await page.getByLabel('Позиция воспроизведения').inputValue()) - paused) < 0.3);
  results.push('native local playback advances with EQ and rapid presets do not pause/restart');
  await page.getByRole('button', { name: 'Моя музыка', exact: true }).click();
  await page.getByRole('button', { name: 'Воспроизвести EQ native two', exact: true }).click();
  await page.waitForTimeout(900); assert.ok(Number(await page.getByLabel('Позиция воспроизведения').inputValue()) > 0.4);
  const after = await page.evaluate(() => window.desktop.getState()); assert.equal(after.settings.equalizer.preset, 'hip-hop'); assert.equal(after.settings.equalizer.enabled, true);
  results.push('track replacement retains latest EQ and remains audible-ready');
  assert.deepEqual(errors, []);
  for (const result of results) console.log(`PASS ${result}`);
} finally {
  await close();
  await writeFile(new URL('./equalizer-native-independent-results.json', import.meta.url), JSON.stringify({ checkedAt: new Date().toISOString(), results, errors, output }, null, 2) + '\n');
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
