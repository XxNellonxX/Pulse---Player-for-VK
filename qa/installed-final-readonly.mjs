import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

// Repeatable read-only acceptance. Never uploads, edits, or deletes account data.
// Metadata and remote URLs stay in memory; output contains counts and booleans.
const browsers = [];
try {
  for (const address of ['http://127.0.0.1:9226', 'http://[::1]:9226']) {
    browsers.push(await chromium.connectOverCDP(address, { timeout: 3000 }));
  }
  const pages = browsers.flatMap(browser => browser.contexts().flatMap(context => context.pages()));
  const main = pages.find(page => page.url().includes('tauri.localhost'));
  const remote = pages.find(page => /^https:\/\/vk\.(com|ru)(\/|$)/.test(page.url()));
  assert.ok(main && remote, 'Both installed WebViews must be available');
  let snapshot;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    snapshot = await remote.evaluate(() => window.__PULSE_VK_WEB__?.read(true));
    const status = await main.evaluate(() => window.desktop.getVkStatus());
    if (snapshot?.complete && snapshot.status === 'complete' && status.state === 'connected' && status.syncProgress?.phase === 'complete') break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(snapshot?.complete && snapshot.status === 'complete', 'Live synchronization did not complete');
  const state = await main.evaluate(() => window.desktop.getState());
  const cleanText = text => Array.from(text).filter(char => {
    const code = char.codePointAt(0);
    return code >= 32 && (code < 127 || code > 159);
  }).slice(0, 500).join('');
  const sourceLibrary = snapshot.tracks.filter(track => track.remote?.inLibrary !== false);
  const nativeLibrary = state.tracks.filter(track => track.source === 'vk' && track.remote?.inLibrary !== false);
  assert.ok(nativeLibrary.length === sourceLibrary.length && nativeLibrary.every((track, index) => track.id === sourceLibrary[index]?.id), 'VK library order differs');
  const nativeTracks = new Map(state.tracks.filter(track => track.source === 'vk').map(track => [track.id, track]));
  assert.equal(nativeTracks.size, snapshot.tracks.length, 'VK registry size differs');
  assert.ok(snapshot.tracks.every(track => {
    const native = nativeTracks.get(track.id);
    return native && native.title === cleanText(track.title) && native.artist === cleanText(track.artist) && native.available === track.available;
  }), 'VK track metadata differs');
  const nativePlaylists = new Map(state.playlists.filter(playlist => playlist.remote).map(playlist => [playlist.id, playlist]));
  assert.equal(nativePlaylists.size, snapshot.playlists.length, 'VK playlist count differs');
  assert.ok(snapshot.playlists.every(playlist => {
    const native = nativePlaylists.get(playlist.id);
    return native && native.title === cleanText(playlist.title) && Boolean(native.contentUnavailable) === Boolean(playlist.contentUnavailable)
      && JSON.stringify(native.trackIds) === JSON.stringify(playlist.trackIds);
  }), 'VK playlist metadata or membership differs');
  const locals = state.tracks.filter(track => track.source === 'local' && /\.mp3$/i.test(track.url));
  const matched = locals.filter(local => {
    const basename = path.win32.basename(decodeURIComponent(new URL(local.url).pathname));
    const stem = basename.replace(/\.mp3$/i, '');
    const unknown = !local.artist || local.artist === 'Неизвестный исполнитель';
    const delimiter = stem.indexOf(' - ');
    const title = local.title === stem && delimiter > 0 ? stem.slice(delimiter + 3).trim() : local.title;
    const artist = unknown && delimiter > 0 ? stem.slice(0, delimiter).trim() : unknown ? null : local.artist;
    return nativeLibrary.some(track => track.title === title && (!artist || track.artist === artist));
  });
  assert.equal(locals.length, 2, 'Expected the two previously selected local MP3 files');
  assert.equal(matched.length, locals.length, 'An already uploaded MP3 is missing or has different metadata');
  const rendered = await main.locator('.track-row .track-meta strong').allTextContents();
  assert.ok(rendered.length && rendered.every((title, index) => title === cleanText(sourceLibrary[index]?.title || '')), 'Visible order differs');
  const result = {
    checkedAt: new Date().toISOString(),
    readOnly: true,
    installedRelease: true,
    signedInSessionRestored: true,
    libraryTrackCount: sourceLibrary.length,
    registryTrackCount: snapshot.tracks.length,
    playlistCount: snapshot.playlists.length,
    fullNativeSequenceMatchesVk: true,
    allTrackMetadataMatchesVk: true,
    allPlaylistMembershipsMatchVk: true,
    unavailablePlaylists: snapshot.playlists.filter(playlist => playlist.contentUnavailable).length,
    previouslyUploadedMp3sPresent: matched.length,
    renderedRowsChecked: rendered.length,
    visibleSequenceMatchesVk: true,
  };
  await writeFile(new URL('installed-final-readonly-result.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  for (const browser of browsers) await browser.close().catch(() => {});
}
