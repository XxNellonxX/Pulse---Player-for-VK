import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Independent real media/network regression. Isolated fake VK and generated
// audio only; no live account, native profile or external media requests.
const root = new URL('../', import.meta.url);
const fatalScenario = process.argv.includes('--fatal');
const work = await mkdtemp(join(tmpdir(), 'pulse-independent-hls-'));
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  await promisify(execFile)(fileURLToPath(new URL('src-tauri/resources/import-tools/ffmpeg.exe', root)), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=44100:duration=20', '-c:a', 'aac', '-b:a', '96k', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_filename', join(work, 'part%02d.ts'), join(work, 'index.m3u8')]);
  const files = new Map(await Promise.all((await readdir(work)).map(async name => [name, await readFile(join(work, name))])));
  const page = await browser.newPage();
  let failingRequests = 0;
  let restored = false;
  const faults = [];
  await page.exposeFunction('__restoreSyntheticCdn', () => { restored = true; });
  await page.route('**/*', async route => {
    const request = new URL(route.request().url());
    if (request.href === 'https://vk.com/audio') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>Independent HLS recovery</title>' });
    if (request.hostname !== 'cdn.example.test') return route.abort();
    const name = request.pathname.slice(1);
    if (name === 'part04.ts' && (fatalScenario ? !restored : failingRequests < 3)) {
      if (!failingRequests) await page.waitForFunction(() => window.__transport?.read().position > 4, null, { timeout: 20000 });
      failingRequests++;
      faults.push({ failedRequest: failingRequests, at: Date.now() });
      if (!fatalScenario && failingRequests === 3) restored = true;
      return route.fulfill({ status: 503, contentType: 'text/plain', body: 'Synthetic temporary outage', headers: { 'Access-Control-Allow-Origin': '*' } });
    }
    const data = files.get(name);
    if (!data) return route.fulfill({ status: 404, body: 'Unknown synthetic media' });
    return route.fulfill({ status: 200, contentType: name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t', body: data, headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  await page.goto('https://vk.com/audio');
  await page.addScriptTag({ content: await readFile(new URL('src-tauri/resources/vk_hls.js', root), 'utf8') });
  await page.evaluate(fatalScenario => {
    window.vk = { id: 101 };
    window.__hlsEvents = [];
    window.__hlsEngineCount = 0;
    window.__resolverCalls = 0;
    window.__fatalSeen = false;
    window.__resumeSamples = [];
    const nativeCanPlay = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function(type) { return type === 'application/vnd.apple.mpegurl' ? 'maybe' : nativeCanPlay.call(this, type); };
    const Base = window.__PULSE_HLS__;
    // Reduce prefetch size so real buffered music is playing at the fault.
    // Fatal scenario accelerates only genuine engine request retry delays.
    window.__PULSE_HLS__ = class extends Base {
      constructor(config) {
        const policy = structuredClone(Base.DefaultConfig.fragLoadPolicy);
        if (fatalScenario) {
          for (const retry of [policy.default.errorRetry, policy.default.timeoutRetry]) if (retry) {
            retry.maxNumRetry = 2; retry.retryDelayMs = 60; retry.maxRetryDelayMs = 60;
          }
        }
        super({ ...config, ...(fatalScenario ? { fragLoadPolicy: policy } : {}), maxBufferLength: 4, maxMaxBufferLength: 6 });
        window.__hlsEngineCount++;
        this.on(Base.Events.ERROR, (_event, value) => {
          const telemetry = { type: value.type, details: value.details, fatal: value.fatal, position: this.media?.currentTime || 0 };
          window.__hlsEvents.push(telemetry);
          // Error-controller may escalate the same object after listeners run.
          queueMicrotask(() => {
            telemetry.fatal = value.fatal;
            if (value.fatal) { window.__fatalSeen = true; window.__restoreSyntheticCdn(); }
          });
        });
      }
    };
  }, fatalScenario);
  await page.addScriptTag({ content: await readFile(new URL('src-tauri/src/vk_direct_audio.js', root), 'utf8') });
  await page.evaluate(async () => {
    const raw = []; raw[0] = 7; raw[1] = 42; raw[5] = 20;
    window.__transport = window.__PULSE_CREATE_DIRECT_AUDIO__();
    window.__transport.volume(0);
    await window.__transport.load(raw, { _ensureHasURL: async data => { window.__resolverCalls++; return { ...data, url: 'https://cdn.example.test/index.m3u8' }; } });
    await window.__transport.play();
    window.__sampleTimer = setInterval(() => {
      const state = window.__transport.read();
      if (window.__fatalSeen && state.playing && !state.recovering) window.__resumeSamples.push(state.position);
    }, 100);
  });
  await page.waitForFunction(() => window.__transport.read().position > .3 || window.__transport.read().error);
  await page.waitForFunction(() => window.__hlsEvents.some(event => event.fatal) || window.__transport.read().ended, null, { timeout: 25000 }).catch(async () => {
    console.log(JSON.stringify({ failingRequests, restored, timedOut: await page.evaluate(() => ({ state: window.__transport.read(), events: window.__hlsEvents })) }, null, 2));
    throw new Error('Synthetic stream did not reach expected terminal or fatal state');
  });
  const faultState = await page.evaluate(() => ({ state: window.__transport.read(), events: window.__hlsEvents }));
  console.log(JSON.stringify({ failingRequests, restored, faultState }, null, 2));
  assert.ok(failingRequests >= 3, 'the transient fault was not exercised');
  assert.ok(restored, 'the fake CDN should be healthy after exhausting the first request retries');
  await page.waitForFunction(() => window.__transport.read().ended, null, { timeout: fatalScenario ? 30000 : 22000 }).catch(() => {});
  const after = await page.evaluate(() => window.__transport.read());
  const proof = await page.evaluate(() => {
    clearInterval(window.__sampleTimer);
    return { engineCount: window.__hlsEngineCount, resolverCalls: window.__resolverCalls, fatalSeen: window.__fatalSeen, firstResumedPosition: window.__resumeSamples[0], resumedSampleCount: window.__resumeSamples.length };
  });
  console.log(JSON.stringify({ after, proof }, null, 2));
  assert.ok(proof.engineCount >= 1, 'native maybe bypassed the bundled HLS engine');
  if (fatalScenario) {
    assert.ok(proof.fatalSeen, 'real bundled HLS engine never escalated the network error');
    assert.ok(proof.engineCount > 1 && proof.resolverCalls > 1, 'fatal HLS error did not renew the session source and engine');
    const failedAt = faultState.events.find(event => event.fatal)?.position;
    assert.ok(proof.firstResumedPosition >= failedAt - .1, `renewal restarted the song: failure ${failedAt}, first resumed ${proof.firstResumedPosition}`);
  }
  assert.ok(after.ended && after.position > 19, `temporary CDN error permanently stopped available music at ${after.position.toFixed(2)}s: ${after.error}`);
  console.log(`PASS real HLS recovers after a ${fatalScenario ? 'fatal' : 'transient'} segment outage without a user click`);
} finally {
  await browser.close();
  // Exact test-created directory only, never an application profile.
  await rm(work, { recursive: true, force: true });
}
