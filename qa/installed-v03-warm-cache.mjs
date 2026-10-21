import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {captureInstalledStateForRestore,restoreInstalledStateBeforeClose} from './installed-state-restore.mjs';

// A distinct real process restart must precede this test. No JS injection,
// force refresh or search can populate the artist tuples before the cache read.
const report={checkedAt:new Date().toISOString(),cloudReadOnly:true};
const browsers=[];let main,remote,saved,error;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function bounded(promise,timeout,message){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),timeout);})]);}finally{clearTimeout(timer);}}
try{
  for(const endpoint of['http://127.0.0.1:9226','http://[::1]:9226']){try{browsers.push(await chromium.connectOverCDP(endpoint,{timeout:1200}));}catch{}}
  const pages=browsers.flatMap(b=>b.contexts().flatMap(c=>c.pages()));main=pages.find(p=>p.url().includes('tauri.localhost'));remote=pages.find(p=>/^https:\/\/vk\.(ru|com)(\/|$)/.test(p.url()));assert.ok(main&&remote,'Installed WebViews unavailable');
  saved=await main.evaluate(captureInstalledStateForRestore);report.version=await main.evaluate(()=>window.desktop.getVersion());assert.equal(report.version,'0.3.0');
  const end=Date.now()+30000;let status;while(Date.now()<end){status=await main.evaluate(()=>window.desktop.getVkStatus());if(status.state==='connected')break;await wait(200);}assert.equal(status.state,'connected');
  report.artistModuleWasAbsent=await remote.evaluate(()=>!window.__PULSE_VK_ARTISTS__);assert.equal(report.artistModuleWasAbsent,true,'Artist module was already used before cold-registry cache probe');
  const result=await bounded(main.evaluate(()=>window.desktop.artistMusic({action:'artist',artistId:'5428185118660812105'})),47000,'Warm artist hydration timed out');
  assert.equal(result.cached,true,'Cold restart did not return the existing native artist cache');report.cacheHit=true;report.nativeTrackCount=result.artist?.tracks?.length||0;report.releaseCount=result.artist?.releases?.length||0;
  const track=result.artist?.tracks?.find(t=>t.available&&t.duration>40);assert.ok(track,'Cached artist has no playable full track');
  await main.evaluate(id=>{window.__qaWarmPlayback={events:0,bufferedEvents:0};window.__qaWarmPlayback.off=window.desktop.onVkPlayback(s=>{if(s.id===id){window.__qaWarmPlayback.events++;if(s.buffered?.length&&s.bufferedAhead>0)window.__qaWarmPlayback.bufferedEvents++;}});},track.id);
  assert.equal((await main.evaluate(()=>window.desktop.vkWebControl({operation:'volume',volume:0}))).accepted,true);
  const played=await bounded(main.evaluate(id=>window.desktop.vkWebControl({operation:'play',id,position:0}),track.id),78000,'Cold cached artist play did not complete');assert.equal(played.accepted,true);
  const samples=[];let first;
  for(let n=0;n<9;n++){
    if(n)await wait(1000);
    const s=await remote.evaluate(id=>{const s=window.__PULSE_VK_WEB__.playback();return{matching:s.id===id,position:s.position,playing:s.playing,error:Boolean(s.error),bufferedRanges:s.buffered?.length||0,bufferedAhead:s.bufferedAhead||0,network:s.network};},track.id);
    first ||= s;assert.equal(s.matching,true);assert.equal(s.playing,true);assert.equal(s.error,false);samples.push(s);
  }
  assert.ok(samples.at(-1).position-first.position>=7.5,'Cold cached tuple clock did not advance8s');assert.ok(samples.some(s=>s.bufferedRanges>0&&s.bufferedAhead>0),'Hydrated cached tuple did not expose actual buffer ranges');
  report.mediaAdvancedSeconds=samples.at(-1).position-first.position;report.actualBufferData=true;report.samples=samples;report.success=true;
  report.nativeEvents=await main.evaluate(()=>({events:window.__qaWarmPlayback.events,bufferedEvents:window.__qaWarmPlayback.bufferedEvents}));assert.ok(report.nativeEvents.events>0&&report.nativeEvents.bufferedEvents>0,'Native cache registry did not publish buffered playback');
}catch(reason){error=reason;report.success=false;report.failure=reason.message;console.error(`FAIL ${reason.message}`);}
finally{
  if(main&&saved){await main.evaluate(()=>{window.__qaWarmPlayback?.off?.();delete window.__qaWarmPlayback;}).catch(()=>{});try{report.localStateRestore=await main.evaluate(restoreInstalledStateBeforeClose,saved);assert.equal(report.localStateRestore.nativeReadbackMatched,true);}catch(reason){error ||= reason;report.restoreFailure=reason.message;report.success=false;}await main.evaluate(()=>window.__TAURI_INTERNALS__.invoke('finish_close')).catch(()=>{});}
  for(const b of browsers)await b.close().catch(()=>{});
  await writeFile(new URL('installed-v03-warm-cache-result.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}
if(error)process.exitCode=1;
