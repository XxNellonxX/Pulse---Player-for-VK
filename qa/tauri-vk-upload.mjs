import { chromium } from 'playwright';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { assertIsolatedNativeBinary } from './assert-isolated-native.mjs';

// Controlled official-site fixture only. Never opens a real account or sends a
// selected file to VK. Build qa/tauri.config.json first; run this alone.
const target = process.env.CARGO_TARGET_DIR || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'vk-player-build', 'target');
const exe = process.env.TAURI_QA_EXE || path.join(target, 'debug', 'vk-player.exe');
const ffmpeg = path.resolve('src-tauri/resources/import-tools/ffmpeg.exe');
assert.ok(existsSync(exe)); assert.ok(existsSync(ffmpeg));
await assertIsolatedNativeBinary(exe);
const root = await mkdtemp(path.join(os.tmpdir(), 'pulse-upload-native-'));
const profile = path.join(root, 'profile');
const file = path.join(root, 'Filename Artist - Filename Title.mp3');
const duplicate = path.join(root, 'Different filename.mp3');
const corrupt = path.join(root, 'Corrupt.mp3');
const execFileAsync = promisify(execFile);
await execFileAsync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20', '-codec:a', 'libmp3lame', '-b:a', '192k', '-metadata', 'title=Tagged Title', '-metadata', 'artist=Tagged Artist', file], { windowsHide:true });
await copyFile(file, duplicate); await writeFile(corrupt, 'Not an MP3 file');
const original = await readFile(file);
assert.ok(original.length > 256 * 1024, 'fixture must cross native chunk boundaries');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const html = `<!doctype html><meta charset="utf-8"><title>QA isolated upload runtime</title><script>
window.vk={id:42,user:{first_name:'QA',last_name:'Upload'}};
window.__qaMode='ok';window.__qaCalls=[];window.__qaTransfers=[];window.__qaLibrary=[];window.__qaSaveCount=0;
const tuple=(id,title,artist)=>[id,42,'https://unused.invalid/audio',title,artist,3];
window.__qaLibrary=[tuple(1,'Existing','QA')];
window.ajax={post(url,p,c){window.__qaCalls.push(p.act||url);setTimeout(()=>{
 if(url.includes('owner_playlists'))return c.onDone([],0,{});
 if(p.act==='new_audio')return c.onDone('Choose MP3','<div/>','AudioUtils.initUpload(box,{},"https://pu.vk.ru/qa-upload?token=FIXTURE_ONLY",{"act":"load_audio","mid":42,"gid":0,"hash":"fixture"},209715200,{},20,1,"1","hash","",true);');
 if(p.act==='done_add'){
  window.__qaSaveCount++;
  if(window.__qaMode==='save-fails')return c.onFail();
  const t=tuple(501+window.__qaSaveCount,'Server Title','Server Artist');window.__qaLibrary.unshift(t);return c.onDone(t);
 }
 if(p.act==='edit_audio_box')return c.onDone('Edit','<div/>',"var id = "+p.aid.split('_')[1]+"; var query = { act: 'edit_audio', aid: id, oid: 42, hash: 'fixture_edit_hash_123', force_edit_hash: '', performer: performer, title: title, genre: genre }; var genreDD={selectedItems: '0'};");
 if(p.act==='edit_audio'){const t=window.__qaLibrary.find(t=>t[0]===p.aid);t[3]=p.title;t[4]=p.performer;return c.onDone(t);}
 if(p.act==='load_section')return c.onDone({list:window.__qaLibrary.slice(p.offset),totalCount:window.__qaLibrary.length,ownerId:42,id:-1});
 c.onFail();
},0)}};
// Deliberately inspect FormData inside this isolated fixture. Production uses
// the browser's native XHR and never sends raw file bytes to the renderer.
window.XMLHttpRequest=class{constructor(){this.upload={};this.status=200;}open(method,url){this.url=url;}send(form){form.get('file').arrayBuffer().then(bytes=>{window.__qaTransfers.push(Array.from(new Uint8Array(bytes)));if(window.__qaMode==='upload-fails')this.onerror();else{this.responseText='{"response":"fixture_signature"}';this.onload();}});}abort(){this.onabort?.();}};
window.getAudioPlayer=()=>({getCurrentAudio:()=>null,isPlaying:()=>false,isPaused:()=>true});
</script><p>Controlled upload fixture. No real VK access.</p>`;

let child,browser,page,remote;
const output=[],results=[];let failures=0;
async function until(fn,message,timeout=12000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await new Promise(resolve=>setTimeout(resolve,100));}throw Error(message);}
async function check(name,fn){try{await fn();results.push({name,pass:true});console.log('PASS '+name);}catch(e){failures++;results.push({name,pass:false,error:e.stack});console.log('FAIL '+name+': '+e.stack);}}
try{
 child=spawn(exe,[],{windowsHide:true,env:{...process.env,VK_PLAYER_QA_PROFILE:profile,VK_PLAYER_QA_FILES:JSON.stringify([file,corrupt,duplicate]),WEBVIEW2_USER_DATA_FOLDER:path.join(root,'browser'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9225 --autoplay-policy=no-user-gesture-required --host-resolver-rules="MAP vk.com 127.0.0.1,MAP vk.ru 127.0.0.1"'},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',x=>output.push(String(x)));child.stderr.on('data',x=>output.push(String(x)));
 for(let i=0;i<100;i++){try{browser=await chromium.connectOverCDP('http://127.0.0.1:9225',{timeout:600});break;}catch{}if(child.exitCode!==null)throw Error('QA binary exited '+child.exitCode+' '+output.join(''));await new Promise(r=>setTimeout(r,150));}
 assert.ok(browser);
 await until(()=>{page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('tauri.localhost'));return !!page;},'main page missing');
 await page.locator('.app-shell').waitFor();
 const session=await browser.newBrowserCDPSession();await session.send('Target.setDiscoverTargets',{discover:true});
 const routes=async()=>{for(const c of browser.contexts())await c.route(/^https:\/\/vk\.(com|ru)\//,r=>r.fulfill({status:200,contentType:'text/html',body:html}));};
 await routes();session.on('Target.targetCreated',()=>void routes());
 await page.evaluate(()=>window.desktop.connectVk());
 await until(()=>{remote=browser.contexts().flatMap(c=>c.pages()).find(p=>p!==page&&(/^https:\/\/vk\.(com|ru)\//.test(p.url())||p.url()==='chrome-error://chromewebdata/'));return !!remote;},'remote page missing');
 await routes();
 if(!await remote.evaluate(()=>!!window.__qaLibrary).catch(()=>false)){
  const dev=await remote.context().newCDPSession(remote);await dev.send('Network.enable');await dev.send('Network.setBypassServiceWorker',{bypass:true});
  dev.on('Fetch.requestPaused',e=>void dev.send('Fetch.fulfillRequest',{requestId:e.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/html; charset=utf-8'}],body:Buffer.from(html).toString('base64')}));
  await dev.send('Fetch.enable',{patterns:[{urlPattern:'https://vk.com/*'},{urlPattern:'https://vk.ru/*'}]});await remote.goto('https://vk.com/audio');
 }
 await until(async()=>(await page.evaluate(()=>window.desktop.getVkStatus())).state==='connected','fixture library did not sync');
 await check('real-native-batch-original-bytes-metadata-corrupt-file-and-renamed-duplicate',async()=>{
  const result=await page.evaluate(()=>window.desktop.uploadFilesToVk());
  assert.deepEqual(result.items.map(x=>x.status),['uploaded','failed','skipped']);
  assert.equal(result.items[0].trackId,'vk-42-502');assert.equal(result.accountId,42);
  const transfers=await remote.evaluate(()=>window.__qaTransfers);assert.equal(transfers.length,1);assert.equal(hash(Buffer.from(transfers[0])),hash(original));
  const info=await remote.evaluate(()=>({saves:window.__qaSaveCount,top:window.__qaLibrary[0].slice(3,5)}));assert.equal(info.saves,1);assert.deepEqual(info.top,['Tagged Title','Tagged Artist']);
  assert.equal(/fixture_signature|token=|fixture_edit_hash/.test(JSON.stringify(result)),false);
 });
 await check('verified-upload-arrives-at-top-of-authoritative-snapshot',async()=>{
  await until(async()=>(await page.evaluate(()=>window.desktop.getState())).tracks[0]?.id==='vk-42-502','new track absent from native authoritative snapshot');
  const state=await page.evaluate(()=>window.desktop.getState());assert.deepEqual(state.tracks.map(x=>x.id),['vk-42-502','vk-42-1']);assert.equal(state.tracks[0].title,'Tagged Title');assert.equal(state.tracks[0].artist,'Tagged Artist');assert.equal(state.tracks[0].source,'vk');
 });
 await check('lost-save-confirmation-is-uncertain-never-fake-success',async()=>{
  await remote.evaluate(()=>window.__qaMode='save-fails');
  const before=await remote.evaluate(()=>window.__qaSaveCount);const result=await page.evaluate(()=>window.desktop.uploadFilesToVk());
  assert.equal(result.items[0].status,'uncertain');assert.equal(await remote.evaluate(()=>window.__qaSaveCount),before+1);assert.equal(result.items.some(x=>x.status==='uploaded'),false);
 });
 await check('existing-local-artist-only-tag-uses-filename-title-and-keeps-tagged-artist',async()=>{
  // Reuse only this temporary fixture path so earlier batch scenarios and the
  // native QA file-picker list remain unchanged. No production file is edited.
  await execFileAsync(ffmpeg,['-y','-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=550:duration=2','-codec:a','libmp3lame','-b:a','128k','-map_metadata','-1','-metadata','artist=Artist From Tag',file],{windowsHide:true});
  const bytes=await readFile(file);
  const imported=await page.evaluate(()=>window.desktop.importFiles());
  const local=imported.find(track=>track.source==='local'&&track.title==='Filename Artist - Filename Title'&&track.artist==='Artist From Tag');
  assert.ok(local,'native local import did not expose the expected artist-only metadata fixture');
  await remote.evaluate(()=>window.__qaMode='ok');
  const before=await remote.evaluate(()=>window.__qaTransfers.length);
  const result=await page.evaluate(id=>window.desktop.uploadLocalTrackToVk(id),local.id);
  assert.equal(result.items.length,1);assert.equal(result.items[0].status,'uploaded');assert.equal(result.accountId,42);
  const info=await remote.evaluate(()=>({top:window.__qaLibrary[0].slice(3,5),transfers:window.__qaTransfers.slice(-1),count:window.__qaTransfers.length}));
  assert.deepEqual(info.top,['Filename Title','Artist From Tag']);assert.equal(info.count,before+1);assert.equal(hash(Buffer.from(info.transfers[0])),hash(bytes));
  const trackId=result.items[0].trackId;
  await until(async()=>(await page.evaluate(()=>window.desktop.getState())).tracks.some(track=>track.id===trackId),'confirmed artist-only local upload did not reach the native snapshot');
  const state=await page.evaluate(()=>window.desktop.getState());
  assert.ok(state.tracks.some(track=>track.id===local.id&&track.source==='local'),'upload discarded the existing playable local file');
  const uploaded=state.tracks.find(track=>track.id===trackId);assert.equal(uploaded.title,'Filename Title');assert.equal(uploaded.artist,'Artist From Tag');assert.equal(uploaded.source,'vk');
 });
 await check('existing-local-real-title-equal-to-filename-stem-is-not-split',async()=>{
  await execFileAsync(ffmpeg,['-y','-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=660:duration=2','-codec:a','libmp3lame','-b:a','128k','-map_metadata','-1','-metadata','title=Filename Artist - Filename Title','-metadata','artist=Genuine Tagged Artist',file],{windowsHide:true});
  const bytes=await readFile(file);
  const imported=await page.evaluate(()=>window.desktop.importFiles());
  const local=imported.find(track=>track.source==='local'&&track.title==='Filename Artist - Filename Title'&&track.artist==='Genuine Tagged Artist');
  assert.ok(local,'native local import did not retain a real title tag equal to its filename stem');
  const before=await remote.evaluate(()=>window.__qaTransfers.length);
  const result=await page.evaluate(id=>window.desktop.uploadLocalTrackToVk(id),local.id);
  assert.equal(result.items.length,1);assert.equal(result.items[0].status,'uploaded');
  const info=await remote.evaluate(()=>({top:window.__qaLibrary[0].slice(3,5),transfers:window.__qaTransfers.slice(-1),count:window.__qaTransfers.length}));
  assert.deepEqual(info.top,['Filename Artist - Filename Title','Genuine Tagged Artist']);assert.equal(info.count,before+1);assert.equal(hash(Buffer.from(info.transfers[0])),hash(bytes));
  const trackId=result.items[0].trackId;
  await until(async()=>(await page.evaluate(()=>window.desktop.getState())).tracks.some(track=>track.id===trackId),'confirmed exact-title local upload did not reach the native snapshot');
  const state=await page.evaluate(()=>window.desktop.getState());
  assert.ok(state.tracks.some(track=>track.id===local.id&&track.source==='local'),'upload discarded the existing local file');
  const uploaded=state.tracks.find(track=>track.id===trackId);assert.equal(uploaded.title,'Filename Artist - Filename Title');assert.equal(uploaded.artist,'Genuine Tagged Artist');
 });
 console.log(JSON.stringify({passed:5-failures,failed:failures}));
}finally{
 if(child?.exitCode===null){const exit=new Promise(r=>child.once('exit',r));child.kill();await Promise.race([exit,new Promise(r=>setTimeout(r,3000))]);}
 await writeFile(new URL('./tauri-vk-upload-results.json',import.meta.url),JSON.stringify({checkedAt:new Date().toISOString(),results,output},null,2)+'\n');
 await browser?.close().catch(()=>{});await new Promise(r=>setTimeout(r,500));await rm(root,{recursive:true,force:true}).catch(()=>{});
}
if(failures)process.exitCode=1;
