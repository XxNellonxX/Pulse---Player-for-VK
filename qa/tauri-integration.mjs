import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { assertIsolatedNativeBinary } from './assert-isolated-native.mjs';

const target = process.env.CARGO_TARGET_DIR || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'vk-player-build', 'target');
const exe = process.env.TAURI_QA_EXE || (existsSync(path.join(target, 'debug', 'vk-player.exe')) ? path.join(target, 'debug', 'vk-player.exe') : fileURLToPath(new URL('../src-tauri/target/debug/vk-player.exe', import.meta.url)));
assert.ok(existsSync(exe), `Build Tauri first; binary not found: ${exe}`);
await assertIsolatedNativeBinary(exe);
const root = await mkdtemp(path.join(os.tmpdir(), 'vk-player-qa-tauri-'));
const profile = path.join(root, 'profile');
const sampleRate = 8000, samples = sampleRate * 30;
const wave = Buffer.alloc(44 + samples * 2);
wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVE', 8); wave.write('fmt ', 12); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(sampleRate, 24); wave.writeUInt32LE(sampleRate * 2, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(samples * 2, 40);
const fixture = path.join(root, 'QA native Tauri.wav');
await writeFile(fixture, wave);
let child, browser;
const output = [];
try {
  child = spawn(exe, [], { windowsHide: true, env: { ...process.env, VK_PLAYER_QA_PROFILE: profile, VK_PLAYER_QA_FILES: JSON.stringify([fixture]), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9223 --autoplay-policy=no-user-gesture-required' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => output.push(String(chunk)));
  child.stderr.on('data', chunk => output.push(String(chunk)));
  child.on('error', error => output.push(error.message));
  for (let i = 0; i < 120; i++) {
    try { browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 1000 }); break; } catch {}
    if (child.exitCode !== null) throw new Error(`Tauri exited ${child.exitCode}: ${output.join('')}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(browser, `WebView2 CDP unavailable. ${output.join('')}`);
  let page;
  for (let i = 0; i < 100; i++) {
    page = browser.contexts().flatMap(context => context.pages()).find(item => /localhost|127\.0\.0\.1|tauri/.test(item.url()));
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page, 'No Tauri renderer WebView');
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.locator('.app-shell').waitFor({ timeout: 20000 });
  assert.equal(await page.evaluate(() => typeof window.desktop?.importFiles), 'function');
  console.log('PASS Tauri native bridge and renderer start');
  await page.getByRole('button', { name: 'Добавить файлы', exact: true }).first().click();
  await page.getByRole('button', { name: 'Воспроизвести QA native Tauri', exact: true }).waitFor({ timeout: 15000 });
  console.log('PASS Tauri imports real WAV metadata');
  await page.getByRole('button', { name: 'Воспроизвести QA native Tauri', exact: true }).click();
  await page.getByRole('button', { name: 'Пауза', exact: true }).waitFor({ timeout: 10000 });
  await page.waitForTimeout(2600);
  assert.ok(Number(await page.getByLabel('Позиция воспроизведения').inputValue()) > 1, 'WebView2 audio did not advance');
  console.log('PASS WebView2 plays native file through scoped media URL');
  await page.getByRole('button', { name: 'Пауза', exact: true }).click();
  await page.waitForTimeout(700);
  const state = await page.evaluate(() => window.desktop.getState());
  assert.equal(state.tracks.length, 1);
  assert.ok(state.position > 1);
  assert.equal(state.tracks[0].title, 'QA native Tauri');
  console.log('PASS Tauri state round-trip keeps queue and position');
  const disk = JSON.parse(await readFile(path.join(profile, 'library.json'), 'utf8'));
  assert.equal((disk.state || disk).tracks.length, 1);
  console.log('PASS isolated Tauri profile saved on disk');
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('button', { name: 'Аккаунт VK', exact: true }).click();
  await page.getByRole('button', { name: 'Подключить', exact: true }).click();
  await page.waitForTimeout(300);
  let vk = await page.evaluate(async () => await Promise.race([
    window.desktop.getVkStatus(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Native bridge stalled after opening official VK window')), 5000)),
  ]));
  for (let retry = 0; retry < 50 && vk.mode === 'web' && vk.state === 'connecting'; retry++) {
    await page.waitForTimeout(100);
    vk = await page.evaluate(() => window.desktop.getVkStatus());
  }
  if (vk.mode === 'web') {
    assert.ok(['waiting-login', 'connecting', 'error'].includes(vk.state), `unexpected guest web-session state ${vk.state}`);
    assert.notEqual(vk.state, 'connected', 'isolated guest profile fabricated a signed-in account');
  } else assert.equal(vk.state, 'not-configured');
  assert.equal(pageErrors.length, 0, pageErrors.join('; '));
  console.log('PASS guest VK state is explicit and native bridge remains responsive');
} finally {
  if (child && child.exitCode === null) child.kill();
  if (browser) await browser.close().catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 500));
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
