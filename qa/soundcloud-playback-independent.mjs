import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// Actual production React hook; fake provider receipts, MSE and media only.
// No credentials, VK account, user files, or external network are used.
const base = process.env.PULSE_QA_URL || 'http://127.0.0.1:5191';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [];
const mockHls = `export default class Hls {
  static Events = {ERROR:'error'}; static isSupported(){return true;}
  constructor(config){this.config=config;this.handlers=new Map();this.destroyed=false;this.stops=0;this.starts=0;this.loading=config.autoStartLoad;window.__engines.push(this);}
  on(event,fn){this.handlers.set(event,fn)}
  attachMedia(audio){this.audio=audio;audio.src='blob:qa-mse-'+window.__engines.length;}
  loadSource(url){this.url=url;if(!window.__holdMedia)this.ready();}
  ready(){this.audio.readyState=4;queueMicrotask(()=>{this.audio.dispatchEvent(new Event('loadedmetadata'));this.audio.dispatchEvent(new Event('canplay'));});}
  startLoad(){this.starts++;this.loading=true;}
  stopLoad(){this.stops++;this.loading=false;}
  destroy(){this.destroyed=true;this.loading=false;}
  fatal(){this.handlers.get('error')?.('error',{fatal:true,type:'networkError',details:'fragLoadError'});}
  expired(){this.handlers.get('error')?.('error',{fatal:false,type:'networkError',details:'fragLoadError',response:{code:410}});}
  retryable(){this.handlers.get('error')?.('error',{fatal:false,type:'networkError',details:'fragLoadError',response:{code:503}});}
}`;
async function run(name, options, action) {
  const page = await browser.newPage(); const errors = []; page.setDefaultTimeout(2500);
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.route('**/node_modules/.vite/deps/hls__js.js*', route => route.fulfill({ contentType: 'application/javascript', body: mockHls }));
    await page.route(base + '/__sc-playback-qa', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div>' }));
    await page.goto(base + '/__sc-playback-qa');
    await page.evaluate(async () => { const runtime = (await import('/@react-refresh')).default; runtime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true; });
    await page.evaluate(async options => {
      window.__audios=[];window.__engines=[];window.__controls=[];window.__releases=[];window.__resolveCalls=[];window.__listeners=new Set();window.__gates=[];window.__holdMedia=options.holdMedia===true;window.__actions={};
      // Only long playback deadlines are virtualized. React and short UI tasks
      // keep their normal timers, so tests exercise the real production hook.
      if(options.fastTimers){
        const timers=new Map();let now=0,nextId=100000;
        const schedule=window.setTimeout.bind(window),cancel=window.clearTimeout.bind(window);
        window.setTimeout=(callback,delay=0,...args)=>{if(Number(delay)>=1000){const id=nextId++;timers.set(id,{at:now+Number(delay),callback:()=>callback(...args)});return id;}return schedule(callback,delay,...args);};
        window.clearTimeout=id=>{if(timers.has(id))timers.delete(id);else cancel(id);};
        window.__advanceTimers=async milliseconds=>{const end=now+milliseconds;for(let count=0;count<64;count++){const due=[...timers].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;timers.delete(due[0]);window.__clock+=due[1].at-now;now=due[1].at;due[1].callback();await Promise.resolve();}window.__clock+=end-now;now=end;};
      }
      // Virtual monotonic time is used only for actual-hook TTL budget tests.
      // Media decode/network/MSE are synthetic, so these do not prove live HLS.
      if(options.virtualClock||options.fastTimers){window.__clock=performance.now();Object.defineProperty(performance,'now',{configurable:true,value:()=>window.__clock});}
      Object.defineProperty(navigator,'mediaSession',{configurable:true,value:{metadata:null,setActionHandler:(name,fn)=>window.__actions[name]=fn}});
      window.Audio=class extends EventTarget {
        constructor(){super();Object.assign(this,{paused:true,error:null,currentTime:0,duration:180,readyState:0,networkState:2,src:'',volume:0,plays:0,buffered:{length:1,start:()=>0,end:()=>180}});window.__audios.push(this);}
        getAttribute(name){return name==='src'?this.src:null;}removeAttribute(name){if(name==='src')this.src='';}
        load(){} play(){this.plays++;this.paused=false;this.dispatchEvent(new Event('playing'));return Promise.resolve();}pause(){this.paused=true;this.dispatchEvent(new Event('pause'));}
      };
      const track=id=>({id,title:'Song '+id,artist:'Artist',album:'',duration:180,source:'vk',url:'vk-web://42/'+id,addedAt:1,available:true,artistCard:'absent',remote:{ownerId:42,audioId:id==='a'?7:8,inLibrary:true}});
      let resolveSequence=0;
      window.desktop={
        resolveVkTrack:async id=>track(id),soundCloudBinding:async id=>({id:'sc-'+id,title:'Song '+id,artist:'Artist',duration:180,streamable:true}),soundCloudStatus:async()=>({configured:options.configured!==false,managed:options.managed===true,proxy:false,message:''}),
        resolveSoundCloud(id){const number=++resolveSequence;window.__resolveCalls.push({id,number});if(options.failFirstResolve&&number===1)return Promise.reject(Error('synthetic-provider-unavailable'));const result={url:location.origin+'/__relay/session-'+number+'/0',title:'Song '+id,sourceId:'sc-'+id};return options.holdFirstResolve&&number===1||options.holdSecondResolve&&number===2?new Promise(resolve=>window.__gates.push(()=>resolve(result))):Promise.resolve(result);},
        releaseSoundCloud:async url=>{window.__releases.push(url);if(options.releaseFails)throw Error('synthetic-release-failure');},vkWebControl:async command=>{window.__controls.push(command);return{accepted:true};},onVkPlayback:fn=>{window.__listeners.add(fn);return()=>window.__listeners.delete(fn);},
      };
      window.__emit=patch=>{for(const listener of window.__listeners)listener({id:'a',requestedId:'a',playing:false,buffering:false,position:0,duration:180,ended:false,...patch});};
      const [react,dom,{usePlayback}]=await Promise.all([import('/node_modules/.vite/deps/react.js'),import('/node_modules/.vite/deps/react-dom_client.js'),import('/src/usePlayback.ts')]);
      const {createElement,useState}=react.default||react,{createRoot}=dom.default||dom;
      const initial={version:1,tracks:[track('a'),track('b')],playlists:[],history:[],queue:['a','b'],currentTrackId:null,position:0,settings:{theme:'dark',style:'minimal',accent:'#bdff62',density:'comfortable',textScale:1,reducedMotion:false,volume:0,repeat:'off',shuffle:false,closeToTray:false,autoplay:false,autoSkip:options.autoSkip===true,equalizer:{enabled:false,preset:'flat',preamp:0,bands:Array(10).fill(0)},preferSoundCloud:true,preferExplicit:true}};
      function Harness(){const[state,setState]=useState(initial);window.__state=state;window.__setState=setState;window.__playback=usePlayback(state,setState);return createElement('span',null,state.currentTrackId||'empty');}
      createRoot(document.getElementById('root')).render(createElement(Harness));
    }, options);
    await page.waitForFunction(()=>window.__playback);
    await action(page); assert.deepEqual(errors,[]); results.push({name,ok:true});console.log('PASS '+name);
  } catch(error) {
    results.push({name,ok:false,error:error.message});
    console.log(JSON.stringify({name,ok:false,error:error.message,debug:await page.evaluate(()=>({state:window.__state?.currentTrackId,error:window.__playback?.error,playing:window.__playback?.playing,resolves:window.__resolveCalls,releases:window.__releases,engines:window.__engines?.map(e=>({destroyed:e.destroyed,loading:e.loading,stops:e.stops,starts:e.starts,url:e.url})),audio:window.__audios?.map(a=>({paused:a.paused,plays:a.plays,src:a.src}))})).catch(()=>null)}));
  } finally {await page.close();}
}
const start=async page=>{await page.evaluate(()=>window.__playback.playTrack('a'));await page.waitForFunction(()=>window.__engines.length===1);};
const expire=async page=>page.evaluate(()=>window.__engines.at(-1).expired());
const renewed=async(page,count=2)=>page.waitForFunction(count=>window.__resolveCalls.length===count&&window.__engines.length===count&&window.__playback.playing,count);
const healthy=async(page,seconds)=>page.evaluate(seconds=>{for(let n=0;n<seconds;n++){window.__clock+=1000;const audio=window.__audios.at(-1);audio.currentTime+=1;audio.dispatchEvent(new Event('timeupdate'));}},seconds);
const advance=async(page,milliseconds)=>{await page.evaluate(milliseconds=>window.__advanceTimers(milliseconds),milliseconds);await page.waitForTimeout(40);};
try {
  await run('saved source plays with original VK library identity and visible source label',{},async page=>{
    await start(page);await page.waitForFunction(()=>window.__playback.playing);
    assert.deepEqual(await page.evaluate(()=>({id:window.__state.currentTrackId,url:window.__state.tracks[0].url,label:window.__playback.sourceLabel,plays:window.__audios.filter(a=>!a.paused).length})),{id:'a',url:'vk-web://42/a',label:'SoundCloud',plays:1});
  });
  await run('pending HLS pause stops network preparation and late canplay cannot play',{holdMedia:true},async page=>{
    await start(page);await page.evaluate(()=>window.__playback.toggle());await page.waitForTimeout(30);
    const stopped=await page.evaluate(()=>window.__engines[0].destroyed||!window.__engines[0].loading);
    await page.evaluate(()=>window.__engines[0].ready());await page.waitForTimeout(30);
    assert.equal(await page.evaluate(()=>window.__audios.some(a=>a.plays>0)),false);
    assert.equal(stopped,true,'Pause cancelled UI intent but left the HLS request pipeline loading');
  });
  await run('media-session pending pause prevents sound',{holdMedia:true},async page=>{
    await start(page);await page.evaluate(()=>window.__actions.pause());await page.evaluate(()=>window.__engines[0].ready());await page.waitForTimeout(30);
    assert.equal(await page.evaluate(()=>window.__audios.some(a=>a.plays>0)),false);
  });
  await run('late fatal HLS event after pause does not skip or restart',{holdMedia:true,autoSkip:true},async page=>{
    await start(page);await page.evaluate(()=>window.__playback.toggle());await page.evaluate(()=>window.__engines[0].fatal());await page.waitForTimeout(40);
    assert.equal(await page.evaluate(()=>window.__state.currentTrackId),'a');assert.equal(await page.evaluate(()=>window.__resolveCalls.length),1);assert.equal(await page.evaluate(()=>window.__playback.error),'');
  });
  await run('a user can resume after cancelling pending HLS without a fresh unrelated selection',{holdMedia:true},async page=>{
    await start(page);await page.evaluate(()=>window.__playback.toggle());await page.evaluate(()=>window.__playback.toggle());await page.evaluate(()=>window.__engines.at(-1).ready());
    await page.waitForFunction(()=>window.__playback.playing);
    assert.equal(await page.evaluate(()=>window.__state.currentTrackId),'a');assert.equal(await page.evaluate(()=>window.__audios.filter(a=>!a.paused).length),1);
  });
  await run('A to B to A rejects late first-A session without releasing the new source',{holdFirstResolve:true},async page=>{
    await page.evaluate(()=>window.__playback.playTrack('a'));await page.waitForFunction(()=>window.__gates.length===1);
    await page.evaluate(()=>window.__playback.playTrack('b'));await page.waitForFunction(()=>window.__playback.playing&&window.__state.currentTrackId==='b');
    await page.evaluate(()=>window.__playback.playTrack('a'));await page.waitForFunction(()=>window.__playback.playing&&window.__state.currentTrackId==='a');
    await page.evaluate(()=>window.__gates.shift()());await page.waitForTimeout(60);
    const result=await page.evaluate(()=>({current:window.__engines.at(-1).url,releases:window.__releases,playing:window.__audios.filter(a=>!a.paused).length}));
    assert.match(result.current,/session-3\/0$/);assert.equal(result.playing,1);assert.equal(result.releases.some(url=>url.endsWith('/session-1/0')),true);assert.equal(result.releases.some(url=>url.endsWith('/session-3/0')),false);
  });
  await run('late fatal error from old HLS cannot skip a currently playing new track',{autoSkip:true},async page=>{
    await start(page);await page.waitForFunction(()=>window.__playback.playing);
    await page.evaluate(()=>window.__playback.playTrack('b'));await page.waitForFunction(()=>window.__playback.playing&&window.__state.currentTrackId==='b');
    await page.evaluate(()=>window.__engines[0].fatal());await page.waitForTimeout(40);
    assert.equal(await page.evaluate(()=>window.__state.currentTrackId),'b');assert.equal(await page.evaluate(()=>window.__resolveCalls.length),2);assert.equal(await page.evaluate(()=>window.__playback.error),'');
  });
  await run('a failed stale-session cleanup does not surface an unhandled promise error',{holdFirstResolve:true,releaseFails:true},async page=>{
    await page.evaluate(()=>window.__playback.playTrack('a'));await page.waitForFunction(()=>window.__gates.length===1);
    await page.evaluate(()=>window.__playback.playTrack('b'));await page.waitForFunction(()=>window.__playback.playing&&window.__state.currentTrackId==='b');
    await page.evaluate(()=>window.__gates.shift()());await page.waitForTimeout(40);
    assert.equal(await page.evaluate(()=>window.__state.currentTrackId),'b');assert.equal(await page.evaluate(()=>window.__playback.playing),true);
  });
  await run('no credentials keep normal VK available without a fake successful SC state',{configured:false},async page=>{
    await page.evaluate(()=>window.__playback.playTrack('a'));await page.waitForFunction(()=>window.__controls.some(c=>c.operation==='play'));
    assert.equal(await page.evaluate(()=>window.__resolveCalls.length),0);assert.equal(await page.evaluate(()=>window.__engines.length),0);assert.equal(await page.evaluate(()=>window.__playback.sourceLabel),'VK');
  });
  await run('a preferred provider grant failure falls back to VK without changing the selected library track',{failFirstResolve:true},async page=>{
    await page.evaluate(()=>window.__playback.playTrack('a'));await page.waitForFunction(()=>window.__controls.some(c=>c.operation==='play'));
    assert.equal(await page.evaluate(()=>window.__state.currentTrackId),'a');assert.equal(await page.evaluate(()=>window.__engines.length),0);
    assert.deepEqual(await page.evaluate(()=>window.__controls.filter(c=>c.operation==='play').map(c=>c.id)),['a']);assert.equal(await page.evaluate(()=>window.__playback.sourceLabel),'VK');
  });
  await run('logout during source preparation cannot start sound or restore the removed VK track',{holdFirstResolve:true},async page=>{
    await page.evaluate(()=>window.__playback.playTrack('a'));await page.waitForFunction(()=>window.__gates.length===1);
    await page.evaluate(()=>window.__setState(previous=>({...previous,tracks:[],queue:[],history:[],currentTrackId:null,position:0})));
    await page.waitForFunction(()=>window.__state.currentTrackId===null);await page.evaluate(()=>window.__gates.shift()());await page.waitForTimeout(40);
    assert.equal(await page.evaluate(()=>window.__state.currentTrackId),null);assert.equal(await page.evaluate(()=>window.__audios.some(a=>!a.paused)),false);
    assert.equal(await page.evaluate(()=>window.__releases.some(url=>url.endsWith('/session-1/0'))),true);assert.equal(await page.evaluate(()=>window.__engines.length),0);
  });
  await run('expired source gets one exact-track renewal before any automatic skip',{autoSkip:true},async page=>{
    await start(page);await page.waitForFunction(()=>window.__playback.playing);
    await page.evaluate(()=>{const audio=window.__audios.at(-1);audio.currentTime=37;audio.dispatchEvent(new Event('timeupdate'));window.__engines[0].fatal();});
    await page.waitForTimeout(80);
    assert.equal(await page.evaluate(()=>window.__state.currentTrackId),'a','one expired SoundCloud source skipped a verified library track');
    assert.deepEqual(await page.evaluate(()=>window.__resolveCalls.map(row=>row.id)),['a','a'],'renewal must obtain a new grant for the same selected provider recording');
    assert.equal(await page.evaluate(()=>window.__audios.at(-1).currentTime),37,'renewal must preserve playback progress');
  });
  await run('pause during an expired-source renewal prevents late grant playback',{autoSkip:true,holdSecondResolve:true},async page=>{
    await start(page);await page.waitForFunction(()=>window.__playback.playing);
    await page.evaluate(()=>{const audio=window.__audios.at(-1);audio.currentTime=37;audio.dispatchEvent(new Event('timeupdate'));window.__engines[0].fatal();});
    await page.waitForFunction(()=>window.__gates.length===1);assert.equal(await page.evaluate(()=>window.__state.currentTrackId),'a');
    await page.evaluate(()=>window.__playback.toggle());await page.evaluate(()=>window.__gates.shift()());await page.waitForTimeout(40);
    assert.equal(await page.evaluate(()=>window.__audios.some(a=>!a.paused)),false);assert.equal(await page.evaluate(()=>window.__state.currentTrackId),'a');
    assert.equal(await page.evaluate(()=>window.__releases.some(url=>url.endsWith('/session-2/0'))),true);
  });
  await run('a late renewed grant cannot replace the next track or release its active session',{autoSkip:true,holdSecondResolve:true},async page=>{
    await start(page);await page.waitForFunction(()=>window.__playback.playing);await page.evaluate(()=>window.__engines[0].fatal());
    await page.waitForFunction(()=>window.__gates.length===1);assert.equal(await page.evaluate(()=>window.__state.currentTrackId),'a');
    await page.evaluate(()=>window.__playback.playTrack('b'));await page.waitForFunction(()=>window.__state.currentTrackId==='b'&&window.__playback.playing);
    await page.evaluate(()=>window.__gates.shift()());await page.waitForTimeout(40);
    assert.equal(await page.evaluate(()=>window.__state.currentTrackId),'b');assert.equal(await page.evaluate(()=>window.__audios.filter(a=>!a.paused).length),1);
    assert.equal(await page.evaluate(()=>window.__releases.some(url=>url.endsWith('/session-2/0'))),true);assert.equal(await page.evaluate(()=>window.__releases.some(url=>url.endsWith('/session-3/0'))),false);
  });
  await run('a repeatedly failed provider returns to exact VK once at the last known position',{autoSkip:false},async page=>{
    await start(page);await page.waitForFunction(()=>window.__playback.playing);
    await page.evaluate(()=>{const audio=window.__audios.at(-1);audio.currentTime=37;audio.dispatchEvent(new Event('timeupdate'));window.__engines[0].fatal();});
    await page.waitForFunction(()=>window.__resolveCalls.length===2&&window.__engines.length===2&&window.__playback.playing);
    await page.evaluate(()=>window.__engines.at(-1).fatal());await page.waitForFunction(()=>window.__controls.some(c=>c.operation==='play'));
    assert.equal(await page.evaluate(()=>window.__state.currentTrackId),'a');
    assert.deepEqual(await page.evaluate(()=>window.__controls.filter(c=>c.operation==='play').map(c=>({id:c.id,position:c.position}))),[{id:'a',position:37}]);
    assert.equal(await page.evaluate(()=>window.__resolveCalls.length),2);assert.equal(await page.evaluate(()=>window.__audios.some(a=>!a.paused)),false);
    await page.evaluate(()=>window.__emit({error:'synthetic-vk-also-unavailable',network:'error'}));await page.waitForTimeout(60);
    assert.equal(await page.evaluate(()=>window.__resolveCalls.length),2,'SC to VK failure must not loop back into exhausted provider attempts');
  });
  await run('resuming a cancelled renewal obtains a fresh exact source at the saved clock',{holdSecondResolve:true},async page=>{
    await start(page);await page.waitForFunction(()=>window.__playback.playing);
    await page.evaluate(()=>{const audio=window.__audios.at(-1);audio.currentTime=37;audio.dispatchEvent(new Event('timeupdate'));window.__engines[0].fatal();});
    await page.waitForFunction(()=>window.__gates.length===1);await page.evaluate(()=>window.__playback.toggle());
    await page.evaluate(()=>window.__gates.shift()());await page.waitForTimeout(20);
    await page.evaluate(()=>window.__playback.toggle());await page.waitForFunction(()=>window.__playback.playing);
    assert.equal(await page.evaluate(()=>window.__state.currentTrackId),'a');
    assert.equal(await page.evaluate(()=>window.__audios.at(-1).currentTime),37);
    assert.equal(await page.evaluate(()=>window.__audios.filter(a=>!a.paused).length),1);
    assert.equal(await page.evaluate(()=>window.__engines.at(-1).url.endsWith('/session-3/0')),true);
  });
  await run('seeking while the initial provider grant is pending starts at the requested position',{holdFirstResolve:true},async page=>{
    await page.evaluate(()=>window.__playback.playTrack('a'));await page.waitForFunction(()=>window.__gates.length===1);
    await page.evaluate(()=>window.__playback.seek(61));await page.evaluate(()=>window.__gates.shift()());
    await page.waitForFunction(()=>window.__playback.playing);
    assert.equal(await page.evaluate(()=>window.__audios.at(-1).currentTime),61);assert.equal(await page.evaluate(()=>window.__state.currentTrackId),'a');
  });
  await run('a late native media error after a user pause does not skip or restart',{autoSkip:true},async page=>{
    await start(page);await page.waitForFunction(()=>window.__playback.playing);
    await page.evaluate(()=>window.__playback.toggle());
    await page.evaluate(()=>window.__audios.at(-1).dispatchEvent(new Event('error')));await page.waitForTimeout(60);
    assert.equal(await page.evaluate(()=>window.__state.currentTrackId),'a');
    assert.equal(await page.evaluate(()=>window.__audios.some(a=>!a.paused)),false);
    assert.equal(await page.evaluate(()=>window.__resolveCalls.length),1);
  });
  await run('a late media ended event after a user pause cannot advance the queue',{},async page=>{
    await start(page);await page.waitForFunction(()=>window.__playback.playing);
    await page.evaluate(()=>window.__playback.toggle());
    await page.evaluate(()=>window.__audios.at(-1).dispatchEvent(new Event('ended')));await page.waitForTimeout(60);
    assert.equal(await page.evaluate(()=>window.__state.currentTrackId),'a');
    assert.equal(await page.evaluate(()=>window.__audios.some(a=>!a.paused)),false);
  });
  await run('a nonfatal HLS 410 renews immediately on the exact track and preserves its media offset',{virtualClock:true,autoSkip:true},async page=>{
    await start(page);await page.waitForFunction(()=>window.__playback.playing);
    await page.evaluate(()=>{const audio=window.__audios.at(-1);audio.currentTime=37;audio.dispatchEvent(new Event('timeupdate'));});
    await expire(page);await renewed(page);
    assert.deepEqual(await page.evaluate(()=>({id:window.__state.currentTrackId,position:window.__audios.at(-1).currentTime,resolves:window.__resolveCalls.map(item=>item.id),vk:window.__controls.filter(item=>item.operation==='play').length})),{id:'a',position:37,resolves:['a','a'],vk:0});
  });
  await run('30 seconds of renewed actual media-clock progress permit a later separate expiry renewal',{virtualClock:true},async page=>{
    await start(page);await page.waitForFunction(()=>window.__playback.playing);await expire(page);await renewed(page);
    await healthy(page,30);await expire(page);await renewed(page,3);
    assert.deepEqual(await page.evaluate(()=>({ids:window.__resolveCalls.map(item=>item.id),position:window.__audios.at(-1).currentTime,playing:window.__audios.filter(item=>!item.paused).length,vk:window.__controls.filter(item=>item.operation==='play').length})),{ids:['a','a','a'],position:30,playing:1,vk:0});
  });
  await run('29 seconds of media progress cannot replenish the one-renewal failure budget',{virtualClock:true},async page=>{
    await start(page);await page.waitForFunction(()=>window.__playback.playing);await expire(page);await renewed(page);await healthy(page,29);await expire(page);
    await page.waitForFunction(()=>window.__controls.some(item=>item.operation==='play'));
    assert.equal(await page.evaluate(()=>window.__resolveCalls.length),2);
    assert.deepEqual(await page.evaluate(()=>window.__controls.filter(item=>item.operation==='play').map(item=>({id:item.id,position:item.position}))),[{id:'a',position:29}]);
  });
  await run('seeking with a large playhead jump cannot manufacture 30 seconds of healthy audio',{virtualClock:true},async page=>{
    await start(page);await page.waitForFunction(()=>window.__playback.playing);await expire(page);await renewed(page);await healthy(page,20);
    await page.evaluate(()=>{const audio=window.__audios.at(-1);audio.seeking=true;audio.dispatchEvent(new Event('seeking'));window.__clock+=31000;window.__playback.seek(120);audio.dispatchEvent(new Event('timeupdate'));audio.seeking=false;audio.dispatchEvent(new Event('seeked'));});
    await healthy(page,5);await expire(page);await page.waitForFunction(()=>window.__controls.some(item=>item.operation==='play'));
    assert.equal(await page.evaluate(()=>window.__resolveCalls.length),2);assert.equal(await page.evaluate(()=>window.__controls.find(item=>item.operation==='play').position),125);
  });
  await run('an unannounced media-clock jump cannot refill the renewal budget',{virtualClock:true},async page=>{
    await start(page);await page.waitForFunction(()=>window.__playback.playing);await expire(page);await renewed(page);
    await page.evaluate(()=>{window.__clock+=1000;const audio=window.__audios.at(-1);audio.currentTime=100;audio.dispatchEvent(new Event('timeupdate'));});
    await expire(page);await page.waitForFunction(()=>window.__controls.some(item=>item.operation==='play'));assert.equal(await page.evaluate(()=>window.__resolveCalls.length),2);
  });
  await run('repeated retryable HLS errors do not themselves refill the budget',{virtualClock:true},async page=>{
    await start(page);await page.waitForFunction(()=>window.__playback.playing);await expire(page);await renewed(page);
    await page.evaluate(()=>{for(let n=0;n<40;n++){window.__clock+=1000;window.__engines.at(-1).retryable();}});
    assert.equal(await page.evaluate(()=>window.__resolveCalls.length),2);await expire(page);await page.waitForFunction(()=>window.__controls.some(item=>item.operation==='play'));
    assert.equal(await page.evaluate(()=>window.__resolveCalls.length),2);
  });
  await run('buffering interruption resets partial healthy progress instead of joining two short streaks',{virtualClock:true},async page=>{
    await start(page);await page.waitForFunction(()=>window.__playback.playing);await expire(page);await renewed(page);await healthy(page,29);
    await page.evaluate(()=>{window.__audios.at(-1).dispatchEvent(new Event('waiting'));window.__clock+=60000;window.__audios.at(-1).dispatchEvent(new Event('playing'));});
    await healthy(page,2);await expire(page);await page.waitForFunction(()=>window.__controls.some(item=>item.operation==='play'));assert.equal(await page.evaluate(()=>window.__resolveCalls.length),2);
  });
  await run('paused wall time cannot refill the renewal budget or cause a paused 410 to restart',{virtualClock:true},async page=>{
    await start(page);await page.waitForFunction(()=>window.__playback.playing);await expire(page);await renewed(page);await healthy(page,29);await page.evaluate(()=>window.__playback.toggle());
    await page.evaluate(()=>{window.__clock+=60000;window.__engines.at(-1).expired();});await page.waitForTimeout(30);
    assert.equal(await page.evaluate(()=>window.__resolveCalls.length),2);assert.equal(await page.evaluate(()=>window.__audios.some(item=>!item.paused)),false);
    await page.evaluate(()=>window.__playback.toggle());await page.waitForFunction(()=>window.__playback.playing);await healthy(page,2);await expire(page);
    await page.waitForFunction(()=>window.__controls.some(item=>item.operation==='play'));assert.equal(await page.evaluate(()=>window.__resolveCalls.length),2);
  });
  await run('410 from a disposed engine cannot spend or replenish the current source budget',{virtualClock:true,autoSkip:true},async page=>{
    await start(page);await page.waitForFunction(()=>window.__playback.playing);await expire(page);await renewed(page);
    await page.evaluate(()=>window.__engines[0].expired());await page.waitForTimeout(30);
    assert.equal(await page.evaluate(()=>window.__resolveCalls.length),2);assert.equal(await page.evaluate(()=>window.__playback.playing),true);
    await page.evaluate(()=>window.__playback.playTrack('b'));await page.waitForFunction(()=>window.__state.currentTrackId==='b'&&window.__playback.playing);
    await page.evaluate(()=>{window.__engines[0].expired();window.__engines[1].expired();});await page.waitForTimeout(30);
    assert.equal(await page.evaluate(()=>window.__state.currentTrackId),'b');assert.equal(await page.evaluate(()=>window.__resolveCalls.length),3);
  });
  await run('pause during nonfatal 410 renewal invalidates its late grant and releases only that source',{holdSecondResolve:true,virtualClock:true},async page=>{
    await start(page);await page.waitForFunction(()=>window.__playback.playing);await expire(page);await page.waitForFunction(()=>window.__gates.length===1);
    await page.evaluate(()=>window.__playback.toggle());await page.evaluate(()=>window.__gates.shift()());await page.waitForTimeout(30);
    assert.equal(await page.evaluate(()=>window.__audios.some(item=>!item.paused)),false);assert.equal(await page.evaluate(()=>window.__state.currentTrackId),'a');
    assert.equal(await page.evaluate(()=>window.__releases.some(url=>url.endsWith('/session-2/0'))),true);
  });
  await run('track switch during nonfatal 410 renewal keeps the new source when the old grant completes',{holdSecondResolve:true,virtualClock:true},async page=>{
    await start(page);await page.waitForFunction(()=>window.__playback.playing);await expire(page);await page.waitForFunction(()=>window.__gates.length===1);
    await page.evaluate(()=>window.__playback.playTrack('b'));await page.waitForFunction(()=>window.__state.currentTrackId==='b'&&window.__playback.playing);
    await page.evaluate(()=>window.__gates.shift()());await page.waitForTimeout(30);
    assert.equal(await page.evaluate(()=>window.__state.currentTrackId),'b');assert.equal(await page.evaluate(()=>window.__audios.filter(item=>!item.paused).length),1);
    assert.equal(await page.evaluate(()=>window.__releases.some(url=>url.endsWith('/session-2/0'))),true);assert.equal(await page.evaluate(()=>window.__releases.some(url=>url.endsWith('/session-3/0'))),false);
  });
  await run('managed VPS startup that never receives media switches the exact track to VK within six seconds',{managed:true,holdMedia:true,fastTimers:true},async page=>{
    await start(page);await advance(page,5900);
    assert.equal(await page.evaluate(()=>window.__controls.some(item=>item.operation==='play')),false,'The route changed before the allowed startup budget');
    await advance(page,250);await page.waitForFunction(()=>window.__controls.some(item=>item.operation==='play'));
    assert.deepEqual(await page.evaluate(()=>window.__controls.filter(item=>item.operation==='play').map(item=>({id:item.id,position:item.position}))),[{id:'a',position:0}]);
    assert.equal(await page.evaluate(()=>window.__resolveCalls.length),1,'Slow startup must not spend another VPS grant before trying the same VK track');
    assert.equal(await page.evaluate(()=>window.__playback.sourceLabel),'VK');
    await page.evaluate(()=>window.__engines[0].ready());await advance(page,30000);
    assert.equal(await page.evaluate(()=>window.__audios.some(item=>!item.paused)),false,'Late VPS media started over the direct VK route');
    assert.equal(await page.evaluate(()=>window.__controls.filter(item=>item.operation==='play').length),1,'Fallback started repeated VK commands');
    assert.equal(await page.evaluate(()=>window.__state.currentTrackId),'a');
  });
  await run('a managed VPS audio stall switches once to the same VK item at its real media position',{managed:true,fastTimers:true},async page=>{
    await start(page);await page.waitForFunction(()=>window.__playback.playing);
    await page.evaluate(()=>{const audio=window.__audios.at(-1);audio.currentTime=37;audio.dispatchEvent(new Event('timeupdate'));audio.dispatchEvent(new Event('waiting'));});
    await advance(page,6200);await page.waitForFunction(()=>window.__controls.some(item=>item.operation==='play'));
    assert.deepEqual(await page.evaluate(()=>window.__controls.filter(item=>item.operation==='play').map(item=>({id:item.id,position:item.position}))),[{id:'a',position:37}]);
    assert.equal(await page.evaluate(()=>window.__resolveCalls.length),1);assert.equal(await page.evaluate(()=>window.__audios.some(item=>!item.paused)),false);
    await page.evaluate(()=>window.__emit({network:'error',error:'synthetic VK also failed'}));await advance(page,30000);
    assert.equal(await page.evaluate(()=>window.__resolveCalls.length),1,'Failed VK fallback looped back into the exhausted VPS source');
  });
  await run('a managed route recovered by genuine media-clock progress stays on VPS',{managed:true,fastTimers:true},async page=>{
    await start(page);await page.waitForFunction(()=>window.__playback.playing);
    await page.evaluate(()=>window.__audios.at(-1).dispatchEvent(new Event('waiting')));await advance(page,4000);
    await page.evaluate(()=>{const audio=window.__audios.at(-1);audio.currentTime=2;audio.dispatchEvent(new Event('timeupdate'));});await advance(page,3000);
    assert.equal(await page.evaluate(()=>window.__controls.some(item=>item.operation==='play')),false);assert.equal(await page.evaluate(()=>window.__playback.sourceLabel),'SoundCloud');
  });
  await run('pausing during the managed stall budget cancels late direct playback',{managed:true,fastTimers:true},async page=>{
    await start(page);await page.waitForFunction(()=>window.__playback.playing);await page.evaluate(()=>window.__audios.at(-1).dispatchEvent(new Event('waiting')));await advance(page,4000);
    await page.evaluate(()=>window.__playback.toggle());await advance(page,30000);
    assert.equal(await page.evaluate(()=>window.__controls.some(item=>item.operation==='play')),false);assert.equal(await page.evaluate(()=>window.__audios.some(item=>!item.paused)),false);assert.equal(await page.evaluate(()=>window.__state.currentTrackId),'a');
  });
  await run('late slow VPS resolution cannot replace its VK fallback or start a second sound',{managed:true,fastTimers:true,holdFirstResolve:true},async page=>{
    await page.evaluate(()=>window.__playback.playTrack('a'));await page.waitForFunction(()=>window.__gates.length===1);await advance(page,6200);
    await page.waitForFunction(()=>window.__controls.some(item=>item.operation==='play'));await page.evaluate(()=>window.__gates.shift()());await page.waitForTimeout(40);
    assert.equal(await page.evaluate(()=>window.__engines.length),0);assert.equal(await page.evaluate(()=>window.__releases.some(url=>url.endsWith('/session-1/0'))),true);assert.equal(await page.evaluate(()=>window.__playback.sourceLabel),'VK');
    assert.deepEqual(await page.evaluate(()=>window.__controls.filter(item=>item.operation==='play').map(item=>item.id)),['a']);
  });
  await run('the next selection retries VPS after a track-specific direct fallback',{managed:true,holdMedia:true,fastTimers:true},async page=>{
    await start(page);await advance(page,6200);await page.waitForFunction(()=>window.__controls.some(item=>item.operation==='play'));
    await page.evaluate(()=>{window.__holdMedia=false;window.__playback.playTrack('b');});await page.waitForFunction(()=>window.__state.currentTrackId==='b'&&window.__playback.playing);
    assert.deepEqual(await page.evaluate(()=>window.__resolveCalls.map(item=>item.id)),['a','b']);assert.equal(await page.evaluate(()=>window.__playback.sourceLabel),'SoundCloud');
    assert.equal(await page.evaluate(()=>window.__audios.filter(item=>!item.paused).length),1);
  });
  await run('switching tracks cancels the old VPS fallback timer without sending a play command for the old item',{managed:true,fastTimers:true},async page=>{
    await start(page);await page.waitForFunction(()=>window.__playback.playing);await page.evaluate(()=>window.__audios.at(-1).dispatchEvent(new Event('waiting')));await advance(page,4000);
    await page.evaluate(()=>window.__playback.playTrack('b'));await page.waitForFunction(()=>window.__state.currentTrackId==='b'&&window.__playback.playing);await advance(page,3000);
    assert.equal(await page.evaluate(()=>window.__controls.some(item=>item.operation==='play')),false);assert.equal(await page.evaluate(()=>window.__state.currentTrackId),'b');assert.deepEqual(await page.evaluate(()=>window.__resolveCalls.map(item=>item.id)),['a','b']);
  });
  await run('a user seek during managed buffering is preserved when direct fallback becomes necessary',{managed:true,fastTimers:true},async page=>{
    await start(page);await page.waitForFunction(()=>window.__playback.playing);await page.evaluate(()=>window.__audios.at(-1).dispatchEvent(new Event('waiting')));await advance(page,3000);
    await page.evaluate(()=>{const audio=window.__audios.at(-1);audio.seeking=true;audio.dispatchEvent(new Event('seeking'));window.__playback.seek(61);audio.seeking=false;audio.dispatchEvent(new Event('seeked'));audio.dispatchEvent(new Event('waiting'));});
    await advance(page,6200);await page.waitForFunction(()=>window.__controls.some(item=>item.operation==='play'));
    assert.deepEqual(await page.evaluate(()=>window.__controls.filter(item=>item.operation==='play').map(item=>({id:item.id,position:item.position}))),[{id:'a',position:61}]);
  });
  await run('playing and canplay events cannot hide a frozen managed audio clock',{managed:true,fastTimers:true},async page=>{
    await start(page);await page.waitForFunction(()=>window.__playback.playing);
    for(let index=0;index<6;index++){await advance(page,1000);await page.evaluate(()=>{const audio=window.__audios.at(-1);audio.dispatchEvent(new Event('canplay'));audio.dispatchEvent(new Event('playing'));});}
    await advance(page,250);await page.waitForFunction(()=>window.__controls.some(item=>item.operation==='play'));
    assert.deepEqual(await page.evaluate(()=>window.__controls.filter(item=>item.operation==='play').map(item=>({id:item.id,position:item.position}))),[{id:'a',position:0}]);
  });
  await run('a fatal managed source error tries direct VK immediately without another slow VPS grant',{managed:true,fastTimers:true},async page=>{
    await start(page);await page.waitForFunction(()=>window.__playback.playing);await page.evaluate(()=>{const audio=window.__audios.at(-1);audio.currentTime=17;audio.dispatchEvent(new Event('timeupdate'));window.__engines.at(-1).fatal();});
    await page.waitForFunction(()=>window.__controls.some(item=>item.operation==='play'));
    assert.deepEqual(await page.evaluate(()=>window.__controls.filter(item=>item.operation==='play').map(item=>({id:item.id,position:item.position}))),[{id:'a',position:17}]);assert.equal(await page.evaluate(()=>window.__resolveCalls.length),1);
  });
  await run('managed capability expiry keeps one exact-recording renewal before the bounded no-progress fallback',{managed:true,fastTimers:true},async page=>{
    await start(page);await page.waitForFunction(()=>window.__playback.playing);await page.evaluate(()=>{const audio=window.__audios.at(-1);audio.currentTime=25;audio.dispatchEvent(new Event('timeupdate'));});await expire(page);await renewed(page);
    assert.deepEqual(await page.evaluate(()=>window.__resolveCalls.map(item=>item.id)),['a','a']);assert.equal(await page.evaluate(()=>window.__audios.at(-1).currentTime),25);
    assert.equal(await page.evaluate(()=>window.__controls.some(item=>item.operation==='play')),false);
    await advance(page,6200);await page.waitForFunction(()=>window.__controls.some(item=>item.operation==='play'));
    assert.deepEqual(await page.evaluate(()=>window.__controls.filter(item=>item.operation==='play').map(item=>({id:item.id,position:item.position}))),[{id:'a',position:25}]);assert.equal(await page.evaluate(()=>window.__resolveCalls.length),2);
    assert.equal(await page.evaluate(()=>window.__state.settings.preferSoundCloud),true,'One bad track changed the application-wide source preference');
  });
  console.log(JSON.stringify({summary:results}));if(results.some(r=>!r.ok))process.exitCode=1;
} finally {await browser.close();}
