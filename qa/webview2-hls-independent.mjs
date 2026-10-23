// Actual isolated Tauri/WebView2 and actual hls.js/MSE/AAC decode. Only the HLS
// transport is fulfilled with locally generated audio; no real account, provider
// credentials, media grants, external request or installed profile is used.
// Run alone: the separate QA application owns one WebView2 environment.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertIsolatedNativeBinary } from './assert-isolated-native.mjs';

const executable = process.env.TAURI_QA_EXE || path.join(process.env.LOCALAPPDATA, 'vk-player-build/target/debug/vk-player.exe');
await assertIsolatedNativeBinary(executable);
const ffmpeg = path.resolve('src-tauri/resources/import-tools/ffmpeg.exe');
const root = await mkdtemp(path.join(os.tmpdir(), 'pulse-webview-hls-'));
const profile = path.join(root, 'profile'); await mkdir(profile);
const fixtureDirectory = process.env.PULSE_QA_HLS_FIXTUREDIR ? path.resolve(process.env.PULSE_QA_HLS_FIXTUREDIR) : root;
const port = Number(process.env.PULSE_QA_CDP_PORT || 9236);
assert.ok(port > 1024 && port < 65536);
const environment = { ...process.env, VK_PLAYER_QA_PROFILE: profile, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --autoplay-policy=no-user-gesture-required` };
for (const name of ['WEBVIEW2_USER_DATA_FOLDER', 'VK_PLAYER_QA_FILES', 'VK_PLAYER_QA_SOUNDCLOUD_FILE', 'PULSE_SOUNDCLOUD_CLIENT_ID', 'PULSE_SOUNDCLOUD_CLIENT_SECRET', 'PULSE_SOUNDCLOUD_PROXY']) delete environment[name];
let child, browser, page;
const resources = new Map(), responses = [], rendererErrors = [];
try {
  const code = fixtureDirectory !== root ? 0 : await new Promise((resolve, reject) => {
    const encoder = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=32', '-c:a', 'aac', '-b:a', '128k', '-hls_time', '2', '-hls_list_size', '0', '-hls_segment_filename', path.join(root, '%d.ts'), path.join(root, 'stream.m3u8')], { windowsHide: true, stdio: 'ignore' });
    encoder.on('error', reject); encoder.on('exit', resolve);
  });
  assert.equal(code, 0, 'Could not encode the independent AAC/HLS fixture');
  const manifest = (await readFile(path.join(fixtureDirectory, 'stream.m3u8'), 'utf8')).replace(/(\d+)\.ts/g, '$1');
  resources.set('0', { bytes: Buffer.from(manifest.replace(/^(\d+)$/gm, match => String(Number(match) + 1))), type: 'application/vnd.apple.mpegurl' });
  for (const match of manifest.matchAll(/^(\d+)$/gm)) resources.set(String(Number(match[1]) + 1), { bytes: await readFile(path.join(fixtureDirectory, match[1] + '.ts')), type: 'video/mp2t' });
  const prefix = 'http://pulse-media.localhost/' + 'b'.repeat(48) + '/';
  const hls = await readFile('node_modules/hls.js/dist/hls.min.js', 'utf8');
  child = spawn(executable, [], { windowsHide: true, env: environment, stdio: 'ignore' });
  for (let n = 0; n < 80; n++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 500 }); break; } catch {}
    if (child.exitCode !== null) throw Error('The isolated native application exited before WebView2 was available');
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  assert.ok(browser, 'The isolated WebView2 debugging endpoint is unavailable');
  for (let n = 0; n < 80; n++) {
    page = browser.contexts().flatMap(context => context.pages()).find(item => /tauri\.localhost/.test(item.url()));
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page, 'The isolated native main page is unavailable');
  page.on('pageerror', error => rendererErrors.push(error.message));
  await page.locator('.app-shell').waitFor({ timeout: 15000 });
  await page.route(prefix + '**', async route => {
    const request = route.request(), suffix = request.url().slice(prefix.length), resource = resources.get(suffix);
    if (!resource || request.method() !== 'GET') return route.fulfill({ status: 404, body: '' });
    responses.push({ index: Number(suffix), size: resource.bytes.length });
    await route.fulfill({ status: 200, contentType: resource.type, headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' }, body: resource.bytes });
  });
  const scriptUrl = new URL('/__independent_hls_engine.js', page.url()).href;
  await page.route(scriptUrl, route => route.fulfill({ status: 200, contentType: 'application/javascript', body: hls }));
  await page.addScriptTag({ url: scriptUrl });
  const engine = await page.evaluate(url => {
    const audio = new Audio(); audio.muted = true; audio.crossOrigin = 'anonymous';
    const hls = new window.Hls({ enableWorker: false, autoStartLoad: true, maxBufferLength: 90, maxMaxBufferLength: 120, backBufferLength: 20, maxBufferSize: 8 * 1024 * 1024 });
    const result = window.__independentHls = { audio, hls, events: [], errors: [], started: performance.now(), firstProgress: null, lastTime: 0, maxGap: 0, previousProgress: null };
    for (const event of ['playing', 'waiting', 'stalled', 'error', 'seeking', 'seeked', 'ended']) audio.addEventListener(event, () => result.events.push({ event, position: audio.currentTime, afterMs: Math.round(performance.now() - result.started) }));
    audio.addEventListener('timeupdate', () => { if (audio.currentTime <= result.lastTime) return; const now = performance.now(); if (result.firstProgress === null) result.firstProgress = now; if (result.previousProgress !== null) result.maxGap = Math.max(result.maxGap, now - result.previousProgress); result.previousProgress = now; result.lastTime = audio.currentTime; });
    hls.on(window.Hls.Events.ERROR, (_, detail) => result.errors.push({ fatal: detail.fatal, type: detail.type, details: detail.details, status: detail.response?.code }));
    hls.attachMedia(audio); hls.loadSource(url);
    return { supported: window.Hls.isSupported(), version: window.Hls.version, userAgent: navigator.userAgent };
  }, prefix + '0');
  assert.equal(engine.supported, true, 'WebView2 does not support the shipping HLS.js/MSE path');
  await page.waitForFunction(() => window.__independentHls.audio.readyState >= 3, undefined, { timeout: 15000 });
  await page.evaluate(() => window.__independentHls.audio.play());
  await page.waitForFunction(() => window.__independentHls.audio.currentTime >= 8, undefined, { timeout: 15000 });
  await page.evaluate(() => { window.__independentHls.audio.currentTime = 20; });
  await page.waitForFunction(() => window.__independentHls.audio.currentTime >= 23 && !window.__independentHls.audio.seeking, undefined, { timeout: 10000 });
  await page.evaluate(() => { const result = window.__independentHls; result.audio.pause(); result.audio.currentTime = 0; result.lastTime = 0; result.previousProgress = null; return result.audio.play(); });
  await page.waitForFunction(() => window.__independentHls.audio.currentTime >= 3, undefined, { timeout: 10000 });
  const actual = await page.evaluate(() => { const result = window.__independentHls; result.audio.pause(); return { currentTime: result.audio.currentTime, duration: result.audio.duration, firstProgressMs: Math.round(result.firstProgress - result.started), maxProgressGapMs: Math.round(result.maxGap), buffered: Array.from({ length: result.audio.buffered.length }, (_, index) => [result.audio.buffered.start(index), result.audio.buffered.end(index)]), events: result.events, errors: result.errors }; });
  assert.deepEqual(actual.errors, [], 'The actual WebView2 HLS decoder reported an error');
  assert.deepEqual(rendererErrors, [], 'The isolated application produced renderer exceptions');
  assert.ok(actual.duration > 31 && actual.duration < 34, 'The MSE duration disagrees with the generated recording');
  assert.ok(actual.firstProgressMs < 5000, 'Synthetic clean HLS took more than five seconds to start');
  assert.ok(actual.maxProgressGapMs < 3000, 'Actual media clock stalled for at least three seconds');
  console.log(JSON.stringify({ status: 'passed', engine, decode: actual, mediaRequests: responses.length, receivedBytes: responses.reduce((sum, item) => sum + item.size, 0), limits: ['Generated local AAC transported by Playwright route fulfillment; no real provider or native allocated-session transport', 'No VK login, external network, user profile or physical macOS verification', 'This does not prove another browser would fix provider network failures'] }));
} finally {
  if (page) await page.evaluate(() => { const result = window.__independentHls; result?.audio.pause(); result?.hls.destroy(); }).catch(() => {});
  if (child?.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]); }
  await browser?.close().catch(() => {});
  assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('pulse-webview-hls-'));
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
