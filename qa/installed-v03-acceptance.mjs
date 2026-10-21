import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {captureInstalledStateForRestore,restoreInstalledStateBeforeClose} from './installed-state-restore.mjs';

// Explicitly coordinated installed-release QA. Cloud library is read-only.
// Temporary UI volume/playback references restore before this process closes.
const report={checkedAt:new Date().toISOString(),cloudReadOnly:true,cases:[]};
const ownSeconds=Math.max(30,Math.min(600,Number(process.env.QA_OWN_SECONDS)||120));
const browsers=[];let main,remote,saved,failure;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function bounded(promise,ms,message){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),ms);})]);}finally{clearTimeout(timer);}}
async function request(input){return bounded(main.evaluate(input=>window.desktop.artistMusic(input),input),47000,`Artist ${input.action} did not complete`);}
async function observed(){return remote.evaluate(()=>{const s=window.__PULSE_VK_WEB__.playback();return{id:s.id,position:s.position,duration:s.duration,playing:s.playing,buffering:s.buffering,recovering:s.recovering,error:Boolean(s.error),buffered:s.buffered,bufferedAhead:s.bufferedAhead,network:s.network};});}
async function waitPlaying(id,timeout=79000){
  const start=Date.now();while(Date.now()-start<timeout){const s=await observed();if(s.id===id&&s.error)throw Error('Native transport reported source error');if(s.id===id&&s.playing&&s.position>=.05)return s;await wait(200);}throw Error('Playback did not reach real advancing media');
}
async function continuity(id,label,seconds=30){
  console.log(`PHASE ${label}${seconds}s muted continuity`);
  await waitPlaying(id);const first=await observed(),samples=[];let pauses=0,maxFrozenMs=0,frozenAt=0,last=first.position;
  for(let n=0;n<seconds;n++){
    await wait(1000);const s=await observed();assert.equal(s.id,id,'Transport unexpectedly changed track');assert.equal(s.error,false,'Real source failed during continuity');
    if(!s.playing)pauses++;if(s.position<=last+.01){frozenAt ||= Date.now();maxFrozenMs=Math.max(maxFrozenMs,Date.now()-frozenAt);}else frozenAt=0;
    last=s.position;samples.push({position:s.position,playing:s.playing,buffering:s.buffering,recovering:s.recovering,network:s.network,bufferedRanges:s.buffered?.length||0,bufferedAhead:s.bufferedAhead||0});
    if((n+1)%30===0)console.log(`PROGRESS ${label}${n+1}/${seconds}s no source error`);
  }
  const final=await observed();assert.ok(final.position-first.position>=seconds-3,`Real media clock progressed less than${seconds-3}s in${seconds}s`);assert.equal(pauses,0,'Unexpected pause during continuity');
  const events=await main.evaluate(id=>{const e=window.__qaV03.events.filter(s=>s.id===id);return{count:e.length,bufferedEvents:e.filter(s=>s.buffered?.length).length,errored:e.some(s=>s.error),maxAhead:Math.max(0,...e.map(s=>s.bufferedAhead||0))};},id);
  assert.ok(events.count>0&&events.bufferedEvents>0&&events.maxAhead>0&&!events.errored,'Native events did not carry actual healthy buffer data');
  assert.ok(await main.locator('.seek-buffer-segment').count()>0,'Player HUD did not render native buffer intervals');
  const hud=await main.locator('.buffer-status').innerText();assert.match(hud,/В буфере|Аудио загружено/);
  const pauseResult=await main.evaluate(()=>window.desktop.vkWebControl({operation:'pause'}));assert.equal(pauseResult.accepted,true);
  await mkdir(new URL('./artifacts/',import.meta.url),{recursive:true});
  await main.locator('.player-wrap').screenshot({path:fileURLToPath(new URL(`./artifacts/installed-v03-${label.startsWith('Own')?'own':'artist'}-buffer.png`,import.meta.url))});
  return{secondsSampled:seconds,mediaAdvancedSeconds:final.position-first.position,unexpectedPauses:pauses,maxObservedFrozenMs:maxFrozenMs,nativeEvents:events,realHudSegments:true,samples};
}
try{
  for(const endpoint of['http://127.0.0.1:9226','http://[::1]:9226']){try{browsers.push(await chromium.connectOverCDP(endpoint,{timeout:1200}));}catch{}}
  const pages=browsers.flatMap(b=>b.contexts().flatMap(c=>c.pages()));main=pages.find(p=>p.url().includes('tauri.localhost'));remote=pages.find(p=>/^https:\/\/vk\.(ru|com)(\/|$)/.test(p.url()));
  assert.ok(main&&remote,'Installed main/VK WebViews unavailable');
  saved=await main.evaluate(captureInstalledStateForRestore);report.version=await main.evaluate(()=>window.desktop.getVersion());assert.equal(report.version,'0.3.0');
  console.log('PHASE preflight native artist receipt');
  const preflight=await request({action:'resolve',query:'Три дня дождя'});assert.ok(preflight.artists?.length,'Native artist receipt preflight is empty');report.preflightNativeArtists=preflight.artists.length;
  await main.evaluate(()=>{window.__qaV03={events:[]};window.__qaV03.off=window.desktop.onVkPlayback(s=>{const e=window.__qaV03.events;e.push(s);if(e.length>600)e.shift();});});
  await main.getByRole('button',{name:'Открыть громкость',exact:true}).click();const volume=main.getByLabel('Громкость',{exact:true});await volume.focus();await volume.press('Home');
  await main.waitForFunction(()=>document.querySelector('input[aria-label="Громкость"]')?.value==='0');
  assert.equal((await main.evaluate(()=>window.desktop.vkWebControl({operation:'volume',volume:0}))).accepted,true);
  const own=saved.tracks.slice(0,120).find(t=>t.id!==saved.currentTrackId&&t.source==='vk'&&t.remote?.inLibrary&&t.available&&t.duration>ownSeconds+30);assert.ok(own,'No visible own-library track for continuity');
  await main.locator('.main-nav').getByRole('button',{name:'Моя музыка',exact:true}).click();
  const ownRow=main.locator('.track-row').filter({has:main.getByRole('button',{name:own.title,exact:true})}).first();await ownRow.getByRole('button',{name:`Воспроизвести ${own.title}`,exact:true}).click();
  report.cases.push({case:'ownLibraryPlayback',...await continuity(own.id,'Own library',ownSeconds)});
  // Read each backend through the shipped native command. Keep only public
  // counts and boolean evidence in the result file, never account IDs/URLs.
  console.log('PHASE native artist catalog');
  const resolved=await request({action:'resolve',query:'Три дня дождя'}),ref=resolved.artists?.find(a=>a.name==='Три дня дождя')||resolved.artists?.[0];assert.ok(ref,'Artist lookup empty');
  const artist=await request({action:'artist',artistId:ref.id});assert.ok(artist.artist?.tracks?.length&&artist.artist?.releases?.length,'Artist has no tracks/releases');
  const cachedArtist=await request({action:'artist',artistId:ref.id});report.cachedArtistSourceProbe={initialCacheHit:Boolean(artist.cached),cacheHit:Boolean(cachedArtist.cached)};
  const artistTrack=cachedArtist.artist.tracks.find(t=>t.available&&t.duration>80);assert.ok(artistTrack,'No full-length artist track');
  let cachedFailure;
  try{const response=await bounded(main.evaluate(id=>window.desktop.vkWebControl({operation:'play',id,position:0}),artistTrack.id),78000,'Cached artist source timed out');assert.equal(response.accepted,true);await waitPlaying(artistTrack.id,3000);}catch(e){cachedFailure=e.message;report.cachedArtistSourceProbe.failure=cachedFailure;}
  await main.evaluate(()=>window.desktop.vkWebControl({operation:'pause'}));
  if(cachedFailure)await request({action:'artist',artistId:ref.id,force:true});
  const releases=artist.artist.releases,release=await request({action:'release',releaseId:releases[0].id});assert.ok(release.tracks?.length,'Release composition empty');
  const updates=await request({action:'updates'});assert.ok(Array.isArray(updates.artists)&&Array.isArray(updates.releases),'Updates schema unavailable');
  const snippets=await request({action:'snippets'});assert.ok(snippets.tracks?.length,'No real VK snippets available');
  const clip=await request({action:'snippet',trackId:snippets.tracks[0].id});assert.ok(clip.clip&&clip.clip.to>clip.clip.from,'VK snippet boundaries unavailable');
  report.cases.push({case:'nativeArtistCatalog',resolvedArtists:resolved.artists.length,releases:releases.length,releaseKinds:[...new Set(releases.map(r=>r.kind))],actualPlays:releases.filter(r=>r.plays!=null).length,releaseTracks:release.tracks.length,followedArtists:updates.artists.length,newReleases:updates.releases.length,snippetTracks:snippets.tracks.length,actualClipBoundaries:true,artistCacheHit:Boolean(artist.cached)});
  // Enter the same catalog through ordinary search/artist/release controls.
  console.log('PHASE actual artist and release UI');
  await main.getByPlaceholder('Поиск музыки').fill('Три дня дождя');await main.locator('.track-row .artist-link').filter({hasText:'Три дня дождя'}).first().click({timeout:45000});
  const artistChoice=main.locator('.artist-follows-strip button').filter({hasText:'Три дня дождя'}).first();
  await Promise.race([artistChoice.waitFor({timeout:45000}),main.locator('.artist-portrait').waitFor({timeout:45000})]);if(await artistChoice.count())await artistChoice.click();
  await main.locator('.artist-hero h1').filter({hasText:'Три дня дождя'}).waitFor({timeout:45000});await main.locator('.artist-release-card').first().waitFor({timeout:45000});
  let followControlAvailable=false;
  if(artist.artist.canFollow!==false&&typeof artist.artist.followed==='boolean'){const follow=main.getByRole('button',{name:artist.artist.followed?'Вы подписаны':'Подписаться на новинки',exact:true});await follow.waitFor();followControlAvailable=true;}
  assert.ok(await main.locator('.artist-track').count()>0);await main.locator('.artist-release-card').first().click();await main.locator('.artist-release-hero-art').waitFor({timeout:45000});assert.ok(await main.locator('.artist-track').count()>0);
  report.cases.push({case:'actualArtistAndReleaseUi',artistOpened:true,releaseOpened:true,releaseTracksVisible:true,followControlAvailable,followNotInvoked:true});
  // An API tuple may be cached natively while absent in a restarted website
  // registry. Test the cache hit before a forced fresh refresh can mask it.
  // Use the visible artist row so React/HUD follows currentTrackId too.
  await main.getByRole('button',{name:'Назад',exact:true}).click();await main.locator('.artist-portrait').waitFor({timeout:45000});
  const artistRow=main.locator('.artist-track').filter({has:main.getByRole('button',{name:artistTrack.title,exact:true})}).first();await artistRow.getByRole('button',{name:`Слушать ${artistTrack.title}`,exact:true}).click();
  report.cases.push({case:'artistApiPlayback',...await continuity(artistTrack.id,'Artist API tuple')});
  const seek=await main.evaluate(()=>window.desktop.vkWebControl({operation:'seek',position:45}));assert.equal(seek.accepted,true);const sought=await observed();assert.ok(Math.abs(sought.position-45)<1.2);assert.equal(sought.playing,false);report.cases.push({case:'nativeSeekPause',seekConfirmed:true,pauseConfirmed:true});
  console.log('PHASE exact VK snippet UI');
  await main.locator('.main-nav').getByRole('button',{name:'Сниппеты',exact:true}).click();await main.locator('.artist-snippet-card').first().waitFor({timeout:45000});
  const snippetTrack=snippets.tracks[0];const snippetCard=main.locator('.artist-snippet-card').filter({hasText:snippetTrack.title}).first();
  await snippetCard.getByRole('button',{name:`Сниппет ${snippetTrack.title}`,exact:true}).click();const snippetStart=await waitPlaying(snippetTrack.id);
  assert.ok(snippetStart.position>=clip.clip.from-.5&&snippetStart.position<clip.clip.from+7,'Snippet did not begin at VK boundary');
  // Native seek preserves hook clip state; skip near the real end to validate
  // automatic pause without waiting out a long snippet.
  const nearEnd=Math.max(clip.clip.from,clip.clip.to-1.5);await main.evaluate(position=>window.desktop.vkWebControl({operation:'seek',position}),nearEnd);
  const stopDeadline=Date.now()+7000;let stopped;while(Date.now()<stopDeadline){const s=await observed();if(s.id===snippetTrack.id&&!s.playing){stopped=s;break;}await wait(200);}assert.ok(stopped&&Math.abs(stopped.position-clip.clip.to)<1.5,'Snippet did not stop at VK end');
  report.cases.push({case:'vkSnippetUi',startsAtProviderBoundary:true,stopsAtProviderBoundary:true,noAutomaticNext:true});
  report.readOnlyMutationServices=await remote.evaluate(()=>({library:typeof window.__PULSE_VK_WEB__?.libraryAction==='function',playlist:typeof window.__PULSE_VK_WEB__?.playlistAction==='function',artist:typeof window.__PULSE_VK_ARTISTS__?.start==='function'}));
  if(cachedFailure)throw Error(`Cached artist playback requires repair: ${cachedFailure}`);report.success=true;
}catch(error){failure=error;report.success=false;report.failure=error.message;console.error(`FAIL ${error.message}`);}
finally{
  if(main&&saved){
    await main.evaluate(()=>{window.__qaV03?.off?.();delete window.__qaV03;}).catch(()=>{});
    try{report.localStateRestore=await main.evaluate(restoreInstalledStateBeforeClose,saved);assert.equal(report.localStateRestore.nativeReadbackMatched,true);}catch(error){report.restoreFailure=error.message;failure ||= error;report.success=false;}
    await main.evaluate(()=>window.__TAURI_INTERNALS__.invoke('finish_close')).catch(()=>{});
  }
  for(const b of browsers)await b.close().catch(()=>{});
  await writeFile(new URL('installed-v03-acceptance-result.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}
if(failure)process.exitCode=1;
