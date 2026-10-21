import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// Headless large-library probe. The synthetic playback callback advances time;
// no native executable, media request, desktop window or VK account is used.
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const baseURL = process.env.QA_BASE_URL || 'http://127.0.0.1:5173';
const settings = { theme: 'dark', style: 'minimal', accent: '#bdff62', density: 'comfortable', textScale: 1, reducedMotion: true, volume: .01, repeat: 'off', shuffle: false, closeToTray: false, autoplay: false, autoSkip: false };
const tracks = Array.from({ length: 20000 }, (_, index) => ({ id: `vk-101-${index + 1}`, title: `Performance track ${index + 1}`, artist: 'QA artist', album: 'QA album', duration: 240, source: 'vk', url: `vk-web://101/${index + 1}`, addedAt: index, available: true, remote: { ownerId: 101, audioId: index + 1, inLibrary: true } }));
const playlists = Array.from({ length: 78 }, (_, index) => ({ id: `vk-playlist-101-${index}`, title: `Performance playlist ${index}`, createdAt: index, trackIds: tracks.slice(index * 200, index * 200 + 200).map(track => track.id), remote: { ownerId: 101, playlistId: index } }));
const state = { version: 1, tracks, playlists, history: [], queue: tracks.map(track => track.id), currentTrackId: null, position: 0, settings };
const status = { state: 'connected', mode: 'web', message: '', user: { id: 101, name: 'Performance QA' }, capabilities: [], syncProgress: { phase: 'complete', tracks: 20000, playlists: 78, completedPlaylists: 78 } };
let failures = 0;

async function run(name, check) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(({ state, status }) => {
    window.__positionSaves = [];
    window.__positionFailure = false;
    window.__positionClosed = 0;
    window.__positionControlCalls = [];
    window.__positionLast = { id: null, playing: false, position: 0, duration: 240 };
    window.__positionEmit = (position, playing = true) => {
      window.__positionLast = { id: 'vk-101-1', requestedId: 'vk-101-1', playing, position, duration: 240, buffering: false, advertising: false, ended: false, runId: 'performance' };
      window.__positionPlayback(window.__positionLast);
    };
    window.desktop = {
      getState: async () => state,
      saveState: async value => {
        window.__positionSaves.push({ at: Date.now(), position: value.position, currentTrackId: value.currentTrackId, trackCount: value.tracks.length, playlistCount: value.playlists.length, volume: value.settings.volume });
        if (window.__positionFailure) throw new Error('disk unavailable');
      },
      getVkStatus: async () => status, getVersion: async () => 'large-library-qa',
      onVkPlayback: callback => { window.__positionPlayback = callback; return () => {}; },
      vkWebControl: async command => {
        window.__positionControlCalls.push(command);
        if (command.operation === 'pause') window.__positionEmit(window.__positionLast.position, false);
        return { accepted: true };
      },
      onCloseRequest: callback => {
        window.__positionClose = async () => {
          window.__positionCloseError = '';
          try { await callback(); window.__positionClosed++; } catch (error) { window.__positionCloseError = error.message; }
        };
        return () => {};
      },
      onCommand: () => () => {},
      refreshVk: async () => ({ status, complete: false, mode: 'web', tracks: [], playlists: [] }),
    };
  }, { state, status });
  try {
    await page.goto(baseURL);
    await page.locator('.app-shell').waitFor();
    await page.waitForFunction(() => !!window.__positionPlayback && !!window.__positionClose && window.__positionSaves.length > 0);
    assert.equal(await page.locator('.track-row').count(), 120, 'large library rendered its entire track registry');
    await page.getByRole('button', { name: 'Воспроизвести Performance track 1', exact: true }).click();
    await page.waitForFunction(() => window.__positionSaves.some(value => value.currentTrackId === 'vk-101-1'));
    await page.evaluate(() => window.__positionEmit(0));
    await page.getByRole('button', { name: 'Пауза', exact: true }).waitFor();
    await page.clock.install();
    await page.evaluate(() => { window.__positionSaves.length = 0; });
    await check(page);
    console.log(`PASS ${name}`);
  } catch (error) { failures++; console.log(`FAIL ${name}: ${error.stack}`); }
  finally { await context.close(); }
}

async function advance(page, seconds) {
  for (let position = 1; position <= seconds; position++) {
    await page.clock.runFor(1000);
    await page.evaluate(position => window.__positionEmit(position), position);
    await page.clock.runFor(1);
  }
}
const saved = page => page.evaluate(() => window.__positionSaves);

await run('large-library-continuous-playback-bounds-writes-without-starving-persistence', async page => {
  await advance(page, 46);
  const writes = await saved(page);
  assert.ok(writes.length >= 2, 'continuous position changes postponed saving indefinitely');
  assert.ok(writes.length <= 3, `46 seconds of position-only playback caused ${writes.length} heavy saves`);
  assert.ok(writes.at(-1).position >= 40, 'periodic save did not use the latest available position');
  for (let index = 1; index < writes.length; index++) assert.ok(writes[index].at - writes[index - 1].at >= 14000, 'position writes were closer than the configured throttle');
  assert.equal(writes.every(value => value.trackCount === 20000 && value.playlistCount === 78), true, 'persistence lost part of the synthetic library');
});

await run('pause-flushes-latest-subthreshold-position-immediately', async page => {
  await advance(page, 8);
  await page.evaluate(() => window.__positionEmit(9.75));
  await page.clock.runFor(1);
  await page.getByRole('button', { name: 'Пауза', exact: true }).click();
  await page.clock.runFor(10);
  const writes = await saved(page);
  assert.ok(writes.length > 0, 'pause waited for the long position throttle');
  assert.equal(writes.at(-1).position, 9.75, 'pause persisted the older two-second checkpoint');
  assert.equal(writes.at(-1).currentTrackId, 'vk-101-1');
});

await run('close-flushes-pending-position-and-failed-save-keeps-window-open', async page => {
  await advance(page, 6);
  await page.evaluate(() => { window.__positionFailure = true; });
  await page.evaluate(() => window.__positionClose());
  assert.equal(await page.evaluate(() => window.__positionClosed), 0);
  assert.ok(await page.evaluate(() => window.__positionCloseError));
  assert.equal((await saved(page)).at(-1).position, 6);
  await page.evaluate(() => { window.__positionFailure = false; });
  await page.evaluate(() => window.__positionClose());
  assert.equal(await page.evaluate(() => window.__positionClosed), 1);
  assert.equal((await saved(page)).at(-1).position, 6);
});

await run('pagehide-flushes-position-before-the-next-throttled-save', async page => {
  await advance(page, 4);
  assert.equal((await saved(page)).length, 0);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await page.clock.runFor(1);
  assert.equal((await saved(page)).at(-1).position, 4);
});

await browser.close();
console.log(`QA result: ${failures} failed checks`);
process.exitCode = failures ? 1 : 0;
