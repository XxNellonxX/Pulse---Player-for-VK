import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const baseURL = process.env.QA_BASE_URL || 'http://127.0.0.1:5173';
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const artifacts = new URL('./artifacts/', import.meta.url);
await mkdir(artifacts, { recursive: true });
function waveUrl(seconds = 12) {
  const sampleRate = 8000, samples = sampleRate * seconds;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8); bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  return `data:audio/wav;base64,${bytes.toString('base64')}`;
}
const url = waveUrl();
const tracks = ['Alpha', 'Beta', 'Gamma'].map((title, i) => ({ id: `qa-${i}`, title, artist: `Artist ${i}`, album: `Album ${i}`, duration: 12, url, source: 'local', addedAt: i, available: true }));
const settings = { theme: 'dark', style: 'minimal', accent: '#bdff62', density: 'comfortable', textScale: 1, reducedMotion: false, volume: .01, repeat: 'off', shuffle: false, closeToTray: true, autoplay: false, autoSkip: false };
const baseState = { version: 1, tracks, playlists: [], history: [], queue: tracks.map(t => t.id), currentTrackId: null, position: 0, settings };
let failures = 0;
async function run(name, fn, state = baseState, viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(({ state }) => {
    localStorage.setItem('pulse-preview', JSON.stringify(state));
    const NativeAudio = window.Audio;
    window.__qaAudio = [];
    window.Audio = class extends NativeAudio { constructor(...args) { super(...args); window.__qaAudio.push(this); } };
  }, { state });
  try {
    await page.goto(baseURL);
    await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 10000 });
    await fn(page, errors);
    console.log(`PASS ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL ${name}: ${error.message}`);
    if (errors.length) console.log(`  page errors: ${errors.join('; ')}`);
    await page.screenshot({ path: fileURLToPath(new URL(`${name.replace(/[^a-z0-9]+/ig, '-')}.png`, artifacts)), fullPage: true }).catch(() => {});
  } finally { await context.close(); }
}

await run('playback-start-pause-next', async page => {
  await page.getByRole('button', { name: 'Воспроизвести Alpha', exact: true }).click();
  await page.getByRole('button', { name: 'Пауза', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Следующий трек', exact: true }).click();
  await page.locator('.now-meta strong').filter({ hasText: 'Beta' }).waitFor();
  assert.equal(await page.locator('.now-meta strong').innerText(), 'Beta');
});

await run('empty-playlist-can-add-existing-track', async page => {
  await page.getByRole('button', { name: 'Новый плейлист', exact: true }).first().click();
  await page.getByPlaceholder('Например, Вечерний драйв').fill('QA playlist');
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  const body = await page.locator('.page-content').innerText();
  assert.match(body, /Добавить треки|Выбрать треки|Alpha|Beta|Gamma/, 'new playlist provides no path to add a library track');
});

await run('global-search-leaves-selected-playlist', async page => {
  await page.getByRole('button', { name: /Only Alpha/ }).click();
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder('Поиск музыки').fill('Beta');
  assert.equal(await page.locator('.track-meta strong').count(), 1, 'Ctrl+K search still restricted to selected playlist');
  assert.equal(await page.locator('.track-meta strong').innerText(), 'Beta');
}, { ...baseState, playlists: [{ id: 'qa-list', title: 'Only Alpha', trackIds: ['qa-0'], createdAt: 1 }] });

await run('remove-active-track-clears-player-state', async page => {
  await page.getByRole('button', { name: 'Воспроизвести Alpha', exact: true }).click();
  const row = page.locator('.track-row').filter({ has: page.locator('.track-meta strong', { hasText: 'Alpha' }) });
  await row.getByRole('button', { name: 'Дополнительные действия' }).click();
  await row.getByRole('button', { name: /^(Удалить|Убрать из библиотеки)$/, exact: true }).click();
  await page.waitForTimeout(600);
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('pulse-preview')));
  assert.equal(persisted.currentTrackId, null, 'removed track leaves a dangling currentTrackId');
});

await run('settings-toggle-has-accessible-name', async page => {
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('button', { name: 'Воспроизведение', exact: true }).click();
  const switches = page.getByRole('switch');
  assert.ok(await switches.count() >= 3);
  for (const control of await switches.all()) assert.ok(await control.getAttribute('aria-label') || await control.getAttribute('aria-labelledby'), 'switch has no accessible name');
});

await run('closed-queue-is-not-keyboard-focusable', async page => {
  const exposed = await page.locator('.queue-panel[aria-hidden="true"] button').evaluateAll(buttons => buttons.filter(button => button.tabIndex >= 0 && !button.disabled).length);
  assert.equal(exposed, 0, 'closed queue exposes focusable controls to keyboard');
});

await run('responsive-720p-no-horizontal-overflow', async page => {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: fileURLToPath(new URL('settings-1280-720.png', artifacts)), fullPage: true });
}, baseState, { width: 1280, height: 720 });

await run('malformed-stored-track-is-recovered', async (page, errors) => { assert.equal(errors.length, 0); }, { ...baseState, tracks: [null] });

await run('next-track-is-recorded-in-listening-history', async page => {
  await page.getByRole('button', { name: 'Воспроизвести Alpha', exact: true }).click();
  await page.getByRole('button', { name: 'Пауза', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Следующий трек', exact: true }).click();
  await page.locator('.now-meta strong').filter({ hasText: 'Beta' }).waitFor();
  await page.getByRole('button', { name: 'История', exact: true }).click();
  assert.equal(await page.locator('.track-meta strong').filter({ hasText: 'Beta' }).count(), 1, 'next/auto-played track is absent from listening history');
});

await run('autoplay-setting-resumes-restored-track', async page => {
  await page.waitForTimeout(800);
  const audio = await page.evaluate(() => { const a = window.__qaAudio.at(-1); return { paused: a.paused, src: a.src, readyState: a.readyState }; });
  assert.equal(audio.paused, false, 'autoplay enabled, but restored audio remains paused');
}, { ...baseState, currentTrackId: 'qa-0', position: 4, settings: { ...settings, autoplay: true } });

await run('rapid-queue-play-clear-does-not-resurrect-source', async page => {
  await page.getByRole('button', { name: 'Воспроизвести Alpha', exact: true }).click();
  await page.getByRole('button', { name: /^Очередь/ }).click();
  await page.getByRole('button', { name: 'Очистить очередь', exact: true }).click();
  await page.waitForTimeout(500);
  const audio = await page.evaluate(() => { const a = window.__qaAudio.at(-1); return { paused: a.paused, src: a.getAttribute('src') }; });
  assert.equal(audio.paused, true);
  assert.ok(!audio.src, 'cleared queue resurrected a media source');
  assert.equal(await page.locator('.no-track').count(), 1);
});

await run('repeat-one-ended-restarts-once-without-changing-track', async page => {
  await page.getByRole('button', { name: 'Воспроизвести Alpha', exact: true }).click();
  await page.getByRole('button', { name: 'Пауза', exact: true }).waitFor();
  await page.evaluate(() => window.__qaAudio.at(-1).dispatchEvent(new Event('ended')));
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.now-meta strong').innerText(), 'Alpha');
  assert.equal(await page.evaluate(() => window.__qaAudio.at(-1).paused), false);
}, { ...baseState, settings: { ...settings, repeat: 'one' } });

await run('shuffle-cycle-does-not-repeat-before-exhaustion', async page => {
  await page.getByRole('button', { name: 'Воспроизвести Alpha', exact: true }).click();
  await page.getByRole('button', { name: 'Пауза', exact: true }).waitFor();
  const played = [await page.locator('.now-meta strong').innerText()];
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: 'Следующий трек', exact: true }).click();
    await page.waitForTimeout(40);
    played.push(await page.locator('.now-meta strong').innerText());
  }
  assert.equal(new Set(played).size, 3, `cycle repeated: ${played.join(' -> ')}`);
}, { ...baseState, settings: { ...settings, shuffle: true } });

await browser.close();
console.log(`QA result: ${failures} failed checks`);
process.exitCode = failures ? 1 : 0;
