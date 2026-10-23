// Clean-profile browser comparison of the shipping hls.js/MSE audio path.
// No user profile, provider credentials, VK login or installed Pulse is used.
// Chrome and bundled Chromium are intentionally excluded at the user's request.
// For a stock Mozilla build, set PULSE_QA_OFFICIAL_FIREFOX_EXE and
// PULSE_QA_GECKODRIVER_EXE. Otherwise the separately installed Playwright
// Firefox is used. --live [--query title] exercises one fresh public VPS grant.
import { chromium, firefox } from 'playwright';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';

const fixtureDirectory = path.resolve(process.env.PULSE_QA_HLS_FIXTURE_DIR || 'release-tauri/browser-audio-fixture');
const reportFile = path.resolve(process.env.PULSE_QA_BROWSER_REPORT || 'release-tauri/browser-audio-matrix-independent.json');
const ffmpeg = path.resolve('src-tauri/resources/import-tools/ffmpeg.exe');
const hashes = [];
const requests = [];
const fixture = new Map();
const results = [];
const live = process.argv.includes('--live');
const queryIndex = process.argv.indexOf('--query');
const query = queryIndex < 0 ? 'Капля испуга' : process.argv[queryIndex + 1];
const trackIndex = process.argv.indexOf('--track');
const expectedTrackId = trackIndex < 0 ? undefined : process.argv[trackIndex + 1];
if (expectedTrackId && !/^[1-9]\d{0,19}$/.test(expectedTrackId)) throw Error('Invalid explicit public track identity');
const gatewayOrigin = 'https://pulse-player.duckdns.org';
const liveResources = new Map();
const upstreamRequests = [];
let liveTrack;
function liveTarget(value, base = gatewayOrigin) {
  const url = new URL(value, base);
  if (url.origin !== gatewayOrigin || url.search || url.hash || !/^\/v1\/media\/[a-f0-9]{48}\/(?:0|[1-9]\d{0,3})$/.test(url.pathname)) throw Error('Live relay rejected a non-gateway media target');
  return url.href;
}
function registerLive(value, base) {
  const url = liveTarget(value, base);
  for (const [key, target] of liveResources) if (target === url) return key;
  if (liveResources.size >= 2048) throw Error('Live fixture exceeded the bounded media registry');
  const key = `/media/${liveResources.size}`; liveResources.set(key, url); return key;
}
async function publicJson(route) {
  const response = await fetch(gatewayOrigin + route, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  upstreamRequests.push({ stage: route.includes('/streams') ? 'grant' : 'search', status: response.status });
  if (response.status !== 200) throw Error(`Public gateway ${route.includes('/streams') ? 'grant' : 'search'} returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 2 * 1024 * 1024) throw Error('Public gateway metadata exceeded the fixture response bound');
  return JSON.parse(bytes);
}
let activeBrowser = '';
await mkdir(fixtureDirectory, { recursive: true });
if (!existsSync(path.join(fixtureDirectory, 'stream.m3u8'))) {
  const encoder = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=32', '-c:a', 'aac', '-b:a', '128k', '-hls_time', '2', '-hls_list_size', '0', '-hls_segment_filename', path.join(fixtureDirectory, '%d.ts'), path.join(fixtureDirectory, 'stream.m3u8')], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '';
  encoder.stderr.on('data', bytes => { errors = (errors + bytes.toString()).slice(-2048); });
  const [code] = await once(encoder, 'exit');
  if (code !== 0) throw Error(`Synthetic AAC encoder failed (${code}): ${errors}`);
}
const manifest = await readFile(path.join(fixtureDirectory, 'stream.m3u8'));
fixture.set('/media/0', { bytes: Buffer.from(manifest.toString().replace(/^(\d+)\.ts$/gm, (_, number) => String(Number(number) + 1))), type: 'application/vnd.apple.mpegurl' });
hashes.push({ file: 'stream.m3u8', sha256: createHash('sha256').update(manifest).digest('hex') });
for (const match of manifest.toString().matchAll(/^(\d+)\.ts$/gm)) {
  const bytes = await readFile(path.join(fixtureDirectory, match[1] + '.ts'));
  fixture.set(`/media/${Number(match[1]) + 1}`, { bytes, type: 'video/mp2t' });
  hashes.push({ file: match[1] + '.ts', sha256: createHash('sha256').update(bytes).digest('hex') });
}
const script = await readFile('node_modules/hls.js/dist/hls.min.js');
fixture.set('/hls.js', { bytes: script, type: 'application/javascript' });
fixture.set('/', { bytes: Buffer.from('<!doctype html><html><body><button id="play">Play</button><script src="/hls.js"></script></body></html>'), type: 'text/html' });
if (live) {
  const search = await publicJson('/v1/soundcloud/tracks?' + new URLSearchParams({ q: query, limit: '10', linked_partitioning: 'true' }));
  const candidate = search.collection?.find(row => row.access === 'playable' && row.streamable !== false && Number(row.duration) >= 30_000 && /^(?:soundcloud:tracks:)?[1-9]\d*$/.test(String(row.urn || row.id)) && (!expectedTrackId || String(row.urn || row.id).replace(/^soundcloud:tracks:/, '') === expectedTrackId));
  if (!candidate) throw Error('No playable public search result with sufficient duration was returned');
  const id = String(candidate.urn || candidate.id).replace(/^soundcloud:tracks:/, '');
  liveTrack = { id, title: candidate.title, artist: candidate.metadata_artist || candidate.user?.username || '', duration: Number(candidate.duration) / 1000 };
  const grant = await publicJson(`/v1/soundcloud/tracks/${id}/streams`);
  const source = grant.hls_aac_160_url || grant.hls_mp3_128_url;
  if (!source) throw Error('The public provider grant has no complete HLS source');
  registerLive(source);
}
const server = http.createServer(async (request, response) => {
  if (live && request.url.startsWith('/media/')) {
    try {
      const target = liveResources.get(request.url);
      if (!target || request.method !== 'GET') throw Error('Invalid live fixture path');
      const headers = request.headers.range ? { range: request.headers.range } : {};
      const upstream = await fetch(target, { headers, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
      upstreamRequests.push({ stage: 'media', browser: activeBrowser, resource: Number(request.url.slice(7)), status: upstream.status });
      if (upstream.status !== 200 && upstream.status !== 206) { response.writeHead(upstream.status, { 'content-length': '0' }); response.end(); return; }
      let bytes = Buffer.from(await upstream.arrayBuffer());
      if (bytes.length > 8 * 1024 * 1024) throw Error('Live fixture media exceeded its bound');
      const type = upstream.headers.get('content-type') || 'application/octet-stream';
      if (/mpegurl/i.test(type) || bytes.subarray(0, 32).toString().startsWith('#EXTM3U')) {
        const text = bytes.toString();
        if (bytes.length > 1024 * 1024 || !text.startsWith('#EXTM3U')) throw Error('Invalid live fixture manifest');
        bytes = Buffer.from(text.split(/\r?\n/).map(line => !line || line.startsWith('#') ? line.replace(/URI="([^"]+)"/g, (_, value) => `URI="${registerLive(value, target)}"`) : registerLive(line, target)).join('\n'));
      }
      const outgoing = { 'content-type': type, 'content-length': bytes.length, 'cache-control': 'no-store', 'access-control-allow-origin': '*' };
      if (upstream.status === 206) outgoing['content-range'] = upstream.headers.get('content-range');
      requests.push({ browser: activeBrowser, path: request.url, bytes: bytes.length, status: upstream.status });
      response.writeHead(upstream.status, outgoing); response.end(bytes);
    } catch {
      upstreamRequests.push({ stage: 'media', browser: activeBrowser, status: 'network-or-validation-error' });
      response.writeHead(502, { 'content-length': '0' }); response.end();
    }
    return;
  }
  const resource = fixture.get(request.url);
  requests.push({ browser: activeBrowser, path: request.url, bytes: resource?.bytes.length || 0, status: resource ? 200 : 404 });
  if (!resource || request.method !== 'GET') { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'content-type': resource.type, 'content-length': resource.bytes.length, 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  response.end(resource.bytes);
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;

// Standard Mozilla Firefox has WebDriver, not Playwright's patched Juggler.
// Keep the browser/profile fully separate and drive only this fixture's page.
function officialFirefoxType(binary, driverBinary) {
  return { async launch() {
    const temporaryProfile = await mkdtemp(path.join(os.tmpdir(), 'pulse-firefox-matrix-'));
    const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    const driver = spawn(driverBinary, ['--host', '127.0.0.1', '--port', String(port), '--log', 'fatal'], { windowsHide: true, stdio: 'ignore' });
    let session, version;
    async function command(method, route, data) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: data ? { 'content-type': 'application/json' } : {}, ...(data ? { body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(20_000) });
      const result = await response.json();
      if (!response.ok || result.value?.error) throw Error(`Firefox WebDriver ${result.value?.error || response.status}: ${String(result.value?.message || '').slice(0, 300)}`);
      return result.value;
    }
    const close = async () => {
      if (session) await command('DELETE', `/session/${session}`).catch(() => {});
      session = undefined;
      if (driver.exitCode === null) { const exited = once(driver, 'exit'); driver.kill(); await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]); }
      if (path.dirname(temporaryProfile) === os.tmpdir() && path.basename(temporaryProfile).startsWith('pulse-firefox-matrix-')) await rm(temporaryProfile, { recursive: true, force: true }).catch(() => {});
    };
    try {
      for (let index = 0; index < 60; index++) {
        try { await command('GET', '/status'); break; } catch { if (index === 59) throw Error('Official Firefox WebDriver did not start'); await new Promise(resolve => setTimeout(resolve, 100)); }
      }
      const created = await command('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { binary, args: ['-headless', '-no-remote', '-profile', temporaryProfile], prefs: { 'browser.shell.checkDefaultBrowser': false, 'browser.startup.homepage': 'about:blank', 'browser.newtabpage.enabled': false, 'datareporting.healthreport.uploadEnabled': false, 'datareporting.policy.dataSubmissionEnabled': false, 'toolkit.telemetry.enabled': false, 'app.update.enabled': false, 'network.captive-portal-service.enabled': false, 'network.connectivity-service.enabled': false } } } } });
      session = created.sessionId; version = created.capabilities.browserVersion;
      const execute = async (fn, argument) => command('POST', `/session/${session}/execute/sync`, { script: `return (${fn.toString()}).apply(null, arguments);`, args: argument === undefined ? [] : [argument] });
      const page = {
        on() {},
        async goto(url) {
          await command('POST', `/session/${session}/url`, { url });
          await execute(() => { window.__matrixExceptions = []; window.addEventListener('error', event => window.__matrixExceptions.push(event.message)); window.addEventListener('unhandledrejection', () => window.__matrixExceptions.push('Unhandled promise rejection')); });
        },
        evaluate: execute,
        async click(selector) { const element = await command('POST', `/session/${session}/element`, { using: 'css selector', value: selector }); await command('POST', `/session/${session}/element/${element['element-6066-11e4-a52e-4f735466cecf']}/click`, {}); },
        async waitForFunction(fn, argument, { timeout = 15_000 } = {}) {
          const deadline = Date.now() + timeout;
          while (Date.now() < deadline) { if (await execute(fn, argument)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
          throw Error('Official Firefox fixture condition timed out');
        },
      };
      const context = { newPage: async () => page, storageState: async () => ({ cookies: await command('GET', `/session/${session}/cookie`), origins: await execute(() => localStorage.length || sessionStorage.length ? [{ origin: location.origin }] : []) }), close: async () => {} };
      return { version: () => version, newContext: async () => context, close };
    } catch (error) { await close(); throw error; }
  } };
}

async function run(name, type, options) {
  activeBrowser = name;
  let browser, context, page;
  const rendererErrors = [], badRequests = [];
  const startedAt = Date.now();
  try {
    browser = await type.launch({ headless: true, ...options });
    context = await browser.newContext({ serviceWorkers: 'block' });
    page = await context.newPage();
    page.on('pageerror', error => rendererErrors.push(error.message));
    page.on('requestfailed', request => badRequests.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText }));
    await page.goto(origin, { waitUntil: 'load' });
    const initialStorage = await context.storageState();
    const engine = await page.evaluate(() => {
      const audio = new Audio(); audio.muted = true; audio.crossOrigin = 'anonymous';
      const supported = window.Hls.isSupported();
      const result = window.__matrix = { audio, events: [], errors: [], samples: [], started: performance.now(), phase: 'startup', firstProgress: null, lastTime: 0, previousProgress: null, maxGap: 0, seekLatency: null };
      const hls = result.hls = new window.Hls({ enableWorker: false, autoStartLoad: true, maxBufferLength: 90, maxMaxBufferLength: 120, backBufferLength: 20, maxBufferSize: 8 * 1024 * 1024 });
      for (const event of ['playing', 'waiting', 'stalled', 'error', 'seeking', 'seeked', 'ended']) audio.addEventListener(event, () => result.events.push({ event, phase: result.phase, position: audio.currentTime, afterMs: Math.round(performance.now() - result.started) }));
      audio.addEventListener('timeupdate', () => {
        const now = performance.now();
        if (result.phase === 'continuous' && audio.currentTime > result.lastTime) {
          if (result.firstProgress === null) result.firstProgress = now;
          if (result.previousProgress !== null) result.maxGap = Math.max(result.maxGap, now - result.previousProgress);
          result.previousProgress = now;
        }
        result.lastTime = audio.currentTime;
      });
      result.timer = setInterval(() => result.samples.push({ phase: result.phase, atMs: Math.round(performance.now() - result.started), position: audio.currentTime, ready: audio.readyState, paused: audio.paused }), 100);
      hls.on(window.Hls.Events.ERROR, (_, detail) => result.errors.push({ phase: result.phase, position: audio.currentTime, fatal: detail.fatal, type: detail.type, details: detail.details, status: detail.response?.code }));
      hls.attachMedia(audio); hls.loadSource(location.origin + '/media/0');
      document.getElementById('play').onclick = () => { result.phase = 'continuous'; return audio.play(); };
      return { supported, version: window.Hls.version, userAgent: navigator.userAgent, audioAac: audio.canPlayType('audio/mp4; codecs="mp4a.40.2"'), mediaSourceAac: Boolean(window.MediaSource?.isTypeSupported('audio/mp4; codecs="mp4a.40.2"')) };
    });
    const browserVersion = browser.version();
    if (!engine.supported || !engine.mediaSourceAac) {
      results.push({ name, status: 'unsupported-codec-or-mse', browserVersion, engine, initialStorage, rendererErrors, limits: ['This installed browser cannot exercise the shipping AAC/MSE path; no playback claim'] });
      return;
    }
    await page.waitForFunction(() => window.__matrix.audio.readyState >= 3, undefined, { timeout: 15_000 });
    await page.click('#play');
    await page.waitForFunction(() => window.__matrix.audio.currentTime >= 10, undefined, { timeout: 18_000 });
    const seekTo = live ? Math.max(12, (await page.evaluate(() => window.__matrix.audio.duration)) - 6) : 24;
    const continuous = await page.evaluate(seekTo => {
      const r = window.__matrix; r.phase = 'seek'; r.seekStarted = performance.now(); r.audio.currentTime = seekTo;
      return { position: r.lastTime, maxProgressGapMs: Math.round(r.maxGap), firstProgressMs: Math.round(r.firstProgress - r.started) };
    }, seekTo);
    await page.waitForFunction(seekTo => window.__matrix.audio.currentTime >= seekTo + 2 && !window.__matrix.audio.seeking, seekTo, { timeout: 15_000 });
    await page.evaluate(seekTo => { const r = window.__matrix; r.seekLatency = performance.now() - r.seekStarted - Math.max(0, r.audio.currentTime - seekTo) * 1000; r.phase = 'near-end'; }, seekTo);
    await page.waitForFunction(() => window.__matrix.audio.ended, undefined, { timeout: 12_000 });
    const playback = await page.evaluate(() => {
      const r = window.__matrix; clearInterval(r.timer);
      return { currentTime: r.audio.currentTime, duration: r.audio.duration, ended: r.audio.ended, decodeError: r.audio.error ? { code: r.audio.error.code, message: r.audio.error.message } : null, firstProgressMs: Math.round(r.firstProgress - r.started), maxProgressGapMs: Math.round(r.maxGap), seekExtraDelayMs: Math.round(r.seekLatency), events: r.events, errors: r.errors, samples: r.samples, rendererExceptions: window.__matrixExceptions || [] };
    });
    const failures = [];
    if (initialStorage.cookies.length || initialStorage.origins.length) failures.push('Context was not initially empty');
    // Seeking may intentionally cancel the old in-flight prefetch. Retain the
    // event in the report but do not call that specific cancellation a decoder
    // failure; all other network/HLS errors still fail the check.
    const unexpectedHlsErrors = playback.errors.filter(error => !(error.fatal === false && error.type === 'networkError' && error.details === 'aborted' && error.phase === 'seek' && error.status == null));
    if (rendererErrors.length || playback.rendererExceptions.length || badRequests.length || playback.decodeError || unexpectedHlsErrors.length) failures.push('Renderer, network or decoder error');
    if (!(continuous.position >= 9.5 && (live ? playback.duration >= 30 : playback.duration > 31 && playback.duration < 34) && playback.ended)) failures.push('Insufficient playback or unexpected duration');
    if (continuous.maxProgressGapMs >= 1500) failures.push('Media progress gap exceeded 1.5 seconds on local media');
    if (playback.firstProgressMs >= 5000) failures.push('Startup exceeded five seconds on local media');
    if (playback.events.some(event => ['waiting', 'stalled'].includes(event.event) && event.phase === 'continuous' && event.position > 1)) failures.push('Unexpected rebuffer during continuous local playback');
    results.push({ name, status: failures.length ? 'failed' : 'passed', failures, browserVersion, engine, initialStorage, continuous, playback, rendererErrors, badRequests, elapsedMs: Date.now() - startedAt });
  } catch (error) {
    const diagnostic = await page?.evaluate(() => {
      const r = window.__matrix; return r ? { currentTime: r.audio.currentTime, ready: r.audio.readyState, duration: r.audio.duration, error: r.audio.error ? { code: r.audio.error.code, message: r.audio.error.message } : null, events: r.events, errors: r.errors } : null;
    }).catch(() => null);
    results.push({ name, status: 'failed', error: error.message, browserVersion: browser?.version(), diagnostic, rendererErrors, badRequests, elapsedMs: Date.now() - startedAt });
  } finally {
    await page?.evaluate(() => { const r = window.__matrix; if (r) { clearInterval(r.timer); r.audio.pause(); r.hls.destroy(); } }).catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

try {
  const edgePath = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  if (existsSync(edgePath)) await run('Microsoft Edge', chromium, { executablePath: edgePath });
  else results.push({ name: 'Microsoft Edge', status: 'unavailable', reason: 'Browser executable is not installed at the expected path' });
  const officialBinary = process.env.PULSE_QA_OFFICIAL_FIREFOX_EXE;
  const geckoBinary = process.env.PULSE_QA_GECKODRIVER_EXE;
  const firefoxPath = process.env.PULSE_QA_FIREFOX_EXE || firefox.executablePath();
  if (!process.argv.includes('--edge-only')) {
    if (officialBinary && geckoBinary) await run('Mozilla Firefox (official, WebDriver)', officialFirefoxType(path.resolve(officialBinary), path.resolve(geckoBinary)), {});
    else if (existsSync(firefoxPath)) await run('Playwright Firefox', firefox, { executablePath: firefoxPath });
    else results.push({ name: 'Playwright Firefox', status: 'unavailable', reason: 'Run npx playwright install firefox to install the isolated QA browser' });
  }
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  const report = { generatedAt: new Date().toISOString(), mode: live ? 'live-managed-gateway' : 'synthetic-loopback', liveTrack, fixture: { directory: fixtureDirectory, description: live ? 'One fresh public gateway HLS grant relayed in memory with an exact gateway-origin allowlist; no account, key or persistent audio cache' : '32-second 440 Hz AAC 128k HLS, two-second segments; exact same bytes and shipping hls.js in both browsers', ...(live ? {} : { hashes }), hlsJsSha256: createHash('sha256').update(script).digest('hex') }, excluded: ['Google Chrome and bundled Chromium: excluded by explicit user instruction'], results, requests, upstreamRequests, limits: ['Fresh isolated browser contexts, no existing browser cookies/cache/extensions', 'Media clock and decoder events measure playback progress; physical speaker output and sub-millisecond audible glitches are not measured', live ? 'Browsers receive the same live grant sequentially through a Node relay; the second run may benefit from the gateway session cache, so this is not a cold-network speed benchmark' : 'Synthetic loopback transport isolates browser/MSE compatibility; it does not prove live VK or SoundCloud network behavior', 'Host VPN and system routing were not changed or independently verified', 'No WebAudio/equalizer path: equalizer disabled as requested; no native application transport is exercised'] };
  await mkdir(path.dirname(reportFile), { recursive: true });
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ reportFile, results: results.map(({ name, status, browserVersion, failures, error, playback }) => ({ name, status, browserVersion, failures, error, firstProgressMs: playback?.firstProgressMs, maxProgressGapMs: playback?.maxProgressGapMs, seekExtraDelayMs: playback?.seekExtraDelayMs })) }));
  if (results.some(result => result.status === 'failed')) process.exitCode = 1;
}
