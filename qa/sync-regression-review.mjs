import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// Independent regression probes. Uses an isolated synthetic desktop bridge;
// no native process, VK account, cookies, or network session is accessed.
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const baseURL = process.env.QA_BASE_URL || 'http://127.0.0.1:5173';
const settings = { theme: 'dark', style: 'minimal', accent: '#bdff62', density: 'comfortable', textScale: 1, reducedMotion: false, volume: .01, repeat: 'off', shuffle: false, closeToTray: false, autoplay: false, autoSkip: false };
const remote = id => ({ id: `vk-101-${id}`, title: `Review ${id}`, artist: 'QA', album: '', duration: 60, url: `vk-web://101/${id}`, source: 'vk', addedAt: id, available: true, remote: { ownerId: 101, audioId: id, inLibrary: true } });
const state = { version: 1, tracks: [remote(1), remote(2)], playlists: [], history: [], queue: ['vk-101-1', 'vk-101-2'], currentTrackId: null, position: 0, settings };
const status = { state: 'connected', mode: 'web', message: '', user: { id: 101, name: 'Review account' }, capabilities: [] };
let failures = 0;

async function run(name, fn, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(({ state, status, options }) => {
    if (options.emptyQueue) state.queue = [];
    if (options.restored) { state.currentTrackId = 'vk-101-1'; state.position = 25; }
    window.__reviewState = state; window.__reviewControls = []; window.__reviewSeek = null;
    window.__reviewEmit = value => window.__reviewPlayback?.({ id: 'vk-101-1', requestedId: 'vk-101-1', playing: false, buffering: false, position: 0, duration: 60, error: null, ended: false, runId: 'review-run', ...value });
    window.desktop = {
      getState: async () => state, saveState: async value => { window.__reviewState = value; },
      getVkStatus: async () => status, refreshVk: async () => ({ status, complete: false, tracks: [], playlists: [] }),
      vkWebControl: async command => { window.__reviewControls.push(command); if (command.operation === 'seek') return new Promise(resolve => { window.__reviewSeek = resolve; }); return { accepted: true }; },
      onVkPlayback: callback => { window.__reviewPlayback = callback; return () => { if (window.__reviewPlayback === callback) delete window.__reviewPlayback; }; },
      onVkUpdate: callback => { window.__reviewUpdate = callback; return () => { if (window.__reviewUpdate === callback) delete window.__reviewUpdate; }; },
      onCommand: () => () => {}, getVersion: async () => 'review',
    };
  }, { state, status, options });
  try {
    await page.goto(baseURL); await page.locator('.app-shell').waitFor();
    await page.waitForFunction(() => !!window.__reviewPlayback);
    await fn(page); console.log(`PASS ${name}`);
  } catch (error) { failures++; console.log(`FAIL ${name}: ${error.message}`); }
  finally { await context.close(); }
}

await run('pause-prevents-late-official-start', async page => {
  await page.getByRole('button', { name: 'Воспроизвести Review 1', exact: true }).click();
  await page.getByRole('button', { name: 'Воспроизвести', exact: true }).click();
  const before = await page.evaluate(() => window.__reviewControls.filter(c => c.operation === 'pause').length);
  await page.evaluate(() => window.__reviewEmit({ playing: true, position: 1 }));
  await page.waitForTimeout(50);
  const after = await page.evaluate(() => window.__reviewControls.filter(c => c.operation === 'pause').length);
  assert.ok(after > before, `late official start after pause was accepted (pause count ${before} -> ${after}; pause UI visible ${await page.getByRole('button', { name: 'Пауза', exact: true }).count()})`);
});

await run('old-seek-cannot-overwrite-new-track-position', async page => {
  await page.getByRole('button', { name: 'Воспроизвести Review 1', exact: true }).click();
  await page.evaluate(() => window.__reviewEmit({ playing: true }));
  await page.getByLabel('Позиция воспроизведения').evaluate(element => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, '38'); element.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForFunction(() => window.__reviewSeek !== null);
  await page.getByRole('button', { name: 'Воспроизвести Review 2', exact: true }).click();
  await page.evaluate(() => window.__reviewSeek({ accepted: true }));
  await page.waitForTimeout(80);
  assert.equal(await page.locator('.now-meta strong').innerText(), 'Review 2');
  assert.equal(Number(await page.getByLabel('Позиция воспроизведения').inputValue()), 0, 'A seek receipt moved B to A requested position');
  assert.equal(await page.evaluate(() => window.__reviewState.position), 0, 'A seek receipt saved position for B');
});

await run('completed-web-import-retains-last-sync-time', async page => {
  await page.evaluate(({ state, status }) => window.__reviewUpdate({ mode: 'web', status, complete: true, tracks: state.tracks, playlists: [], syncedAt: Date.now() }), { state, status });
  await page.locator('.user-chip').click();
  await page.waitForTimeout(40);
  assert.equal(await page.getByText('Последняя синхронизация: ещё не выполнялась').count(), 0, 'complete event lost syncedAt');
});

await run('fresh-web-library-next-plays-the-next-library-track', async page => {
  // VK supplies Review 1 before Review 2, regardless of their local import
  // dates. Playback should follow that same visible sequence.
  await page.getByRole('button', { name: 'Воспроизвести Review 1', exact: true }).click();
  await page.evaluate(() => window.__reviewEmit({ id: 'vk-101-1', requestedId: 'vk-101-1', playing: true }));
  await page.getByRole('button', { name: 'Следующий трек', exact: true }).click();
  await page.waitForTimeout(80);
  assert.equal(await page.locator('.now-meta strong').innerText(), 'Review 2', 'first import left the library unable to continue playback');
}, { emptyQueue: true });

await run('restored-manual-play-applies-pulse-volume', async page => {
  await page.getByRole('button', { name: 'Воспроизвести', exact: true }).click();
  await page.waitForTimeout(80);
  const controls = await page.evaluate(() => window.__reviewControls);
  assert.ok(controls.some(c => c.operation === 'volume' && c.volume === .01), 'restored-track Play ignored the saved Pulse volume');
}, { restored: true });

await run('play-after-end-restarts-instead-of-resuming-ended-source', async page => {
  await page.getByRole('button', { name: 'Воспроизвести Review 2', exact: true }).click();
  await page.evaluate(() => window.__reviewEmit({ id: 'vk-101-2', requestedId: 'vk-101-2', playing: true }));
  await page.evaluate(() => window.__reviewEmit({ id: 'vk-101-2', requestedId: 'vk-101-2', ended: true, position: 60 }));
  const before = await page.evaluate(() => window.__reviewControls.filter(c => c.operation === 'pause').length);
  await page.getByRole('button', { name: 'Воспроизвести', exact: true }).click();
  // adapter's resume branch does not clear endedTrack; its next poll retains
  // ended=true even when the official player acknowledges resumed playback.
  await page.evaluate(() => window.__reviewEmit({ id: 'vk-101-2', requestedId: 'vk-101-2', playing: true, ended: true, position: 0 }));
  await page.waitForTimeout(40);
  const after = await page.evaluate(() => window.__reviewControls.filter(c => c.operation === 'pause').length);
  assert.equal(after, before, 'uncleared site ended marker immediately paused the resumed source');
});

await browser.close();
console.log(`Review probes: ${failures} failed checks`);
process.exitCode = failures ? 1 : 0;
