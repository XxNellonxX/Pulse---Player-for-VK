import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

// Live acceptance for the user's previously selected local MP3s, which they
// explicitly requested to upload to VK. No generated fixture is published.
// Prints only counts/statuses; source URLs and account metadata stay in memory.
// Historical mutating acceptance: require an explicit opt-in on every run.
assert.equal(process.env.PULSE_ALLOW_LIVE_UPLOADS, '1', 'Live upload acceptance is disabled by default. Use read-only installed verification for repeat checks.');
const mainBrowser = await chromium.connectOverCDP('http://127.0.0.1:9226');
const vkBrowser = await chromium.connectOverCDP('http://[::1]:9226');
try {
  const main = mainBrowser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('tauri.localhost'));
  const vk = vkBrowser.contexts().flatMap(context => context.pages()).find(page => /^https:\/\/vk\.(com|ru)(\/|$)/.test(page.url()));
  assert.ok(main && vk);
  async function until(callback, message, timeout = 120000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await callback()) return; await new Promise(resolve => setTimeout(resolve, 500)); }
    throw new Error(message);
  }
  async function complete() {
    await until(async () => { const status = await main.evaluate(() => window.desktop.getVkStatus()); return status.state === 'connected' && status.syncProgress?.phase === 'complete'; }, 'The live VK account did not finish synchronization');
  }
  await complete();
  const original = await main.evaluate(() => window.desktop.getState());
  const pending = original.tracks.filter(track => track.source === 'local' && track.available && /\.mp3$/i.test(track.url));
  const summary = { checkedAt: new Date().toISOString(), selectedLocalMp3Count: pending.length, uploads: [], directPlayback: [] };
  for (const local of pending) {
    const fresh = await main.evaluate(() => window.desktop.getState());
    if (fresh.tracks.some(track => track.source === 'vk' && track.remote?.inLibrary && track.title === local.title && track.artist === local.artist)) { summary.uploads.push({ status: 'already-present' }); continue; }
    const result = await main.evaluate(id => window.desktop.uploadLocalTrackToVk(id), local.id);
    const item = result.items[0];
    summary.uploads.push({ status: item?.status || 'missing-result' });
    console.log(JSON.stringify({ completedUploads: summary.uploads.length, status: item?.status || 'missing-result' }));
    if (item?.status !== 'uploaded') { summary.uploads.at(-1).message = item?.message; continue; }
    await complete();
    const updated = await main.evaluate(() => window.desktop.getState());
    const remote = updated.tracks.find(track => track.id === item.trackId && track.remote?.inLibrary);
    assert.ok(remote, 'VK saved an upload but the native library has not received it');
    assert.equal(updated.tracks.find(track => track.source === 'vk' && track.remote?.inLibrary)?.id, remote.id, 'The uploaded track is not first in VK order');
    summary.uploads.at(-1).appearsAtTop = true;
    summary.uploads.at(-1).metadataPreserved = remote.title === local.title && remote.artist === local.artist;
  }
  await complete();
  const state = await main.evaluate(() => window.desktop.getState());
  const playable = state.tracks.filter(track => track.source === 'vk' && track.remote?.inLibrary && track.available).slice(0, 3);
  await vk.evaluate(() => { const ap = getAudioPlayer(); window.__PULSE_QA_OFFICIAL_PLAY = ap.play; window.__PULSE_QA_OFFICIAL_CALLS = 0; ap.play = function (...args) { window.__PULSE_QA_OFFICIAL_CALLS++; return window.__PULSE_QA_OFFICIAL_PLAY.apply(this, args); }; });
  const oldVolume = await main.getByLabel('Громкость', { exact: true }).inputValue();
  const setVolume = value => main.getByLabel('Громкость', { exact: true }).evaluate((element, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); }, value);
  await setVolume('0.01');
  try {
    for (const track of playable) {
      await main.getByRole('button', { name: `Воспроизвести ${track.title}`, exact: true }).first().click();
      await until(async () => { const value = await vk.evaluate(() => window.__PULSE_VK_WEB__?.playback()); return value?.id === track.id && value.playing && value.position > 2 && !value.advertising && !value.error; }, 'Direct VK playback did not advance without advertising', 30000);
      summary.directPlayback.push({ positionAdvanced: true, advertising: false });
      await main.getByRole('button', { name: 'Пауза', exact: true }).click();
      await until(async () => !(await vk.evaluate(() => window.__PULSE_VK_WEB__.playback())).playing, 'Direct pause was not confirmed', 5000);
    }
    assert.equal(await vk.evaluate(() => window.__PULSE_QA_OFFICIAL_CALLS), 0, 'The official play/ad entry point was invoked');
    summary.officialPlayCalls = 0;
  } finally {
    await setVolume(oldVolume);
    await vk.evaluate(() => { if (window.__PULSE_QA_OFFICIAL_PLAY) getAudioPlayer().play = window.__PULSE_QA_OFFICIAL_PLAY; delete window.__PULSE_QA_OFFICIAL_PLAY; delete window.__PULSE_QA_OFFICIAL_CALLS; });
  }
  await writeFile(new URL('installed-upload-playback-result.json', import.meta.url), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary));
} finally {
  await mainBrowser.close().catch(() => {});
  await vkBrowser.close().catch(() => {});
}
