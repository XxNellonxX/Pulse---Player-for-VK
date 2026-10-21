import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const baseURL = process.env.QA_BASE_URL || 'http://127.0.0.1:5173';
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });

const sample = Buffer.alloc(44 + 8000 * 8 * 2);
sample.write('RIFF'); sample.writeUInt32LE(sample.length - 8, 4); sample.write('WAVE', 8); sample.write('fmt ', 12); sample.writeUInt32LE(16, 16); sample.writeUInt16LE(1, 20); sample.writeUInt16LE(1, 22); sample.writeUInt32LE(8000, 24); sample.writeUInt32LE(16000, 28); sample.writeUInt16LE(2, 32); sample.writeUInt16LE(16, 34); sample.write('data', 36); sample.writeUInt32LE(8000 * 8 * 2, 40);
const valid = `data:audio/wav;base64,${sample.toString('base64')}`;
const baseSettings = { theme: 'dark', style: 'minimal', accent: '#bdff62', density: 'comfortable', textScale: 1, reducedMotion: false, volume: .01, repeat: 'off', shuffle: false, closeToTray: false, autoplay: false, autoSkip: false };
const tracks = [
  { id: 'edge-a', title: 'Edge A', artist: 'QA', album: '', duration: 8, url: valid, source: 'local', addedAt: 1, available: true },
  { id: 'edge-b', title: 'Edge B', artist: 'QA', album: '', duration: 8, url: valid, source: 'local', addedAt: 2, available: true },
  { id: 'edge-c', title: 'Edge C', artist: 'QA', album: '', duration: 8, url: valid, source: 'local', addedAt: 3, available: true },
];
const makeState = (overrides = {}) => ({ version: 1, tracks, playlists: [], history: [], queue: tracks.map(track => track.id), currentTrackId: null, position: 0, settings: baseSettings, ...overrides });

let failures = 0;
async function run(name, fn, state = makeState(), setup = '') {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.clock.install();
  await page.addInitScript(({ state, setup }) => {
    localStorage.setItem('pulse-preview', JSON.stringify(state));
    const NativeAudio = window.Audio;
    window.__qaAudio = [];
    const FakeAudio = class extends EventTarget {
      constructor() { super(); Object.assign(this, { paused: true, error: null, currentTime: 0, duration: 8, readyState: 0, volume: .01, src: '', loads: 0, plays: 0 }); window.__qaAudio.push(this); }
      load() { this.loads++; this.error = null; this.readyState = 1; queueMicrotask(() => { this.dispatchEvent(new Event('loadedmetadata')); this.dispatchEvent(new Event('waiting')); }); }
      play() { this.plays++; this.paused = false; if (this.readyState >= 3) { this.dispatchEvent(new Event('playing')); return Promise.resolve(); } return new Promise(resolve => this.addEventListener('canplay', () => { if (!this.paused) this.dispatchEvent(new Event('playing')); resolve(); }, { once: true })); }
      pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
      removeAttribute(name) { if (name === 'src') this.src = ''; }
      getAttribute(name) { return name === 'src' ? this.src : null; }
    };
    window.Audio = setup === 'hold-load' || setup === 'error-audio' ? FakeAudio : class extends NativeAudio {
      constructor(...args) { super(...args); this.loads = 0; const nativeLoad = this.load.bind(this); this.load = () => { this.loads++; return nativeLoad(); }; window.__qaAudio.push(this); }
    };
  }, { state, setup });
  try {
    await page.goto(baseURL);
    await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 10000 });
    await fn(page);
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}: ${error.message}`);
  } finally {
    await context.close();
  }
}

// A media error leaves HTMLMediaElement.error set. The public play control then
// takes the error branch, but playTrack keeps the same currentTrackId, so the
// source effect does not run again and no new load is attempted.
await run('error-toggle-reloads-same-track', async page => {
  await page.evaluate(() => { const audio = window.__qaAudio.at(-1); audio.error = { code: 4 }; audio.dispatchEvent(new Event('error')); });
  await page.locator('.player-error').waitFor({ timeout: 5000 });
  const before = await page.evaluate(() => ({ count: window.__qaAudio.length, loads: window.__qaAudio.at(-1).loads, error: Boolean(window.__qaAudio.at(-1).error) }));
  assert.equal(before.error, true, 'fixture did not reach media error state');
  await page.getByRole('button', { name: 'Воспроизвести', exact: true }).click();
  await page.waitForTimeout(250);
  const after = await page.evaluate(() => ({ count: window.__qaAudio.length, loads: window.__qaAudio.at(-1).loads, error: Boolean(window.__qaAudio.at(-1).error) }));
  assert.ok(after.count > before.count || after.loads > before.loads, 'play after media error never reloaded the track source');
}, makeState({ currentTrackId: 'edge-a' }), 'error-audio');

// A stale canplay event may arrive after the user has stopped playback. The
// async loader currently checks only sourceVersion, then calls play() anyway.
await run('pause-during-buffering-does-not-autoplay', async page => {
  await page.getByRole('button', { name: 'Воспроизвести Edge A', exact: true }).click();
  // Native media turns paused=false after a pending play request, before it
  // can emit playing. Request play directly, then press the public pause
  // control while the source loader is still waiting for canplay.
  await page.evaluate(() => { void window.__qaAudio.at(-1).play(); });
  await page.getByRole('button', { name: 'Воспроизвести', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__qaAudio.at(-1).paused), true, 'fixture did not pause the pending play request');
  await page.evaluate(() => { const audio = window.__qaAudio.at(-1); audio.readyState = 3; audio.dispatchEvent(new Event('canplay')); });
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => window.__qaAudio.at(-1).paused), true, 'stale canplay restarted playback after pause');
}, makeState({ currentTrackId: null }), 'hold-load');

// waiting/stalled must eventually either recover or surface an error; a
// permanent waiting state currently leaves the player spinning forever.
await run('stalled-media-does-not-spin-forever', async page => {
  await page.getByRole('button', { name: 'Воспроизвести Edge A', exact: true }).click();
  await page.evaluate(() => { const audio = window.__qaAudio.at(-1); audio.dispatchEvent(new Event('waiting')); audio.dispatchEvent(new Event('stalled')); });
  await page.clock.fastForward(60000);
  const snapshot = await page.locator('.player-error').count();
  assert.ok(snapshot > 0, 'permanent waiting state never surfaced a recovery error');
}, makeState({ currentTrackId: null }), 'hold-load');

// Repeat-one applies to an ended track. An unavailable track must still be
// skipped when auto-skip is on, otherwise a broken source can lock the queue.
await run('repeat-one-does-not-block-error-autoskip', async page => {
  await page.evaluate(() => { const audio = window.__qaAudio.at(-1); audio.error = { code: 4 }; audio.dispatchEvent(new Event('error')); });
  await page.waitForTimeout(150);
  assert.equal(await page.locator('.now-meta strong').innerText(), 'Edge B', 'repeat-one replayed failed media instead of skipping it');
}, makeState({ currentTrackId: 'edge-a', settings: { ...baseSettings, autoSkip: true, repeat: 'one' } }), 'error-audio');

// A short network interruption must not be classified as an unavailable track.
await run('transient-buffering-recovers-without-error', async page => {
  await page.getByRole('button', { name: 'Воспроизвести Edge A', exact: true }).click();
  await page.clock.fastForward(5000);
  await page.evaluate(() => { const audio = window.__qaAudio.at(-1); audio.readyState = 3; audio.dispatchEvent(new Event('canplay')); });
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.player-error').count(), 0, 'a short buffering interruption surfaced an error');
  assert.equal(await page.evaluate(() => window.__qaAudio.at(-1).paused), false, 'buffered media never resumed');
}, makeState(), 'hold-load');

// A one-track queue is a valid repeat-all cycle; currentTrackId is unchanged,
// so relying on a source effect keyed only by id cannot restart the element.
await run('repeat-all-restarts-single-track-queue', async page => {
  await page.evaluate(() => { const audio = window.__qaAudio.at(-1); audio.currentTime = 8; audio.paused = true; audio.dispatchEvent(new Event('ended')); });
  await page.waitForTimeout(100);
  const status = await page.evaluate(() => ({ position: window.__qaAudio.at(-1).currentTime, paused: window.__qaAudio.at(-1).paused }));
  assert.equal(status.position, 0, 'repeat-all did not rewind the only track');
  assert.equal(status.paused, false, 'repeat-all did not restart the only track');
}, makeState({ tracks: tracks.slice(0, 1), queue: ['edge-a'], currentTrackId: 'edge-a', settings: { ...baseSettings, repeat: 'all' } }), 'error-audio');

// The same HTMLAudioElement is reused between tracks. An error from the old
// source can arrive after a fast switch and must not auto-skip the new track.
await run('stale-error-after-switch-does-not-skip-current', async page => {
  await page.getByRole('button', { name: 'Воспроизвести Edge A', exact: true }).click();
  await page.evaluate(() => { window.__oldAudio = window.__qaAudio.at(-1); });
  await page.getByRole('button', { name: 'Воспроизвести Edge B', exact: true }).click();
  await page.evaluate(() => { const audio = window.__oldAudio; audio.error = { code: 4 }; audio.dispatchEvent(new Event('error')); });
  await page.waitForTimeout(150);
  assert.equal(await page.locator('.now-meta strong').innerText(), 'Edge B', 'a late error from the previous source skipped the newly selected track');
}, makeState({ currentTrackId: null, settings: { ...baseSettings, autoSkip: true } }), 'hold-load');

// Cancelling pending playback is a user action, so an orphaned loading
// deadline must not show an unavailable-file error after the pause.
await run('cancel-buffering-does-not-later-report-error', async page => {
  await page.getByRole('button', { name: 'Воспроизвести Edge A', exact: true }).click();
  await page.getByRole('button', { name: 'Воспроизвести', exact: true }).click();
  await page.clock.fastForward(60000);
  assert.equal(await page.locator('.player-error').count(), 0, 'a cancelled load later surfaced an unavailable-track error');
}, makeState(), 'hold-load');

await run('consecutive-media-errors-stop-autoskip', async page => {
  for (let index = 0; index < 3; index++) {
    await page.evaluate(() => { const audio = window.__qaAudio.at(-1); audio.error = { code: 4 }; audio.dispatchEvent(new Event('error')); });
    await page.waitForTimeout(50);
  }
  assert.equal(await page.locator('.now-meta strong').innerText(), 'Edge C');
  assert.match(await page.locator('.player-error').innerText(), /Автопереход остановлен/, 'consecutive errors did not stop automatic skipping');
  assert.equal(await page.evaluate(() => window.__qaAudio.at(-1).paused), true);
}, makeState({ currentTrackId: 'edge-a', settings: { ...baseSettings, autoSkip: true, repeat: 'all' } }), 'error-audio');

await browser.close();
console.log(`QA result: ${failures} failed checks`);
process.exitCode = failures ? 1 : 0;
