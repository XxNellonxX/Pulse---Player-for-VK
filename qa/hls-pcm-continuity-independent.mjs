import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Independent PCM-level check: generated continuous sine, production transport,
// and an AudioWorklet measurement on the audio rendering thread. No VK account,
// signed media, network mutation, or physical speaker output is involved.
const root = new URL('../', import.meta.url);
const control = process.argv.includes('--control-gap');
const stress = process.argv.includes('--stress');
const worker = process.argv.includes('--worker');
const blockedWorker = process.argv.includes('--blocked-worker');
assert.ok(!blockedWorker || worker, '--blocked-worker requires --worker');
const duration = 24;
const work = await mkdtemp(join(tmpdir(), 'pulse-pcm-continuity-'));
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  await promisify(execFile)(fileURLToPath(new URL('src-tauri/resources/import-tools/ffmpeg.exe', root)), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${duration}`, '-c:a', 'aac', '-b:a', '192k', '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod', '-hls_segment_filename', join(work, 'part%02d.ts'), join(work, 'index.m3u8')]);
  const files = new Map(await Promise.all((await readdir(work)).map(async name => [name, await readFile(join(work, name))])));
  const page = await browser.newPage();
  const consoleErrors = [];
  let segmentRequests = 0;
  page.on('pageerror', error => consoleErrors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.href === 'https://vk.com/audio') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>Independent PCM continuity</title>' });
    if (url.origin !== 'https://vk.com' || !url.pathname.startsWith('/__qa_pcm/')) return route.abort();
    const name = url.pathname.split('/').at(-1);
    const data = files.get(name);
    if (!data) return route.fulfill({ status: 404, body: 'Unknown fixture' });
    if (name.endsWith('.ts')) segmentRequests++;
    // Keep sequential loading/transmuxing active during most of playback,
    // rather than prefetching the entire short fixture before stressing it.
    if (stress && name.endsWith('.ts')) await new Promise(resolve => setTimeout(resolve, 600 + Number(name.match(/\d+/)?.[0] || 0) % 4 * 50));
    return route.fulfill({ status: 200, contentType: name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t', body: data });
  });
  await page.goto('https://vk.com/audio');
  await page.addScriptTag({ content: await readFile(new URL('src-tauri/resources/vk_hls.js', root), 'utf8') });
  await page.evaluate(({ worker, blockedWorker }) => {
    window.vk = { id: 101 };
    window.__pcmEvents = [];
    window.__pcmEngines = [];
    window.__pcmWorkers = 0;
    window.__pcmBlockedWorkerAttempts = 0;
    window.__pcmWorkerResponses = {};
    window.__pcmLongTasks = [];
    new PerformanceObserver(entries => {
      for (const entry of entries.getEntries()) window.__pcmLongTasks.push(entry.duration);
    }).observe({ type: 'longtask', buffered: true });
    const NativeWorker = window.Worker;
    window.Worker = new Proxy(NativeWorker, { construct(Target, args) {
      if (blockedWorker) {
        window.__pcmBlockedWorkerAttempts++;
        throw new DOMException('Independent fixture denies blob workers', 'SecurityError');
      }
      window.__pcmWorkers++;
      const created = Reflect.construct(Target, args);
      created.addEventListener('error', event => window.__pcmEvents.push({ kind: 'worker-error', message: event.message }));
      created.addEventListener('message', event => {
        const type = event.data?.event;
        if (typeof type === 'string') window.__pcmWorkerResponses[type] = (window.__pcmWorkerResponses[type] || 0) + 1;
      });
      return created;
    } });
    const Base = window.__PULSE_HLS__;
    window.__PULSE_HLS__ = class extends Base {
      constructor(config) {
        super({ ...config, enableWorker: worker });
        window.__pcmEngines.push(this);
        this.on(Base.Events.ERROR, (_event, data) => window.__pcmEvents.push({ kind: 'hls-error', details: data.details, fatal: data.fatal, position: this.media?.currentTime }));
      }
    };
    const NativeAudio = window.Audio;
    window.Audio = function(...args) {
      const media = new NativeAudio(...args);
      window.__pcmMedia = media;
      for (const event of ['waiting', 'stalled', 'seeking', 'seeked', 'pause', 'playing', 'error']) media.addEventListener(event, () => window.__pcmEvents.push({ kind: event, position: media.currentTime, at: performance.now() }));
      return media;
    };
  }, { worker, blockedWorker });
  await page.addScriptTag({ content: await readFile(new URL('src-tauri/src/vk_direct_audio.js', root), 'utf8') });
  await page.evaluate(async ({ duration, control, stress }) => {
    const raw = []; raw[0] = 7; raw[1] = 42;
    window.__pcmTransport = window.__PULSE_CREATE_DIRECT_AUDIO__();
    await window.__pcmTransport.load(raw, { _ensureHasURL: async data => ({ ...data, url: 'https://vk.com/__qa_pcm/index.m3u8' }) });
    const context = window.__pcmContext = new AudioContext({ sampleRate: 48000 });
    const processor = `class Continuity extends AudioWorkletProcessor {
      constructor() { super(); this.first = -1; this.frames = 0; this.zeros = 0; this.maxZero = 0; this.zeroStart = 0; this.gaps = []; this.last = 0; this.maxStep = 0; this.largeSteps = 0; this.nonzero = 0; this.done = false; }
      process(inputs, outputs) {
        const input = inputs[0]?.[0];
        // Output remains zero, so this test never plays through speakers.
        if (this.done) return true;
        // A disconnected/empty media input is also silence after playback
        // starts. Never omit these render quanta from the observation clock.
        const frames = input?.length || outputs[0]?.[0]?.length || 128;
        for (let i = 0; i < frames; i++) {
          const value = input?.[i] || 0;
          if (this.first < 0 && Math.abs(value) > .0001) this.first = currentFrame + i;
          if (this.first < 0) continue;
          const elapsed = (currentFrame + i - this.first) / sampleRate;
          if (elapsed >= 1 && elapsed < ${duration - 0.75}) {
            this.frames++;
            if (Math.abs(value) > .000001) this.nonzero++;
            this.maxStep = Math.max(this.maxStep, Math.abs(value - this.last));
            if (Math.abs(value - this.last) > .04) this.largeSteps++;
            if (Math.abs(value) < .000001) { if (!this.zeros) this.zeroStart = elapsed; this.zeros++; }
            else if (this.zeros) { this.maxZero = Math.max(this.maxZero, this.zeros); if (this.zeros > sampleRate * .005) this.gaps.push({ start: this.zeroStart, ms: this.zeros / sampleRate * 1000 }); this.zeros = 0; }
          }
          this.last = value;
          if (elapsed >= ${duration - 0.75} && !this.done) { this.maxZero = Math.max(this.maxZero, this.zeros); this.done = true; this.port.postMessage({ measuredSeconds: this.frames / sampleRate, nonzeroSeconds: this.nonzero / sampleRate, maxSilenceMs: this.maxZero / sampleRate * 1000, maxSampleStep: this.maxStep, largeSteps: this.largeSteps, gaps: this.gaps }); }
        }
        return true;
      }
    } registerProcessor('continuity', Continuity);`;
    const blob = URL.createObjectURL(new Blob([processor], { type: 'application/javascript' }));
    await context.audioWorklet.addModule(blob);
    URL.revokeObjectURL(blob);
    const source = context.createMediaElementSource(window.__pcmMedia);
    const gain = context.createGain();
    const node = new AudioWorkletNode(context, 'continuity');
    window.__pcmNode = node;
    node.port.onmessage = event => { window.__pcmResult = event.data; };
    source.connect(gain).connect(node).connect(context.destination);
    await context.resume();
    if (control) { gain.gain.setValueAtTime(0, context.currentTime + 11); gain.gain.setValueAtTime(1, context.currentTime + 11.08); }
    await window.__pcmTransport.play();
    window.__pcmPoll = setInterval(() => window.__pcmTransport.read(), 500);
    window.__pcmStressTicks = 0;
    if (stress) window.__pcmStress = setInterval(() => { window.__pcmStressTicks++; const until = performance.now() + 75; while (performance.now() < until) {} }, 500);
  }, { duration, control, stress });
  await page.waitForFunction(() => window.__pcmResult, null, { timeout: 40000 });
  const result = await page.evaluate(() => ({ pcm: window.__pcmResult, events: window.__pcmEvents, engines: window.__pcmEngines.length, workers: window.__pcmWorkers, blockedWorkerAttempts: window.__pcmBlockedWorkerAttempts, workerResponses: window.__pcmWorkerResponses, stressTicks: window.__pcmStressTicks, mainThreadLongTasks: { count: window.__pcmLongTasks.length, maximumMs: Math.max(0, ...window.__pcmLongTasks) }, state: window.__pcmTransport.read() }));
  result.scenario = control ? 'positive-control-80ms-silence' : stress ? 'production-hls-with-main-thread-and-network-stress' : 'production-hls-baseline';
  result.consoleErrors = consoleErrors;
  result.workerEnabled = worker;
  result.workerBlocked = blockedWorker;
  result.segmentRequests = segmentRequests;
  console.log(JSON.stringify(result, null, 2));
  await writeFile(new URL(`qa/hls-pcm-${control ? 'control' : stress ? 'stress' : 'baseline'}${worker ? '-worker' : ''}${blockedWorker ? '-blocked' : ''}-result.json`, root), JSON.stringify(result, null, 2));
  assert.equal(consoleErrors.length, 0, 'renderer errors');
  assert.ok(result.pcm.measuredSeconds > 21, 'too little PCM was measured');
  assert.equal(result.engines, 1, 'normal playback unexpectedly replaced its engine');
  if (worker && !blockedWorker) assert.ok(result.workers > 0 && result.workerResponses.init > 0 && result.workerResponses.transmuxComplete > 0 && !result.events.some(event => event.kind === 'worker-error'), 'worker candidate did not actually initialize and transmux audio');
  if (blockedWorker) assert.ok(result.blockedWorkerAttempts > 0 && result.workers === 0 && Object.keys(result.workerResponses).length === 0, 'denied worker construction did not exercise inline fallback');
  if (stress) assert.ok(result.stressTicks > 30 && result.mainThreadLongTasks.maximumMs >= 70 && segmentRequests > 20, 'network/main-thread stress was not exercised');
  if (control) assert.ok(result.pcm.maxSilenceMs >= 70 && result.pcm.maxSilenceMs < 100, 'worklet did not detect scheduled 80ms positive control');
  else {
    assert.ok(result.pcm.maxSilenceMs < 10, `silent PCM gap of ${result.pcm.maxSilenceMs.toFixed(2)}ms inside continuous reference audio`);
    assert.equal(result.pcm.largeSteps, 0, 'discontinuous PCM step inside the continuous reference sine');
  }
  console.log(`PASS ${result.scenario}: max silent run ${result.pcm.maxSilenceMs.toFixed(3)}ms`);
} finally {
  await browser.close();
  // Only this newly created, exact fixture directory is removed.
  await rm(work, { recursive: true, force: true });
}
