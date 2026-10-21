import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const results = [];
const artifacts = new URL('./artifacts/', import.meta.url);
await mkdir(artifacts, { recursive: true });
const settings = { theme:'dark', palette:'graphite', style:'minimal', accent:'#bdff62', density:'comfortable', textScale:1, reducedMotion:false, volume:.54, repeat:'off', shuffle:false, closeToTray:false, autoplay:false, autoSkip:false };

async function fixture(page, options) {
  await page.addInitScript(({settings, options}) => {
    const makeTrack = (n, owner = 101, own = true) => ({ id:`vk-${owner}-${n}`,title:`Track ${n}`,artist:'Moon Artist',artistRefs:[{id:'6749485843676900230',name:'Moon Artist'}],album:'',duration:180,url:`vk-web://${owner}/${n}`,source:'vk',addedAt:n,available:true,remote:{ownerId:owner,audioId:n,inLibrary:own,searchResult:!own} });
    let status = { state:'connected',mode:'web',user:{id:101,name:'Synthetic user'},message:'',capabilities:[{id:'library',status:'verified'},{id:'track-mutations',status:'verified'},{id:'mutations',status:'verified'}] };
    let tracks = Array.from({length:options.count || 8},(_,i) => makeTrack(i+1));
    const playlists = [{id:'vk-playlist-101-50',title:'Own playlist',description:'old description',trackIds:[tracks[0].id,tracks[1].id],createdAt:1,remote:{ownerId:101,playlistId:50}},{id:'vk-playlist-202-51',title:'Foreign playlist',trackIds:[tracks[0].id],createdAt:1,remote:{ownerId:202,playlistId:51}},...(options.restricted ? [{id:'vk-playlist-101-52',title:'Restricted',trackIds:[],contentUnavailable:true,createdAt:1,remote:{ownerId:101,playlistId:52}}] : [])];
    let saved = { version:1,tracks,playlists,queue:[],history:[],currentTrackId:null,position:0,settings };
    let snapshot = { status,complete:true,syncedAt:Date.now(),tracks,playlists,mode:'web' };
    const artistTrack = makeTrack(99,202,false);
    const release = {id:'vk-playlist-202-55',ownerId:202,playlistId:55,title:'Midnight EP',artist:'Moon Artist',artistRefs:[{id:'6749485843676900230',name:'Moon Artist'}],kind:'ep',year:2026,trackCount:4,plays:123456};
    const artist = {id:'6749485843676900230',name:'Moon Artist',followed:false,canFollow:true,listeners:234567,followers:4567,bio:'A real artist profile fixture.',tracks:[artistTrack],releases:[release],checkedAt:Date.now()};
    window.__qa = { calls:[], pending:[], saved, update:null, playback:null, artist, artistTrack, snapshot, makeTrack };
    const pending = (kind, input) => new Promise((resolve,reject) => window.__qa.pending.push({kind,input,resolve,reject}));
    const emit = command => { const id = command.id || saved.currentTrackId || artistTrack.id; window.__qa.lastId = id; const event = {id,requestedId:id,playing:command.operation !== 'pause' && command.operation !== 'stop',buffering:false,position:command.position || 1,duration:180,buffered:[[0,100]],bufferedAhead:99,network:'ready',ended:false,runId:command.runId}; window.__qa.playback?.(event); };
    window.desktop = {
      getState:async()=>saved,saveState:async s=>{saved=s;window.__qa.saved=s;},getVkStatus:async()=>status,
      connectVk:async()=>status,disconnectVk:async()=>({...status,state:'disconnected'}),refreshVk:async()=>snapshot,
      onVkUpdate:cb=>{window.__qa.update=cb;return()=>{};},onVkPlayback:cb=>{window.__qa.playback=cb;return()=>{};},
      vkWebControl:async command=>{window.__qa.calls.push(['playback',command]);queueMicrotask(()=>emit(command));return {accepted:true};},
      onCommand:()=>()=>{},onImportProgress:()=>()=>{},getVersion:async()=>'0.3.0',openVkMusic:async()=>{},openExternal:async()=>{},importFiles:async()=>[],removeTrack:async()=>{},exportDiagnostics:async()=>null,
      searchVk:async query=>{window.__qa.calls.push(['search',query]);return [artistTrack];},
      addVkTrack:async track=>{window.__qa.calls.push(['add',track.id]);return pending('add',track);},
      vkPlaylistChange:async input=>{window.__qa.calls.push(['playlist',input]);return pending('playlist',input);},
      artistMusic:async input=>{window.__qa.calls.push(['artist',input]);if(options.deferArtist) return pending('artist',input);if(input.action==='artist'||input.action==='follow') return {artist:{...artist,...(input.action==='follow'?{followed:input.follow}:{})},checkedAt:Date.now()};if(input.action==='resolve') return {artists:[artist],checkedAt:Date.now()};if(input.action==='updates') return {artists:[{...artist,followed:true}],releases:[release],checkedAt:Date.now()};if(input.action==='release') return {release,tracks:[artistTrack],checkedAt:Date.now()};if(input.action==='snippet') return {clip:{trackId:input.trackId,from:42,to:58},checkedAt:Date.now()};return {tracks:[artistTrack],checkedAt:Date.now()};}
    };
  }, {settings,options});
}

async function run(name, test, options={}) {
  if(process.env.QA_FILTER && !name.includes(process.env.QA_FILTER)) return;
  const context = await browser.newContext({viewport:{width:options.width || 1100,height:740}}), page = await context.newPage(), errors=[];
  page.setDefaultTimeout(4500);page.on('pageerror',e=>errors.push(e.message));
  await fixture(page,options);
  try {
    await page.goto('http://127.0.0.1:5173/'); await page.locator('.app-shell').waitFor(); await page.waitForTimeout(80);
    await test(page);assert.deepEqual(errors,[]);results.push({name,pass:true});console.log(`PASS ${name}`);
  } catch(e) {results.push({name,pass:false,error:e.message});console.log(`FAIL ${name}: ${e.stack}`);await page.screenshot({path:fileURLToPath(new URL(`independent-v03-${name}.png`,artifacts))});}
  finally {await context.close();}
}

async function side(page,button) {await page.evaluate(button=>window.dispatchEvent(new MouseEvent('mousedown',{button,bubbles:true,cancelable:true})),button);await page.waitForTimeout(100);}
async function openComposer(page) {if(await page.getByRole('button',{name:'Открыть меню',exact:true}).isVisible()) await page.getByRole('button',{name:'Открыть меню',exact:true}).click();await page.getByRole('button',{name:'Новый плейлист',exact:true}).click();await page.getByRole('dialog').waitFor();}
try {
  await run('mouse-back-forward-and-branch',async page=>{
    await page.getByRole('button',{name:'Локальные файлы',exact:true}).click();await page.getByRole('button',{name:'История',exact:true}).click();await side(page,3);assert.equal(await page.locator('h1').innerText(),'Локальные файлы');await side(page,4);assert.equal(await page.locator('h1').innerText(),'История');await side(page,3);await page.getByRole('button',{name:'Плейлисты',exact:true}).first().click();await page.waitForTimeout(80);assert.equal(await page.getByRole('button',{name:'Вперёд',exact:true}).isDisabled(),true);
  });
  await run('back-restores-list-scroll',async page=>{
    await page.locator('.content-scroll').evaluate(e=>e.scrollTop=650);assert.ok(await page.locator('.content-scroll').evaluate(e=>e.scrollTop)>500);await page.getByRole('button',{name:'Локальные файлы',exact:true}).click();await side(page,3);assert.ok(await page.locator('.content-scroll').evaluate(e=>e.scrollTop)>500);
  },{count:120});
  await run('search-typing-coalesces-history',async page=>{
    await page.getByPlaceholder('Поиск музыки').fill('a');await page.getByPlaceholder('Поиск музыки').fill('ab');await page.getByPlaceholder('Поиск музыки').fill('abc');await page.getByRole('button',{name:'История',exact:true}).click();await side(page,3);assert.equal(await page.getByPlaceholder('Поиск музыки').inputValue(),'abc');await side(page,3);assert.equal(await page.locator('h1').innerText(),'Моя музыка');
  });
  await run('playlist-busy-escape-keeps-modal',async page=>{
    await openComposer(page);await page.locator('input[name="playlist-title"]').fill('Moon mix');await page.locator('.composer-library-row').first().click();await page.getByRole('button',{name:'Создать плейлист',exact:true}).click();await page.waitForTimeout(60);await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog').count(),1);assert.equal(await page.evaluate(()=>window.__qa.calls.filter(c=>c[0]==='playlist').length),1);
  });
  await run('playlist-failure-preserves-draft-and-order',async page=>{
    await openComposer(page);await page.locator('input[name="playlist-title"]').fill('Moon mix');await page.locator('.composer-library-row').first().click();await page.locator('.composer-library-row').first().click();await page.getByRole('button',{name:'Поднять Track 2',exact:true}).click();await page.getByRole('button',{name:'Создать плейлист',exact:true}).click();await page.evaluate(()=>window.__qa.pending.find(p=>p.kind==='playlist').reject('VK connection lost'));await page.waitForTimeout(100);assert.equal(await page.getByRole('dialog').count(),1);assert.equal(await page.locator('input[name="playlist-title"]').inputValue(),'Moon mix');assert.deepEqual(await page.locator('.composer-selected-row strong').allTextContents(),['Track 2','Track 1']);assert.equal(await page.getByRole('button',{name:'Создать плейлист',exact:true}).isEnabled(),true);assert.match(await page.getByRole('dialog').getByRole('alert').innerText(),/не подтвердил|Не удалось/);await page.screenshot({path:fileURLToPath(new URL('independent-v03-playlist-failure.png',artifacts))});
  });
  await run('playlist-unconfirmed-never-closes-as-success',async page=>{
    await openComposer(page);await page.locator('input[name="playlist-title"]').fill('Pending mix');await page.getByRole('button',{name:'Создать плейлист',exact:true}).click();await page.evaluate(()=>window.__qa.pending.find(p=>p.kind==='playlist').resolve({...window.__qa.snapshot,mutationConfirmed:false}));await page.waitForTimeout(100);assert.equal(await page.getByRole('dialog').count(),1);assert.equal(await page.locator('.notification-card').count(),1);
  });
  await run('playlist-confirmed-save-preserves-exact-payload',async page=>{
    await openComposer(page);await page.locator('input[name="playlist-title"]').fill('Night mix');await page.locator('textarea').fill('Ordered for the road');await page.locator('.composer-library-row').first().click();await page.locator('.composer-library-row').first().click();await page.getByRole('button',{name:'Поднять Track 2',exact:true}).click();await page.getByRole('button',{name:'Создать плейлист',exact:true}).click();const input=await page.evaluate(()=>window.__qa.calls.find(c=>c[0]==='playlist')[1]);assert.equal(input.operation,'create');assert.equal(input.title,'Night mix');assert.equal(input.description,'Ordered for the road');assert.deepEqual(input.trackIds,['vk-101-2','vk-101-1']);await page.evaluate(()=>{const p=window.__qa.pending.find(p=>p.kind==='playlist');const list={id:'vk-playlist-101-75',title:p.input.title,description:p.input.description,trackIds:p.input.trackIds,createdAt:Date.now(),remote:{ownerId:101,playlistId:75}};p.resolve({...window.__qa.snapshot,playlists:[list,...window.__qa.snapshot.playlists],mutationConfirmed:true,createdPlaylistId:list.id});});await page.waitForTimeout(100);assert.equal(await page.getByRole('dialog').count(),0);assert.match(await page.locator('h1').innerText(),/Night mix/);assert.deepEqual(await page.locator('.track-meta strong').allTextContents(),['Track 2','Track 1']);
  });
  await run('edit-composer-preserves-existing-metadata',async page=>{
    await page.getByRole('button',{name:/Own playlist/}).click();await page.getByRole('button',{name:'Редактировать',exact:true}).click();assert.equal(await page.locator('input[name="playlist-title"]').inputValue(),'Own playlist');assert.equal(await page.locator('textarea').inputValue(),'old description');assert.deepEqual(await page.locator('.composer-selected-row strong').allTextContents(),['Track 1','Track 2']);await page.locator('input[name="playlist-title"]').fill('Renamed');await page.getByRole('button',{name:'Сохранить изменения',exact:true}).click();const input=await page.evaluate(()=>window.__qa.calls.find(c=>c[0]==='playlist')[1]);assert.equal(input.operation,'edit');assert.equal(input.playlistId,'vk-playlist-101-50');assert.equal(input.description,'old description');assert.deepEqual(input.trackIds,['vk-101-1','vk-101-2']);
  });
  await run('foreign-playlist-is-readonly-in-picker',async page=>{
    await page.locator('.track-row').first().getByRole('button',{name:'Дополнительные действия',exact:true}).click();await page.getByRole('button',{name:'В плейлист',exact:true}).click();assert.equal(await page.locator('.playlist-picker button').filter({hasText:'Foreign playlist'}).isDisabled(),true);
  });
  await run('canonical-add-confirmed-no-repeat-button',async page=>{
    await page.getByPlaceholder('Поиск музыки').fill('new artist');await page.waitForTimeout(350);const add=page.getByRole('button',{name:'Добавить в мою музыку VK',exact:true});await add.click();await page.evaluate(()=>document.querySelector('.track-add')?.click());assert.equal(await page.evaluate(()=>window.__qa.calls.filter(c=>c[0]==='add').length),1);await page.evaluate(()=>{const own=window.__qa.makeTrack(777);window.__qa.pending.find(p=>p.kind==='add').resolve({...window.__qa.snapshot,tracks:[own,...window.__qa.snapshot.tracks],mutationConfirmed:true,addedTrack:{sourceId:'vk-202-99',ownedId:own.id}})});await page.waitForTimeout(100);assert.equal(await add.count(),0);await page.locator('.track-row').filter({hasText:'Track 99'}).getByRole('button',{name:'Дополнительные действия',exact:true}).click();assert.equal(await page.getByRole('button',{name:'В мою музыку VK',exact:true}).count(),0);
  });
  await run('unconfirmed-add-still-offers-retry',async page=>{
    await page.getByPlaceholder('Поиск музыки').fill('new artist');await page.waitForTimeout(350);await page.getByRole('button',{name:'Добавить в мою музыку VK',exact:true}).click();await page.evaluate(()=>window.__qa.pending.find(p=>p.kind==='add').resolve({...window.__qa.snapshot,mutationConfirmed:false}));await page.waitForTimeout(100);assert.equal(await page.getByRole('button',{name:'Добавить в мою музыку VK',exact:true}).isEnabled(),true);assert.equal(await page.locator('.track-row').filter({hasText:'Track 99'}).locator('.track-saved').count(),0);
  });
  await run('notifications-dismiss-and-seven-seconds',async page=>{
    assert.equal(await page.locator('.notification-card').count(),1);await page.getByRole('button',{name:'Закрыть уведомление',exact:true}).click();assert.equal(await page.locator('.notification-card').count(),0);await page.clock.install();await page.clock.pauseAt(new Date());await page.evaluate(()=>window.__qa.update({...window.__qa.snapshot,status:{...window.__qa.snapshot.status,state:'error',message:'Synthetic connection failure'},complete:false}));await page.locator('.notification-card').waitFor();assert.equal(await page.locator('.notification-card').count(),1);await page.clock.fastForward(6999);assert.equal(await page.locator('.notification-card').count(),1);await page.clock.fastForward(2);await page.locator('.notification-card').waitFor({state:'detached'});assert.equal(await page.locator('.notification-card').count(),0);assert.equal(await page.locator('.sync-banner').count(),0);
  },{restricted:true});
  await run('artist-card-renders-real-sections-and-clicks',async page=>{
    await page.locator('.artist-link').first().click();await page.locator('.artist-hero h1').filter({hasText:'Moon Artist'}).waitFor();assert.match(await page.locator('.artist-stats').innerText(),/234.567/);assert.equal(await page.getByRole('heading',{name:'EP',exact:true}).count(),1);await page.locator('.artist-release-card').click();await page.locator('.artist-hero h1').filter({hasText:'Midnight EP'}).waitFor();await side(page,3);await page.locator('.artist-hero h1').filter({hasText:'Moon Artist'}).waitFor();await page.locator('.content-scroll').evaluate(e=>e.scrollTop=0);await page.waitForTimeout(80);await page.screenshot({path:fileURLToPath(new URL('independent-v03-final-artist-top.png',artifacts))});assert.ok((await page.locator('.artist-hero h1').boundingBox()).y>68);
  });
  await run('async-artist-back-restores-scroll-after-data-arrives',async page=>{
    await page.locator('.artist-link').first().click();await page.waitForTimeout(80);await page.evaluate(()=>window.__qa.pending.filter(p=>p.kind==='artist').forEach(p=>{p.done=true;p.resolve({artist:window.__qa.artist,checkedAt:Date.now()})}));await page.locator('.artist-hero h1').filter({hasText:'Moon Artist'}).waitFor();await page.locator('.content-scroll').evaluate(e=>e.scrollTop=250);await page.waitForTimeout(80);const before=await page.locator('.content-scroll').evaluate(e=>e.scrollTop);assert.ok(before>150);await page.getByRole('button',{name:'Новинки артистов',exact:true}).click();await page.waitForTimeout(80);await side(page,3);await page.waitForTimeout(250);await page.evaluate(()=>window.__qa.pending.filter(p=>p.kind==='artist'&&!p.done&&p.input.action==='artist').forEach(p=>{p.done=true;p.resolve({artist:window.__qa.artist,checkedAt:Date.now()})}));await page.locator('.artist-hero h1').filter({hasText:'Moon Artist'}).waitFor();await page.waitForTimeout(100);const restored=await page.locator('.content-scroll').evaluate(e=>e.scrollTop);assert.ok(Math.abs(restored-before)<5,`Artist scroll ${before} became ${restored} after delayed data`);
  },{deferArtist:true});
  await run('manual-scroll-cancels-delayed-history-restoration',async page=>{
    await page.locator('.artist-link').first().click();await page.waitForTimeout(80);await page.evaluate(()=>window.__qa.pending.filter(p=>p.kind==='artist').forEach(p=>{p.done=true;p.resolve({artist:window.__qa.artist,checkedAt:Date.now()})}));await page.locator('.artist-hero h1').filter({hasText:'Moon Artist'}).waitFor();await page.locator('.content-scroll').evaluate(e=>e.scrollTop=250);await page.waitForTimeout(80);await page.getByRole('button',{name:'Новинки артистов',exact:true}).click();await page.waitForTimeout(80);await side(page,3);await page.waitForTimeout(80);await page.locator('.content-scroll').dispatchEvent('wheel',{deltaY:50});await page.evaluate(()=>window.__qa.pending.filter(p=>p.kind==='artist'&&!p.done&&p.input.action==='artist').forEach(p=>{p.done=true;p.resolve({artist:window.__qa.artist,checkedAt:Date.now()})}));await page.locator('.artist-hero h1').filter({hasText:'Moon Artist'}).waitFor();await page.waitForTimeout(120);assert.equal(await page.locator('.content-scroll').evaluate(e=>e.scrollTop),0);
  },{deferArtist:true});
  await run('artist-playing-pause-button-pauses',async page=>{
    await page.locator('.artist-link').first().click();await page.getByRole('button',{name:'Слушать Track 99',exact:true}).click();await page.waitForTimeout(180);await page.evaluate(()=>window.__qa.playback({id:'vk-202-99',requestedId:'vk-202-99',playing:true,buffering:false,position:3,duration:180,buffered:[[0,100]],bufferedAhead:97,network:'ready',ended:false}));await page.getByRole('button',{name:'Пауза Track 99',exact:true}).click();await page.waitForTimeout(120);const calls=await page.evaluate(()=>window.__qa.calls.filter(c=>c[0]==='playback').map(c=>c[1].operation));assert.equal(calls.at(-1),'pause');
  });
  await run('updates-fetch-does-not-churn-on-playback',async page=>{
    await page.getByRole('button',{name:'Новинки артистов',exact:true}).click();await page.locator('.artist-release-card').waitFor();const initial=await page.evaluate(()=>window.__qa.calls.filter(c=>c[0]==='artist').length);for(let i=0;i<10;i++)await page.evaluate(i=>window.__qa.playback({id:null,playing:false,buffering:false,position:i,duration:180,ended:false}),i);await page.waitForTimeout(150);assert.equal(await page.evaluate(()=>window.__qa.calls.filter(c=>c[0]==='artist').length),initial);
  });
  await run('late-artist-response-does-not-replace-current-section',async page=>{
    await page.locator('.artist-link').first().click();await page.waitForTimeout(50);await page.getByRole('button',{name:'Новинки артистов',exact:true}).click();await page.waitForTimeout(50);await page.evaluate(()=>window.__qa.pending.find(p=>p.kind==='artist'&&p.input.action==='updates').resolve({releases:[],checkedAt:Date.now()}));await page.waitForTimeout(60);await page.evaluate(()=>window.__qa.pending.find(p=>p.kind==='artist'&&p.input.action==='artist').resolve({artist:window.__qa.artist,checkedAt:Date.now()}));await page.waitForTimeout(80);assert.equal(await page.locator('.artist-hero h1').innerText(),'Новые релизы');assert.equal(await page.locator('.artist-track').count(),0);
  },{deferArtist:true});
  await run('artist-account-change-clears-stale-card',async page=>{
    await page.locator('.artist-link').first().click();await page.locator('.artist-hero h1').filter({hasText:'Moon Artist'}).waitFor();await page.evaluate(()=>{window.__qa.calls=[];window.__qa.update({...window.__qa.snapshot,status:{...window.__qa.snapshot.status,user:{id:303,name:'Other user'}},tracks:[],playlists:[]});});await page.waitForTimeout(120);assert.ok(await page.evaluate(()=>window.__qa.calls.some(c=>c[0]==='artist'&&c[1].action==='artist')));
  });
  await run('artist-success-marker-revoked-on-authoritative-removal',async page=>{
    await page.locator('.artist-link').first().click();await page.getByRole('button',{name:'Добавить Track 99 в VK',exact:true}).click();await page.evaluate(()=>{const own=window.__qa.makeTrack(777);window.__qa.pending.find(p=>p.kind==='add').resolve({...window.__qa.snapshot,tracks:[own,...window.__qa.snapshot.tracks],mutationConfirmed:true,addedTrack:{sourceId:'vk-202-99',ownedId:own.id}})});await page.waitForTimeout(100);assert.equal(await page.getByRole('button',{name:'Добавить Track 99 в VK',exact:true}).count(),0);await page.evaluate(()=>window.__qa.update({...window.__qa.snapshot}));await page.waitForTimeout(100);assert.equal(await page.getByRole('button',{name:'Добавить Track 99 в VK',exact:true}).count(),1);
  });
  await run('snippet-uses-vk-range-not-arbitrary-time',async page=>{
    await page.getByRole('button',{name:'Сниппеты',exact:true}).click();await page.getByRole('button',{name:'Сниппет Track 99',exact:true}).click();await page.waitForTimeout(150);const commands=await page.evaluate(()=>window.__qa.calls.filter(c=>c[0]==='playback').map(c=>c[1]));assert.ok(commands.some(c=>c.operation==='play'&&c.position===42));await page.evaluate(()=>window.__qa.playback({id:'vk-202-99',requestedId:'vk-202-99',playing:true,buffering:false,position:58.1,duration:180,ended:false}));await page.waitForTimeout(100);assert.ok(await page.evaluate(()=>window.__qa.calls.some(c=>c[0]==='playback'&&c[1].operation==='pause')));
  });
  await run('narrow-composer-layout',async page=>{
    await openComposer(page);await page.locator('input[name="playlist-title"]').fill('Night drive');await page.locator('.composer-library-row').first().click();await page.screenshot({path:fileURLToPath(new URL('independent-v03-composer-900.png',artifacts))});assert.ok(await page.getByRole('button',{name:'Создать плейлист',exact:true}).isVisible());assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  },{width:900});
  await run('buffered-seekbar-actual-ranges-and-offline-state',async page=>{
    await page.locator('.track-row').first().getByRole('button',{name:'Воспроизвести Track 1',exact:true}).click();await page.waitForTimeout(100);await page.evaluate(()=>window.__qa.playback({id:'vk-101-1',requestedId:'vk-101-1',playing:true,buffering:false,position:17,duration:180,buffered:[[0,40],[60,100]],bufferedAhead:23,network:'ready',ended:false}));await page.waitForTimeout(80);assert.equal(await page.locator('.seek-buffer-segment').count(),2);assert.match(await page.locator('.buffer-status').innerText(),/0:23/);await page.getByRole('slider',{name:'Позиция воспроизведения',exact:true}).focus();await page.keyboard.press('ArrowRight');await page.waitForTimeout(50);assert.ok(await page.evaluate(()=>window.__qa.calls.some(c=>c[0]==='playback'&&c[1].operation==='seek'&&c[1].position===22)));await page.evaluate(()=>window.__qa.playback({id:'vk-101-1',requestedId:'vk-101-1',playing:false,buffering:true,position:22,duration:180,buffered:[[0,40],[60,100]],bufferedAhead:18,network:'offline',ended:false}));await page.waitForTimeout(80);assert.match(await page.locator('.buffer-status').innerText(),/Нет подключения/);await page.screenshot({path:fileURLToPath(new URL('independent-v03-buffered-network.png',artifacts))});
  });
} finally {await writeFile(new URL('./independent-v03-results.json',import.meta.url),JSON.stringify({checkedAt:new Date().toISOString(),results},null,2)+'\n');await browser.close();}
process.exitCode=results.some(r=>!r.pass)?1:0;
