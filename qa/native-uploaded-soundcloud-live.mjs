// Explicit live regression. Only the VK account/library is synthetic; the real
// packaged App, native IPC, SoundCloud catalog, VPS and private media protocol
// handle actual audio. Never run this against the installed application.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { assertIsolatedNativeBinary } from './assert-isolated-native.mjs';

// --fixtures path/to/ignored.json accepts an array of {id,title,artist,duration,
// sourceId,continuous?,seek?,repeat?,available?,artistCard?}.
// --report also requires an ignored JSON.
const argument = flag => {
  const at = process.argv.indexOf(flag);
  if (at < 0) return undefined;
  assert.ok(process.argv[at + 1] && !process.argv[at + 1].startsWith('--'), `${flag} requires a value`);
  return process.argv[at + 1];
};
const ignoredJson = value => {
  const file = path.resolve(value);
  assert.equal(path.extname(file).toLowerCase(), '.json', 'QA fixture/report must be a JSON file');
  execFileSync('git', ['check-ignore', '--quiet', '--', file], { stdio: 'ignore' });
  return file;
};
const fixtureFile = argument('--fixtures') || process.env.PULSE_QA_NATIVE_FIXTURES;
const reportFile = ignoredJson(argument('--report') || process.env.PULSE_QA_NATIVE_REPORT || 'qa/native-uploaded-soundcloud-live-results.json');
let fixtureValues = [
  { id: 'vk-101-1', title: 'breath', artist: 't1de', duration: 94, sourceId: '2408295021', continuous: true, repeat: true },
  { id: 'vk-101-2', title: 'blue', artist: 'safetypleace, arkale, neea', duration: 149, sourceId: '2405927967' },
];
if (fixtureFile) {
  const bytes = await readFile(ignoredJson(fixtureFile));
  assert.ok(bytes.length <= 65536, 'Fixture JSON is too large');
  fixtureValues = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''));
}
assert.ok(Array.isArray(fixtureValues) && fixtureValues.length > 0 && fixtureValues.length <= 8, 'Expected one to eight fixture tracks');
const tracks = fixtureValues.map(value => {
  const identity = /^vk-([1-9]\d{0,14})-([1-9]\d{0,14})$/u.exec(value.id);
  assert.ok(identity && Number.isSafeInteger(Number(identity[1])) && Number.isSafeInteger(Number(identity[2])), 'Expected a canonical positive own VK fixture ID');
  for (const key of ['title', 'artist']) assert.ok(typeof value[key] === 'string' && value[key].trim() && value[key].length <= 500 && !/[\u0000-\u001f]/u.test(value[key]), `Invalid fixture ${key}`);
  assert.ok(Number.isFinite(value.duration) && value.duration >= 8 && value.duration <= 240, 'Fixture duration must be 8–240 seconds');
  assert.match(value.sourceId, /^[1-9]\d{0,19}$/u, 'Expected a numeric SoundCloud source ID');
  for (const key of ['continuous', 'repeat', 'available']) assert.ok(value[key] === undefined || typeof value[key] === 'boolean', `Invalid ${key} flag`);
  assert.ok(value.artistCard === undefined || ['absent', 'present', 'unknown'].includes(value.artistCard), 'Invalid artistCard fixture');
  const seek = value.seek ?? Math.min(45, value.duration - 4);
  assert.ok(Number.isFinite(seek) && seek >= 0 && seek + 2 < value.duration, 'Invalid fixture seek position');
  return { id: value.id, owner: Number(identity[1]), audio: Number(identity[2]), title: value.title, artist: value.artist, duration: value.duration, sourceId: value.sourceId, continuous: value.continuous === true, repeat: value.repeat === true, available: value.available !== false, artistCard: value.artistCard || 'unknown', seek };
});
const account = tracks[0].owner;
assert.ok(tracks.every(track => track.owner === account), 'Synthetic fixtures must belong to one account');
assert.equal(new Set(tracks.map(track => track.id)).size, tracks.length, 'Duplicate VK fixture ID');
const attempts = [...tracks, ...tracks.filter(track => track.repeat)];
const failFirstManifest = process.argv.includes('--fail-first-manifest');
assert.ok(!failFirstManifest || tracks.length === 1 && attempts.length === 1, 'One manifest fault requires exactly one recording attempt');
const wallBudgetMs = Math.min(600000, 45000 + attempts.reduce((total, track, index) => total + (track.continuous && index < tracks.length ? track.duration * 1000 + 20000 : 45000), 0));
if (process.argv.includes('--check-fixtures')) {
  console.log(JSON.stringify({ status: 'valid', tracks: tracks.map(({ id, sourceId, continuous, repeat, available, artistCard }) => ({ id, sourceId, continuous, repeat, available, artistCard })), attempts: attempts.length, wallBudgetMs }));
  process.exit(0);
}
if (!process.argv.includes('--live')) {
  console.log('Not run: pass --live to request real SoundCloud audio through the configured public VPS.');
  process.exit(0);
}
const executable = process.env.TAURI_QA_EXE || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'vk-player-build/target/debug/vk-player.exe');
await assertIsolatedNativeBinary(executable);
const revision = {
  executableSha256: createHash('sha256').update(await readFile(executable)).digest('hex'),
  sourceHashes: Object.fromEntries(await Promise.all(['src/shared/sourceMatching.ts', 'src/sourceResolution.ts'].map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')]))),
};
const root = await mkdtemp(path.join(os.tmpdir(), 'pulse-native-sc-live-'));
const profile = path.join(root, 'profile'); await mkdir(profile);
const port = Number(process.env.PULSE_QA_CDP_PORT || 9237);
assert.ok(Number.isInteger(port) && port > 1024 && port < 65536);
const environment = { ...process.env, VK_PLAYER_QA_PROFILE: profile,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --autoplay-policy=no-user-gesture-required --host-resolver-rules="MAP vk.com 127.0.0.1,MAP vk.ru 127.0.0.1"` };
for (const name of ['WEBVIEW2_USER_DATA_FOLDER', 'VK_PLAYER_QA_FILES', 'VK_PLAYER_QA_SOUNDCLOUD_FILE', 'PULSE_SOUNDCLOUD_CLIENT_ID', 'PULSE_SOUNDCLOUD_CLIENT_SECRET', 'PULSE_SOUNDCLOUD_PROXY']) delete environment[name];
const scriptData = value => JSON.stringify(value).replace(/</gu, '\\u003c').replace(/\u2028/gu, '\\u2028').replace(/\u2029/gu, '\\u2029');
const html = `<!doctype html><meta charset="utf-8"><title>Pulse isolated live transport QA</title><script>
window.vk={id:${account},user:{first_name:'Synthetic',last_name:'QA'}};
window.__qaFixture=true; window.__qaVkPlayCalls=0;
const rows=${scriptData([...tracks].reverse())}.map(x=>{const r=[];r[0]=x.audio;r[1]=x.owner;r[2]='';r[3]=x.title;r[4]=x.artist;r[5]=x.duration;r[21]=x.available?0:1;if(x.artistCard==='absent')r[17]=[];if(x.artistCard==='present')r[17]=[{id:'1001',name:x.artist}];return r;});
window.ajax={post(url,p,c){setTimeout(()=>{if(url.includes('owner_playlists'))return c.onDone([],0,{});const list=p.playlist_id===-1?rows:[];c.onDone({list,totalCount:list.length,ownerId:vk.id,id:p.playlist_id,hasMore:false});},0);}};
window.ap={_ensureHasURL:async()=>{window.__qaVkPlayCalls++;throw Error('Synthetic VK fixture has no audio. Actual SoundCloud must supply playback.');},getCurrentAudio:()=>null,isPlaying:()=>false,isPaused:()=>true,subscribe(){}};
window.getAudioPlayer=()=>window.ap;
</script><p>Synthetic account/library only. Real SoundCloud audio uses native Pulse transport.</p>`;
let child, browser, page, remote, targetSession;
let phase = 'startup';
const attachedBrowsers = [];
const results = [], responses = [], rendererErrors = [], nativeOutput = [], mediaFailures = [], manifestOrigins = [], mediaTimeline = [];
const runStarted = Date.now();
const faultInjection = { requested: failFirstManifest, kind: 'one synthetic HTTP 503 for first native manifest only', injected: 0, resolveCalls: 0 };
const safeError = error => String(error?.message || error).replace(/https?:\/\/[^\s"'<>]+/gu, '[URL]').replace(/[a-f0-9]{48}/gu, '[capability]').slice(0, 700);
const until = async (predicate, message, budget = 20000) => {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error(message);
};
const registerRoutes = async () => {
  for (const current of attachedBrowsers) for (const context of current.contexts()) await context.route(/^https:\/\/vk\.(?:com|ru)\//, route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
};
try {
  child = spawn(executable, [], { windowsHide: true, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { if (nativeOutput.length < 20) nativeOutput.push(safeError(bytes.toString())); });
  const wallBudget = setTimeout(() => child?.kill(), wallBudgetMs); wallBudget.unref();
  await until(async () => { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 500 }); return true; } catch { assert.equal(child.exitCode, null, 'Isolated QA process exited before attachment'); return false; } }, 'Isolated QA CDP endpoint unavailable');
  attachedBrowsers.push(browser);
  await until(async () => { page = browser.contexts().flatMap(context => context.pages()).find(item => /tauri\.localhost/.test(item.url())); return !!page; }, 'QA main page unavailable');
  await page.addInitScript(() => {
    window.__qaRealAudio = [];
    const NativeAudio = window.Audio;
    window.Audio = function (...args) {
      const value = new NativeAudio(...args); value.muted = true; window.__qaRealAudio.push(value);
      value.__qaMetrics = { gaps: [], events: [], previous: null, ended: false };
      value.addEventListener('timeupdate', () => { const m = value.__qaMetrics, now = performance.now(); if (value.paused || value.seeking) { m.previous = null; return; } if (m.previous !== null) m.gaps.push(Math.round(now - m.previous)); m.previous = now; });
      for (const name of ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'playing', 'abort', 'emptied', 'waiting', 'stalled', 'error', 'ended', 'seeking', 'pause']) value.addEventListener(name, () => { value.__qaMetrics.events.push({ name, atMs: Math.round(performance.now()), position: value.currentTime, readyState: value.readyState, networkState: value.networkState, mediaError: value.error?.code || null }); if (['seeking', 'pause', 'ended'].includes(name)) value.__qaMetrics.previous = null; if (name === 'ended') { value.__qaMetrics.ended = true; value.__qaMetrics.terminal = { position: value.currentTime, duration: value.duration, mediaError: value.error?.code || null }; } });
      return value;
    };
    window.Audio.prototype = NativeAudio.prototype;
  });
  await page.reload(); await page.locator('.app-shell').waitFor({ timeout: 15000 });
  page.on('pageerror', error => rendererErrors.push(safeError(error)));
  const devtools = await page.context().newCDPSession(page); await devtools.send('Network.enable');
  if (failFirstManifest) {
    devtools.on('Fetch.requestPaused', event => {
      let firstManifest = false;
      try { const url = new URL(event.request.url); firstManifest = url.host === 'pulse-media.localhost' && url.pathname.split('/').at(-1) === '0' && faultInjection.injected === 0; } catch {}
      if (firstManifest) {
        faultInjection.injected++;
        void devtools.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 503, responseHeaders: [{ name: 'Content-Type', value: 'text/plain' }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: Buffer.from('Isolated QA: one deliberate initial manifest failure').toString('base64') });
      } else void devtools.send('Fetch.continueRequest', { requestId: event.requestId });
    });
    await devtools.send('Fetch.enable', { patterns: [{ urlPattern: 'http://pulse-media.localhost/*', requestStage: 'Request' }] });
  }
  const mediaRequests = new Map();
  devtools.on('Network.requestWillBeSent', event => {
    if (!/^(?:http:\/\/pulse-media\.localhost\/|pulse-media:)/u.test(event.request.url)) return;
    const url = new URL(event.request.url), last = url.pathname.split('/').at(-1);
    const request = { protocol: url.protocol, host: url.host, resourceIndex: /^\d{1,4}$/u.test(last) ? Number(last) : null, requestNumber: mediaRequests.size, startedAtMs: Date.now() - runStarted, startedPhase: phase };
    mediaRequests.set(event.requestId, request); mediaTimeline.push({ ...request, event: 'request' });
  });
  devtools.on('Network.loadingFailed', event => {
    const request = mediaRequests.get(event.requestId); if (!request) return;
    const failure = { ...request, elapsedMs: Date.now() - runStarted - request.startedAtMs, phase, error: safeError(event.errorText), blockedReason: event.blockedReason };
    mediaFailures.push(failure); mediaTimeline.push({ ...failure, event: 'failed' });
  });
  devtools.on('Network.loadingFinished', event => {
    const request = mediaRequests.get(event.requestId); if (request) mediaTimeline.push({ ...request, event: 'finished', elapsedMs: Date.now() - runStarted - request.startedAtMs, encodedBytes: event.encodedDataLength });
  });
  devtools.on('Network.responseReceived', event => {
    if (!event.response.url.startsWith('http://pulse-media.localhost/')) return;
    const request = mediaRequests.get(event.requestId);
    const response = { status: event.response.status, mime: event.response.mimeType, encodedSeparator: /%2f/iu.test(new URL(event.response.url).pathname), ...(request ? { requestNumber: request.requestNumber, resourceIndex: request.resourceIndex, elapsedMs: Date.now() - runStarted - request.startedAtMs } : {}) };
    responses.push(response); mediaTimeline.push({ ...request, ...response, event: 'response' });
  });
  page.on('response', async response => {
    if (!response.url().startsWith('http://pulse-media.localhost/') || !/mpegurl/u.test(response.headers()['content-type'] || '')) return;
    try {
      const text = await response.text();
      const origins = [...text.matchAll(/(?:^|URI=")((?:https?:\/\/|pulse-media:\/\/)[^\s"]+)/gmu)].map(match => { const url = new URL(match[1]); return { protocol: url.protocol, host: url.host, encodedSeparator: /%2f/iu.test(url.pathname) }; });
      manifestOrigins.push({ extm3u: text.startsWith('#EXTM3U'), lines: text.split('\n').length, origins });
    } catch { manifestOrigins.push({ unreadable: true }); }
  });
  const initial = await page.evaluate(async () => ({ sc: await window.desktop.soundCloudStatus(), vk: await window.desktop.getVkStatus(), state: await window.desktop.getState() }));
  assert.equal(initial.sc.managed, true); assert.equal(initial.state.tracks.length, 0); assert.notEqual(initial.vk.state, 'connected');
  targetSession = await browser.newBrowserCDPSession(); await targetSession.send('Target.setDiscoverTargets', { discover: true });
  targetSession.on('Target.targetCreated', () => { void registerRoutes().catch(() => {}); });
  await registerRoutes(); await page.evaluate(() => window.desktop.connectVk());
  await until(async () => {
    if (attachedBrowsers.length === 1) {
      try { const alternate = await chromium.connectOverCDP(`http://[::1]:${port}`, { timeout: 400 }); attachedBrowsers.push(alternate); } catch {}
    }
    await registerRoutes();
    remote = attachedBrowsers.flatMap(current => current.contexts()).flatMap(context => context.pages()).find(item => item !== page && (/^https:\/\/vk\.(?:com|ru)\//.test(item.url()) || item.url() === 'chrome-error://chromewebdata/'));
    return !!remote;
  }, 'Synthetic VK context unavailable');
  await registerRoutes();
  if (!await remote.evaluate(() => window.__qaFixture === true).catch(() => false)) {
    const remoteDevtools = await remote.context().newCDPSession(remote);
    await remoteDevtools.send('Network.enable'); await remoteDevtools.send('Network.setBypassServiceWorker', { bypass: true });
    remoteDevtools.on('Fetch.requestPaused', event => { void remoteDevtools.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: Buffer.from(html).toString('base64') }); });
    await remoteDevtools.send('Fetch.enable', { patterns: [{ urlPattern: 'https://vk.com/*' }, { urlPattern: 'https://vk.ru/*' }] });
    await remote.goto('https://vk.com/audio'); await remote.waitForFunction(() => window.__qaFixture === true);
  }
  await until(async () => { const state = await page.evaluate(() => window.desktop.getState()); return state.tracks.length === tracks.length && (await page.evaluate(() => window.desktop.getVkStatus())).state === 'connected'; }, 'Synthetic native VK snapshot was not committed');
  const imported = await page.evaluate(async () => (await window.desktop.getState()).tracks.map(({ id, available, artistCard }) => ({ id, available, artistCard })));
  for (const fixture of tracks) {
    const track = imported.find(track => track.id === fixture.id);
    assert.equal(track?.available, fixture.available, 'Native VK snapshot changed fixture availability');
    assert.equal(track?.artistCard, fixture.artistCard, 'Native VK snapshot changed fixture artist-card evidence');
  }
  await page.evaluate(() => {
    window.__qaNativeCalls = [];
    const native = window.desktop, wrapped = { ...native };
    for (const name of ['resolveVkTrack', 'soundCloudStatus', 'soundCloudBinding', 'searchSoundCloud', 'bindSoundCloud', 'resolveSoundCloud']) {
      const original = native[name];
      wrapped[name] = async (...args) => {
        const call = { name, started: performance.now(), startedAtMs: Math.round(performance.now()), ok: false }; window.__qaNativeCalls.push(call);
        try { const value = await original(...args); call.ok = true; call.elapsedMs = Math.round(performance.now() - call.started); if (name === 'searchSoundCloud') { call.count = value.collection.length; call.hasMore = value.hasMore; } if (name === 'resolveSoundCloud') call.sourceId = value.sourceId; if (name === 'resolveVkTrack') { call.source = value.source; call.available = value.available; call.artistCard = value.artistCard; call.urlKind = value.url.split(':')[0]; } return value; }
        catch (error) { call.elapsedMs = Math.round(performance.now() - call.started); call.error = String(error).replace(/https?:\/\/[^\s"'<>]+/gu, '[URL]').replace(/[a-f0-9]{48}/gu, '[capability]').slice(0, 500); throw error; }
      };
    }
    window.desktop = wrapped;
  });
  for (const track of attempts) {
    phase = `${track.title}:start`;
    const repeated = results.some(result => result.id === track.id), started = Date.now();
    const before = responses.length, beforeFailures = mediaFailures.length;
    const callOffset = await page.evaluate(() => window.__qaNativeCalls.length);
    const vkPlaysBefore = await remote.evaluate(() => window.__qaVkPlayCalls);
    try {
    await page.evaluate(() => { for (const audio of window.__qaRealAudio) if (!audio.paused) audio.pause(); window.__qaObservedAudio = null; });
    // Build the real App queue from one visible local result. A natural ended
    // event must not silently start another fixture before metrics are read.
    await page.keyboard.press('Control+k');
    await page.locator('.search-scope').getByRole('button', { name: 'Моя музыка', exact: true }).click();
    await page.locator('#global-search').fill(track.title);
    await until(async () => await page.locator('.track-row').count() === 1 && await page.locator('.track-row .track-meta strong').textContent() === track.title, `Local search did not isolate ${track.title}`, 5000);
    const play = page.getByRole('button', { name: `Воспроизвести ${track.title}`, exact: true });
    await play.waitFor({ timeout: 5000 });
    // A repeated single fixture can retain the same element; begin at zero.
    if (repeated) await page.evaluate(() => { for (const audio of window.__qaRealAudio) if (audio.readyState >= 3 && Number.isFinite(audio.duration)) audio.currentTime = 0; });
    await play.click();
    await until(async () => await page.evaluate(title => document.querySelector('.track-row.active .track-meta strong')?.textContent === title && window.__qaRealAudio.some(audio => !audio.paused && audio.readyState >= 3 && audio.currentTime >= 3), track.title), `Actual native ${track.title} audio failed to advance`, 30000);
    const firstProgressMs = Date.now() - started;
    console.log('PROGRESS ' + JSON.stringify({ track: track.title, repeated, positionAtLeast: 3, elapsedMs: firstProgressMs, successfulNativeMediaResponses: responses.slice(before).filter(response => [200, 206].includes(response.status)).length }));
    const binding = await page.evaluate(id => window.desktop.soundCloudBinding(id), track.id);
    assert.equal(binding?.id, track.sourceId); assert.equal(binding?.selection, 'metadata');
    await page.evaluate(() => { window.__qaObservedAudio = window.__qaRealAudio.find(audio => !audio.paused && audio.readyState >= 3); });
    const continuous = track.continuous && !repeated;
    if (continuous) {
      phase = `${track.title}:continuous`;
      await until(async () => await page.evaluate(() => window.__qaObservedAudio.__qaMetrics.ended), `Full native ${track.title} recording failed to reach ended`, Math.ceil(track.duration * 1000 + 15000));
    } else {
      phase = `${track.title}:seek`;
      await page.evaluate(seek => { window.__qaObservedAudio.currentTime = seek; }, track.seek);
      await until(async () => await page.evaluate(seek => !window.__qaObservedAudio.paused && window.__qaObservedAudio.currentTime >= seek + 2 && window.__qaObservedAudio.currentTime < seek + 10, track.seek), `Native ${track.title} seek failed`, 15000);
    }
    const observed = await page.evaluate(continuous => {
      const audio = window.__qaObservedAudio;
      const metrics = audio.__qaMetrics;
      return { position: continuous ? metrics.terminal.position : audio.currentTime, duration: continuous ? metrics.terminal.duration : audio.duration, muted: audio.muted, mediaError: continuous ? metrics.terminal.mediaError : audio.error?.code || null, ended: metrics.ended, maxProgressGapMs: Math.max(0, ...metrics.gaps), events: metrics.events };
    }, continuous);
    assert.equal(observed.mediaError, null); assert.ok(Math.abs(observed.duration - track.duration) < 2);
    const currentResponses = responses.slice(before); assert.ok(currentResponses.some(response => [200, 206].includes(response.status))); assert.ok(currentResponses.every(response => [200, 206].includes(response.status) || failFirstManifest && response.status === 503));
    assert.equal(await remote.evaluate(() => window.__qaVkPlayCalls), vkPlaysBefore, 'The App fell back to synthetic VK instead of actual native SoundCloud');
    results.push({ status: 'passed', id: track.id, track: track.title, sourceId: binding.id, importedAvailable: track.available, importedArtistCard: track.artistCard, repeated, continuous, firstThreeSecondsMs: firstProgressMs, ...observed, nativeMediaResponses: currentResponses.length, mediaFailures: mediaFailures.slice(beforeFailures) });
    console.log('PASS ' + JSON.stringify(results.at(-1)));
    } catch (error) {
      const calls = await page.evaluate(offset => window.__qaNativeCalls.slice(offset).map(({ started, ...call }) => call), callOffset).catch(() => []);
      const state = await page.evaluate(async id => { const binding = await window.desktop.soundCloudBinding(id).catch(() => null); return { binding: binding ? { id: binding.id, selection: binding.selection } : null, audio: window.__qaRealAudio.map(audio => ({ position: audio.currentTime, duration: Number.isFinite(audio.duration) ? audio.duration : null, paused: audio.paused, readyState: audio.readyState, networkState: audio.networkState, mediaError: audio.error?.code || null, events: audio.__qaMetrics.events })), notices: [...document.querySelectorAll('[role="alert"],.player-error')].map(node => node.textContent?.slice(0, 300)) }; }, track.id).catch(() => null);
      results.push({ status: 'failed', id: track.id, track: track.title, expectedSourceId: track.sourceId, importedAvailable: track.available, importedArtistCard: track.artistCard, repeated, error: safeError(error), elapsedMs: Date.now() - started, calls, state, responses: responses.slice(before), mediaFailures: mediaFailures.slice(beforeFailures) });
      console.log('FAIL ' + JSON.stringify(results.at(-1)));
      process.exitCode = 1;
      // Keep the failure as a failure, but release its isolated attempt so later
      // fixtures still test the real source path rather than abandoned sessions.
      await page.evaluate(async () => { for (const audio of window.__qaRealAudio) audio.pause(); await window.desktop.releaseSoundCloud(); }).catch(() => {});
    }
  }
  const calls = await page.evaluate(() => window.__qaNativeCalls.map(({ started, ...call }) => call));
  faultInjection.resolveCalls = calls.filter(call => call.name === 'resolveSoundCloud').length;
  if (failFirstManifest) {
    assert.equal(faultInjection.injected, 1, 'Native manifest fault was not injected');
    assert.ok(faultInjection.resolveCalls >= 2, 'Playback recovered without exercising the native SoundCloud renewal path');
  }
  const passed = results.length === attempts.length && results.every(result => result.status === 'passed') && rendererErrors.length === 0;
  if (!passed) process.exitCode = 1;
  const report = { status: passed ? 'passed' : 'failed', testedAt: new Date().toISOString(), revision, fixtureCount: tracks.length, attemptCount: attempts.length, ...(failFirstManifest ? { faultInjection } : {}), results, calls, responses, manifestOrigins, mediaFailures, mediaTimeline, rendererErrors, limits: ['Synthetic VK account/library, genuine native SoundCloud IPC/media and actual packaged App/HLS', 'Muted audio verifies decoder/media clock, not physical output or audible microstutters', 'No real VK cookies, user profile or credentials used; no physical Mac check', 'HLS instance is module-private; native request timings and actual Audio events are observed, HLS internal error codes are unavailable', ...(failFirstManifest ? ['One initial native manifest HTTP 503 was deliberately injected; this does not prove the cause of any prior live failure'] : []), 'Only the explicitly listed recordings and repeat attempts were exercised, not universal provider availability'] };
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} catch (error) {
  const report = { status: 'failed', testedAt: new Date().toISOString(), revision, ...(failFirstManifest ? { faultInjection } : {}), results, responses, manifestOrigins, mediaFailures, mediaTimeline, rendererErrors, error: safeError(error), nativeOutput };
  report.targets = await targetSession?.send('Target.getTargets').then(value => value.targetInfos.map(item => ({ type: item.type, origin: (() => { try { return new URL(item.url).origin; } catch { return 'unknown'; } })() }))).catch(() => null);
  report.qaFiles = (await readdir(profile, { recursive: true }).catch(() => [])).filter(name => /DevToolsActivePort|vk-webview|vk-web-session/u.test(name)).slice(0, 20);
  if (page) report.state = await page.evaluate(async () => ({ vk: (await window.desktop.getVkStatus()).state, tracks: (await window.desktop.getState()).tracks.map(({ id, title, artist, duration, artistCard, available, source }) => ({ id, title, artist, duration, artistCard, available, source })), settings: { preferSoundCloud: (await window.desktop.getState()).settings.preferSoundCloud }, calls: window.__qaNativeCalls?.map(({ started, ...call }) => call), audio: window.__qaRealAudio?.map(audio => ({ position: audio.currentTime, duration: Number.isFinite(audio.duration) ? audio.duration : null, paused: audio.paused, error: audio.error?.code || null, readyState: audio.readyState, metrics: audio.__qaMetrics })), notices: [...document.querySelectorAll('[role="alert"],.player-error')].map(node => node.textContent?.slice(0, 300)) })).catch(() => null);
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report)); process.exitCode = 1;
} finally {
  phase = 'cleanup';
  if (page) await page.evaluate(async () => { for (const audio of window.__qaRealAudio || []) audio.pause(); await window.desktop.releaseSoundCloud(); }).catch(() => {});
  if (child?.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]); }
  for (const current of attachedBrowsers) await current.close().catch(() => {});
  assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('pulse-native-sc-live-'));
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
