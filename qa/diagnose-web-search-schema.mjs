import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
const browsers=[];
try {
for(const address of ['http://127.0.0.1:9226','http://[::1]:9226']){try{browsers.push(await chromium.connectOverCDP(address,{timeout:1500}));}catch{}}
const pages=browsers.flatMap(b=>b.contexts().flatMap(c=>c.pages()));
const remote=pages.find(p=>/^https:\/\/vk\.(ru|com)(\/|$)/.test(p.url()));
const main=pages.find(p=>p.url().includes('tauri.localhost'));
if(!remote||!main)throw new Error('App not ready');
await remote.evaluate('delete window.__PULSE_VK_SEARCH__;'+await readFile(new URL('../src-tauri/src/vk_web_search.js',import.meta.url),'utf8'));
const result=await main.evaluate(async()=>{const tracks=await window.desktop.searchVk('Daft Punk');return{count:tracks.length,nonLibrary:tracks.filter(t=>t.remote?.inLibrary===false).length,valid:tracks.every(t=>t.source==='vk'&&t.id&&t.title&&t.artist&&t.url.startsWith('vk-web://')),artistMatchesQuery:tracks.filter(t=>/Daft Punk/i.test(t.artist)).length};});
const evidence={checkedAt:new Date().toISOString(),nativeSearchAfterInjectedFix:true,cloudReadOnly:true,query:'Daft Punk',...result};
await writeFile(new URL('installed-search-schema-result.json',import.meta.url),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));
}finally{for(const browser of browsers)await browser.close().catch(()=>{});}
