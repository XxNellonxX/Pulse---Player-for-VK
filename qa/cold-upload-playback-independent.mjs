import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// Adversarial tests of the real shared React hook. All provider responses,
// media clocks and audio decoders are synthetic; no user profile is opened.
// In particular, these distinguish a cold VK file upload from a saved SC link.
const base = process.env.PULSE_QA_URL || 'http://127.0.0.1:5191';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [];
const hls = `export default class Hls {
  static Events={ERROR:'error'}; static isSupported(){return true;}
  constructor(){this.handlers=new Map();window.__engines.push(this);}
  on(name,fn){this.handlers.set(name,fn);} startLoad(){} stopLoad(){} destroy(){this.destroyed=true;}
  attachMedia(audio){this.audio=audio;audio.src='blob:synthetic-mse';}
  loadSource(url){this.url=url;this.audio.readyState=4;queueMicrotask(()=>{this.audio.dispatchEvent(new Event('loadedmetadata'));this.audio.dispatchEvent(new Event('canplay'));});}
}`;

async function run(name, options, action) {
  const page = await browser.newPage();
  page.setDefaultTimeout(1700);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.route('**/node_modules/.vite/deps/hls__js.js*', route => route.fulfill({ contentType: 'application/javascript', body: hls }));
    await page.route(base + '/__cold-upload-qa', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div>' }));
    await page.goto(base + '/__cold-upload-qa');
    await page.evaluate(async () => { const runtime=(await import('/@react-refresh')).default;runtime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true; });
    await page.evaluate(async options => {
      window.__audios=[];window.__engines=[];window.__controls=[];window.__searches=[];window.__resolves=[];window.__bindings=new Map();window.__listeners=new Set();window.__gates=[];window.__nativeGates=[];window.__releases=[];
      Object.defineProperty(navigator,'mediaSession',{configurable:true,value:{metadata:null,setActionHandler(){}}});
      window.Audio=class extends EventTarget {
        constructor(){super();Object.assign(this,{paused:true,error:null,currentTime:0,duration:94,readyState:0,networkState:2,src:'',volume:0,buffered:{length:0,start:()=>0,end:()=>0}});window.__audios.push(this);}
        getAttribute(name){return name==='src'?this.src:null;} removeAttribute(name){if(name==='src')this.src='';} load(){}
        play(){this.paused=false;this.dispatchEvent(new Event('playing'));return Promise.resolve();} pause(){this.paused=true;this.dispatchEvent(new Event('pause'));}
      };
      // VK-stage failure cases deliberately have verified card evidence, so
      // their first route is VK. Card presence does not establish provenance.
      const track=id=>({id,title:'breath '+id,artist:'t1de',album:'',duration:94,source:'vk',url:'vk-web://42/'+id,addedAt:1,available:options.vkUnavailable!==true,...(options.omitArtistCard?{}:{artistCard:options.artistCard||'present'}),...(options.artistRefs?{artistRefs:[{id:'artist-1',name:'t1de'}]}:{}),remote:{ownerId:42,audioId:id==='a'?7:8,inLibrary:true}});
      window.desktop={
        resolveVkTrack:async id=>({...track(id),...(options.hydratedAbsent?{artistCard:'absent'}:{}),...(options.hydratedUnavailable?{available:false}:{})}),
        soundCloudBinding:async id=>options.savedBinding?{id:'sc-'+id,title:'breath '+id,artist:'t1de',duration:94,streamable:true,selection:'user'}:window.__bindings.get(id)||null,
        soundCloudStatus:async()=>({configured:true,managed:true,proxy:false,message:''}),
        searchSoundCloud:async query=>{window.__searches.push(query);return {collection:[{id:'sc-'+(query.includes('breath b')?'b':'a'),title:options.noMatch?'different song':query.includes('breath b')?'breath b':'breath a',artist:'t1de',duration:94,streamable:true}],hasMore:false};},
        bindSoundCloud:async(id,sourceId,selection)=>{window.__bindings.set(id,{id:sourceId,title:'breath '+id,artist:'t1de',duration:94,streamable:true,selection});},
        resolveSoundCloud(id){window.__resolves.push(id);const result={url:location.origin+'/__cold-media/'+id+'/session-'+window.__resolves.length+'/0',sourceId:'sc-'+id,title:'breath '+id};return options.holdSource?new Promise(resolve=>window.__gates.push(()=>resolve(result))):Promise.resolve(result);},
        releaseSoundCloud:async url=>{window.__releases.push(url);},
        vkWebControl:async command=>{window.__controls.push(command);if(command.operation==='play'&&options.holdNativePlay&&window.__controls.filter(item=>item.operation==='play').length===1)return new Promise(resolve=>window.__nativeGates.push(()=>resolve({accepted:false,error:'late native play rejection'})));if((command.operation==='play'||command.operation==='resume')&&(options.rejectPlay||window.__rejectPlay))return {accepted:false,error:'VK did not load uploaded audio'};return {accepted:true};},
        onVkPlayback:listener=>{window.__listeners.add(listener);return()=>window.__listeners.delete(listener);},
      };
      window.__emit=patch=>{for(const listener of window.__listeners)listener({id:'a',requestedId:'a',playing:false,buffering:false,position:0,duration:94,ended:false,...patch});};
      const [react,dom,{usePlayback}]=await Promise.all([import('/node_modules/.vite/deps/react.js'),import('/node_modules/.vite/deps/react-dom_client.js'),import('/src/usePlayback.ts')]);
      const {createElement,useState}=react.default||react,{createRoot}=dom.default||dom;
      const missing={...track('missing-local'),source:'local',available:false,url:'file:///does-not-exist.mp3'};
      const initial={version:1,tracks:[track('a'),...(options.includeMissingLocal?[missing]:[]),track('b')],playlists:[],history:[],queue:['a',...(options.includeMissingLocal?['missing-local']:[]),'b'],currentTrackId:null,position:0,settings:{theme:'dark',style:'minimal',accent:'#bdff62',density:'comfortable',textScale:1,reducedMotion:false,volume:0,repeat:'off',shuffle:false,closeToTray:false,autoplay:false,autoSkip:options.autoSkip===true,equalizer:{enabled:false,preset:'flat',preamp:0,bands:Array(10).fill(0)},preferSoundCloud:options.preferSoundCloud!==false,preferExplicit:true}};
      function Harness(){const[state,setState]=useState(initial);window.__state=state;window.__setState=setState;window.__playback=usePlayback(state,setState);return createElement('span',null,state.currentTrackId||'empty');}
      createRoot(document.getElementById('root')).render(createElement(Harness));
    }, options);
    await page.waitForFunction(()=>window.__playback);
    await action(page);
    assert.deepEqual(errors,[]);
    results.push({name,ok:true});console.log('PASS '+name);
  } catch(error) {
    const debug=await page.evaluate(()=>({selected:window.__state?.currentTrackId,playing:window.__playback?.playing,buffering:window.__playback?.buffering,error:window.__playback?.error,label:window.__playback?.sourceLabel,searches:window.__searches,resolves:window.__resolves,controls:window.__controls,engines:window.__engines?.length})).catch(()=>null);
    results.push({name,ok:false,error:error.message,debug});console.log(JSON.stringify(results.at(-1)));
  } finally { await page.close(); }
}
const beginVK=async page=>{await page.evaluate(()=>window.__playback.playTrack('a'));await page.waitForFunction(()=>window.__controls.some(command=>command.operation==='play'));};
const expectSC=async page=>{await page.waitForFunction(()=>window.__playback.playing&&window.__playback.sourceLabel==='SoundCloud');assert.equal(await page.evaluate(()=>window.__state.currentTrackId),'a');};

try {
  await run('VK-unavailable record with a verified artist card plays SC without any VK start and retains the VK restriction', {vkUnavailable:true,artistCard:'present',artistRefs:true}, async page=>{
    await page.evaluate(()=>window.__playback.playTrack('a'));await expectSC(page);
    assert.equal(await page.evaluate(()=>window.__controls.some(command=>['play','resume'].includes(command.operation))),false);
    assert.equal(await page.evaluate(()=>window.__state.tracks.find(track=>track.id==='a').available),false);
    assert.deepEqual(await page.evaluate(()=>window.__resolves),['a']);
  });
  await run('VK-unavailable unmatched recording has an actionable source-selection error and never retries restricted VK', {vkUnavailable:true,noMatch:true}, async page=>{
    await page.evaluate(()=>window.__playback.playTrack('a'));await page.waitForFunction(()=>window.__playback.error.length>0);
    assert.match(await page.evaluate(()=>window.__playback.error),/соответств|выбер|информаци/i);
    assert.equal(await page.evaluate(()=>window.__controls.some(command=>['play','resume'].includes(command.operation))),false);
    assert.equal(await page.evaluate(()=>window.__playback.buffering),false);
  });
  await run('disabled SC preference never searches or starts restricted VK even with a saved user binding', {vkUnavailable:true,preferSoundCloud:false,savedBinding:true}, async page=>{
    await page.evaluate(()=>window.__playback.playTrack('a'));await page.waitForFunction(()=>window.__playback.error.length>0);
    assert.deepEqual(await page.evaluate(()=>window.__searches),[]);assert.deepEqual(await page.evaluate(()=>window.__resolves),[]);
    assert.equal(await page.evaluate(()=>window.__controls.some(command=>['play','resume'].includes(command.operation))),false);
  });
  await run('saved user choice can play an independently available SC recording when VK availability is false', {vkUnavailable:true,savedBinding:true}, async page=>{
    await page.evaluate(()=>window.__playback.playTrack('a'));await expectSC(page);assert.deepEqual(await page.evaluate(()=>window.__searches),[]);
    assert.equal(await page.evaluate(()=>window.__state.tracks.find(track=>track.id==='a').available),false);
    assert.equal(await page.evaluate(()=>window.__controls.some(command=>['play','resume'].includes(command.operation))),false);
  });
  await run('next and full-library shuffle retain SC-eligible VK records while excluding missing local files', {vkUnavailable:true,includeMissingLocal:true}, async page=>{
    await page.evaluate(()=>window.__playback.playTrack('a'));await expectSC(page);
    await page.evaluate(()=>window.__playback.next());await page.waitForFunction(()=>window.__state.currentTrackId==='b'&&window.__playback.playing&&window.__playback.sourceLabel==='SoundCloud');
    await page.evaluate(()=>window.__playback.toggleShuffle());await page.waitForFunction(()=>window.__state.settings.shuffle);
    assert.deepEqual(await page.evaluate(()=>[...window.__state.queue].sort()),['a','b']);
    assert.equal(await page.evaluate(()=>window.__state.tracks.filter(track=>track.source==='vk').every(track=>track.available===false)),true);
    assert.equal(await page.evaluate(()=>window.__controls.some(command=>['play','resume'].includes(command.operation))),false);
  });
  await run('SC exhaustion on VK-unavailable audio stops and the next recording independently uses SC', {vkUnavailable:true,savedBinding:true}, async page=>{
    await page.evaluate(()=>window.__playback.playTrack('a'));await expectSC(page);
    await page.evaluate(()=>window.__engines.at(-1).handlers.get('error')('error',{fatal:true,response:{code:503}}));await page.waitForFunction(()=>window.__resolves.length===2&&window.__playback.playing);
    assert.equal(await page.evaluate(()=>window.__controls.some(command=>['play','resume'].includes(command.operation))),false);
    await page.evaluate(()=>window.__engines.at(-1).handlers.get('error')('error',{fatal:true,response:{code:503}}));await page.waitForFunction(()=>window.__playback.error.length>0);
    assert.equal(await page.evaluate(()=>window.__controls.some(command=>['play','resume'].includes(command.operation))),false);
    assert.equal(await page.evaluate(()=>window.__playback.buffering),false);
    await page.evaluate(()=>window.__playback.next());await page.waitForFunction(()=>window.__state.currentTrackId==='b'&&window.__playback.playing&&window.__playback.sourceLabel==='SoundCloud');
    assert.deepEqual(await page.evaluate(()=>window.__resolves),['a','a','b']);
  });
  await run('expired SC grant on VK-unavailable audio renews once at the saved offset and never falls through to VK', {vkUnavailable:true,savedBinding:true}, async page=>{
    await page.evaluate(()=>window.__playback.playTrack('a'));await expectSC(page);
    await page.evaluate(()=>{window.__audios.at(-1).currentTime=17;window.__engines.at(-1).handlers.get('error')('error',{fatal:true,response:{code:410}});});
    await page.waitForFunction(()=>window.__resolves.length===2&&window.__playback.playing);
    assert.equal(await page.evaluate(()=>window.__state.position),17);
    await page.evaluate(()=>window.__engines.at(-1).handlers.get('error')('error',{fatal:true,response:{code:410}}));await page.waitForFunction(()=>window.__playback.error.length>0);
    assert.deepEqual(await page.evaluate(()=>window.__resolves),['a','a']);
    assert.equal(await page.evaluate(()=>window.__controls.some(command=>['play','resume'].includes(command.operation))),false);
    assert.equal(await page.evaluate(()=>window.__state.tracks.find(track=>track.id==='a').available),false);
    await page.evaluate(()=>window.__playback.retry());await expectSC(page);assert.deepEqual(await page.evaluate(()=>window.__resolves),['a','a','a']);
  });
  await run('full-library shuffle with SC preference disabled excludes unavailable VK and local entries', {vkUnavailable:true,includeMissingLocal:true,preferSoundCloud:false}, async page=>{
    await page.evaluate(()=>window.__playback.toggleShuffle());await page.waitForFunction(()=>window.__state.settings.shuffle);
    assert.deepEqual(await page.evaluate(()=>window.__state.queue),[]);
    assert.deepEqual(await page.evaluate(()=>window.__resolves),[]);
    assert.equal(await page.evaluate(()=>window.__controls.some(command=>['play','resume'].includes(command.operation))),false);
  });
  await run('freshly resolved VK restriction preserves the actionable SC no-match error', {hydratedUnavailable:true,noMatch:true}, async page=>{
    await page.evaluate(()=>window.__playback.playTrack('a'));await page.waitForFunction(()=>window.__playback.error.length>0);
    assert.match(await page.evaluate(()=>window.__playback.error),/соответств|выбер|информаци/i);
    assert.equal(await page.evaluate(()=>window.__controls.some(command=>['play','resume'].includes(command.operation))),false);
  });
  await run('pausing pending SC for VK-unavailable audio releases the late grant without starting either source', {vkUnavailable:true,holdSource:true}, async page=>{
    await page.evaluate(()=>window.__playback.playTrack('a'));await page.waitForFunction(()=>window.__gates.length===1);
    await page.evaluate(()=>{window.__playback.toggle();window.__gates.shift()();});await page.waitForTimeout(70);
    assert.equal(await page.evaluate(()=>window.__audios.some(audio=>!audio.paused)),false);assert.equal(await page.evaluate(()=>window.__releases.length),1);
    assert.equal(await page.evaluate(()=>window.__controls.some(command=>['play','resume'].includes(command.operation))),false);
  });
  await run('unknown artist card discovers a strict SC source before any VK media command', {rejectPlay:true,artistCard:'unknown'}, async page=>{
    await page.evaluate(()=>window.__playback.playTrack('a'));await expectSC(page);assert.deepEqual(await page.evaluate(()=>window.__resolves),['a']);assert.equal(await page.evaluate(()=>window.__controls.some(command=>command.operation==='play')),false);
  });
  await run('old library record without a card field discovers SC before any VK media command', {rejectPlay:true,omitArtistCard:true}, async page=>{
    await page.evaluate(()=>window.__playback.playTrack('a'));await expectSC(page);assert.equal(await page.evaluate(()=>window.__searches.length),1);assert.equal(await page.evaluate(()=>window.__controls.some(command=>command.operation==='play')),false);
  });
  await run('an explicitly absent artist card prioritizes SC discovery', {rejectPlay:true,artistCard:'absent'}, async page=>{
    await page.evaluate(()=>window.__playback.playTrack('a'));await expectSC(page);assert.equal(await page.evaluate(()=>window.__searches.length),1);assert.equal(await page.evaluate(()=>window.__controls.some(command=>command.operation==='play')),false);
  });
  await run('verified artist reference retains the VK first route despite a legacy unknown card flag', {artistCard:'unknown',artistRefs:true}, async page=>{
    await beginVK(page);assert.equal(await page.evaluate(()=>window.__searches.length),0);await page.evaluate(()=>window.__emit({network:'error',error:'Uploaded VK audio failed'}));await expectSC(page);
  });
  await run('cold uploaded file with known artist card still falls back after rejected VK start', {rejectPlay:true,artistCard:'present'}, async page=>{
    await beginVK(page);await expectSC(page);assert.equal(await page.evaluate(()=>window.__searches.length),1);
  });
  await run('one VK error status starts strict SC discovery for cold uploaded file', {}, async page=>{
    await beginVK(page);await page.evaluate(()=>window.__emit({network:'error',error:'Uploaded VK audio failed'}));await expectSC(page);assert.equal(await page.evaluate(()=>window.__searches.length),1);
  });
  await run('duplicate VK error statuses cannot cancel an already scheduled SC fallback', {}, async page=>{
    await beginVK(page);await page.evaluate(()=>{window.__emit({network:'error',error:'Uploaded VK audio failed'});window.__emit({network:'error',error:'Uploaded VK audio failed'});});await expectSC(page);assert.equal(await page.evaluate(()=>window.__searches.length),1);
  });
  await run('late VK error while an SC grant resolves cannot poison current source state', {holdSource:true}, async page=>{
    await beginVK(page);await page.evaluate(()=>window.__emit({network:'error',error:'Uploaded VK audio failed'}));await page.waitForFunction(()=>window.__gates.length===1);
    await page.evaluate(()=>{window.__emit({network:'error',error:'late old VK error'});window.__gates.shift()();});await expectSC(page);assert.equal(await page.evaluate(()=>window.__playback.error),'');
  });
  await run('saved external binding works independently from the cold discovery path', {savedBinding:true,rejectPlay:true}, async page=>{
    await page.evaluate(()=>window.__playback.playTrack('a'));await expectSC(page);assert.equal(await page.evaluate(()=>window.__searches.length),0);assert.equal(await page.evaluate(()=>window.__controls.some(command=>command.operation==='play')),false);
  });
  await run('pause while cold fallback grant is pending rejects its eventual audio', {holdSource:true}, async page=>{
    await beginVK(page);await page.evaluate(()=>window.__emit({network:'error',error:'Uploaded VK audio failed'}));await page.waitForFunction(()=>window.__gates.length===1);
    await page.evaluate(()=>{window.__playback.toggle();window.__gates.shift()();});await page.waitForTimeout(70);assert.equal(await page.evaluate(()=>window.__audios.some(audio=>!audio.paused)),false);assert.equal(await page.evaluate(()=>window.__releases.length),1);
  });
  await run('next during cold fallback cannot let the old upload replace selected track', {holdSource:true}, async page=>{
    await beginVK(page);await page.evaluate(()=>window.__emit({network:'error',error:'Uploaded VK audio failed'}));await page.waitForFunction(()=>window.__gates.length===1);
    await page.evaluate(()=>window.__playback.playTrack('b'));await page.waitForFunction(()=>window.__controls.some(command=>command.operation==='play'&&command.id==='b'));
    await page.evaluate(()=>window.__gates.shift()());await page.waitForTimeout(70);assert.equal(await page.evaluate(()=>window.__state.currentTrackId),'b');assert.equal(await page.evaluate(()=>window.__audios.some(audio=>!audio.paused)),false);assert.equal(await page.evaluate(()=>window.__releases.length),1);
  });
  await run('explicit retry after rejected VK source can recover through newly available SC', {rejectPlay:true}, async page=>{
    await beginVK(page);await page.waitForTimeout(50);await page.evaluate(()=>window.__playback.retry());await expectSC(page);
  });
  await run('fresh native artist-card evidence controls first playback of old persisted uploads', {hydratedAbsent:true}, async page=>{
    await page.evaluate(()=>window.__playback.playTrack('a'));await expectSC(page);assert.equal(await page.evaluate(()=>window.__controls.some(command=>command.operation==='play')),false);
  });
  await run('three failed VK-unavailable catalog discoveries do not spend the media-error automatic-skip budget', {vkUnavailable:true,noMatch:true,autoSkip:true}, async page=>{
    await page.evaluate(()=>window.__playback.playTrack('a'));await page.waitForFunction(()=>window.__playback.error.length>0);
    for(let retry=0;retry<2;retry++){
      const before=await page.evaluate(()=>window.__searches.length);
      await page.evaluate(()=>window.__playback.retry());
      await page.waitForFunction(before=>window.__searches.length>before&&window.__playback.error.length>0,before);
      assert.equal(await page.evaluate(()=>window.__state.currentTrackId),'a');
      assert.match(await page.evaluate(()=>window.__playback.error),/соответств|выбер|информаци/i);
    }
    await page.evaluate(()=>window.__setState(previous=>({...previous,queue:['a','b','c'],tracks:[previous.tracks[0],...['b','c'].map(id=>({...previous.tracks[1],id,source:'local',available:true,url:location.origin+'/local-'+id+'.mp3'}))]})));
    await page.evaluate(()=>window.__playback.next());
    await page.waitForFunction(()=>window.__state.currentTrackId==='b'&&window.__audios.at(-1).src.endsWith('/local-b.mp3'));
    await page.evaluate(()=>{const audio=window.__audios.at(-1);audio.readyState=4;audio.dispatchEvent(new Event('canplay'));});
    await page.waitForFunction(()=>window.__playback.playing);
    await page.evaluate(()=>window.__audios.at(-1).dispatchEvent(new Event('error')));
    await page.waitForFunction(()=>window.__state.currentTrackId==='c');
    assert.equal(await page.evaluate(()=>window.__controls.some(command=>['play','resume'].includes(command.operation))),false);
  });
  await run('unmatched cold uploaded file ends with a source-selection explanation instead of replaying failed VK', {noMatch:true}, async page=>{
    await beginVK(page);await page.evaluate(()=>window.__emit({network:'error',error:'Uploaded VK audio failed'}));
    await page.waitForFunction(()=>window.__playback.error.length>0);assert.match(await page.evaluate(()=>window.__playback.error),/соответств|выбер|информаци/i);assert.equal(await page.evaluate(()=>window.__controls.filter(command=>command.operation==='play').length),1);assert.equal(await page.evaluate(()=>window.__playback.buffering),false);
  });
  await run('explicit retry resets the exact-track exhausted external-route budget', {savedBinding:true}, async page=>{
    await page.evaluate(()=>window.__playback.playTrack('a'));await expectSC(page);
    await page.evaluate(()=>window.__engines.at(-1).handlers.get('error')('error',{fatal:true,response:{code:503}}));await page.waitForFunction(()=>window.__resolves.length===2&&window.__playback.playing);
    await page.evaluate(()=>window.__engines.at(-1).handlers.get('error')('error',{fatal:true,response:{code:503}}));await page.waitForFunction(()=>window.__controls.some(command=>command.operation==='play'));
    await page.evaluate(()=>window.__emit({network:'error',error:'VK route also failed'}));await page.waitForFunction(()=>window.__playback.error.length>0);
    await page.evaluate(()=>window.__playback.retry());await expectSC(page);assert.deepEqual(await page.evaluate(()=>window.__resolves),['a','a','a']);
  });
  await run('playing the same library row again starts a new external-route attempt after exhaustion', {savedBinding:true}, async page=>{
    await page.evaluate(()=>window.__playback.playTrack('a'));await expectSC(page);
    await page.evaluate(()=>window.__engines.at(-1).handlers.get('error')('error',{fatal:true,response:{code:503}}));await page.waitForFunction(()=>window.__resolves.length===2&&window.__playback.playing);
    await page.evaluate(()=>window.__engines.at(-1).handlers.get('error')('error',{fatal:true,response:{code:503}}));await page.waitForFunction(()=>window.__controls.some(command=>command.operation==='play'));
    await page.evaluate(()=>window.__emit({network:'error',error:'VK route also failed'}));await page.waitForFunction(()=>window.__playback.error.length>0);
    await page.evaluate(()=>window.__playback.playTrack('a'));await expectSC(page);assert.deepEqual(await page.evaluate(()=>window.__resolves),['a','a','a']);
  });
  await run('native rejection while restarting the loaded same row still discovers SC', {}, async page=>{
    await beginVK(page);await page.evaluate(()=>{window.__emit({playing:true,position:4});window.__rejectPlay=true;window.__playback.playTrack('a');});await expectSC(page);assert.equal(await page.evaluate(()=>window.__searches.length),1);
  });
  await run('native rejection when resuming the loaded upload still discovers SC', {}, async page=>{
    await beginVK(page);await page.evaluate(()=>window.__emit({playing:true,position:4}));await page.waitForFunction(()=>window.__playback.playing);
    await page.evaluate(()=>window.__playback.toggle());await page.waitForFunction(()=>!window.__playback.playing);
    await page.evaluate(()=>{window.__rejectPlay=true;window.__playback.toggle();});await expectSC(page);assert.equal(await page.evaluate(()=>window.__searches.length),1);
  });
  await run('late rejected native play receipt cannot cancel SC chosen from playback error', {holdNativePlay:true}, async page=>{
    await beginVK(page);await page.evaluate(()=>window.__emit({network:'error',error:'Uploaded VK audio failed'}));await expectSC(page);
    await page.evaluate(()=>window.__nativeGates.shift()());await page.waitForTimeout(70);assert.equal(await page.evaluate(()=>window.__playback.playing),true);assert.equal(await page.evaluate(()=>window.__playback.error),'');assert.deepEqual(await page.evaluate(()=>window.__resolves),['a']);
  });
  await run('fresh same-ID retry discards pending cold lookup and releases only the late old grant', {holdSource:true}, async page=>{
    await beginVK(page);await page.evaluate(()=>window.__emit({network:'error',error:'Uploaded VK audio failed'}));await page.waitForFunction(()=>window.__gates.length===1);
    await page.evaluate(()=>window.__playback.retry());await page.waitForFunction(()=>window.__gates.length===2);
    await page.evaluate(()=>window.__gates[1]());await expectSC(page);await page.evaluate(()=>window.__gates[0]());await page.waitForTimeout(70);
    assert.equal(await page.evaluate(()=>window.__playback.playing),true);assert.equal(await page.evaluate(()=>window.__releases.length),1);assert.equal(await page.evaluate(()=>window.__releases.includes(window.__engines.at(-1).url)),false);assert.equal(await page.evaluate(()=>window.__audios.filter(audio=>!audio.paused).length),1);
  });
  console.log(JSON.stringify({summary:results,scope:'Synthetic actual shared hook on Edge; no live provider or physical audio verification.'}));
  if(results.some(result=>!result.ok))process.exitCode=1;
} finally {await browser.close();}
