import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const failures=[];
async function run(name,fn){
  const page=await browser.newPage({viewport:{width:1440,height:900}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    const own={id:'vk-42-1',title:'Existing song',artist:'QA artist',album:'',duration:180,source:'vk',url:'vk-web://42/1',available:true,addedAt:1,remote:{ownerId:42,audioId:1,inLibrary:true}};
    const result={id:'vk-19-2',title:'Search song',artist:'QA artist',album:'',duration:200,source:'vk',url:'vk-web://19/2',available:true,addedAt:2,remote:{ownerId:19,audioId:2,inLibrary:false,searchResult:true}};
    const settings={theme:'dark',style:'minimal',accent:'#bdff62',density:'comfortable',textScale:1,reducedMotion:false,volume:0,repeat:'off',shuffle:false,closeToTray:false,autoplay:false,autoSkip:false};
    window.__state={version:1,tracks:[own],playlists:[{id:'restricted',title:'Restricted mix',trackIds:[],createdAt:1,remote:{ownerId:42,playlistId:8},contentUnavailable:true}],history:[],queue:[own.id],currentTrackId:null,position:0,settings};
    window.__status={state:'connected',mode:'web',message:'Ready',user:{id:42,name:'QA account'},capabilities:[{id:'library',label:'library',status:'verified',detail:''},{id:'track-mutations',label:'tracks',status:'verified',detail:''},{id:'mutations',label:'playlists',status:'verified',detail:''}]};
    window.__mode='success';window.__addCalls=0;window.__updates=new Set();window.__resolve=null;
    const snapshot=(overrides={})=>({status:window.__status,tracks:window.__state.tracks,playlists:window.__state.playlists,mode:'web',complete:true,mutationConfirmed:true,...overrides});
    window.desktop={
      getState:async()=>window.__state,saveState:async state=>{window.__state=state;},getVkStatus:async()=>window.__status,onCommand:()=>()=>{},onVkUpdate:callback=>{window.__updates.add(callback);return()=>window.__updates.delete(callback);},onVkPlayback:()=>()=>{},
      searchVk:async()=>[result],refreshVk:async()=>snapshot(),getVersion:async()=>'QA',
      addVkTrack:async()=>{
        window.__addCalls++;
        if(window.__mode==='pending')await new Promise(resolve=>{window.__resolve=resolve;});
        if(window.__mode==='reject')throw new Error('No confirmation');
        if(window.__mode==='unconfirmed')return snapshot({mutationConfirmed:false});
        const owned={...result,id:'vk-42-99',remote:{ownerId:42,audioId:99,inLibrary:true,searchResult:false},url:'vk-web://42/99'};
        return snapshot({tracks:[owned,own],addedTrack:{sourceId:result.id,ownedId:owned.id}});
      },
    };
  });
  try{await page.clock.install();await page.goto('http://127.0.0.1:5173');await page.locator('.app-shell').waitFor();await fn(page);assert.deepEqual(errors,[]);console.log(`PASS ${name}`);}catch(error){failures.push({name,error:error.message});console.log(`FAIL ${name}: ${error.message}`);}finally{await page.close();}
}
async function search(page){await page.getByPlaceholder('Поиск музыки').fill('Search');await page.getByRole('button',{name:'Добавить в мою музыку VK',exact:true}).waitFor();}
async function side(page,button){await page.evaluate(button=>{for(const type of['mousedown','mouseup','auxclick'])window.dispatchEvent(new MouseEvent(type,{button,bubbles:true,cancelable:true}));},button);}
try{
  await run('side mouse navigation restores route and query without typing history spam',async page=>{
    await page.getByRole('button',{name:'Плейлисты',exact:true}).click();
    await page.getByRole('button',{name:'Поиск',exact:true}).click();
    await page.getByPlaceholder('Поиск музыки').pressSequentially('Search',{delay:20});
    await side(page,3);await page.waitForFunction(()=>document.querySelector('h1')?.textContent==='Плейлисты');
    await side(page,4);await page.waitForFunction(()=>document.querySelector('h1')?.textContent==='Поиск');
    assert.equal(await page.getByPlaceholder('Поиск музыки').inputValue(),'Search');
    await page.keyboard.press('Alt+ArrowLeft');await page.waitForFunction(()=>document.querySelector('h1')?.textContent==='Плейлисты');
    await page.keyboard.press('Alt+ArrowRight');await page.waitForFunction(()=>document.querySelector('h1')?.textContent==='Поиск');
  });
  await run('restricted playlist notice expires after seven seconds and stays dismissed on navigation',async page=>{
    const notice=page.locator('.notification-card').filter({hasText:'VK ограничил'});await notice.waitFor();
    await page.clock.fastForward(6900);assert.equal(await notice.count(),1);
    await page.clock.fastForward(200);assert.equal(await notice.count(),0);
    await page.getByRole('button',{name:'Плейлисты',exact:true}).click();await page.locator('.main-nav').getByRole('button',{name:'Моя музыка',exact:true}).click();
    assert.equal(await notice.count(),0);
  });
  await run('confirmed add updates library and removes every duplicate add action',async page=>{
    await search(page);await page.getByRole('button',{name:'Добавить в мою музыку VK',exact:true}).click();
    await page.getByText('Трек сохранён в вашей музыке VK',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Добавить в мою музыку VK',exact:true}).count(),0);
    await page.locator('.track-row').filter({hasText:'Search song'}).first().getByRole('button',{name:'Дополнительные действия'}).click();
    assert.equal(await page.getByRole('button',{name:'В мою музыку VK',exact:true}).count(),0,'Saved search alias still offers duplicate cloud add');
    await page.locator('.main-nav').getByRole('button',{name:'Моя музыка',exact:true}).click();assert.ok(await page.locator('.track-row').filter({hasText:'Search song'}).count()>0);
    assert.equal(await page.evaluate(()=>window.__addCalls),1);
  });
  await run('unconfirmed add retains retry without a false saved state',async page=>{
    await page.evaluate(()=>window.__mode='unconfirmed');await search(page);await page.getByRole('button',{name:'Добавить в мою музыку VK',exact:true}).click();
    await page.getByText('VK пока не подтвердил изменение. Синхронизируйте библиотеку перед повтором.',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Добавить в мою музыку VK',exact:true}).count(),1);
    assert.equal(await page.getByText('Трек сохранён в вашей музыке VK',{exact:true}).count(),0);
    await page.locator('.main-nav').getByRole('button',{name:'Моя музыка',exact:true}).click();assert.equal(await page.locator('.track-row').filter({hasText:'Search song'}).count(),0);
  });
  await run('add in flight rejects repeated actions and old-account confirmation',async page=>{
    await page.evaluate(()=>window.__mode='pending');await search(page);await page.getByRole('button',{name:'Добавить в мою музыку VK',exact:true}).click();
    await page.getByRole('button',{name:'Сохраняем в VK',exact:true}).waitFor();
    await page.evaluate(()=>{window.__status={...window.__status,user:{id:99,name:'New QA account'}};for(const listener of window.__updates)listener({status:window.__status,clearRemote:true,complete:false,tracks:[],playlists:[]});window.__mode='success';window.__resolve();});
    await page.waitForTimeout(80);await page.locator('.main-nav').getByRole('button',{name:'Моя музыка',exact:true}).click();
    assert.equal(await page.locator('.track-row').filter({hasText:'Search song'}).count(),0);
    assert.equal(await page.getByText('Трек сохранён в вашей музыке VK',{exact:true}).count(),0);
    assert.equal(await page.evaluate(()=>window.__addCalls),1);
  });
}finally{await browser.close();}
console.log(JSON.stringify({failures},null,2));process.exitCode=failures.length?1:0;
