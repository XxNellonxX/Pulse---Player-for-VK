import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { assertIsolatedNativeBinary } from './assert-isolated-native.mjs';

// Downloads a public test recording into a disposable QA profile. No VK login
// or account writes. Optional URLs exercise the same path against other hosts.
const target = process.env.CARGO_TARGET_DIR || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'vk-player-build', 'target');
const exe = process.env.TAURI_QA_EXE || path.join(target, 'debug', 'vk-player.exe');
await assertIsolatedNativeBinary(exe);
const root = await mkdtemp(path.join(os.tmpdir(), 'pulse-public-url-'));
const profile = path.join(root, 'profile');
const results = [], output = [];
const urls = process.env.PULSE_QA_URLS ? JSON.parse(process.env.PULSE_QA_URLS) : ['https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3'];
let child, browser, page;
try {
  child = spawn(exe, [], { windowsHide:true, env:{...process.env,VK_PLAYER_QA_PROFILE:profile,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9250 --autoplay-policy=no-user-gesture-required'},stdio:['ignore','pipe','pipe'] });
  child.stdout.on('data', bytes => output.push(String(bytes))); child.stderr.on('data', bytes => output.push(String(bytes)));
  for(let attempt=0;attempt<100;attempt++) {
    try { browser=await chromium.connectOverCDP('http://127.0.0.1:9250',{timeout:500});break; } catch {}
    if(child.exitCode!==null)throw Error('Isolated player exited early');
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(browser);
  for(let attempt=0;attempt<100;attempt++) {
    page=browser.contexts().flatMap(context=>context.pages()).find(item=>/tauri|localhost/.test(item.url()));
    if(page)break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(page); await page.locator('.app-shell').waitFor();
  await page.evaluate(async()=>{const state=await window.desktop.getState();state.settings.volume=0;await window.desktop.saveState(state);});
  await page.reload(); await page.locator('.app-shell').waitFor();
  for(const url of urls) {
    const report = await page.evaluate(async url=>window.desktop.importFromUrl(url,'local'),url);
    assert.equal(report.items.length,1);assert.equal(report.items[0].status,'local');
    const track=report.items[0].track;
    assert.equal(track.source,'local');assert.ok(track.available);assert.ok(track.duration>5);assert.ok(track.title.length>0);
    const disk=JSON.parse(await readFile(path.join(profile,'library.json'),'utf8'));
    const serialized=JSON.stringify(disk);
    assert.equal(serialized.includes('spotify.com'),false);
    await page.reload(); await page.locator('.app-shell').waitFor();
    await page.getByRole('button',{name:/^Локальные файлы/}).click();
    await page.getByRole('button',{name:`Воспроизвести ${track.title}`,exact:true}).click();
    await page.getByRole('button',{name:'Пауза',exact:true}).waitFor({timeout:15000});
    await page.waitForTimeout(2200);
    const position=Number(await page.getByLabel('Позиция воспроизведения').inputValue());
    assert.ok(position>1,`Audio did not advance: ${position}`);
    await page.getByRole('button',{name:'Пауза',exact:true}).click();
    results.push({host:new URL(url).hostname,title:track.title,artist:track.artist,duration:track.duration,position,status:'PASS'});
    console.log(`PASS real public URL import, disk restore and native playback: ${new URL(url).hostname}`);
  }
  const count=await page.evaluate(async()=>(await window.desktop.getState()).tracks.length);
  for(const url of ['https://open.spotify.com/track/fixture','https://music.apple.com/album/fixture','https://127.0.0.1/private.mp3']) {
    const error=await page.evaluate(async url=>{try{await window.desktop.importFromUrl(url,'local');return null;}catch(value){return String(value);}},url);
    assert.ok(error);assert.equal(await page.evaluate(async()=>(await window.desktop.getState()).tracks.length),count);
  }
  results.push({status:'PASS',check:'protected services and private address reject without library mutation'});
  console.log('PASS unsupported and private addresses leave the library intact');
} finally {
  if(child?.exitCode===null)child.kill();if(browser)await browser.close().catch(()=>{});
  await writeFile(new URL('./import-url-native-results.json',import.meta.url),JSON.stringify({checkedAt:new Date().toISOString(),results,output},null,2)+'\n');
  await new Promise(resolve=>setTimeout(resolve,400));await rm(root,{recursive:true,force:true}).catch(()=>{});
}
