// Independent user-flow regression: isolated Edge, public UI, fixture audio only.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const base = process.env.PULSE_QA_URL || 'http://127.0.0.1:5193';
const bytes = Buffer.alloc(44 + 8000 * 2 * 10);
bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8); bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
const audio = `data:audio/wav;base64,${bytes.toString('base64')}`;
const tracks = Array.from({ length: 9 }, (_, index) => ({ id: `song-${index}`, title: `Fixture ${index}`, artist: 'Fixture Artist', album: '', duration: 30, source: 'local', url: audio, available: true, addedAt: index }));
tracks.push({ ...tracks[0], id: 'discovery', title: 'Discovery Outside Own', source: 'vk', remote: { ownerId: 99, audioId: 99, inLibrary: false, searchResult: true } });
const seed = { version: 1, tracks, playlists: [
  { id: 'a', title: 'Fixture Album A', trackIds: ['song-1', 'song-2', 'song-3'], createdAt: 1 },
  { id: 'b', title: 'Fixture Album B', trackIds: ['song-4', 'song-5'], createdAt: 2 },
  { id: 'single', title: 'Fixture Single', trackIds: ['song-6'], createdAt: 3 },
], queue: tracks.slice(0, 9).map(track => track.id), queueSource: tracks.slice(0, 9).map(track => track.id), currentTrackId: null, history: [], position: 0, settings: { theme: 'dark', style: 'minimal', volume: 0, shuffle: true, repeat: 'all', autoSkip: false, preferSoundCloud: false } };
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
const passed = label => { checks.push(label); console.log('PASS ' + label); };
async function saved() { return page.evaluate(() => JSON.parse(localStorage.getItem('pulse-preview'))); }
async function settle(predicate, label) { for (let i = 0; i < 60; i++) { const value = await saved(); if (predicate(value)) return value; await page.waitForTimeout(50); } throw Error('Timed out: ' + label); }
async function toggleShuffle(expected) { await page.locator('.player-button').filter({ has: page.locator('svg.lucide-shuffle') }).click(); return settle(state => state.settings.shuffle === expected, 'shuffle=' + expected); }
async function next() { await page.getByRole('button', { name: 'Следующий трек', exact: true }).click(); await page.waitForTimeout(100); return saved(); }
async function openAlbum(name, title) { await page.getByRole('button', { name: new RegExp('^' + name) }).click(); await page.locator('.track-list .track-title-button').filter({ hasText: title }).click(); return settle(state => state.currentTrackId && state.queue.length <= 3, title); }
try {
  await page.addInitScript(value => { if (!localStorage.getItem('pulse-qa-seeded')) { localStorage.setItem('pulse-preview', JSON.stringify(value)); localStorage.setItem('pulse-qa-seeded', '1'); } }, seed);
  await page.goto(base); await page.locator('.app-shell').waitFor();
  let state = await openAlbum('Fixture Album A', 'Fixture 1');
  assert.deepEqual([...state.queue].sort(), ['song-1', 'song-2', 'song-3']); assert.equal(state.queue[0], 'song-1');
  passed('opening an album with shuffle already enabled replaces the whole-library deck');
  for (let i = 0; i < 10; i++) { state = await next(); assert.ok(['song-1', 'song-2', 'song-3'].includes(state.currentTrackId)); assert.deepEqual([...state.queue].sort(), ['song-1', 'song-2', 'song-3']); }
  passed('several repeat-all cycles stay inside the album without leaking own music');
  const current = state.currentTrackId; state = await toggleShuffle(false); assert.deepEqual(state.queue, ['song-1', 'song-2', 'song-3']); assert.equal(state.currentTrackId, current);
  passed('turning shuffle off restores album order and preserves the playing track');
  const victim = state.queue.find(id => id !== current);
  await page.getByRole('button', { name: /^Открыть очередь/ }).click();
  await page.locator('.queue-row').filter({ hasText: 'Fixture ' + victim.split('-')[1] }).getByRole('button', { name: 'Удалить', exact: true }).click();
  await page.getByRole('button', { name: 'Закрыть очередь', exact: true }).click();
  await page.getByRole('button', { name: 'Моя музыка', exact: true }).click();
  const requested = page.locator('.track-row[data-track-id="song-8"]'); await requested.getByRole('button', { name: 'Дополнительные действия', exact: true }).click(); await requested.getByRole('button', { name: 'В очередь', exact: true }).click();
  state = await settle(value => value.queue.includes('song-8') && !value.queue.includes(victim), 'queue edits');
  const expected = ['song-1', 'song-2', 'song-3'].filter(id => id !== victim).concat('song-8');
  await toggleShuffle(true); state = await toggleShuffle(false); assert.deepEqual(state.queue, expected);
  passed('queue removals stay removed and explicit additions survive shuffle toggles');
  await toggleShuffle(true); await page.reload(); await page.locator('.app-shell').waitFor(); state = await toggleShuffle(false); assert.deepEqual(state.queue, expected);
  passed('application remount retains the chosen source order and queue edits');
  await toggleShuffle(true); state = await openAlbum('Fixture Album B', 'Fixture 4'); assert.deepEqual([...state.queue].sort(), ['song-4', 'song-5']);
  for (let i = 0; i < 5; i++) { state = await next(); assert.ok(['song-4', 'song-5'].includes(state.currentTrackId)); }
  passed('switching to another album starts a new independent shuffle context');
  state = await openAlbum('Fixture Single', 'Fixture 6'); assert.deepEqual(state.queue, ['song-6']); state = await next(); assert.deepEqual(state.queue, ['song-6']); assert.equal(state.currentTrackId, 'song-6');
  passed('single-track repeat works without introducing library tracks');
  // Only this last flow supplies a synthetic read-only VK account/search. No
  // real credentials, network calls or provider audio are used.
  await page.evaluate(discovery => {
    const status = { state: 'connected', mode: 'web', message: 'QA fixture', capabilities: [], user: { id: 42, name: 'QA' } };
    window.desktop = { connectVk: async () => status, refreshVk: async () => ({ complete: false, unchanged: true, status }), searchVk: async () => [discovery], onCommand: () => () => {}, saveState: async value => { localStorage.setItem('pulse-preview', JSON.stringify(value)); } };
  }, tracks[9]);
  await page.getByRole('button', { name: 'Подключить VK', exact: true }).click();
  await page.locator('#global-search').fill('Discovery Outside Own'); await page.locator('.track-list .track-title-button').filter({ hasText: 'Discovery Outside Own' }).click();
  const active = () => page.locator('.now-playing strong').innerText();
  assert.equal(await active(), 'Discovery Outside Own');
  await page.getByRole('button', { name: /^Открыть очередь/ }).click(); assert.deepEqual(await page.locator('.queue-track strong').allTextContents(), ['Discovery Outside Own']); await page.getByRole('button', { name: 'Закрыть очередь', exact: true }).click();
  await page.locator('.player-button').filter({ has: page.locator('svg.lucide-shuffle') }).click();
  await page.getByRole('button', { name: /^Открыть очередь/ }).click(); assert.deepEqual(await page.locator('.queue-track strong').allTextContents(), ['Discovery Outside Own']);
  passed('a global-search discovery outside own music keeps its own playback context');
  assert.deepEqual(errors, []); passed('no renderer exceptions');
  console.log(JSON.stringify({ passed: checks.length, total: checks.length, checks, scope: 'Fixture audio in isolated Edge; no live VK or physical Mac verification.' }));
} catch (error) { console.error(error.stack); console.log(JSON.stringify({ checks, errors, state: await saved().then(value => ({ queue: value?.queue, queueSource: value?.queueSource, currentTrackId: value?.currentTrackId, shuffle: value?.settings?.shuffle })).catch(() => null) })); process.exitCode = 1; }
finally { await browser.close(); }
