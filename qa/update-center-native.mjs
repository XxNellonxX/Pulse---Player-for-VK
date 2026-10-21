import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { assertIsolatedNativeBinary } from './assert-isolated-native.mjs';
const target=process.env.CARGO_TARGET_DIR||path.join(process.env.LOCALAPPDATA||os.tmpdir(),'vk-player-build','target');
const exe=process.env.TAURI_QA_EXE||path.join(target,'debug','vk-player.exe');await assertIsolatedNativeBinary(exe);
const root=await mkdtemp(path.join(os.tmpdir(),'pulse-native-updates-'));let child,browser;
try {
 child=spawn(exe,[],{windowsHide:true,env:{...process.env,VK_PLAYER_QA_PROFILE:path.join(root,'profile'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9252'},stdio:'ignore'});
 for(let retry=0;retry<100;retry++){try{browser=await chromium.connectOverCDP('http://127.0.0.1:9252',{timeout:500});break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}assert.ok(browser);
 let page;for(let retry=0;retry<100;retry++){page=browser.contexts().flatMap(context=>context.pages()).find(item=>/tauri|localhost/.test(item.url()));if(page)break;await new Promise(resolve=>setTimeout(resolve,100));}assert.ok(page);await page.locator('.app-shell').waitFor();
 const data=await page.evaluate(async()=>({version:await window.desktop.getVersion(),release:await window.desktop.checkAppRelease()}));
 assert.equal(data.release.currentVersion,data.version);assert.ok(/^\d+\.\d+\.\d+$/.test(data.release.latestVersion));
 assert.match(data.release.downloadUrl,/^https:\/\/github\.com\/XxNellonxX\/Pulse---Player-for-VK\/releases\/download\/v[\d.]+\/.+_x64-setup\.exe$/);
 assert.match(data.release.releaseUrl,/^https:\/\/github\.com\/XxNellonxX\/Pulse---Player-for-VK\/releases\/tag\/v[\d.]+$/);
 assert.ok(data.release.notes.length>0);console.log('PASS native GitHub release discovery, version and official Windows installer URL',JSON.stringify({current:data.version,latest:data.release.latestVersion,available:data.release.available}));
}finally{if(child?.exitCode===null)child.kill();if(browser)await browser.close().catch(()=>{});await new Promise(resolve=>setTimeout(resolve,400));await rm(root,{recursive:true,force:true}).catch(()=>{});}
