import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// Real Chromium + bundled hls.js, generated AAC/TS only. No VK account, no
// native shell, no production data. This catches timer/decoder behaviour that
// a VM fake cannot model.
const work = await mkdtemp(join(tmpdir(), 'pulse-slow-browser-'));
const ffmpeg = fileURLToPath(new URL('../src-tauri/resources/import-tools/ffmpeg.exe', import.meta.url));
const hlsScript = await readFile(new URL('../src-tauri/resources/vk_hls.js', import.meta.url), 'utf8');
const transportScript = await readFile(new URL('../src-tauri/src/vk_direct_audio.js', import.meta.url), 'utf8');
const origin = 'https://vk.com/__qa_slow/';
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const exec = promisify(execFile);
const results = [];
try {
  await exec(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', '-c:a', 'aac', '-b:a', '128k', join(work, 'track.m4a')]);
  await exec(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', join(work, 'track.m4a'), '-c:a', 'copy', '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod', '-hls_segment_filename', join(work, 'part%02d.ts'), join(work, 'good.m3u8')]);
  const files = new Map(await Promise.all((await readdir(work)).map(async name => [name, await readFile(join(work, name))])));

  async function run(name, { delayFirst = 0, fallback = 'same' }) {
    const page = await browser.newPage(); const requested = []; let firstPart = true;
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.href === 'https://vk.com/audio') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>slow QA</title>' });
      if (!url.href.startsWith(origin)) return route.abort();
      let base = url.pathname.split('/').at(-1); requested.push(base);
      if (base === 'primary.m3u8' || base === 'alternate.m3u8') base = 'good.m3u8';
      const body = files.get(base);
      if (!body) return route.fulfill({ status: 404, body: 'missing fixture' });
      if (delayFirst && /^part\d+\.ts$/.test(base) && firstPart) { firstPart = false; await new Promise(resolve => setTimeout(resolve, delayFirst)); }
      return route.fulfill({ status: 200, contentType: base.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : base.endsWith('.ts') ? 'video/mp2t' : 'audio/mp4', body });
    });
    await page.goto('https://vk.com/audio'); await page.addScriptTag({ content: hlsScript }); await page.evaluate(() => {
      window.vk = { id: 101 }; window.__slowBrowserMetrics = { engines: 0, media: 0, started: performance.now(), firstPlayingMs: null };
      const HlsBase = window.__PULSE_HLS__;
      window.__PULSE_HLS__ = class extends HlsBase { constructor(config) { super(config); window.__slowBrowserMetrics.engines++; } };
      const NativeAudio = window.Audio;
      window.Audio = function (...args) { const audio = new NativeAudio(...args); window.__slowBrowserMetrics.media++; audio.addEventListener('playing', () => { window.__slowBrowserMetrics.firstPlayingMs ??= performance.now() - window.__slowBrowserMetrics.started; }); return audio; };
    }); await page.addScriptTag({ content: transportScript });
    await page.evaluate(({ origin, fallback }) => {
      const raw = { ownerId: 101, id: 7, __pulseResolveSource: async () => ({ ownerId: 101, id: 7, url: `${origin}primary.m3u8` }), __pulseFallbackSource: async () => fallback === 'same' ? ({ ownerId: 101, id: 7, url: `${origin}primary.m3u8` }) : ({ ownerId: 101, id: 7, url: `${origin}alternate.m3u8` }) };
      window.__slowTransport = window.__PULSE_CREATE_DIRECT_AUDIO__(); window.__slowTransport.volume(0); window.__slowResult = window.__slowTransport.load(raw, {}).then(() => window.__slowTransport.play()).then(() => ({ ok: true }), error => ({ ok: false, error: error.message }));
    }, { origin, fallback });
    await page.waitForFunction(() => window.__slowTransport.read().position > .3 || window.__slowTransport.read().error, null, { timeout: 30000 });
    const result = await page.evaluate(async () => ({ result: await window.__slowResult, state: window.__slowTransport.read(), metrics: window.__slowBrowserMetrics }));
    results.push({ name, requested, result: { ok: result.result.ok, error: result.result.error || null }, metrics: { engines: result.metrics.engines, media: result.metrics.media, firstPlayingMs: Math.round(result.metrics.firstPlayingMs) }, state: { playing: result.state.playing, position: result.state.position, bufferedAhead: result.state.bufferedAhead, error: Boolean(result.state.error) } });
    await page.evaluate(() => window.__slowTransport.destroy()); await page.close();
  }
  await run('same-source-delayed-first-segment', { delayFirst: 6800, fallback: 'same' });
  await run('distinct-source-hedge', { delayFirst: 22000, fallback: 'distinct' });
  for (const result of results) console.log(JSON.stringify(result));
  assert.equal(results.length, 2);
  assert.ok(results.every(result => result.result.ok && result.state.playing), JSON.stringify(results));
  assert.equal(results[0].metrics.engines, 1, 'the same slow HLS delivery was restarted');
  assert.equal(results[0].metrics.media, 1, 'a slow but usable delivery created unnecessary media elements');
  assert.ok(results[0].metrics.firstPlayingMs >= 6500 && results[0].metrics.firstPlayingMs < 10000);
  assert.ok(results[1].requested.includes('alternate.m3u8'), JSON.stringify(results[1]));
  assert.ok(results[1].metrics.firstPlayingMs < 6000, 'a distinct responsive fallback was delayed behind the slow original');
} finally { await browser.close(); await rm(work, { recursive: true, force: true }); }
