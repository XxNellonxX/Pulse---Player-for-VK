import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

// Live read-only-cloud diagnostic of the reported track. No source URLs,
// request headers, credentials or account identities are logged or saved.
const browsers = [], connected = new Set();
const faults = [], samples = [];
let main, remote, saved;
try {
  for (let n = 0; n < 300; n++) {
    for (const addr of ['http://127.0.0.1:9226', 'http://[::1]:9226']) {
      if (connected.has(addr)) continue;
      try { browsers.push(await chromium.connectOverCDP(addr, { timeout: 500 })); connected.add(addr); } catch {}
    }
    const pages = browsers.flatMap(b => b.contexts().flatMap(c => c.pages()));
    main = pages.find(p => p.url().includes('tauri.localhost'));
    remote = pages.find(p => /^https:\/\/vk\.(com|ru)\//.test(p.url()));
    if (main && remote && await main.evaluate(async () => (await window.desktop.getVkStatus()).state === 'connected').catch(() => false)) break;
    await new Promise(r => setTimeout(r, 500));
  }
  assert.ok(main && remote);
  saved = await main.evaluate(() => window.desktop.getState());
  await remote.evaluate(() => {
    const OriginalAudio = window.Audio;
    window.__qaSourceDiagnosis = { original: OriginalAudio, audio: null, events: [] };
    window.Audio = function (...args) {
      const audio = new OriginalAudio(...args);
      window.__qaSourceDiagnosis.audio = audio;
      for (const type of ['playing', 'waiting', 'stalled', 'pause', 'ended', 'error']) audio.addEventListener(type, () => window.__qaSourceDiagnosis.events.push({ type, position: audio.currentTime, ready: audio.readyState, code: audio.error?.code || 0 }));
      return audio;
    };
    window.Audio.prototype = OriginalAudio.prototype;
  });
  remote.on('requestfailed', request => {
    if (request.resourceType() === 'media' || /\.(?:m3u8|ts|m4s|mp3)(?:[?#]|$)/i.test(request.url())) faults.push({ kind: 'requestfailed', type: request.resourceType(), failure: request.failure()?.errorText });
  });
  remote.on('response', response => {
    if (response.status() >= 400 && (response.request().resourceType() === 'media' || /\.(?:m3u8|ts|m4s|mp3)(?:[?#]|$)/i.test(response.url()))) faults.push({ kind: 'http', status: response.status() });
  });
  const chosen = saved.tracks.find(t => t.title === 'Скоро лето' && t.artist.includes('Три дня дождя') && t.available);
  assert.ok(chosen, 'Reported track not synchronized');
  await main.getByLabel('Громкость', { exact: true }).fill('0');
  await main.getByRole('button', { name: `Воспроизвести ${chosen.title}`, exact: true }).first().click();
  console.log('Started the currently reported track with media diagnostics');
  const started = Date.now();
  while (Date.now() - started < 240000) {
    const s = await remote.evaluate(() => {
      const p = window.__PULSE_VK_WEB__.playback(), a = window.__qaSourceDiagnosis?.audio;
      return { elapsed: 0, position: p.position, duration: p.duration, playing: p.playing, buffering: p.buffering, recovering: p.recovering, ended: p.ended, hasError: Boolean(p.error), mediaErrorCode: a?.error?.code || 0, readyState: a?.readyState, bufferedEnd: a?.buffered?.length ? a.buffered.end(a.buffered.length - 1) : 0 };
    });
    s.elapsed = Math.round((Date.now() - started) / 1000); samples.push(s);
    if (samples.length % 15 === 0 || s.hasError) console.log(JSON.stringify(s));
    if (s.hasError || s.ended) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  const events = await remote.evaluate(() => window.__qaSourceDiagnosis.events);
  await writeFile(new URL('installed-source-diagnosis-result.json', import.meta.url), JSON.stringify({ checkedAt: new Date().toISOString(), cloudReadOnly: true, samples, events, faults }, null, 2) + '\n');
  console.log(JSON.stringify({ ended: samples.at(-1)?.ended, lastPosition: samples.at(-1)?.position, mediaErrorCode: samples.at(-1)?.mediaErrorCode, events: events.filter(e => e.type === 'error'), faults }));
} finally {
  if (main && saved) await main.evaluate(async saved => { await window.desktop.vkWebControl({ operation: 'pause' }).catch(() => {}); await window.desktop.saveState(saved); }, saved).catch(() => {});
  if (remote) await remote.evaluate(() => { if (window.__qaSourceDiagnosis) window.Audio = window.__qaSourceDiagnosis.original; delete window.__qaSourceDiagnosis; }).catch(() => {});
  for (const b of browsers) await b.close().catch(() => {});
}
