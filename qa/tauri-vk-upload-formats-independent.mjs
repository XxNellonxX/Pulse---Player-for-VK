import { chromium } from 'playwright';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { assertIsolatedNativeBinary } from './assert-isolated-native.mjs';

// This test can write only to its newly-created debug QA profile and fake site.
// It never opens a real VK account. No production source is patched.
const exe=process.env.TAURI_QA_EXE||path.join(process.env.LOCALAPPDATA,'vk-player-build','target','debug','vk-player.exe');
await assertIsolatedNativeBinary(exe);
const ffmpeg=path.resolve('src-tauri/resources/import-tools/ffmpeg.exe'),ffprobe=path.resolve('src-tauri/resources/import-tools/ffprobe.exe');
const exec=promisify(execFile),root=await mkdtemp(path.join(os.tmpdir(),'pulse-formats-independent-')),profile=path.join(root,'profile');
const flac=path.join(root,'Fallback Artist - Fallback Title.flac'),aac=path.join(root,'Variable AAC.aac'),full=path.join(root,'Full.mp3'),cut=path.join(root,'Truncated.mp3'),bad=path.join(root,'Corrupt.mp3');
await exec(ffmpeg,['-nostdin','-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=440:duration=5','-metadata','title=FLAC Tagged Title','-metadata','artist=FLAC Tagged Artist','-c:a','flac',flac],{windowsHide:true});
await exec(ffmpeg,['-nostdin','-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=550:duration=5','-c:a','aac','-b:a','96k',aac],{windowsHide:true});
await exec(ffmpeg,['-nostdin','-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=660:duration=30','-c:a','libmp3lame','-b:a','192k',full],{windowsHide:true});
const bytes=await readFile(full);await writeFile(cut,bytes.subarray(0,Math.floor(bytes.length/2)));await writeFile(bad,'Not audio at all');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const sourceHashes=await Promise.all([flac,aac,cut,bad].map(async f=>[f,hash(await readFile(f))]));
const html=`<!doctype html><meta charset="utf-8"><title>Isolated format upload</title><script>
window.vk={id:42,user:{first_name:'QA',last_name:'Formats'}};window.__qaTransfers=[];window.__qaLibrary=[];window.__qaSaves=0;window.__qaPendingTransfer=null;
window.ajax={post(url,p,c){setTimeout(()=>{
if(url.includes('owner_playlists'))return c.onDone([],0,{});
if(p.act==='new_audio')return c.onDone('Choose audio','<div/>','AudioUtils.initUpload(box,{},"https://pu.vk.ru/qa-upload",{"act":"load_audio","mid":42,"gid":0,"hash":"fixture"},209715200,{},20,1,"1","hash","",true);');
if(p.act==='done_add'){const id=700+(++window.__qaSaves);const tuple=[id,42,'https://cdn.example.test/upload-'+id+'.mp3','Server Title','Server Artist',5];window.__qaLibrary.unshift(tuple);window.__qaTransfers.at(-1).id=id;return c.onDone(tuple);}
if(p.act==='edit_audio_box')return c.onDone('Edit','<div/>',"var id = "+p.aid.split('_')[1]+"; var query = { act: 'edit_audio', aid: id, oid: 42, hash: 'fixture_edit_hash_123', force_edit_hash: '', performer: performer, title: title, genre: genre }; var genreDD={selectedItems: '0'};");
if(p.act==='edit_audio'){const t=window.__qaLibrary.find(t=>t[0]===p.aid);t[3]=p.title;t[4]=p.performer;return c.onDone(t);}
if(p.act==='load_section')return c.onDone({list:window.__qaLibrary.slice(p.offset),totalCount:window.__qaLibrary.length,ownerId:42,id:-1});
c.onFail();},0)}};
window.XMLHttpRequest=class{constructor(){this.upload={};this.status=200;}open(){}send(form){form.get('file').arrayBuffer().then(bytes=>{window.__qaTransfers.push({bytes:Array.from(new Uint8Array(bytes)),name:form.get('file').name});this.responseText='{"response":"fixture_signature"}';this.onload();});}abort(){this.onabort?.();}};
window.getAudioPlayer=()=>({getCurrentAudio:()=>null,isPlaying:()=>false,isPaused:()=>true,_ensureHasURL:()=>new Promise(()=>{})});
</script><p>Isolated synthetic runtime only</p>`;
let child,browser,page,remote;const results=[],output=[],evidence={},noticeOnly=process.argv.includes('--notice-only');
async function until(fn,message,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error(message);}
async function check(name,fn){try{await fn();results.push({name,pass:true});console.log('PASS '+name);}catch(error){results.push({name,pass:false,error:error.stack});console.error('FAIL '+name+': '+error.stack);}}
async function visibleImportNotice(){
 const notice=page.locator('.notification-card.notification-error').filter({hasText:'Не удалось добавить файлов: 2'});await notice.waitFor({timeout:4000});const text=await notice.innerText();assert.match(text,/обрезан|поврежд|декодир/i);evidence.importNotice=text;return notice;
}
try{
 child=spawn(exe,[],{windowsHide:true,env:{...process.env,VK_PLAYER_QA_PROFILE:profile,VK_PLAYER_QA_FILES:JSON.stringify([flac,aac,cut,bad]),WEBVIEW2_USER_DATA_FOLDER:path.join(root,'browser'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9248 --autoplay-policy=no-user-gesture-required --host-resolver-rules="MAP vk.com 127.0.0.1,MAP vk.ru 127.0.0.1"'},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',b=>output.push(String(b)));child.stderr.on('data',b=>output.push(String(b)));
 await until(async()=>{try{browser=await chromium.connectOverCDP('http://127.0.0.1:9248',{timeout:500});return true}catch{return false}},'CDP unavailable');
 await until(()=>{page=browser.contexts().flatMap(c=>c.pages()).find(p=>/tauri.localhost/.test(p.url()));return !!page},'Main view unavailable');await page.locator('.app-shell').waitFor();
 if(noticeOnly){
  await check('rejected-files-show-user-visible-count-reason-and-dismiss-control',async()=>{
   const imported=await page.evaluate(()=>window.desktop.importFiles());evidence.localTracks=imported;assert.deepEqual(imported.map(track=>track.title).sort(),['FLAC Tagged Title','Variable AAC']);const notice=await visibleImportNotice();await notice.getByRole('button',{name:'Закрыть уведомление',exact:true}).click();await notice.waitFor({state:'detached',timeout:2000});assert.equal((await page.evaluate(()=>window.desktop.getState())).tracks.length,2);
  });
 }else{
 const session=await browser.newBrowserCDPSession();await session.send('Target.setDiscoverTargets',{discover:true});
 const routeAll=async()=>{for(const context of browser.contexts()){
  await context.route(/^https:\/\/vk\.(com|ru)\//,r=>r.fulfill({status:200,contentType:'text/html',body:html}));
  await context.route('https://cdn.example.test/*',async route=>{const id=Number(new URL(route.request().url()).pathname.match(/(\d+)/)?.[1]);const bytes=await remote.evaluate(id=>window.__qaTransfers.find(t=>t.id===id)?.bytes,id);assert.ok(bytes);return route.fulfill({status:200,contentType:'audio/mpeg',headers:{'Access-Control-Allow-Origin':'*'},body:Buffer.from(bytes)});});
 }};await routeAll();session.on('Target.targetCreated',()=>void routeAll());
 await page.evaluate(()=>window.desktop.connectVk());
 await until(()=>{remote=browser.contexts().flatMap(c=>c.pages()).find(p=>p!==page&&(/^https:\/\/vk\.(com|ru)\//.test(p.url())||p.url()==='chrome-error://chromewebdata/'));return !!remote},'Remote fixture unavailable');await routeAll();
 if(!await remote.evaluate(()=>!!window.__qaLibrary).catch(()=>false)){const dev=await remote.context().newCDPSession(remote);await dev.send('Network.enable');await dev.send('Network.setBypassServiceWorker',{bypass:true});dev.on('Fetch.requestPaused',e=>void dev.send('Fetch.fulfillRequest',{requestId:e.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/html; charset=utf-8'}],body:Buffer.from(html).toString('base64')}));await dev.send('Fetch.enable',{patterns:[{urlPattern:'https://vk.com/*'},{urlPattern:'https://vk.ru/*'}]});await remote.goto('https://vk.com/audio');}
 await until(async()=>(await page.evaluate(()=>window.desktop.getVkStatus())).state==='connected','Fixture not connected');
 let report;
 await check('non-mp3-conversion-and-truncated-corrupt-per-file-rejection',async()=>{
  report=await page.evaluate(()=>window.desktop.uploadFilesToVk());assert.deepEqual(report.items.map(i=>i.status),['uploaded','uploaded','failed','failed']);assert.equal(report.accountId,42);assert.equal(await remote.evaluate(()=>window.__qaSaves),2);assert.equal(await remote.evaluate(()=>window.__qaTransfers.length),2);assert.match(report.items[2].message,/обрезан|поврежд|декодир/i);assert.equal(/fixture_signature|token=/.test(JSON.stringify(report)),false);
 });
 await check('converted-bytes-are-full-mp3-and-original-sources-stay-unchanged',async()=>{
  const transfers=await remote.evaluate(()=>window.__qaTransfers);assert.equal(transfers.length,2);for(let i=0;i<transfers.length;i++){const file=path.join(root,'verify-'+i+'.mp3');await writeFile(file,Buffer.from(transfers[i].bytes));const {stdout}=await exec(ffprobe,['-v','error','-show_entries','stream=codec_name:format=duration','-of','json',file],{windowsHide:true});const info=JSON.parse(stdout);assert.equal(info.streams[0].codec_name,'mp3');assert.ok(Number(info.format.duration)>4.9);}for(const [file,digest]of sourceHashes)assert.equal(hash(await readFile(file)),digest);
  const library=await remote.evaluate(()=>window.__qaLibrary);assert.deepEqual(library.find(t=>t[0]===701).slice(3,5),['FLAC Tagged Title','FLAC Tagged Artist']);
 });
 await check('confirmed-converted-upload-is-ordered-and-plays-even-with-stuck-site-resolver',async()=>{
  await until(async()=>(await page.evaluate(()=>window.desktop.getState())).tracks.some(t=>t.id==='vk-42-702'),'Converted upload missing');const state=await page.evaluate(()=>window.desktop.getState());assert.deepEqual(state.tracks.filter(t=>t.source==='vk').map(t=>t.id),['vk-42-702','vk-42-701']);
  await page.evaluate(async()=>{await window.desktop.vkWebControl({operation:'volume',volume:0});const receipt=await window.desktop.vkWebControl({operation:'play',id:'vk-42-701',position:0});if(!receipt.accepted)throw Error(receipt.error);});
  await until(async()=>{const status=await remote.evaluate(()=>window.__PULSE_VK_WEB__.playback());return status.playing&&status.position>.3},'Uploaded MP3 failed to advance native playback');const playback=await remote.evaluate(()=>window.__PULSE_VK_WEB__.playback());assert.equal(playback.error,null);assert.equal(playback.requestedId,'vk-42-701');assert.ok(playback.duration>4.9);await page.evaluate(()=>window.desktop.vkWebControl({operation:'pause'}));
 });
 await check('local-flac-and-raw-aac-imports-actually-play-in-webview',async()=>{
  const imported=await page.evaluate(()=>window.desktop.importFiles());evidence.localTracks=imported;await visibleImportNotice();assert.ok(imported.some(t=>t.source==='local'&&t.title==='FLAC Tagged Title'));assert.ok(imported.some(t=>t.source==='local'&&t.title==='Variable AAC'));for(const track of imported){assert.ok(track.duration>0&&Number.isFinite(track.duration));assert.equal(track.available,true);}
  await page.evaluate(async()=>{const state=await window.desktop.getState();state.settings.volume=0;state.settings.autoSkip=false;state.currentTrackId=null;state.position=0;await window.desktop.saveState(state)});await page.reload();await page.locator('.app-shell').waitFor();await page.getByRole('button',{name:/^Локальные файлы(?:\s+\d+)?$/}).click();evidence.localPlayback=[];
  for(const name of ['FLAC Tagged Title','Variable AAC']){
   await page.getByRole('button',{name:'Воспроизвести '+name,exact:true}).click();
   try{await page.getByRole('button',{name:'Пауза',exact:true}).waitFor({timeout:6000});await until(async()=>Number(await page.getByLabel('Позиция воспроизведения').inputValue())>.5,'Local '+name+' clock did not advance',6000);evidence.localPlayback.push({name,position:Number(await page.getByLabel('Позиция воспроизведения').inputValue()),pass:true});await page.getByRole('button',{name:'Пауза',exact:true}).click()}
   catch(error){evidence.localPlayback.push({name,pass:false,text:await page.locator('body').innerText()});throw error}
  }
 });
 await check('local-picker-does-not-expose-truncated-mp3-as-a-full-track',async()=>{
  const damaged=evidence.localTracks?.find(track=>track.source==='local'&&track.title==='Truncated');
  assert.ok(!damaged||!damaged.available,'Local file picker exposed a half-truncated MP3 as available with duration '+damaged?.duration+'s instead of rejecting its incomplete source');
 });
 await check('reimport-preserves-normalized-track-identities-without-changing-originals',async()=>{
  const firstIds=evidence.localTracks.filter(track=>['FLAC Tagged Title','Variable AAC'].includes(track.title)).map(track=>track.id).sort();const again=await page.evaluate(()=>window.desktop.importFiles());evidence.reimportTracks=again;
  assert.deepEqual(again.map(track=>track.id).sort(),firstIds);const state=await page.evaluate(()=>window.desktop.getState());assert.equal(state.tracks.filter(track=>track.source==='local').length,2);for(const [file,digest]of sourceHashes)assert.equal(hash(await readFile(file)),digest);
  await page.reload();await page.locator('.app-shell').waitFor();const restored=await page.evaluate(()=>window.desktop.getState());assert.deepEqual(restored.tracks.filter(track=>track.source==='local').map(track=>track.id).sort(),firstIds);assert.ok(restored.tracks.filter(track=>track.source==='local').every(track=>track.available));
 });
 }
}finally{
 if(child?.exitCode===null){const exit=new Promise(r=>child.once('exit',r));child.kill();await Promise.race([exit,new Promise(r=>setTimeout(r,3000))]);}await browser?.close().catch(()=>{});await writeFile(new URL(noticeOnly?'./tauri-vk-upload-notice-independent-results.json':'./tauri-vk-upload-formats-independent-results.json',import.meta.url),JSON.stringify({checkedAt:new Date().toISOString(),results,evidence,output},null,2)+'\n');await new Promise(r=>setTimeout(r,500));await rm(root,{recursive:true,force:true}).catch(()=>{});
}
process.exitCode=results.some(r=>!r.pass)?1:0;
