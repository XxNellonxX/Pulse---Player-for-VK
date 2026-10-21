import { chromium } from 'playwright';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { assertIsolatedNativeBinary } from './assert-isolated-native.mjs';

// Build with: node scripts/tauri.mjs build --debug --no-bundle --config qa/tauri.config.json
// This identifier and temporary profile are separate from the user's open app.
const target = process.env.CARGO_TARGET_DIR || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'vk-player-build', 'target');
const exe = process.env.TAURI_QA_EXE || path.join(target, 'debug', 'vk-player.exe');
assert.ok(existsSync(exe));
await assertIsolatedNativeBinary(exe);
const root = await mkdtemp(path.join(os.tmpdir(), 'vk-player-web-native-'));
const profile = path.join(root, 'profile');
const execFileAsync = promisify(execFile);
const windowsHelper = path.join(root, 'isolated-window-check.ps1');
await writeFile(windowsHelper, '\ufeff' + `param([int]$QaOwner,[string]$Action='inspect')
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class QaWindows {
 public delegate bool Visit(IntPtr window, IntPtr arg);
 [DllImport("user32.dll")] public static extern bool EnumWindows(Visit visit, IntPtr arg);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out int owner);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder title, int capacity);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
 [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int show);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
}
'@
$QaMatches=[System.Collections.Generic.List[object]]::new()
[QaWindows]::EnumWindows({param($QaWindow,$QaArg)
 $QaProcess=0;[void][QaWindows]::GetWindowThreadProcessId($QaWindow,[ref]$QaProcess)
 if($QaProcess -eq $QaOwner){
  $QaTitle=[System.Text.StringBuilder]::new(1024);[void][QaWindows]::GetWindowText($QaWindow,$QaTitle,1024)
  if($QaTitle.Length -gt 0){$QaMatches.Add([pscustomobject]@{handle=$QaWindow.ToInt64();title=$QaTitle.ToString();visible=[QaWindows]::IsWindowVisible($QaWindow)})}
 }
 return $true
},[IntPtr]::Zero)|Out-Null
if($Action -eq 'close-vk'){
 foreach($QaEntry in $QaMatches){if($QaEntry.title -match 'подключение к Pulse|QA isolated official-site runtime'){[void][QaWindows]::PostMessage([IntPtr]$QaEntry.handle,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)}}
}
if($Action -eq 'hide-main'){
 foreach($QaEntry in $QaMatches){if($QaEntry.title -eq 'VK Player QA'){[void][QaWindows]::ShowWindowAsync([IntPtr]$QaEntry.handle,0)}}
}
ConvertTo-Json -InputObject @($QaMatches.ToArray()) -Compress
`);
const wave = Buffer.alloc(44 + 8000 * 30 * 2);
wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVE', 8); wave.write('fmt ', 12); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(wave.length - 44, 40);
const fixtureFile = path.join(root, 'QA local alongside VK.wav');
await writeFile(fixtureFile, wave);
const html = `<!doctype html><meta charset="utf-8"><title>QA isolated official-site runtime</title><script>
window.vk={id:__QA_ACCOUNT__,user:{first_name:'QA',last_name:'Fixture'}};
window.__qaMode='ok';window.__qaHeld=[];window.__qaCalls=[];
window.__qaLibraryOrder=__QA_ORDER__;
const tuple=(owner,id,title)=>{const r=[];r[0]=id;r[1]=owner;r[2]='https://cdn.example.invalid/plain.mp3';r[3]=title;r[4]='QA';r[5]=30;return r;};
window.__qaRespond=(url,p,c)=>{
  if(url.includes('owner_playlists')){
    if(window.__qaMode==='partial')return c.onDone([],2,{});
    return c.onDone([{ownerId:vk.id,id:10,title:'QA remote mix',create_time:1700000000},{ownerId:vk.id,id:11,title:'QA remote empty',create_time:1700000010}],2,{});
  }
  let list=[];
  if(p.playlist_id===-1){const blocked=tuple(p.owner_id,3,'QA restricted');blocked[21]=1;const all=new Map([[1,tuple(p.owner_id,1,'QA remote first')],[2,tuple(p.owner_id,2,'QA remote second')],[3,blocked]]);list=window.__qaLibraryOrder.map(id=>all.get(id));}
  else if(p.playlist_id===10)list=[tuple(p.owner_id,1,'QA remote first'),tuple(303,4,'QA playlist exclusive')];
  c.onDone({list,totalCount:list.length,ownerId:p.owner_id,id:p.playlist_id,hasMore:false});
};
window.ajax={post(url,p,c){window.__qaCalls.push({url,p});if(window.__qaMode==='hold'&&p.act==='load_section')window.__qaHeld.push({url,p,c});else setTimeout(()=>window.__qaRespond(url,p,c),0);}};
window.__qaRelease=()=>{window.__qaMode='ok';for(const r of window.__qaHeld.splice(0))window.__qaRespond(r.url,r.p,r.c);};
const OriginalAudio=window.Audio;window.Audio=function(...args){const audio=new OriginalAudio(...args);window.__qaAudio=audio;return audio;};window.Audio.prototype=OriginalAudio.prototype;
window.__qaOfficialPlayCalls=0;
window.__qaResolveHeld=[];window.__qaHoldResolve=false;
window.ap={_ensureHasURL:async audio=>{if(window.__qaHoldResolve)await new Promise(resolve=>window.__qaResolveHeld.push(resolve));return {...audio,url:'https://vk.com/qa-audio.wav'};},
 play(){window.__qaOfficialPlayCalls++;throw Error('Official/ad player must never run in this test');},
 getCurrentAudio:()=>null,isPlaying:()=>false,isPaused:()=>true,subscribe(){}};
window.getAudioPlayer=()=>window.ap;
</script><p>Isolated QA runtime. No real VK request or account.</p>`;

let child, browser, page, remotePage;
let fixtureAccount = 0;
let fixtureOrder = [1, 2, 3];
const output = [], errors = [];
let failures = 0;
async function until(predicate, message, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await page.waitForTimeout(100);
  }
  throw new Error(message);
}
async function check(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.log(`FAIL ${name}: ${error.stack}`); if (name.includes('login-imports') || name.includes('restart')) { console.log('native status', await page.evaluate(() => window.desktop.getVkStatus())); if (remotePage) console.log('site payload', await remotePage.evaluate(() => ({ url: location.href, fixture: typeof window.__qaRespond, release: typeof window.__qaRelease, user: window.vk?.id, payload: window.__PULSE_VK_WEB__?.read(true) }))); } }
}
async function vkWindow() {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', windowsHelper, '-QaOwner', String(child.pid)], { windowsHide: true });
  const windows = JSON.parse(stdout.trim());
  const vk = windows.find(item => /подключение к Pulse|QA isolated official-site runtime/.test(item.title));
  assert.ok(vk, `isolated VK native window not found: ${stdout}`);
  return vk;
}
async function assertWindowVisible(expected, message) {
  await until(async () => (await vkWindow()).visible === expected, message);
}
async function start() {
  child = spawn(exe, [], { windowsHide: true, env: { ...process.env, VK_PLAYER_QA_PROFILE: profile, VK_PLAYER_QA_FILES: JSON.stringify([fixtureFile]), WEBVIEW2_USER_DATA_FOLDER: path.join(root, 'qa-browser'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9225 --autoplay-policy=no-user-gesture-required --host-resolver-rules="MAP vk.com 127.0.0.1,MAP vk.ru 127.0.0.1"' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => output.push(String(data))); child.stderr.on('data', data => output.push(String(data)));
  for (let retry = 0; retry < 100; retry++) {
    try { browser = await chromium.connectOverCDP('http://127.0.0.1:9225', { timeout: 600 }); break; } catch {}
    if (child.exitCode !== null) throw new Error(`QA binary exited ${child.exitCode}. Build the QA identifier first. ${output.join('')}`);
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  assert.ok(browser);
  for (let retry = 0; retry < 100; retry++) {
    page = browser.contexts().flatMap(item => item.pages()).find(item => item.url().includes('tauri.localhost'));
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page);
  await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', windowsHelper, '-QaOwner', String(child.pid), '-Action', 'hide-main'], { windowsHide: true });
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('.app-shell').waitFor();
  // Each Webview2 profile is a separate CDP browser context. Catch the popup's
  // first request at browser scope before native opens it.
  const session = await browser.newBrowserCDPSession();
  await session.send('Target.setDiscoverTargets', { discover: true });
  const registerRoutes = async () => {
    for (const candidate of browser.contexts()) await candidate.route(/^https:\/\/vk\.(com|ru)\//, route => new URL(route.request().url()).pathname === '/qa-audio.wav'
      ? route.fulfill({ status: 200, contentType: 'audio/wav', body: wave })
      : route.fulfill({ status: 200, contentType: 'text/html', body: html.replace('__QA_ACCOUNT__', String(fixtureAccount)).replace('__QA_ORDER__', JSON.stringify(fixtureOrder)) }));
  };
  await registerRoutes();
  session.on('Target.targetCreated', () => { void registerRoutes(); });
  return registerRoutes;
}
async function findRemote(registerRoutes) {
  for (let retry = 0; retry < 80; retry++) {
    remotePage = browser.contexts().flatMap(item => item.pages()).find(item => item !== page && (/^https:\/\/vk\.(com|ru)\//.test(item.url()) || item.url() === 'chrome-error://chromewebdata/'));
    if (remotePage) break;
    await page.waitForTimeout(100);
  }
  if (!remotePage) {
    console.log('CDP contexts:', browser.contexts().map(item => item.pages().map(page => page.url())));
    console.log('Status:', await page.evaluate(() => window.desktop.getVkStatus()));
  }
  assert.ok(remotePage, 'official QA window not visible over CDP');
  // If its new context was created after routing registration, reload once
  // after installing the route. Only the isolated QA window is navigated.
  await registerRoutes();
  if (!await remotePage.evaluate(() => !!window.__qaRespond).catch(() => false)) {
    const devtools = await remotePage.context().newCDPSession(remotePage);
    await devtools.send('Network.enable');
    await devtools.send('Network.setBypassServiceWorker', { bypass: true });
    // A restored WebView can predate Playwright's BrowserContext attachment.
    // Route its navigation at the target session itself in that case.
    devtools.on('Fetch.requestPaused', event => {
      if (new URL(event.request.url).pathname === '/qa-audio.wav') {
        void devtools.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'audio/wav' }], body: wave.toString('base64') });
        return;
      }
      const body = html.replace('__QA_ACCOUNT__', String(fixtureAccount)).replace('__QA_ORDER__', JSON.stringify(fixtureOrder));
      void devtools.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: Buffer.from(body).toString('base64') });
    });
    await devtools.send('Fetch.enable', { patterns: [{ urlPattern: 'https://vk.com/*' }, { urlPattern: 'https://vk.ru/*' }] });
    await remotePage.goto('https://vk.com/audio');
    await remotePage.waitForFunction(() => typeof window.__qaRespond === 'function');
  }
}
async function stop() {
  if (child && child.exitCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill();
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
  }
  if (browser) await browser.close().catch(() => {});
  browser = null; page = null; remotePage = null;
  await new Promise(resolve => setTimeout(resolve, 500));
}
try {
  let registerRoutes = await start();
  await page.evaluate(() => window.desktop.connectVk());
  await findRemote(registerRoutes);

  await check('guest-login-window-is-shown-only-when-authentication-is-required', async () => {
    await until(async () => (await page.evaluate(() => window.desktop.getVkStatus())).state === 'waiting-login', 'guest session was not recognized');
    await assertWindowVisible(true, 'VK login window did not become visible for the guest');
  });
  await check('successful-login-hides-window-before-library-import-completes', async () => {
    await remotePage.evaluate(() => { window.__qaMode = 'hold'; window.vk.id = 101; });
    try {
      await until(async () => (await page.evaluate(() => window.desktop.getVkStatus())).user?.id === 101, 'authenticated account not observed');
      assert.equal((await page.evaluate(() => window.desktop.getState())).tracks.length, 0, 'fixture was not held before import');
      await assertWindowVisible(false, 'VK remained visible after authentication while the import was still pending');
    } finally { await remotePage.evaluate(() => window.__qaRelease()); }
  });

  await check('native-web-login-imports-library-and-playlists-into-pulse', async () => {
    await until(async () => (await page.evaluate(() => window.desktop.getState())).tracks.length === 4, 'complete native web snapshot was not committed');
    const state = await page.evaluate(() => window.desktop.getState());
    assert.equal(state.playlists.length, 2);
    assert.deepEqual(state.playlists.find(item => item.title === 'QA remote mix').trackIds, ['vk-101-1', 'vk-303-4']);
    assert.equal(state.tracks.find(item => item.id === 'vk-101-3').available, false);
    assert.ok(state.tracks.every(item => item.url.startsWith('vk-web://')));
    assert.equal(await page.locator('.track-meta strong').filter({ hasText: 'QA remote first' }).count(), 1);
    assert.equal(await page.locator('.track-meta strong').filter({ hasText: 'QA playlist exclusive' }).count(), 0);
    assert.deepEqual(await page.locator('.track-row .track-meta strong').allTextContents(), ['QA remote first', 'QA remote second', 'QA restricted']);
  });
  await check('native-source-order-survives-refresh-and-on-disk-merge', async () => {
    await remotePage.evaluate(() => { window.__qaLibraryOrder = [2, 1, 3]; });
    await page.evaluate(() => window.desktop.refreshVk());
    await until(async () => (await page.locator('.track-row .track-meta strong').allTextContents()).join('|') === 'QA remote second|QA remote first|QA restricted', 'renderer did not adopt the reordered official-source sequence');
    const disk = JSON.parse(await readFile(path.join(profile, 'library.json'), 'utf8'));
    assert.deepEqual(disk.state.tracks.map(track => track.id), ['vk-101-2', 'vk-101-1', 'vk-101-3', 'vk-303-4']);
    await assertWindowVisible(false, 'background refresh exposed VK');
  });
  await check('native-web-controls-real-fixture-audio-and-reports-position', async () => {
    await assertWindowVisible(false, 'background VK window was visible before playback');
    await page.getByRole('button', { name: 'Воспроизвести QA remote first', exact: true }).click();
    await page.getByRole('button', { name: 'Пауза', exact: true }).waitFor({ timeout: 10000 });
    await page.waitForTimeout(2400);
    assert.ok(Number(await page.getByLabel('Позиция воспроизведения').inputValue()) > 1);
    assert.ok(await remotePage.evaluate(() => window.__qaAudio.currentTime > 1 && !window.__qaAudio.paused));
    assert.equal(await remotePage.evaluate(() => window.__qaOfficialPlayCalls), 0, 'native bridge started the official/ad player');
    await page.getByRole('button', { name: 'Пауза', exact: true }).click();
    await remotePage.waitForFunction(() => window.__qaAudio.paused);
    await assertWindowVisible(false, 'playback exposed the background VK window');
  });
  await check('same-account-sync-during-pending-load-keeps-command-and-transport-aligned', async () => {
    await remotePage.evaluate(() => { window.__qaHoldResolve = true; });
    await page.evaluate(() => { window.__qaControlRace = { pending: true }; window.desktop.vkWebControl({ operation: 'play', id: 'vk-101-2' }).then(result => { window.__qaControlRace = { result }; }, error => { window.__qaControlRace = { error: String(error) }; }); });
    await remotePage.waitForFunction(() => window.__qaResolveHeld.length > 0);
    await page.evaluate(() => window.desktop.refreshVk());
    await until(async () => (await page.evaluate(() => window.desktop.getVkStatus())).state === 'connected', 'same-account refresh never completed');
    await remotePage.evaluate(() => { window.__qaHoldResolve = false; window.__qaResolveHeld.splice(0).forEach(resolve => resolve()); });
    await page.waitForFunction(() => window.__qaControlRace.pending !== true);
    const receipt = await page.evaluate(() => window.__qaControlRace);
    assert.equal(receipt.error, undefined, `ordinary same-account sync invalidated a playback receipt: ${receipt.error}`);
    assert.equal(receipt.result?.accepted, true);
    await remotePage.waitForFunction(() => window.__PULSE_VK_WEB__.playback().playing && window.__PULSE_VK_WEB__.playback().id === 'vk-101-2');
    await page.evaluate(() => window.desktop.vkWebControl({ operation: 'stop' }));
    assert.equal(await remotePage.evaluate(() => window.__qaOfficialPlayCalls), 0);
  });
  await check('explicit-open-remains-visible-until-user-closes-it-and-controls-stay-alive', async () => {
    await page.evaluate(() => window.desktop.openVkMusic());
    await assertWindowVisible(true, 'explicit Open VK did not show its window');
    await page.evaluate(() => window.desktop.refreshVk());
    await until(async () => (await page.evaluate(() => window.desktop.getVkStatus())).state === 'connected', 'manual-window refresh did not finish');
    await assertWindowVisible(true, 'a completed sync hid an explicitly opened VK window');
    await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', windowsHelper, '-QaOwner', String(child.pid), '-Action', 'close-vk'], { windowsHide: true });
    await assertWindowVisible(false, 'closing VK did not hide its native window');
    await page.getByRole('button', { name: 'Воспроизвести QA remote second', exact: true }).click();
    await remotePage.waitForFunction(() => window.__qaAudio && !window.__qaAudio.paused && window.__PULSE_VK_WEB__.playback().id === 'vk-101-2');
    await page.getByRole('button', { name: 'Пауза', exact: true }).click();
    await remotePage.waitForFunction(() => window.__qaAudio.paused);
  });
  await check('native-restart-restores-signed-in-session-and-keeps-vk-hidden', async () => {
    fixtureAccount = 101;
    fixtureOrder = [2, 1, 3];
    await stop();
    registerRoutes = await start();
    await findRemote(registerRoutes);
    await until(async () => (await page.evaluate(() => window.desktop.getVkStatus())).state === 'connected', 'restored signed-in session did not synchronize');
    await assertWindowVisible(false, 'startup exposed VK although the fixture was already signed in');
    assert.equal((await page.evaluate(() => window.desktop.getState())).tracks.length, 4);
    assert.deepEqual(await page.locator('.track-row .track-meta strong').allTextContents(), ['QA remote second', 'QA remote first', 'QA restricted']);
    await page.getByRole('button', { name: 'Воспроизвести QA remote first', exact: true }).click();
    await remotePage.waitForFunction(() => window.__qaAudio && !window.__qaAudio.paused && window.__PULSE_VK_WEB__.playback().id === 'vk-101-1');
    await page.getByRole('button', { name: 'Пауза', exact: true }).click();
    await remotePage.waitForFunction(() => window.__qaAudio.paused);
  });
  await check('native-web-partial-refresh-keeps-last-complete-library', async () => {
    await remotePage.evaluate(() => { window.__qaMode = 'partial'; });
    await page.evaluate(() => window.desktop.refreshVk());
    await until(async () => (await page.evaluate(() => window.desktop.getVkStatus())).state === 'error', 'partial sync did not report an error');
    const state = await page.evaluate(() => window.desktop.getState());
    assert.equal(state.tracks.length, 4); assert.equal(state.playlists.length, 2);
    const disk = JSON.parse(await readFile(path.join(profile, 'library.json'), 'utf8'));
    assert.equal(disk.state.tracks.length, 4);
  });
  await check('native-web-account-switch-clears-old-cache-before-new-result', async () => {
    await remotePage.evaluate(() => { window.__qaMode = 'hold'; window.vk.id = 202; });
    await until(async () => (await page.evaluate(() => window.desktop.getVkStatus())).user?.id === 202, 'account change not observed');
    assert.equal((await page.evaluate(() => window.desktop.getState())).tracks.length, 0);
    assert.equal(await page.locator('.track-row').count(), 0);
    await remotePage.evaluate(() => window.__qaRelease());
    await until(async () => (await page.evaluate(() => window.desktop.getState())).tracks.some(item => item.id === 'vk-202-1'), 'new account data not imported');
    const state = await page.evaluate(() => window.desktop.getState());
    assert.equal(state.tracks.some(item => item.id === 'vk-101-1'), false);
  });
  await check('native-web-logout-clears-pulse-remote-state', async () => {
    await remotePage.evaluate(() => { window.vk.id = 0; });
    await until(async () => (await page.evaluate(() => window.desktop.getState())).tracks.length === 0 && (await page.evaluate(() => window.desktop.getVkStatus())).state === 'waiting-login', 'logout did not clear remote state');
    assert.equal((await page.evaluate(() => window.desktop.getVkStatus())).state, 'waiting-login');
    assert.equal(await page.locator('.track-row').count(), 0);
    await assertWindowVisible(true, 'expired/logout session did not show a login window');
  });
  await check('native-web-has-no-main-renderer-errors', async () => assert.deepEqual(errors, []));
} finally {
  await stop();
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
console.log(`QA result: ${failures} failed checks`);
process.exitCode = failures ? 1 : 0;
