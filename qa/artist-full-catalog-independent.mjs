import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// Render the actual shared component with independently controlled provider
// receipts. No VK/profile writes, navigation, media playback or Chrome.
const base = process.env.PULSE_QA_URL || 'http://127.0.0.1:5193';
const browser = await chromium.launch({channel:'msedge',headless:true});
let passed = 0;
async function check(name, scenario) {
  const page = await browser.newPage();
  page.setDefaultTimeout(3000);
  const errors=[]; page.on('pageerror',error=>errors.push(error.message));
  try {
    await page.route(base+'/__artist-qa',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><div id="root"></div>'}));
    await page.goto(base+'/__artist-qa');
    await page.evaluate(async()=>{
      const runtime=(await import('/@react-refresh')).default; runtime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
      const [{default:React},dom,{ArtistView}]=await Promise.all([import('/node_modules/.vite/deps/react.js'),import('/node_modules/.vite/deps/react-dom_client.js'),import('/src/ArtistView.tsx')]);const{createRoot}=dom.default||dom;
      window.__calls=[];window.__pending=[];window.__plays=[];
      window.__track=(id,title)=>({id:`vk--200-${id}`,source:'vk',title,artist:'Performer',album:'',duration:120,url:`vk-web://-200/${id}`,addedAt:1,available:true,remote:{ownerId:-200,audioId:id,inLibrary:false}});
      window.desktop={artistMusic:async input=>{
        window.__calls.push(input);
        if(input.action==='artist')return{artist:{id:input.artistId,name:`Artist ${input.artistId}`,tracks:[window.__track(1,'Popular only')],releases:[],checkedAt:Date.now()},checkedAt:Date.now()};
        if(input.action==='artist-tracks')return new Promise((resolve,reject)=>window.__pending.push({input,resolve,reject}));
        throw Error('Unexpected request');
      }};
      const root=createRoot(document.getElementById('root'));window.__render=(id='123',connected=true)=>root.render(React.createElement(ArtistView,{request:{action:'artist',artistId:id},connected,library:[],onNavigate:request=>window.__render(request.artistId),onPlay:(track,context)=>window.__plays.push({id:track.id,context:context.map(row=>row.id)}),onAdd:async()=>{},onSnippet(){},onConnect(){}}));window.__render();
    });
    await page.getByRole('heading',{name:'Artist 123',exact:true}).waitFor();
    await scenario(page);
    assert.deepEqual(errors,[]);passed++;console.log('PASS '+name);
  } finally {await page.close();}
}
async function fullPage(page,{ids=[2,3],cursor='at-abcdefghijk-123456',artistId='123',total=4}={}) {
  await page.evaluate(({ids,cursor,artistId,total})=>{const next=window.__pending.shift();if(!next)throw Error('No pending artist page');next.resolve({artistId,tracks:ids.map(id=>window.__track(id,'Full track '+id)),checkedAt:Date.now(),hasMore:Boolean(cursor),...(cursor?{nextCursor:cursor}:{}),totalTracks:total});},{ids,cursor,artistId,total});
}
try {
  await check('all tracks requests the full endpoint and playback context excludes popular placeholders',async page=>{
    await page.getByRole('button',{name:'Все треки',exact:true}).click();await page.waitForFunction(()=>window.__pending.length===1);
    assert.equal(await page.getByRole('button',{name:'Popular only',exact:true}).count(),0);
    await fullPage(page);await page.getByRole('button',{name:'Full track 2',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>window.__plays[0]),{id:'vk--200-2',context:['vk--200-2','vk--200-3']});
    assert.deepEqual(await page.evaluate(()=>window.__calls.map(x=>x.action)),['artist','artist-tracks']);
  });
  await check('next pages deduplicate and preserve provider order, then remove the pager',async page=>{
    await page.getByRole('button',{name:'Все треки',exact:true}).click();await fullPage(page);await page.getByRole('button',{name:'Загрузить ещё треки',exact:true}).click();await page.waitForFunction(()=>window.__pending.length===1);
    assert.equal(await page.evaluate(()=>window.__pending[0].input.cursor),'at-abcdefghijk-123456');
    await fullPage(page,{ids:[3,4],cursor:null});await page.getByRole('button',{name:'Full track 4',exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Full track 3',exact:true}).count(),1);
    assert.equal(await page.getByRole('button',{name:'Загрузить ещё треки',exact:true}).count(),0);
    await page.getByRole('button',{name:'Full track 4',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.__plays[0].context),['vk--200-2','vk--200-3','vk--200-4']);
    await page.getByRole('button',{name:'Популярное',exact:true}).click();await page.getByRole('button',{name:'Popular only',exact:true}).waitFor();
  });
  await check('artist navigation fences late catalogue receipts',async page=>{
    await page.getByRole('button',{name:'Все треки',exact:true}).click();await page.waitForFunction(()=>window.__pending.length===1);
    await page.evaluate(()=>window.__render('456'));await page.getByRole('heading',{name:'Artist 456',exact:true}).waitFor();
    await fullPage(page);await page.waitForTimeout(75);assert.equal(await page.getByRole('button',{name:'Full track 2',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Все треки',exact:true}).count(),1);
  });
  await check('disconnect removes pending catalogue data and reconnect starts clean',async page=>{
    await page.getByRole('button',{name:'Все треки',exact:true}).click();await page.waitForFunction(()=>window.__pending.length===1);await page.evaluate(()=>window.__render('123',false));await page.getByRole('button',{name:'Подключить VK',exact:true}).waitFor();
    await fullPage(page);await page.evaluate(()=>window.__render('456',true));await page.getByRole('heading',{name:'Artist 456',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Full track 2',exact:true}).count(),0);
  });
  await check('initial page failure has a working retry without showing popular as the full catalogue',async page=>{
    await page.getByRole('button',{name:'Все треки',exact:true}).click();await page.waitForFunction(()=>window.__pending.length===1);await page.evaluate(()=>window.__pending.shift().reject(Error('Temporary network failure')));await page.getByRole('alert').waitFor();
    assert.equal(await page.getByRole('button',{name:'Popular only',exact:true}).count(),0);await page.getByRole('button',{name:'Повторить',exact:true}).click();await page.waitForFunction(()=>window.__pending.length===1);await fullPage(page,{cursor:null});await page.getByRole('button',{name:'Full track 2',exact:true}).waitFor();
  });
  await check('append failure preserves prior tracks and retries the same cursor',async page=>{
    await page.getByRole('button',{name:'Все треки',exact:true}).click();await fullPage(page);await page.getByRole('button',{name:'Загрузить ещё треки',exact:true}).click();await page.waitForFunction(()=>window.__pending.length===1);await page.evaluate(()=>window.__pending.shift().reject(Error('Temporary page failure')));await page.getByRole('alert').waitFor();
    await page.getByRole('button',{name:'Full track 2',exact:true}).waitFor();await page.getByRole('button',{name:'Повторить',exact:true}).click();await page.waitForFunction(()=>window.__pending.length===1);assert.equal(await page.evaluate(()=>window.__pending[0].input.cursor),'at-abcdefghijk-123456');await fullPage(page,{ids:[4],cursor:null});await page.getByRole('button',{name:'Full track 4',exact:true}).waitFor();
  });
  await check('wrong artist or non-advancing receipts are rejected without merging',async page=>{
    await page.getByRole('button',{name:'Все треки',exact:true}).click();await fullPage(page,{artistId:'999'});await page.getByRole('alert').waitFor();assert.equal(await page.getByRole('button',{name:'Full track 2',exact:true}).count(),0);
    await page.getByRole('button',{name:'Открыть заново',exact:true}).click();await fullPage(page);await page.getByRole('button',{name:'Загрузить ещё треки',exact:true}).click();await fullPage(page,{ids:[4]});await page.getByRole('alert').waitFor();assert.equal(await page.getByRole('button',{name:'Full track 4',exact:true}).count(),0);
  });
  await check('expired cursor offers a clean restart instead of retrying an impossible page',async page=>{
    await page.getByRole('button',{name:'Все треки',exact:true}).click();await fullPage(page);await page.getByRole('button',{name:'Загрузить ещё треки',exact:true}).click();await page.waitForFunction(()=>window.__pending.length===1);await page.evaluate(()=>window.__pending.shift().reject(Error('VK больше не хранит эту страницу. Откройте все треки заново.')));await page.getByRole('button',{name:'Открыть заново',exact:true}).click();await page.waitForFunction(()=>window.__pending.length===1);assert.equal(await page.evaluate(()=>window.__pending[0].input.cursor),undefined);await fullPage(page,{ids:[5],cursor:null,total:1});await page.getByRole('button',{name:'Full track 5',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Full track 2',exact:true}).count(),0);
  });
}finally{await browser.close();}
console.log(`${passed} independent artist UI scenarios passed`);
