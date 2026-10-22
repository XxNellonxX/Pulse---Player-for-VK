import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { assertIsolatedNativeBinary } from './assert-isolated-native.mjs';

// Run alone: the QA app identifier owns one Windows WebView2 environment.
// This never logs in, writes provider credentials or accesses a real library.
// Valid grants / upstream audio / expired allocated sessions need separate QA.
const exe = process.env.TAURI_QA_EXE || path.join(process.env.LOCALAPPDATA, 'vk-player-build/target/debug/vk-player.exe');
await assertIsolatedNativeBinary(exe);
const root = await mkdtemp(path.join(os.tmpdir(), 'pulse-sc-native-independent-'));
const profile = path.join(root, 'profile');
const port = Number(process.env.PULSE_QA_CDP_PORT || 9236);
assert.ok(port > 1024 && port < 65536);
const env = { ...process.env, VK_PLAYER_QA_PROFILE: profile, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --autoplay-policy=no-user-gesture-required` };
for (const name of ['WEBVIEW2_USER_DATA_FOLDER', 'VK_PLAYER_QA_FILES', 'PULSE_SOUNDCLOUD_CLIENT_ID', 'PULSE_SOUNDCLOUD_CLIENT_SECRET', 'PULSE_SOUNDCLOUD_PROXY']) delete env[name];
const output = [], errors = [], results = [], responses = [];
const memoryMode = process.env.PULSE_QA_MEMORY === '1', execFileAsync = promisify(execFile);
let memory;
let child, browser, page;
async function measure() {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./measure-process-tree.ps1', import.meta.url)), '-RootProcessId', String(child.pid)], { windowsHide: true });
  return JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
}
async function test(name, action) {
  try { await action(); results.push({ name, ok: true }); console.log('PASS ' + name); }
  catch (error) { results.push({ name, ok: false, error: error.message }); console.log('FAIL ' + name + ': ' + error.message); }
}
try {
  child = spawn(exe, [], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => output.push(String(chunk))); child.stderr.on('data', chunk => output.push(String(chunk)));
  child.on('error', error => output.push(error.message));
  for (let n = 0; n < 80; n++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 500 }); break; } catch {}
    if (child.exitCode !== null) throw Error('Isolated QA exited: ' + child.exitCode + ' ' + output.join(''));
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  assert.ok(browser, 'Isolated WebView2 debugging endpoint unavailable');
  for (let n = 0; n < 80; n++) {
    page = browser.contexts().flatMap(context => context.pages()).find(item => /tauri\.localhost/.test(item.url()));
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page, 'Isolated Tauri main page absent');
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('.app-shell').waitFor({ timeout: 15000 });
  if (memoryMode) {
    await page.waitForTimeout(7000);
    memory = { measuredAt: new Date().toISOString(), mode: 'Isolated Windows QA debug build; empty library, no credentials or audio; sum of own process tree only. Working set includes shared pages. Metadata requests use actual native IPC and public service, not fake playback.', idle: await measure() };
    console.log('MEMORY_IDLE ' + JSON.stringify(memory.idle));
    memory.searches = await page.evaluate(async () => {
      if (!window.desktop.searchCatalogArtists) throw Error('Catalog bridge is not built yet');
      const results = [];
      for (const query of ['Daft Punk', 'Kendrick Lamar', 'Björk', 'Кино', 'Молчат Дома', 'Massive Attack', 'Nina Simone', 'Burial', 'Aphex Twin', 'Radiohead']) {
        const started = performance.now();
        try { const value = await window.desktop.searchCatalogArtists(query, 0); results.push({ query, ok: true, count: value.artists.length, firstArtistId: value.artists[0]?.id, stale: value.stale, fetchedAt: value.fetchedAt, elapsedMs: Math.round(performance.now() - started) }); }
        catch (cause) { results.push({ query, ok: false, error: String(cause), elapsedMs: Math.round(performance.now() - started) }); }
      }
      return results;
    });
    await page.waitForTimeout(3000); memory.afterTenNativeSearches = await measure();
    const successful = memory.searches.find(result => result.ok && result.firstArtistId);
    if (successful) {
      memory.cacheAndArtist = await page.evaluate(async successful => {
        let started = performance.now();
        const repeated = await window.desktop.searchCatalogArtists(successful.query, 0);
        const result = { repeatedSearch: { count: repeated.artists.length, fetchedAt: repeated.fetchedAt, elapsedMs: Math.round(performance.now() - started) } };
        started = performance.now();
        try {
          const artist = await window.desktop.getCatalogArtist(successful.firstArtistId, 0);
          result.artist = { ok: true, id: artist.artist.id, releases: artist.releases.length, fetchedAt: artist.fetchedAt, elapsedMs: Math.round(performance.now() - started) };
          started = performance.now(); const again = await window.desktop.getCatalogArtist(successful.firstArtistId, 0);
          result.repeatedArtist = { id: again.artist.id, fetchedAt: again.fetchedAt, elapsedMs: Math.round(performance.now() - started) };
        } catch (error) { result.artist = { ok: false, error: String(error), elapsedMs: Math.round(performance.now() - started) }; }
        return result;
      }, successful);
      assert.equal(memory.cacheAndArtist.repeatedSearch.fetchedAt, successful.fetchedAt);
      if (memory.cacheAndArtist.artist.ok) {
        assert.equal(memory.cacheAndArtist.artist.id, successful.firstArtistId);
        assert.equal(memory.cacheAndArtist.repeatedArtist.fetchedAt, memory.cacheAndArtist.artist.fetchedAt);
      }
      const cache = JSON.parse(await readFile(path.join(profile, 'musicbrainz-catalog.json'), 'utf8'));
      memory.cacheFile = { version: cache.version, entries: cache.entries.length, bytes: (await readFile(path.join(profile, 'musicbrainz-catalog.json'))).length };
      assert.ok(memory.cacheFile.entries > 0);
    }
    console.log('MEMORY_AFTER_TEN ' + JSON.stringify(memory));
    await writeFile(new URL('./catalog-memory-independent-results.json', import.meta.url), JSON.stringify(memory, null, 2) + '\n');
  }
  await page.evaluate(() => { window.__qaCspFailures = []; document.addEventListener('securitypolicyviolation', event => window.__qaCspFailures.push({ blocked: event.blockedURI, directive: event.effectiveDirective })); });
  const dev = await page.context().newCDPSession(page);
  await dev.send('Network.enable');
  dev.on('Network.responseReceived', event => { if (event.response.url.startsWith('http://pulse-media.localhost/')) responses.push(event.response); });

  await test('actual native bridge reports no provider keys and no signed-in user', async () => {
    const actual = await page.evaluate(async () => ({ provider: await window.desktop.soundCloudStatus(), vk: await window.desktop.getVkStatus(), library: await window.desktop.getState() }));
    assert.equal(actual.provider.configured, false); assert.equal(actual.provider.proxy, false);
    assert.notEqual(actual.vk.state, 'connected'); assert.equal(actual.library.tracks.length, 0);
    assert.equal(/clientSecret|access_token|Bearer /i.test(JSON.stringify(actual)), false);
  });
  await test('no keys reject search and URL resolution promptly with native actionable errors', async () => {
    const actual = await page.evaluate(async () => {
      const started = performance.now(), failures = [];
      for (const call of [() => window.desktop.searchSoundCloud('Fixture Artist Fixture Song'), () => window.desktop.resolveSoundCloudCandidate('https://soundcloud.com/qa-artist/qa-song')]) {
        try { await call(); failures.push(null); } catch (error) { failures.push(String(error)); }
      }
      return { failures, elapsed: performance.now() - started };
    });
    assert.equal(actual.failures.length, 2); for (const failure of actual.failures) assert.match(failure || '', /SoundCloud|хранилищ|доступ/i);
    assert.ok(actual.elapsed < 2000, 'Unconfigured source waited for a network timeout: ' + actual.elapsed);
  });
  await test('guest cannot bind or resolve a nonexistent VK track', async () => {
    const actual = await page.evaluate(async () => {
      const failures = [];
      for (const call of [() => window.desktop.soundCloudBinding('vk-42-7'), () => window.desktop.bindSoundCloud('vk-42-7', 'soundcloud:tracks:123'), () => window.desktop.resolveSoundCloud('vk-42-7')]) {
        try { await call(); failures.push(null); } catch (error) { failures.push(String(error)); }
      }
      return failures;
    });
    assert.equal(actual.length, 3); for (const failure of actual) assert.ok(failure && failure.length, 'Guest operation fabricated success');
  });
  await test('real custom media protocol permits browser CORS and rejects unknown/malformed requests', async () => {
    const actual = await page.evaluate(async () => {
      const base = 'http://pulse-media.localhost/' + 'a'.repeat(48) + '/0', result = [];
      for (const [url, init] of [[base, {}], ['http://pulse-media.localhost/not-a-token/0', {}], [base, { method: 'HEAD' }], [base, { method: 'OPTIONS' }], [base, { method: 'POST' }], [base, { headers: { Range: 'bytes=garbage' } }]]) {
        const response = await fetch(url, init);
        result.push({ status: response.status, type: response.type, body: await response.text(), cache: response.headers.get('cache-control') });
      }
      return result;
    });
    assert.deepEqual(actual.map(item => item.status), [404, 404, 404, 204, 405, 416]);
    for (const item of actual) { assert.equal(item.type, 'cors'); assert.equal(item.body, ''); assert.equal(item.cache, 'no-store'); }
    assert.deepEqual(await page.evaluate(() => window.__qaCspFailures), []);
    assert.ok(responses.length >= 6);
    for (const response of responses) {
      const headers = Object.fromEntries(Object.entries(response.headers).map(([name, value]) => [name.toLowerCase(), String(value)]));
      assert.equal(headers['access-control-allow-origin'], '*');
      assert.match(headers['access-control-allow-headers'], /Range/i);
    }
  });
  await test('unknown-session cleanup keeps native bridge healthy', async () => {
    await page.evaluate(async () => { await window.desktop.releaseSoundCloud('http://pulse-media.localhost/' + 'a'.repeat(48) + '/0'); await window.desktop.releaseSoundCloud(); });
    assert.equal((await page.evaluate(() => window.desktop.soundCloudStatus())).configured, false);
  });
  await test('actual packaged UI explains API setup and has no renderer exception', async () => {
    await page.getByRole('button', { name: 'Настройки', exact: true }).click();
    await page.getByRole('button', { name: 'Источники музыки', exact: true }).click();
    await page.getByText('Если у вас обычный аккаунт SoundCloud', { exact: true }).waitFor();
    await page.getByText(/платная подписка не гарантирует/).waitFor();
    assert.equal(await page.getByLabel('Client Secret', { exact: true }).inputValue(), '');
    assert.equal(await page.getByLabel('Client Secret', { exact: true }).getAttribute('type'), 'password');
    assert.deepEqual(errors, []);
  });
  if (process.env.PULSE_QA_CATALOG_ROUTE === '1') await test('native catalog route is independent, rejects invalid proxy credentials and never returns secrets', async () => {
    const before = await page.evaluate(() => window.desktop.statusCatalogRoute());
    assert.equal(before.proxy, false); assert.deepEqual(Object.keys(before).sort(), ['available', 'message', 'proxy']);
    const failures = await page.evaluate(async () => {
      const result = [];
      for (const value of ['ftp://qa-user:qa-password@proxy.example:2121', 'https://qa-user:qa-password@proxy.example:8080/path?token=secret', 'socks5h://proxy.example:0']) {
        try { await window.desktop.configureCatalogRoute(value); result.push(null); } catch (error) { result.push(String(error)); }
      }
      return result;
    });
    for (const failure of failures) { assert.ok(failure); assert.equal(/qa-password|qa-user|token=secret/.test(failure), false); }
    assert.deepEqual(await page.evaluate(() => window.desktop.statusCatalogRoute()), before);
    assert.equal((await page.evaluate(() => window.desktop.soundCloudStatus())).configured, false);
    // This read-only invalid-write test cannot create a new keyring entry.
    await page.getByRole('button', { name: 'Каталог артистов', exact: true }).click();
    await page.locator('.catalog-route-settings summary').click();
    assert.equal(await page.getByLabel('Прокси для MusicBrainz', { exact: true }).inputValue(), '');
    assert.equal(await page.getByLabel('Прокси для MusicBrainz', { exact: true }).getAttribute('type'), 'password');
    assert.equal(await page.getByLabel('Client Secret', { exact: true }).count(), 0);
    assert.deepEqual(errors, []);
  });
  console.log(JSON.stringify({ results, limits: ['No real SoundCloud API keys or valid native media grant', 'No physical macOS test'], profile }));
  if (results.some(result => !result.ok)) process.exitCode = 1;
} finally {
  if (child?.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]); }
  await browser?.close().catch(() => {});
  // root is produced by mkdtemp under OS temp; never accept user/library paths.
  assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('pulse-sc-native-independent-'));
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
