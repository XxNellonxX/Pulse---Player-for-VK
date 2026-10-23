import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,mkdir,rm,realpath} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {assertIsolatedNativeBinary} from './assert-isolated-native.mjs';

const executable=process.env.TAURI_QA_EXE;
assert.ok(executable,'Set TAURI_QA_EXE to the separately built VK Player QA binary.');
await assertIsolatedNativeBinary(executable);
const binary=await realpath(executable),binaryHash=createHash('sha256').update(await readFile(binary)).digest('hex');
const root=await mkdtemp(path.join(os.tmpdir(),'pulse-collection-independent-'));
const profile=path.join(root,'profile'),port=Number(process.env.PULSE_QA_CDP_PORT||9239);
await mkdir(profile,{recursive:true});
const results=[],errors=[],output=[];let child,browser,page;
const sleep=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
function pass(name,details){results.push({name,ok:true,...details});console.log('PASS '+name)}
function wave(seconds,tag){const sampleRate=8000,count=sampleRate*seconds,bytes=Buffer.alloc(44+count*2);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVE',8);bytes.write('fmt ',12);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(sampleRate,24);bytes.writeUInt32LE(sampleRate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(count*2,40);bytes.writeInt16LE(tag,count*2+42);return bytes}
const first=path.join(root,'Native A.wav'),second=path.join(root,'Native B.wav');
await writeFile(first,wave(30,1));await writeFile(second,wave(30,2));
const csv=path.join(root,'Native repeated collection.csv');
await writeFile(csv,'Track Name,Artist Name(s),Duration (ms)\nNative B,Неизвестный исполнитель,30000\nNative A,Неизвестный исполнитель,30000\nNative B,Неизвестный исполнитель,30000','utf8');
async function start(){
 child=spawn(binary,[],{windowsHide:true,env:{...process.env,VK_PLAYER_QA_PROFILE:profile,VK_PLAYER_QA_FILES:JSON.stringify([first,second]),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --autoplay-policy=no-user-gesture-required`},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',chunk=>output.push(String(chunk)));child.stderr.on('data',chunk=>output.push(String(chunk)));child.on('error',error=>output.push(error.message));
 for(let attempt=0;attempt<120;attempt++){try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:1000});break}catch{}if(child.exitCode!==null)throw Error('QA player exited '+child.exitCode+' '+output.join(''));await sleep(250)}
 assert.ok(browser,'Isolated WebView2 CDP did not start');
 for(let attempt=0;attempt<80;attempt++){page=browser.contexts().flatMap(context=>context.pages()).find(item=>/localhost|127\.0\.0\.1|tauri/.test(item.url()));if(page)break;await sleep(100)}
 assert.ok(page,'QA renderer was not found');page.on('pageerror',error=>errors.push(error.message));await page.locator('.app-shell').waitFor({timeout:20000});
}
async function stop(){if(browser){await browser.close().catch(()=>{});browser=null}if(child&&child.exitCode===null){child.kill();await Promise.race([new Promise(resolve=>child.once('exit',resolve)),sleep(3000)])}child=null;await sleep(350)}
try{
 await start();
 pass('separate QA application starts with the isolated profile',{binaryHash});
 await page.getByRole('button',{name:'Локальные файлы',exact:true}).click();await page.getByRole('button',{name:'Добавить файлы',exact:true}).first().click();await page.getByRole('button',{name:'Воспроизвести Native A',exact:true}).waitFor({timeout:15000});await page.getByRole('button',{name:'Воспроизвести Native B',exact:true}).waitFor();
 const nativeFiles=await page.evaluate(()=>window.desktop.getState());assert.equal(nativeFiles.tracks.length,2);assert.ok(nativeFiles.tracks.every(track=>track.source==='local'&&track.available));pass('actual native WAV imports expose metadata through the real bridge');
 // Account status is isolated in the renderer so QA never reads or writes the
 // production Spotify keyring. Collection and media IPC remain the real native methods.
 await page.evaluate(()=>{window.desktop=Object.freeze({...window.desktop,serviceImportStatus:async()=>({spotify:{configured:false,connected:false,message:'QA: account login intentionally disabled'},yandex:{configured:false,connected:false,message:'QA: account login intentionally disabled'}})})});
 await page.getByRole('button',{name:'Загрузить в VK',exact:true}).first().click();await page.locator('.service-collection-import input[type=file]').setInputFiles(csv);await page.getByRole('button',{name:'Импортировать коллекцию',exact:true}).waitFor();await page.getByRole('button',{name:'Импортировать коллекцию',exact:true}).click();await page.getByText('3 / 3 с источником',{exact:true}).waitFor({timeout:10000});await page.waitForTimeout(500);
 let saved=await page.evaluate(()=>window.desktop.getState());const collection=saved.serviceImports.find(record=>record.title==='Native repeated collection');assert.ok(collection);assert.deepEqual(collection.entries.map(entry=>entry.title),['Native B','Native A','Native B']);assert.deepEqual(collection.entries.map(entry=>entry.position),[0,1,2]);assert.equal(collection.entries[0].trackId,collection.entries[2].trackId);assert.equal(collection.complete,true);const ids=collection.entries.map(entry=>entry.trackId);assert.deepEqual(saved.playlists.find(playlist=>playlist.id===`import-${collection.id}`).trackIds,ids);pass('CSV UI matches real registered local tracks and persists intentional repeated source order');
 await page.getByRole('button',{name:'Моя музыка',exact:true}).click();await page.getByRole('combobox',{name:/^Сортировка:/}).click();await page.getByRole('option',{name:'Порядок импорта Spotify',exact:true}).click();const titles=await page.locator('.track-list .track-title-button strong').allTextContents();assert.deepEqual(titles,['Native B','Native A']);pass('My Music source sorting uses imported positions without changing base library');
 await page.getByRole('button',{name:'Выключить звук',exact:true}).click();assert.equal(Number(await page.getByLabel('Громкость',{exact:true}).inputValue()),0);await page.getByRole('button',{name:'Включить звук',exact:true}).click();assert.equal(Number(await page.getByLabel('Громкость',{exact:true}).inputValue()),.7);await page.getByRole('button',{name:'Выключить звук',exact:true}).click();pass('native mute toggles zero and restores the prior volume');
 await page.getByRole('button',{name:'Воспроизвести Native B',exact:true}).click();await page.getByRole('button',{name:'Пауза',exact:true}).waitFor({timeout:10000});await page.waitForTimeout(1300);const before=Number(await page.getByLabel('Позиция воспроизведения',{exact:true}).inputValue());assert.ok(before>0.5);const seek=page.getByLabel('Позиция воспроизведения',{exact:true});await seek.focus();await seek.press('ArrowRight');await seek.press('ArrowRight');await page.waitForTimeout(600);const after=Number(await seek.inputValue());assert.ok(after>=before+9,{before,after});await page.getByRole('button',{name:'Пауза',exact:true}).click();await page.waitForTimeout(700);pass('muted native WebView2 media clock advances and keyboard seek changes the real playback position',{before,after});
 const style=await page.locator('.seek-input').evaluate(element=>{const value=getComputedStyle(element);return{outlineStyle:value.outlineStyle,outlineWidth:value.outlineWidth,boxShadow:value.boxShadow}});assert.ok(style.outlineStyle==='none'||parseFloat(style.outlineWidth)===0);assert.equal(style.boxShadow,'none');pass('focused seek control has no enclosing outline',{style});
 saved=await page.evaluate(async()=>{const value=await window.desktop.getState();const record=value.serviceImports[0];record.clientSecret='QA_UNKNOWN_SECRET_CANARY';record.access_token='QA_UNKNOWN_TOKEN_CANARY';record.entries[0].audioUrl='https://example.test/private-audio';record.entries[0].oauth_token='QA_ENTRY_TOKEN_CANARY';record.sourceUrl='https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?access_token=QA_QUERY_TOKEN_CANARY#fragment';await window.desktop.saveState(value);return window.desktop.getState()});
 assert.ok(!JSON.stringify(saved.serviceImports).includes('CANARY'));assert.ok(!saved.serviceImports[0].sourceUrl.includes('?'));assert.ok(!saved.serviceImports[0].sourceUrl.includes('#'));assert.equal(saved.serviceImports[0].entries[0].trackId,ids[0]);pass('native persistence strips unknown credentials and audio fields without dropping valid metadata');
 const disk=JSON.parse(await readFile(path.join(profile,'library.json'),'utf8'));assert.ok(!JSON.stringify(disk).includes('CANARY'));const expectedPosition=saved.position;assert.ok(expectedPosition>8);await stop();await start();
 const restored=await page.evaluate(()=>window.desktop.getState());const restoredCollection=restored.serviceImports.find(record=>record.title==='Native repeated collection');assert.deepEqual(restoredCollection.entries.map(entry=>entry.position),[0,1,2]);assert.deepEqual(restoredCollection.entries.map(entry=>entry.trackId),ids);assert.deepEqual(restored.playlists.find(playlist=>playlist.id===`import-${restoredCollection.id}`).trackIds,ids);assert.ok(Math.abs(restored.position-expectedPosition)<.5);assert.equal(restored.settings.volume,0);pass('restarting the actual native process retains repeated rows, positions, playback position and mute');
 assert.deepEqual(errors,[]);pass('no renderer exceptions throughout the native import and restart flows');
 console.log(JSON.stringify({passed:results.length,total:results.length,binaryHash,muted:true,realAccountLogin:false,results}));
}catch(error){console.error(error.stack);console.log(JSON.stringify({passed:results.length,results,errors,output:output.join('').slice(-2500)}));process.exitCode=1}
finally{await stop();const resolved=path.resolve(root),temporary=path.resolve(os.tmpdir());assert.ok(resolved.startsWith(temporary+path.sep)&&path.basename(resolved).startsWith('pulse-collection-independent-'));await rm(resolved,{recursive:true,force:true}).catch(()=>{})}
