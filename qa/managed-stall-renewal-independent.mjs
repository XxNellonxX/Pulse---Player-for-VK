import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// Actual production React hook; fake provider receipts, MSE and media only.
// No credentials, VK account, user files, or external network are used.
// Independent follow-up tests for managed source recovery. Fixtures derive from
// the existing synthetic hook harness; assertions below use distinct sequences.
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
      const track=id=>({id,title:'Song '+id,artist:'Artist',album:'',duration:180,source:'vk',url:'vk-web://42/'+id,addedAt:1,available:options.vkUnavailable!==true,artistCard:'absent',remote:{ownerId:42,audioId:id==='a'?7:8,inLibrary:true}});
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
const noVk=async page=>assert.equal(await page.evaluate(()=>window.__controls.some(item=>item.operation==='play'||item.operation==='resume')),false);
const renewCalls=async(page,ids)=>assert.deepEqual(await page.evaluate(()=>window.__resolveCalls.map(item=>item.id)),ids);
try {
  await run('cold managed grant with no decoder readiness gets one fresh grant and starts on SC',{managed:true,fastTimers:true,holdMedia:true},async page=>{
    await start(page);
    await advance(page,5999);await renewCalls(page,['a']);await noVk(page);
    await page.evaluate(()=>window.__holdMedia=false);await advance(page,2);await renewed(page);
    await renewCalls(page,['a','a']);await noVk(page);assert.equal(await page.evaluate(()=>window.__playback.sourceLabel),'SoundCloud');
    assert.equal(await page.evaluate(()=>window.__engines[0].destroyed),true);
    assert.equal(await page.evaluate(()=>window.__audios.filter(audio=>!audio.paused).length),1);
  });
  await run('two frozen managed clocks exhaust exactly two grants despite synthetic playing events',{managed:true,fastTimers:true,autoSkip:true},async page=>{
    await start(page);await page.waitForFunction(()=>window.__playback.playing);
    for(let attempt=0;attempt<2;attempt++){
      for(let second=0;second<6;second++){
        await advance(page,1000);
        await page.evaluate(()=>{const audio=window.__audios.at(-1);audio.dispatchEvent(new Event('canplay'));audio.dispatchEvent(new Event('playing'));});
      }
      if(attempt===0)await renewed(page);
    }
    await page.waitForFunction(()=>window.__controls.some(command=>command.operation==='play'));
    await renewCalls(page,['a','a']);assert.equal(await page.evaluate(()=>window.__state.currentTrackId),'a');
    await page.evaluate(()=>{for(const engine of window.__engines){engine.expired();engine.retryable();engine.fatal();}});
    await advance(page,30000);await renewCalls(page,['a','a']);
    assert.deepEqual(await page.evaluate(()=>window.__controls.filter(command=>command.operation==='play').map(command=>command.id)),['a']);
  });
  await run('unavailable VK stops after two managed stalls and cannot loop back to restricted VK',{managed:true,fastTimers:true,vkUnavailable:true,autoSkip:true},async page=>{
    await start(page);await page.waitForFunction(()=>window.__playback.playing);await advance(page,6001);await renewed(page);
    await advance(page,6001);await page.waitForFunction(()=>window.__playback.error.length>0);
    await noVk(page);await renewCalls(page,['a','a']);assert.equal(await page.evaluate(()=>window.__playback.buffering),false);
    assert.equal(await page.evaluate(()=>window.__state.currentTrackId),'a');
    await advance(page,60000);await renewCalls(page,['a','a']);await noVk(page);
  });
  await run('pause during stall renewal releases the late second grant without starting sound',{managed:true,fastTimers:true,holdSecondResolve:true},async page=>{
    await start(page);await page.waitForFunction(()=>window.__playback.playing);await advance(page,6001);await page.waitForFunction(()=>window.__gates.length===1);
    await page.evaluate(()=>window.__playback.toggle());await page.evaluate(()=>window.__gates.shift()());await advance(page,30000);
    await noVk(page);await renewCalls(page,['a','a']);assert.equal(await page.evaluate(()=>window.__audios.some(audio=>!audio.paused)),false);
    assert.equal(await page.evaluate(()=>window.__releases.some(url=>url.endsWith('/session-2/0'))),true);
  });
  await run('next during managed renewal discards the old grant and preserves the new playing session',{managed:true,fastTimers:true,holdSecondResolve:true},async page=>{
    await start(page);await page.waitForFunction(()=>window.__playback.playing);await advance(page,6001);await page.waitForFunction(()=>window.__gates.length===1);
    await page.evaluate(()=>window.__playback.next());await page.waitForFunction(()=>window.__state.currentTrackId==='b'&&window.__playback.playing);
    await page.evaluate(()=>window.__gates.shift()());await page.waitForTimeout(40);
    await noVk(page);await renewCalls(page,['a','a','b']);
    assert.equal(await page.evaluate(()=>window.__releases.some(url=>url.endsWith('/session-2/0'))),true);
    assert.equal(await page.evaluate(()=>window.__releases.some(url=>url.endsWith('/session-3/0'))),false);
    assert.equal(await page.evaluate(()=>window.__audios.filter(audio=>!audio.paused).length),1);
    assert.equal(await page.evaluate(()=>window.__engines.at(-1).url.endsWith('/session-3/0')),true);
  });
  await run('one managed retry preserves the last real media offset',{managed:true,fastTimers:true},async page=>{
    await start(page);await page.waitForFunction(()=>window.__playback.playing);
    await page.evaluate(()=>{const audio=window.__audios.at(-1);audio.currentTime=37;audio.dispatchEvent(new Event('timeupdate'));});
    await advance(page,6001);await renewed(page);
    await noVk(page);assert.equal(await page.evaluate(()=>window.__state.position),37);assert.equal(await page.evaluate(()=>window.__audios.at(-1).currentTime),37);
  });
  await run('hard gateway failure renews once then uses exact VK at the saved position',{managed:true,fastTimers:true},async page=>{
    await start(page);await page.waitForFunction(()=>window.__playback.playing);
    await page.evaluate(()=>{const audio=window.__audios.at(-1);audio.currentTime=27;audio.dispatchEvent(new Event('timeupdate'));window.__engines.at(-1).retryable();});await renewed(page);await noVk(page);
    await page.evaluate(()=>window.__engines.at(-1).retryable());await page.waitForFunction(()=>window.__controls.some(command=>command.operation==='play'));
    await renewCalls(page,['a','a']);assert.deepEqual(await page.evaluate(()=>window.__controls.filter(command=>command.operation==='play').map(command=>({id:command.id,position:command.position}))),[{id:'a',position:27}]);
  });
  await run('expiry and ordinary stall share one bounded renewal budget',{managed:true,fastTimers:true},async page=>{
    await start(page);await page.waitForFunction(()=>window.__playback.playing);await expire(page);await renewed(page);
    await advance(page,6001);await page.waitForFunction(()=>window.__controls.some(command=>command.operation==='play'));
    await renewCalls(page,['a','a']);
  });
  await run('exhaustion of A leaves a fresh independent one-renewal budget for B',{managed:true,fastTimers:true},async page=>{
    await start(page);await page.waitForFunction(()=>window.__playback.playing);await advance(page,6001);await renewed(page);await advance(page,6001);
    await page.waitForFunction(()=>window.__controls.some(command=>command.operation==='play'));
    await page.evaluate(()=>window.__playback.next());await page.waitForFunction(()=>window.__state.currentTrackId==='b'&&window.__playback.playing);
    await advance(page,6001);await renewed(page,4);await renewCalls(page,['a','a','b','b']);
    assert.deepEqual(await page.evaluate(()=>window.__controls.filter(command=>command.operation==='play').map(command=>command.id)),['a']);
  });
  await run('pause before first managed deadline cancels automatic renewals',{managed:true,fastTimers:true},async page=>{
    await start(page);await page.waitForFunction(()=>window.__playback.playing);await advance(page,5900);await page.evaluate(()=>window.__playback.toggle());
    await advance(page,60000);await renewCalls(page,['a']);await noVk(page);assert.equal(await page.evaluate(()=>window.__audios.some(audio=>!audio.paused)),false);
  });
  console.log(JSON.stringify({summary:results,scope:'Actual production hook, independently chosen managed-stall adversarial sequences on clean Edge with synthetic media and provider receipts; no live/network playback claim.'}));
  if(results.some(result=>!result.ok))process.exitCode=1;
}finally{await browser.close();}
