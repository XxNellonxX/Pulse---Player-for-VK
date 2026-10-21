import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// Load the real Tauri bridge module through Vite, with only native invoke mocked.
// This verifies the transmitted payload rather than a duplicate implementation.
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage();
const baseURL = process.env.QA_BASE_URL || 'http://127.0.0.1:5173';
try {
  await page.route(`${baseURL}/qa-desktop-bridge.html`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><script type="module">import "/src/desktop.ts";window.__bridgeReady=true;</script>' }));
  await page.addInitScript(() => {
    window.isTauri = true;
    window.__bridgeInvocations = [];
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => { window.__bridgeInvocations.push({ command, args: structuredClone(args) }); } };
  });
  await page.goto(`${baseURL}/qa-desktop-bridge.html`);
  await page.waitForFunction(() => window.__bridgeReady && window.desktop);
  const outcome = await page.evaluate(async () => {
    const tracks = Array.from({ length: 20000 }, (_, index) => ({ id: `vk-101-${index + 1}`, title: 'A long track title with realistic metadata', artist: 'Artist', album: 'Album', duration: 240, source: 'vk', url: `vk-web://101/${index + 1}`, addedAt: 1, available: true, remote: { ownerId: 101, audioId: index + 1, inLibrary: true } }));
    tracks.push({ id: 'local-1', title: 'Local source', source: 'local', url: 'C:/private/file.mp3', duration: 240, artist: 'Artist', album: '', addedAt: 1, available: true });
    const playlists = Array.from({ length: 78 }, (_, index) => ({ id: `vk-playlist-${index}`, title: 'Remote playlist', createdAt: 1, remote: { ownerId: 101, playlistId: index }, trackIds: tracks.slice(index * 200, index * 200 + 200).map(track => track.id) }));
    playlists.push({ id: 'local-playlist', title: 'My local mix', createdAt: 1, trackIds: ['local-1', 'vk-101-1'] });
    const state = { version: 1, tracks, playlists, history: ['vk-101-4', 'local-1'], queue: tracks.map(track => track.id), currentTrackId: 'vk-101-1', position: 77.25, settings: { theme: 'light', volume: .25 } };
    const original = JSON.stringify(state);
    await window.desktop.saveState(state);
    const invocation = window.__bridgeInvocations.at(-1);
    return { command: invocation.command, payload: invocation.args.state, beforeBytes: original.length, afterBytes: JSON.stringify(invocation.args).length, unchanged: JSON.stringify(state) === original };
  });
  assert.equal(outcome.command, 'save_state');
  assert.deepEqual(outcome.payload.tracks, []);
  assert.deepEqual(outcome.payload.playlists, [{ id: 'local-playlist', title: 'My local mix', createdAt: 1, trackIds: ['local-1', 'vk-101-1'] }]);
  assert.equal(outcome.payload.queue.length, 20001); assert.equal(outcome.payload.queue[20000], 'local-1');
  assert.deepEqual(outcome.payload.history, ['vk-101-4', 'local-1']); assert.equal(outcome.payload.currentTrackId, 'vk-101-1'); assert.equal(outcome.payload.position, 77.25);
  assert.deepEqual(outcome.payload.settings, { theme: 'light', volume: .25 }); assert.equal(outcome.unchanged, true);
  assert.ok(outcome.afterBytes < outcome.beforeBytes / 10, 'Tauri save still carries most of the authoritative music catalog');
  console.log(`PASS real bridge retains UI references and local playlists, omits native registry, ${outcome.beforeBytes}→${outcome.afterBytes} bytes`);
} finally { await browser.close(); }
