import { chromium } from 'playwright';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { assertIsolatedNativeBinary } from './assert-isolated-native.mjs';
const target=process.env.CARGO_TARGET_DIR||path.join(process.env.LOCALAPPDATA||os.tmpdir(),'vk-player-build','target');
const exe=process.env.TAURI_QA_EXE||path.join(target,'debug','vk-player.exe');
await assertIsolatedNativeBinary(exe);
const root=await mkdtemp(path.join(os.tmpdir(),'pulse-native-codecs-'));
const ffmpeg=path.resolve('src-tauri/resources/import-tools/ffmpeg.exe'),exec=promisify(execFile);
const fixtures=[['Float32','pcm_f32le','wav'],['Int32','pcm_s32le','wav'],['FLAC','flac','flac'],['AAC','aac','m4a'],['OPUS','libopus','ogg']];
const files=[];const results=[];let child,browser,page;
try {
  for(let index=0;index<fixtures.length;index++) {
    const [name,codec,extension]=fixtures[index],file=path.join(root,`Codec ${name}.${extension}`);
    await exec(ffmpeg,['-nostdin','-hide_banner','-loglevel','error','-f','lavfi','-i',`sine=frequency=${300+index*90}:duration=12`,'-metadata',`title=Codec ${name}`,'-metadata','artist=QA','-c:a',codec,file],{windowsHide:true});files.push(file);
  }
  child=spawn(exe,[],{windowsHide:true,env:{...process.env,VK_PLAYER_QA_PROFILE:path.join(root,'profile'),VK_PLAYER_QA_FILES:JSON.stringify(files),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9251 --autoplay-policy=no-user-gesture-required'},stdio:'ignore'});
  for(let retry=0;retry<100;retry++) {try{browser=await chromium.connectOverCDP('http://127.0.0.1:9251',{timeout:500});break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(browser);
  for(let retry=0;retry<100;retry++){page=browser.contexts().flatMap(context=>context.pages()).find(item=>/tauri|localhost/.test(item.url()));if(page)break;await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(page);await page.locator('.app-shell').waitFor();
  await page.evaluate(async()=>{const state=await window.desktop.getState();state.settings.volume=0;state.settings.autoSkip=false;await window.desktop.saveState(state);await window.desktop.importFiles();});
  await page.reload();await page.locator('.app-shell').waitFor();
  const tracks=await page.evaluate(async()=>(await window.desktop.getState()).tracks);assert.equal(tracks.length,fixtures.length);
  for(const [name] of fixtures) {
    await page.getByRole('button',{name:`Воспроизвести Codec ${name}`,exact:true}).click();
    try {
      await page.getByRole('button',{name:'Пауза',exact:true}).waitFor({timeout:5000});await page.waitForTimeout(1300);
      const position=Number(await page.getByLabel('Позиция воспроизведения').inputValue());assert.ok(position>.5);
      await page.getByRole('button',{name:'Пауза',exact:true}).click();results.push({name,status:'PASS',position});console.log(`PASS WebView2 native playback ${name}`);
    } catch(error) {results.push({name,status:'FAIL',error:String(error),text:await page.locator('body').innerText()});console.log(`FAIL WebView2 native playback ${name}`);}
  }
  assert.equal(results.filter(item=>item.status==='FAIL').length,0);
} finally {
  if(child?.exitCode===null)child.kill();if(browser)await browser.close().catch(()=>{});
  await writeFile(new URL('./local-codec-native-results.json',import.meta.url),JSON.stringify({checkedAt:new Date().toISOString(),results},null,2)+'\n');
  await new Promise(resolve=>setTimeout(resolve,400));await rm(root,{recursive:true,force:true}).catch(()=>{});
}
