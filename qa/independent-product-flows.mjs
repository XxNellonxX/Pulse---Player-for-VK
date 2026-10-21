import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { writeFile,mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const results=[];
const settings={theme:'dark',palette:'graphite',style:'minimal',accent:'#bdff62',density:'comfortable',textScale:1,reducedMotion:false,volume:.54,repeat:'off',shuffle:false,closeToTray:false,autoplay:false,autoSkip:false};
const makeTrack=(id,owner=101,inLibrary=true)=>({id:`vk-${owner}-${id}`,title:`Track ${id}`,artist:`Artist ${id}`,album:'',duration:180,url:`vk-web://${owner}/${id}`,source:'vk',addedAt:0,available:true,remote:{ownerId:owner,audioId:id,inLibrary,...(!inLibrary?{searchResult:true}:{})}});
async function run(name,test,{count=4,offline=false}={}){
 const context=await browser.newContext({viewport:{width:1100,height:740}}),page=await context.newPage(),errors=[];page.setDefaultTimeout(5000);page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(({settings,tracks,offline})=>{
  const status={state:offline?'connecting':'connected',mode:'web',user:{id:101,name:'Synthetic user'},message:'',capabilities:[{id:'library',status:'verified'},{id:'track-mutations',status:'verified'}]};
  let snapshot={status,complete:true,syncedAt:1,tracks,playlists:[]},saved={version:1,tracks,playlists:[{id:'local-list',title:'Local selection',trackIds:[tracks[0].id],createdAt:1}],queue:[],history:[],currentTrackId:null,position:0,settings};
  window.__qaCalls=[];window.__qaSaved=saved;window.__qaPending=[];window.__qaUpdate=null;
  window.desktop={getState:async()=>saved,saveState:async state=>{window.__qaSaved=state;},getVkStatus:async()=>status,connectVk:async()=>status,refreshVk:async()=>snapshot,disconnectVk:async()=>({...status,state:'disconnected'}),searchVk:async query=>{window.__qaCalls.push(['search',query]);return new Promise(resolve=>window.__qaPending.push({query,resolve}));},deleteVkTrack:async id=>{window.__qaCalls.push(['delete',id]);snapshot={...snapshot,tracks:snapshot.tracks.filter(t=>t.id!==id),mutationConfirmed:true};return snapshot;},addVkTrack:async track=>{window.__qaCalls.push(['add',track.id]);return snapshot;},onVkUpdate:cb=>{window.__qaUpdate=cb;return()=>{};},onVkPlayback:()=>()=>{},vkWebControl:async command=>{window.__qaCalls.push(['playback',command]);return {accepted:true};},onCommand:()=>()=>{},onImportProgress:()=>()=>{},importFiles:async()=>[],removeTrack:async()=>{},openVkMusic:async()=>{},openExternal:async()=>{},getVersion:async()=>'0.2.0',exportDiagnostics:async()=>null};
 },{settings,tracks:Array.from({length:count},(_,i)=>makeTrack(i+1)),offline});
 try{await page.goto('http://127.0.0.1:5173/');await page.locator('.app-shell').waitFor();await page.waitForTimeout(80);await test(page);assert.deepEqual(errors,[]);results.push({name,pass:true});console.log(`PASS ${name}`);}catch(error){results.push({name,pass:false,error:error.message});console.log(`FAIL ${name}: ${error.stack}`);await page.screenshot({path:fileURLToPath(new URL(`./artifacts/independent-${name}.png`,import.meta.url))});}finally{await context.close();}
}
try{
 await mkdir(new URL('./artifacts/',import.meta.url),{recursive:true});
 await run('cache-visible-before-connection-and-after-transient-error',async page=>{
  assert.equal(await page.locator('.track-row').count(),4);await page.evaluate(()=>window.__qaUpdate({status:{state:'error',mode:'web',message:'Temporary network failure',user:{id:101,name:'Synthetic user'},capabilities:[]},complete:false,tracks:[],playlists:[],error:'Temporary network failure'}));await page.waitForTimeout(80);assert.equal(await page.locator('.track-row').count(),4);
 },{offline:true});
 await run('full-library-shuffle-is-not-limited-to-visible-rows',async page=>{
  assert.equal(await page.locator('.track-row').count(),120);await page.getByRole('button',{name:'Перемешать всю мою музыку',exact:true}).click();await page.waitForTimeout(500);const queue=await page.evaluate(()=>window.__qaSaved.queue);assert.equal(queue.length,5001);assert.equal(new Set(queue).size,5001);assert.ok(queue.some(id=>Number(id.split('-').at(-1))>120));assert.equal(await page.getByRole('button',{name:'Перемешать всю мою музыку',exact:true}).getAttribute('aria-pressed'),'true');
 },{count:5001});
 await run('visible-delete-updates-vk-and-ui-on-confirmed-response',async page=>{
  page.on('dialog',dialog=>dialog.accept());const row=page.locator('.track-row').filter({has:page.locator('.track-meta strong',{hasText:/^Track 1$/})});await row.getByRole('button',{name:'Удалить из VK',exact:true}).click();await page.waitForTimeout(120);assert.equal(await row.count(),0);assert.equal(await page.evaluate(()=>window.__qaCalls.filter(c=>c[0]==='delete').length),1);assert.equal(await page.locator('.track-row').count(),3);
 });
 await run('local-playlist-can-remove-vk-track-while-disconnected',async page=>{
  await page.getByRole('button',{name:/Local selection/}).click();await page.locator('.track-row').getByRole('button',{name:'Убрать из плейлиста',exact:true}).click();await page.waitForTimeout(500);const saved=await page.evaluate(()=>window.__qaSaved);assert.equal(saved.playlists[0].trackIds.length,0);assert.equal(saved.tracks.length,4);assert.equal(await page.evaluate(()=>window.__qaCalls.filter(c=>c[0]==='delete').length),0);
 },{offline:true});
 await run('late-global-result-does-not-overwrite-new-query-or-own-scope',async page=>{
  await page.getByPlaceholder('Поиск музыки').fill('first');await page.waitForTimeout(350);await page.getByPlaceholder('Поиск музыки').fill('second');await page.waitForTimeout(350);await page.evaluate(()=>window.__qaPending.find(p=>p.query==='second').resolve([{id:'vk-9-99',title:'Second suggestion',artist:'Any',album:'',duration:180,url:'vk-web://9/99',source:'vk',addedAt:0,available:true,remote:{ownerId:9,audioId:99,inLibrary:false,searchResult:true}}]));await page.getByRole('button',{name:'Воспроизвести Second suggestion',exact:true}).waitFor();await page.evaluate(()=>window.__qaPending.find(p=>p.query==='first').resolve([{id:'vk-9-98',title:'Stale first',artist:'Any',album:'',duration:180,url:'vk-web://9/98',source:'vk',addedAt:0,available:true,remote:{ownerId:9,audioId:98,inLibrary:false,searchResult:true}}]));await page.waitForTimeout(80);assert.equal(await page.locator('.track-meta strong').innerText(),'Second suggestion');await page.getByRole('button',{name:'Моя музыка',exact:true}).last().click();assert.equal(await page.locator('.track-row').count(),0);
 });
 await run('artist-navigation-and-track-information-are-real-actions',async page=>{
  await page.locator('.track-row').first().getByRole('button',{name:'Дополнительные действия',exact:true}).click();await page.getByRole('button',{name:'Информация о треке',exact:true}).click();assert.match(await page.getByRole('dialog').innerText(),/Track 1/);await page.keyboard.press('Escape');await page.locator('.track-row').first().locator('.artist-link').click();assert.equal(await page.getByPlaceholder('Поиск музыки').inputValue(),'Artist 1');await page.waitForTimeout(350);assert.ok(await page.evaluate(()=>window.__qaCalls.some(c=>c[0]==='search'&&c[1]==='Artist 1')));
 });
 await writeFile(new URL('./independent-product-flows-result.json',import.meta.url),JSON.stringify({checkedAt:new Date().toISOString(),results},null,2)+'\n');
 process.exitCode=results.some(r=>!r.pass)?1:0;
}finally{await browser.close();}
