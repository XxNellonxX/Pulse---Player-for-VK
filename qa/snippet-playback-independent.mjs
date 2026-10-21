import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// Isolate the public hook from App's UI and VK account. Adversarial transport
// events use fake media, so no library changes or real sound are involved.
const browser = await chromium.launch({ executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true });
const results = [];
async function run(name, action, {local = false, current = null, hold = false} = {}) {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.route('http://127.0.0.1:5173/__snippetqa', route => route.fulfill({contentType:'text/html', body:'<!doctype html><html><body><div id="root"></div></body></html>'}));
    await page.goto('http://127.0.0.1:5173/__snippetqa');
    await page.evaluate(async () => { const runtime = (await import('/@react-refresh')).default; runtime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true; });
    await page.evaluate(async ({local,current,hold}) => {
      window.__audio = []; window.__controls = []; window.__listeners = new Set(); window.__hold = hold; window.__gates = [];
      window.Audio = class extends EventTarget {
        constructor() { super(); Object.assign(this,{paused:true,error:null,currentTime:0,duration:300,readyState:0,networkState:1,buffered:{length:0},src:'',volume:0}); window.__audio.push(this); }
        load() { if(!this.src)return; this.readyState=4; queueMicrotask(()=>{this.dispatchEvent(new Event('loadedmetadata'));this.dispatchEvent(new Event('canplay'));}); }
        play() { this.paused=false; this.dispatchEvent(new Event('playing')); return Promise.resolve(); }
        pause() { this.paused=true; this.dispatchEvent(new Event('pause')); }
        removeAttribute(name) { if(name==='src')this.src=''; }
        getAttribute(name) { return name==='src'?this.src:null; }
      };
      window.desktop = {
        vkWebControl(command) { window.__controls.push(command); return command.operation==='play' && window.__hold ? new Promise(resolve=>window.__gates.push(()=>resolve({accepted:true}))) : Promise.resolve({accepted:true}); },
        onVkPlayback(callback) {window.__listeners.add(callback); return()=>window.__listeners.delete(callback);},
      };
      window.__emit = patch => { const event={id:'one',playing:true,buffering:false,position:0,duration:300,ended:false,buffered:[[0,60]],network:'ready',...patch}; for(const listener of window.__listeners)listener(event); };
      const [react,reactDom,{usePlayback}] = await Promise.all([import('/node_modules/.vite/deps/react.js'),import('/node_modules/.vite/deps/react-dom_client.js'),import('/src/usePlayback.ts')]);
      const {createElement,useState} = react.default || react,{createRoot}=reactDom.default || reactDom;
      const initial={version:1,tracks:['one','two'].map(id=>({id,title:id,artist:'QA',album:'',duration:300,url:local?'https://example.invalid/audio.wav':`vk-web://${id}`,source:local?'local':'vk',addedAt:1,available:true})),playlists:[],history:[],queue:['one','two'],currentTrackId:current,position:0,settings:{theme:'dark',style:'minimal',accent:'#bdff62',density:'comfortable',textScale:1,reducedMotion:false,volume:0,repeat:'all',shuffle:false,closeToTray:false,autoplay:false,autoSkip:false,equalizer:{enabled:false,preset:'flat',preamp:0,bands:Array(10).fill(0)}}};
      function Harness(){const [state,setState]=useState(initial);window.__state=state;window.__playback=usePlayback(state,setState);return createElement('span',null,state.currentTrackId||'empty');}
      createRoot(document.getElementById('root')).render(createElement(Harness));
    },{local,current,hold});
    await page.waitForFunction(()=>window.__playback);
    await action(page);
    assert.deepEqual(errors,[]); results.push(name); console.log(`PASS ${name}`);
  } finally {await page.close();}
}
try {
  await run('native snippet starts at VK boundary and stops without next',async page=>{
    await page.evaluate(()=>window.__playback.playSnippet('one',33,42));
    await page.waitForFunction(()=>window.__controls.some(c=>c.operation==='play'));
    assert.equal(await page.evaluate(()=>window.__controls.find(c=>c.operation==='play').position),33);
    await page.evaluate(()=>window.__emit({position:33}));
    await page.evaluate(()=>window.__emit({position:42}));
    await page.waitForFunction(()=>window.__controls.some(c=>c.operation==='pause'));
    const state=await page.evaluate(()=>({id:window.__state.currentTrackId,position:window.__state.position,clip:window.__playback.snippet,playing:window.__playback.playing}));
    assert.deepEqual(state,{id:'one',position:42,clip:null,playing:false});
  });
  await run('stale same-track status cannot end a pending snippet',async page=>{
    await page.evaluate(()=>window.__playback.playSnippet('one',20,35));
    await page.waitForFunction(()=>window.__gates.length===1);
    await page.evaluate(()=>window.__emit({position:150,ended:true}));
    assert.equal(await page.evaluate(()=>window.__playback.snippet?.to),35);
    assert.equal(await page.evaluate(()=>window.__state.position),20);
    assert.equal(await page.evaluate(()=>window.__controls.filter(c=>c.operation==='pause').length),0);
    await page.evaluate(()=>{window.__hold=false;window.__gates.shift()();});
    await page.waitForTimeout(30);
    await page.evaluate(()=>window.__emit({position:20}));
    await page.evaluate(()=>window.__emit({position:35}));
    await page.waitForFunction(()=>window.__playback.snippet===null);
    assert.equal(await page.evaluate(()=>window.__state.currentTrackId),'one');
  },{current:'one',hold:true});
  await run('normal track selection cancels snippet bounds',async page=>{
    await page.evaluate(()=>window.__playback.playSnippet('one',20,35));
    await page.waitForFunction(()=>window.__controls.some(c=>c.operation==='play'));
    await page.evaluate(()=>window.__playback.playTrack('two'));
    await page.waitForFunction(()=>window.__state.currentTrackId==='two');
    await page.evaluate(()=>window.__emit({id:'two',position:60}));
    assert.equal(await page.evaluate(()=>window.__playback.snippet),null);
    assert.equal(await page.evaluate(()=>window.__playback.playing),true);
  });
  await run('pause during native snippet startup cannot resurrect playback',async page=>{
    await page.evaluate(()=>window.__playback.playSnippet('one',20,35));
    await page.waitForFunction(()=>window.__gates.length===1);
    await page.evaluate(()=>window.__playback.toggle());
    await page.evaluate(()=>{window.__hold=false;window.__gates.shift()();});
    await page.waitForTimeout(30);
    await page.evaluate(()=>window.__emit({position:21,playing:true}));
    assert.equal(await page.evaluate(()=>window.__playback.playing),false);
    assert.ok(await page.evaluate(()=>window.__controls.filter(c=>c.operation==='pause').length)>0);
    await page.evaluate(()=>window.__playback.toggle());
    await page.waitForFunction(()=>window.__controls.some(c=>c.operation==='resume'));
    await page.evaluate(()=>window.__emit({position:22,playing:true}));
    assert.equal(await page.evaluate(()=>window.__playback.playing),true);
    await page.evaluate(()=>window.__emit({position:35}));
    await page.waitForFunction(()=>window.__playback.snippet===null);
    assert.equal(await page.evaluate(()=>window.__playback.playing),false);
  },{hold:true});
  await run('local snippet uses real boundaries and manual seek restores full track',async page=>{
    await page.evaluate(()=>window.__playback.playSnippet('one',20,35));
    await page.waitForFunction(()=>window.__audio.at(-1)?.paused===false);
    assert.equal(await page.evaluate(()=>window.__audio.at(-1).currentTime),20);
    await page.evaluate(()=>{const audio=window.__audio.at(-1);audio.currentTime=35;audio.dispatchEvent(new Event('timeupdate'));});
    assert.equal(await page.evaluate(()=>window.__audio.at(-1).paused),true);
    assert.equal(await page.evaluate(()=>window.__state.currentTrackId),'one');
    await page.evaluate(()=>window.__playback.playSnippet('one',10,25));
    await page.evaluate(()=>window.__playback.seek(60));
    await page.evaluate(()=>{const audio=window.__audio.at(-1);audio.currentTime=65;audio.dispatchEvent(new Event('timeupdate'));});
    assert.equal(await page.evaluate(()=>window.__playback.snippet),null);
    assert.equal(await page.evaluate(()=>window.__audio.at(-1).paused),false);
  },{local:true});
  await run('invalid snippet never starts arbitrary media',async page=>{
    await page.evaluate(()=>window.__playback.playSnippet('one',40,20));
    assert.match(await page.evaluate(()=>window.__playback.error),/границы сниппета/);
    assert.equal(await page.evaluate(()=>window.__controls.filter(c=>c.operation==='play').length),0);
  });
  await run('native buffered gaps do not inflate visible loading progress',async page=>{
    await page.evaluate(()=>window.__playback.playTrack('one'));
    await page.waitForFunction(()=>window.__controls.some(c=>c.operation==='play'));
    await page.evaluate(()=>window.__emit({position:30,buffered:[[0,20],[45,80]],bufferedAhead:9999,network:'stalled',buffering:true}));
    assert.equal(await page.evaluate(()=>window.__playback.bufferedAhead),0);
    assert.deepEqual(await page.evaluate(()=>window.__playback.buffered),[[0,20],[45,80]]);
    assert.equal(await page.evaluate(()=>window.__playback.network),'stalled');
  });
  await run('local download-stalled event does not stop healthy buffered audio',async page=>{
    await page.evaluate(()=>window.__playback.playTrack('one'));
    await page.waitForFunction(()=>window.__audio.at(-1)?.paused===false);
    await page.clock.install();
    await page.evaluate(()=>{const audio=window.__audio.at(-1);audio.readyState=4;audio.dispatchEvent(new Event('stalled'));});
    await page.clock.fastForward(20000);
    assert.equal(await page.evaluate(()=>window.__playback.error),'');
    assert.equal(await page.evaluate(()=>window.__playback.playing),true);
    await page.evaluate(()=>{const audio=window.__audio.at(-1);audio.readyState=2;audio.dispatchEvent(new Event('waiting'));audio.readyState=4;audio.currentTime=5;audio.dispatchEvent(new Event('timeupdate'));});
    await page.clock.fastForward(20000);
    assert.equal(await page.evaluate(()=>window.__playback.error),'');
    assert.equal(await page.evaluate(()=>window.__playback.buffering),false);
  },{local:true});
  console.log(`Snippet independent QA: ${results.length} passed`);
} finally {await browser.close();}
