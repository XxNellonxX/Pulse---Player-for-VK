import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const baseURL = process.env.QA_BASE_URL || 'http://127.0.0.1:5173';
const settings = { theme: 'dark', style: 'minimal', accent: '#bdff62', density: 'comfortable', textScale: 1, reducedMotion: false, volume: .01, repeat: 'off', shuffle: false, closeToTray: false, autoplay: false, autoSkip: false };
const remote = id => ({ id: `vk-101-${id}`, title: `Web ${id}`, artist: 'QA', album: '', duration: 60, url: `vk-web://101/${id}`, source: 'vk', addedAt: id, available: true, remote: { ownerId: 101, audioId: id, inLibrary: true } });
const local = { id: 'local-qa', title: 'Local safe', artist: 'QA', album: '', duration: 60, url: 'https://example.invalid/local.wav', source: 'local', addedAt: 0, available: true };
const state = { version: 1, tracks: [remote(1), remote(2), local], playlists: [], history: [], queue: ['vk-101-1', 'vk-101-2', 'local-qa'], currentTrackId: null, position: 0, settings };
const status = { state: 'connected', mode: 'web', message: '', user: { id: 101, name: 'QA' }, capabilities: [] };
const wave = Buffer.alloc(44 + 8000 * 60 * 2);
wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVE', 8); wave.write('fmt ', 12); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(wave.length - 44, 40);
let failures = 0;

async function run(name, fn, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.route('https://example.invalid/local.wav', route => route.fulfill({ status: 200, contentType: 'audio/wav', body: wave }));
  await page.addInitScript(({ state, status, options }) => {
    if (options.fastWatchdog) {
      const nativeTimeout = window.setTimeout.bind(window);
      window.__qaNativeTimeout = nativeTimeout;
      window.setTimeout = (callback, delay, ...args) => nativeTimeout(callback, delay >= 45000 && delay < 90000 ? options.watchdogDelay || 180 : delay === 15000 ? 180 : delay, ...args);
    }
    const initial = { ...state, tracks: options.directTrack ? state.tracks.map(track => track.id === 'vk-101-1' ? { ...track, url: 'https://example.invalid/local.wav' } : track) : state.tracks, settings: { ...state.settings, repeat: options.repeat || 'off' } };
    window.__qaControls = []; window.__qaControlPending = []; window.__qaState = initial;
    window.__qaEmitPlayback = value => window.__qaPlayback?.({ id: 'vk-101-1', playing: false, buffering: false, position: 0, duration: 60, error: null, ended: false, runId: 'qa-run', ...value });
    window.desktop = {
      getState: async () => initial,
      saveState: async value => { window.__qaState = value; },
      getVkStatus: async () => status,
      refreshVk: async () => ({ status, complete: false, tracks: [], playlists: [] }),
      vkWebControl: async command => {
        window.__qaControls.push(command);
        if (options.delayedPlay && command.operation === 'play') return new Promise(resolve => window.__qaNativeTimeout(() => resolve({ accepted: true, pending: true }), 120));
        if (options.deferredPlay && command.operation === 'play') return new Promise(resolve => window.__qaControlPending.push(resolve));
        return { accepted: true, pending: command.operation === 'play' };
      },
      resolveVkTrack: async id => { if (options.directTrack) return initial.tracks.find(track => track.id === id); throw new Error('delegated playback must not resolve a local audio URL'); },
      getVersion: async () => 'qa',
      onCommand: () => () => {},
      onVkPlayback(callback) { window.__qaPlayback = callback; return () => { if (window.__qaPlayback === callback) delete window.__qaPlayback; }; },
      onVkUpdate(callback) { window.__qaVkUpdate = callback; return () => { if (window.__qaVkUpdate === callback) delete window.__qaVkUpdate; }; },
    };
  }, { state, status, options });
  try {
    await page.goto(baseURL); await page.locator('.app-shell').waitFor();
    await page.waitForFunction(() => !!window.__qaPlayback);
    await fn(page);
    console.log(`PASS ${name}`);
  } catch (error) { failures++; console.log(`FAIL ${name}: ${error.stack}`); }
  finally { await context.close(); }
}

await run('web-command-acceptance-is-not-reported-as-playing', async page => {
  await page.getByRole('button', { name: 'Воспроизвести Web 1', exact: true }).click();
  await page.waitForTimeout(80);
  assert.equal(await page.getByRole('button', { name: 'Пауза', exact: true }).count(), 0);
  await page.evaluate(() => window.__qaEmitPlayback({ playing: true, position: 4 }));
  await page.getByRole('button', { name: 'Пауза', exact: true }).waitFor();
  assert.equal(Number(await page.getByLabel('Позиция воспроизведения').inputValue()), 4);
});

await run('different-official-track-cannot-overwrite-selected-pulse-track', async page => {
  await page.getByRole('button', { name: 'Воспроизвести Web 1', exact: true }).click();
  await page.evaluate(() => window.__qaEmitPlayback({ id: 'vk-101-2', playing: true, position: 30 }));
  assert.equal(await page.locator('.now-meta strong').innerText(), 'Web 1');
  assert.equal(Number(await page.getByLabel('Позиция воспроизведения').inputValue()), 0);
});

await run('official-play-failure-before-source-load-is-visible', async page => {
  await page.getByRole('button', { name: 'Воспроизвести Web 1', exact: true }).click();
  await page.evaluate(() => window.__qaEmitPlayback({ id: null, requestedId: 'vk-101-1', playing: false, error: 'VK rejected source' }));
  await page.waitForTimeout(80);
  assert.equal(await page.locator('.player-error').count(), 1, 'source-less rejection left a permanent spinner');
});

await run('repeat-one-does-not-replay-on-each-duplicate-ended-poll', async page => {
  await page.getByRole('button', { name: 'Воспроизвести Web 1', exact: true }).click();
  await page.evaluate(() => window.__qaEmitPlayback({ playing: true }));
  await page.waitForTimeout(80);
  await page.evaluate(() => window.__qaEmitPlayback({ ended: true, position: 60 }));
  await page.waitForTimeout(50);
  await page.evaluate(() => window.__qaEmitPlayback({ ended: true, position: 60 }));
  await page.waitForTimeout(50);
  const calls = await page.evaluate(() => window.__qaControls.filter(command => command.operation === 'play'));
  assert.equal(calls.length, 2, 'same ended state was counted twice while restart was awaiting official playback');
}, { repeat: 'one' });

await run('switch-to-local-stops-even-an-unconfirmed-official-play', async page => {
  await page.getByRole('button', { name: 'Воспроизвести Web 1', exact: true }).click();
  await page.waitForFunction(() => window.__qaControlPending.length > 0);
  await page.getByRole('button', { name: 'Воспроизвести Local safe', exact: true }).click();
  await page.evaluate(() => window.__qaControlPending.splice(0).forEach(resolve => resolve({ accepted: true })));
  await page.waitForTimeout(120);
  const calls = await page.evaluate(() => window.__qaControls);
  assert.ok(calls.some(command => command.operation === 'stop'), 'official track can start late alongside local playback');
}, { deferredPlay: true });

await run('accepted-web-play-without-official-playing-times-out', async page => {
  await page.getByRole('button', { name: 'Воспроизвести Web 1', exact: true }).click();
  await page.waitForTimeout(270);
  assert.equal(await page.locator('.player-error').count(), 1, 'accepted command with no actual source kept spinning');
  assert.ok((await page.evaluate(() => window.__qaControls)).some(command => command.operation === 'pause'));
}, { fastWatchdog: true });

await run('slow-but-successful-vk-start-is-not-mistaken-for-a-stall', async page => {
  await page.getByRole('button', { name: 'Воспроизвести Web 1', exact: true }).click();
  await page.waitForTimeout(80);
  assert.equal(await page.locator('.player-error').count(), 0, 'start timeout fired within the VK resolver/load budget');
  await page.evaluate(() => window.__qaEmitPlayback({ playing: true, position: 1 }));
  await page.getByRole('button', { name: 'Пауза', exact: true }).waitFor();
}, { fastWatchdog: true, delayedPlay: true, watchdogDelay: 1500 });

await run('continuous-official-buffering-does-not-extend-watchdog-forever', async page => {
  await page.getByRole('button', { name: 'Воспроизвести Web 1', exact: true }).click();
  for (let poll = 0; poll < 6; poll++) {
    await page.evaluate(() => window.__qaEmitPlayback({ buffering: true }));
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(1550);
  assert.equal(await page.locator('.player-error').count(), 1, 'each buffering event restarted the watchdog');
}, { fastWatchdog: true, watchdogDelay: 1500 });

await run('pause-cancels-web-start-watchdog', async page => {
  await page.getByRole('button', { name: 'Воспроизвести Web 1', exact: true }).click();
  await page.locator('.play-button').click();
  await page.waitForTimeout(260);
  assert.equal(await page.locator('.player-error').count(), 0, 'pause later reported the cancelled start as an error');
  assert.equal(await page.locator('.play-button .spin').count(), 0);
}, { fastWatchdog: true });

await run('switch-to-local-cancels-web-watchdog', async page => {
  await page.getByRole('button', { name: 'Воспроизвести Web 1', exact: true }).click();
  await page.getByRole('button', { name: 'Воспроизвести Local safe', exact: true }).click();
  await page.waitForTimeout(260);
  assert.equal(await page.locator('.player-error').count(), 0, 'old web timeout overwrote healthy local playback');
  assert.equal(await page.locator('.now-meta strong').innerText(), 'Local safe');
}, { fastWatchdog: true });

await run('same-track-id-migrates-from-direct-audio-to-website-playback', async page => {
  await page.getByRole('button', { name: 'Воспроизвести Web 1', exact: true }).click();
  await page.getByRole('button', { name: 'Пауза', exact: true }).waitFor();
  // A native migration may retain identity while changing how audio is played.
  // Verify the source URL change is observed independently of currentTrackId.
  await page.evaluate(() => {
    const s = window.__qaState;
    const migrated = { ...s.tracks.find(track => track.id === 'vk-101-1'), source: 'vk', url: 'vk-web://101/1', remote: { ownerId: 101, audioId: 1, inLibrary: true } };
    window.__qaVkUpdate({ complete: true, mode: 'web', status: { state: 'connected', mode: 'web', message: '', user: { id: 101, name: 'QA' }, capabilities: [] }, tracks: [migrated], playlists: [] });
  });
  await page.waitForTimeout(100);
  const calls = await page.evaluate(() => window.__qaControls);
  assert.ok(calls.some(command => command.operation === 'play' && command.id === 'vk-101-1'), 'same-ID URL change never switched source to official playback');
}, { directTrack: true });

await run('official-advertisement-can-finish-without-triggering-15-second-network-timeout', async page => {
  await page.clock.install();
  await page.getByRole('button', { name: 'Воспроизвести Web 1', exact: true }).click();
  await page.evaluate(() => window.__qaEmitPlayback({ advertising: true, buffering: true }));
  await page.clock.fastForward(30000);
  assert.equal(await page.locator('.player-error').count(), 0);
  assert.equal(await page.locator('.player-info').count(), 1);
  await page.evaluate(() => window.__qaEmitPlayback({ advertising: false, playing: true, position: 3 }));
  assert.equal(await page.locator('.player-info').count(), 0);
  await page.getByRole('button', { name: 'Пауза', exact: true }).waitFor();
});

await run('a-frozen-official-advertisement-still-has-a-bounded-wait', async page => {
  await page.clock.install();
  await page.getByRole('button', { name: 'Воспроизвести Web 1', exact: true }).click();
  await page.evaluate(() => window.__qaEmitPlayback({ advertising: true, buffering: true }));
  await page.clock.fastForward(91000);
  assert.equal(await page.locator('.player-error').count(), 1);
  assert.equal(await page.locator('.player-info').count(), 0);
});

await browser.close();
console.log(`QA result: ${failures} failed checks`);
process.exitCode = failures ? 1 : 0;
