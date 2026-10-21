import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Independent real-media source-selection regressions. Fake VK session,
// generated AAC/HLS only. Never connects to user accounts or real media URLs.
const root = new URL('../', import.meta.url);
const work = await mkdtemp(join(tmpdir(), 'pulse-source-selection-'));
const ffmpeg = fileURLToPath(new URL('src-tauri/resources/import-tools/ffmpeg.exe', root));
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const hlsScript = await readFile(new URL('src-tauri/resources/vk_hls.js', root), 'utf8');
const transportScript = await readFile(new URL('src-tauri/src/vk_direct_audio.js', root), 'utf8');
const origin = 'https://vk.com/__qa_selection/';
try {
  await promisify(execFile)(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4', '-c:a', 'aac', '-b:a', '128k', join(work, 'track.m4a')]);
  await promisify(execFile)(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', join(work, 'track.m4a'), '-c:a', 'copy', '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod', '-hls_segment_filename', join(work, 'part%02d.ts'), join(work, 'good.m3u8')]);
  const files = new Map(await Promise.all((await readdir(work)).map(async name => [name, await readFile(join(work, name))])));
  // A deliberately truncated ciphertext is an invalid generated AES-CBC
  // source, matching the class of live decoder failure without real keys.
  files.set('synthetic.key', Buffer.from('0123456789abcdef'));
  files.set('invalid-ciphertext.ts', Buffer.alloc(15, 0x31));

  async function fixture(streams, legacy = `${origin}broken.m3u8`, factoryIncludesVideo = false) {
    const page = await browser.newPage();
    const requested = [];
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.href === 'https://vk.com/audio') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Independent source selection</title>' });
      // Keep every request inside this isolated fixture. Record only a file
      // basename; even failed safety checks cannot persist real signed URLs.
      requested.push(url.pathname.split('/').at(-1));
      if (!url.href.startsWith(origin)) return route.abort();
      const name = url.pathname.split('/').at(-1);
      if (name === 'broken.m3u8') return route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-KEY:METHOD=AES-128,URI="synthetic.key",IV=0x00000000000000000000000000000001\n#EXTINF:4,\ninvalid-ciphertext.ts\n#EXT-X-ENDLIST\n' });
      const data = files.get(name);
      if (!data) return route.fulfill({ status: 404, body: 'Unavailable generated candidate' });
      return route.fulfill({ status: 200, contentType: name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : name.endsWith('.ts') ? 'video/mp2t' : 'audio/mp4', body: data });
    });
    await page.goto('https://vk.com/audio');
    await page.addScriptTag({ content: hlsScript });
    await page.evaluate(() => {
      window.vk = { id: 101 };
      window.__selection = { engines: 0, media: 0, hlsErrors: [] };
      const HlsBase = window.__PULSE_HLS__;
      window.__PULSE_HLS__ = class extends HlsBase {
        constructor(config) {
          const policy = structuredClone(HlsBase.DefaultConfig.fragLoadPolicy);
          // The negative-control source is deterministically malformed; skip
          // retry delays here without replacing the real parser/decrypter.
          for (const retry of [policy.default.errorRetry, policy.default.timeoutRetry]) if (retry) retry.maxNumRetry = 0;
          super({ ...config, fragLoadPolicy: policy });
          window.__selection.engines++;
          this.on(HlsBase.Events.ERROR, (_event, data) => window.__selection.hlsErrors.push({ details: data.details, error: data.error?.message }));
        }
      };
      const AudioBase = window.Audio;
      window.Audio = function(...args) { window.__selection.media++; return new AudioBase(...args); };
    });
    await page.addScriptTag({ content: transportScript });
    await page.evaluate(async ({ streams, legacy, factoryIncludesVideo }) => {
      const raw = []; raw[0] = 7; raw[1] = 42;
      window.__selectionTransport = window.__PULSE_CREATE_DIRECT_AUDIO__();
      window.__selectionTransport.volume(0);
      const player = {
        _ensureHasURL: async data => ({ ...data, url: legacy, extra: { audio_streams: streams } }),
        // Model the official site's legacy preference that filters extras;
        // the transport must still retain explicitly supplied alternatives.
        _impl: { _fixture__createAudio: data => ({ sources: data.sources.filter(source => factoryIncludesVideo || source.infrastructure === 'audio').map(source => ({ ...source, format: ['unknown', 'dash', 'hls', 'mp3'].includes(source.format) ? source.format : undefined })) }) },
      };
      window.__selectionLoad = window.__selectionTransport.load(raw, player).then(() => window.__selectionTransport.play()).then(() => ({ ok: true }), error => ({ ok: false, message: error.message }));
    }, { streams, legacy, factoryIncludesVideo });
    return {
      page, requested, errors,
      async playing() {
        await page.waitForFunction(() => window.__selectionTransport.read().position > .25 || window.__selectionTransport.read().error, null, { timeout: 15000 });
        const outcome = await page.evaluate(async () => ({ state: window.__selectionTransport.read(), load: await window.__selectionLoad, ...window.__selection }));
        assert.equal(outcome.load.ok, true, outcome.load.message);
        assert.ok(outcome.state.playing && outcome.state.position > .25, `No decoded playback: ${JSON.stringify(outcome)}`);
        assert.equal(errors.length, 0, 'renderer exception');
        return outcome;
      },
      async close() { await page.evaluate(() => window.__selectionTransport.destroy()); await page.close(); },
    };
  }

  let f = await fixture([]);
  try {
    const outcome = await f.page.evaluate(async () => ({ load: await window.__selectionLoad, ...window.__selection }));
    assert.equal(outcome.load.ok, false, 'malformed AES negative-control source unexpectedly succeeded');
    assert.equal(outcome.engines, 1);
    assert.ok(outcome.hlsErrors.some(error => error.details === 'fragParsingError' && /failed to decrypt data/i.test(error.error || '')), 'real bundled HLS did not reproduce the intended decryption failure');
    assert.ok(f.requested.includes('synthetic.key') && f.requested.includes('invalid-ciphertext.ts'));
    console.log('PASS negative control reproduces real HLS decryption failure on malformed synthetic ciphertext');
  } finally { await f.close(); }

  f = await fixture([
    { type: 'aac', url: `${origin}track.m4a` },
    { type: 'mp3', url: `${origin}must-not-request-mp3.mp3` },
    { type: 'flac', url: `${origin}must-not-request-flac.flac` },
  ]);
  try {
    const result = await f.playing();
    assert.equal(result.engines, 0, 'broken legacy HLS was started despite a valid explicit AAC file');
    assert.deepEqual(f.requested, ['track.m4a'], 'explicit progressive candidates lost provider order or opened broken HLS');
    console.log('PASS valid provider-first AAC plays without starting the broken HLS candidate or fetching other files');
  } finally { await f.close(); }

  f = await fixture([
    { type: 'aac', url: `${origin}track.m4a` },
    { type: 'mp3', url: `${origin}must-not-request-mp3.mp3` },
    { type: 'flac', url: `${origin}must-not-request-flac.flac` },
  ], `${origin}broken.m3u8`, true);
  try {
    const result = await f.playing();
    assert.equal(result.engines, 0);
    assert.deepEqual(f.requested, ['track.m4a'], 'the official factory format mapping reordered provider-first AAC behind MP3');
    console.log('PASS provider-first AAC remains first when the official factory includes video-infrastructure formats');
  } finally { await f.close(); }

  f = await fixture([{ type: 'aac', url: `${origin}unavailable-aac.m4a` }], `${origin}good.m3u8`);
  try {
    const result = await f.playing();
    assert.equal(result.engines, 1, 'unavailable progressive source did not fall back to real HLS');
    assert.equal(f.requested[0], 'unavailable-aac.m4a', 'HLS was tried before the explicit progressive candidate');
    assert.ok(f.requested.includes('good.m3u8') && f.requested.some(name => name?.endsWith('.ts')), 'real generated HLS segments were not decoded');
    console.log('PASS unavailable progressive file falls back to actual HLS playback');
  } finally { await f.close(); }

  f = await fixture([{ type: 'aac', url: `${origin}unavailable-primary.m4a`, fallback_url: `${origin}track.m4a` }]);
  try {
    const result = await f.playing();
    assert.equal(result.engines, 0, 'a granted progressive fallback was ignored in favor of broken HLS');
    assert.deepEqual(f.requested, ['unavailable-primary.m4a', 'track.m4a']);
    console.log('PASS explicitly supplied fallback_url is decoded after its unavailable primary');
  } finally { await f.close(); }

  f = await fixture([
    { type: 'aac', url: `${origin}drm-must-not-request.m4a`, fallback_url: `${origin}drm-fallback-must-not-request.m4a`, drm: true },
    { type: 'aac', url: 'https://127.0.0.1/private.m4a' },
    { type: 'aac', url: 'http://example.test/insecure.m4a' },
    { type: 'aac', url: 'https://person:password@example.test/credentials.m4a' },
    { type: 'aac', url: 'https://example.test:8443/nondefault-port.m4a' },
    { type: 'aac', url: `${origin}unavailable-safe.m4a`, fallback_url: 'https://localhost/unsafe-fallback.m4a' },
  ], `${origin}good.m3u8`);
  try {
    const result = await f.playing();
    assert.equal(result.engines, 1);
    assert.ok(f.requested.includes('unavailable-safe.m4a'));
    assert.ok(!f.requested.some(name => /drm|private|insecure|credentials|nondefault|unsafe-fallback/.test(name || '')), 'unsafe or DRM source was requested');
    console.log('PASS DRM and unsafe primary/fallback URLs are excluded before real HLS fallback');
  } finally { await f.close(); }
} finally {
  await browser.close();
  // Exact temporary fixture directory only; no profile or app data.
  await rm(work, { recursive: true, force: true });
}
