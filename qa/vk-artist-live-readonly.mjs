// Inspects only the app-owned signed-in VK document; performs no cloud writes,
// navigation or playback. Evidence contains counts and public IDs only.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
const browsers = [], evidence = { checkedAt: new Date().toISOString(), cloudReadOnly: true, playbackStarted: false, cases: [] };
try {
  for (const address of ['http://127.0.0.1:9226', 'http://[::1]:9226']) {
    try { browsers.push(await chromium.connectOverCDP(address, { timeout: 1500 })); } catch {}
  }
  const page = browsers.flatMap(b => b.contexts().flatMap(c => c.pages())).find(p => /^https:\/\/vk\.(ru|com)(\/|$)/.test(p.url()));
  if (!page) throw Error('The app-owned VK document is unavailable');
  await page.evaluate('delete window.__PULSE_VK_ARTISTS__;' + await fs.readFile(new URL('../src-tauri/src/vk_artist.js', import.meta.url), 'utf8'));
  async function request(input) {
    return page.evaluate(async input => {
      const api = window.__PULSE_VK_ARTISTS__, account = Number(window.vk.id), key = `artist-live-${Date.now()}`;
      if (!api.start(key, input, account)) throw Error('Artist adapter did not accept the read');
      for (let n = 0; n < 220; n++) {
        const receipt = api.read(key, account);
        if (receipt.complete) {
          if (receipt.error) return { error: receipt.error };
          const d = receipt.result;
          window.__pulseArtistReadOnly = d;
          const releases = d.artist?.releases || d.releases || (d.release ? [d.release] : []), tracks = d.artist?.tracks || d.tracks || [];
          return { artistId: d.artist?.id, artistName: d.artist?.name, artists: d.artists?.length, tracks: tracks.length, releases: releases.length, kinds: [...new Set(releases.map(r => r.kind))], releasesWithActualPlays: releases.filter(r => Number.isSafeInteger(r.plays)).length, hasMore: d.hasMore, stringArtistIds: (d.artists || []).every(a => typeof a.id === 'string'), nativeTrackSources: tracks.every(t => /^vk-web:\/\//.test(t.url)), exportedMediaUrls: /\.mp3(?:[?"\s]|$)|\.m3u8(?:[?"\s]|$)|access_key/.test(JSON.stringify(d)), clip: d.clip, firstReleaseId: releases[0]?.id, firstTrackId: tracks[0]?.id };
        }
        await new Promise(r => setTimeout(r, 200));
      }
      return { timeout: true };
    }, input);
  }
  for (const input of [{ action: 'resolve', query: 'Daft Punk' }, { action: 'artist', artistId: '5428185118660812105' }, { action: 'updates' }, { action: 'snippets' }]) {
    const result = await request(input); evidence.cases.push({ action: input.action, ...result });
    if (input.action === 'artist' && result.firstReleaseId) evidence.cases.push({ action: 'release', ...await request({ action: 'release', releaseId: result.firstReleaseId }) });
    if (input.action === 'snippets' && result.firstTrackId) evidence.cases.push({ action: 'snippet', ...await request({ action: 'snippet', trackId: result.firstTrackId }) });
  }
  // Lose this module's entire private registry to model process restart.
  // Native cache restoration supplies exact IDs, with no source/access key.
  await page.evaluate('delete window.__PULSE_VK_ARTISTS__;' + await fs.readFile(new URL('../src-tauri/src/vk_artist.js', import.meta.url), 'utf8'));
  evidence.cases.push({ action: 'warm-cache-hydrate', ...await request({ action: 'hydrate', ids: ['vk--2001399483-155399483'] }) });
  evidence.cases.push({ action: 'warm-cache-repeat', ...await request({ action: 'hydrate', ids: ['vk--2001399483-155399483'] }) });
  evidence.cases.push({ action: 'release-without-private-map', ...await request({ action: 'release', releaseId: 'vk-playlist--2000527972-29527972' }) });
  evidence.success = evidence.cases.every(c => !c.error && !c.timeout && !c.exportedMediaUrls);
  await fs.writeFile(new URL('vk-artist-live-readonly-result.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence));
  if (!evidence.success) process.exitCode = 1;
} finally { for (const browser of browsers) await browser.close().catch(() => {}); }
