import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir,writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const page=await browser.newPage();
const settings={theme:'dark',palette:'graphite',style:'minimal',accent:'#bdff62',density:'comfortable',textScale:1,reducedMotion:false,volume:.54,repeat:'off',shuffle:false,closeToTray:false,autoplay:false,autoSkip:false};
const tracks=[{id:'local-1',title:'Track',artist:'Artist',album:'',duration:180,url:'',source:'local',addedAt:0,available:true}];
const playlists=Array.from({length:78},(_,i)=>({id:`fixture-list-${i}`,title:i%2===0?'Очень длинное название плейлиста, которое должно аккуратно сокращаться и оставлять место для числа треков':'LongUnbrokenPlaylistTitle'.repeat(12),trackIds:Array.from({length:i===1?99999:15},()=>tracks[0].id),createdAt:1,...(i%5===0?{contentUnavailable:true}:{})}));
await page.addInitScript(state=>localStorage.setItem('pulse-preview',JSON.stringify(state)),{version:1,tracks,playlists,queue:[],history:[],currentTrackId:null,position:0,settings});
const results=[];
try{
 await mkdir(new URL('./artifacts/',import.meta.url),{recursive:true});
 await page.goto('http://127.0.0.1:5173/');await page.locator('.app-shell').waitFor();
 for(const width of [960,1440]){
  await page.setViewportSize({width,height:800});await page.waitForTimeout(80);
  const metrics=await page.evaluate(()=>{
   const sidebar=document.querySelector('.sidebar-scroll');
   const rows=[...document.querySelectorAll('.playlist-nav')].map(row=>{
    const rect=row.getBoundingClientRect(),name=row.querySelector('span').getBoundingClientRect(),count=row.querySelector('small').getBoundingClientRect(),icon=row.querySelector('svg').getBoundingClientRect();
    return {rowRight:rect.right,rowWidth:rect.width,nameRight:name.right,countLeft:count.left,countRight:count.right,countWidth:count.width,iconWidth:icon.width,scrollWidth:row.scrollWidth,clientWidth:row.clientWidth};
   });
   return {bodyOverflow:document.documentElement.scrollWidth>innerWidth,sidebarScrollWidth:sidebar.scrollWidth,sidebarClientWidth:sidebar.clientWidth,overflowX:getComputedStyle(sidebar).overflowX,rows};
  });
  assert.equal(metrics.bodyOverflow,false);assert.ok(metrics.sidebarScrollWidth<=metrics.sidebarClientWidth+1,'Sidebar still has horizontal inner overflow');assert.equal(metrics.overflowX,'hidden');assert.equal(metrics.rows.length,40);
  for(const row of metrics.rows){assert.ok(row.scrollWidth<=row.clientWidth+1);assert.ok(row.countRight<=row.rowRight-10,'Track count clipped beyond row padding');assert.ok(row.countWidth>0);assert.ok(row.iconWidth>=15);assert.ok(row.nameRight<=row.countLeft-9,'Playlist title overlaps track count');}
  await page.screenshot({path:fileURLToPath(new URL(`./artifacts/independent-sidebar-${width}.png`,import.meta.url))});results.push({width,...metrics});
 }
 // Verify that this fixture actually exercises the original grid minimum
 // sizing bug rather than passing merely because titles happen to be short.
 await page.addStyleTag({content:'.sidebar-scroll{overflow-x:auto;min-width:auto}.sidebar-section,.playlist-nav{min-width:auto}.playlist-nav{width:auto}.playlist-nav>svg{flex:0 1 auto}.playlist-nav>span{flex:0 1 auto}'});
 const original=await page.locator('.sidebar-scroll').evaluate(el=>({scrollWidth:el.scrollWidth,clientWidth:el.clientWidth}));
 assert.ok(original.scrollWidth>original.clientWidth+50,'Adversarial fixture must reproduce original horizontal scrollbar');
 await writeFile(new URL('./independent-long-sidebar-result.json',import.meta.url),JSON.stringify({checkedAt:new Date().toISOString(),results,originalReproduction:original},null,2)+'\n');
 console.log('PASS long Cyrillic/unbroken titles, 78 playlists, large/unavailable counts: 960/1440; original overflow reproduced');
}finally{await browser.close();}
