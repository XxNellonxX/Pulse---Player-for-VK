import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

// Independent failure/cleanup tests. Network and decoder readiness are fake;
// these cannot establish that any live VK delivery is available or playable.
const source = await readFile(new URL('../src-tauri/src/vk_direct_audio.js', import.meta.url), 'utf8');
// Enough microtasks to drain all sixteen deliberately synchronous failures;
// advancing a clock before that drain would invent an artificial hedge delay.
const flush = async () => { for (let n = 0; n < 1000; n++) await Promise.resolve(); };
const url = n => `https://test-media.example.test/source-${n}.mp3`;
const raw = (urls = [url(0)]) => ({ ownerId: 101, id: 7, url: '', extra: { audio_streams: urls.map(url => ({ type: 'mp3', url })) }, hashes: 'add/edit/action/delete/replace/urlhash/restore' });

function fixture(policy = () => 'hold') {
  let now = 0, sequence = 0, peak = 0;
  const media = [], timers = new Map();
  class Audio {
    constructor() { Object.assign(this,{src:'',paused:true,readyState:0,currentTime:0,duration:120,ended:false,listeners:new Map()});media.push(this); }
    addEventListener(name, fn) { if (!this.listeners.has(name))this.listeners.set(name,new Set());this.listeners.get(name).add(fn); }
    removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
    emit(name) { for(const fn of [...this.listeners.get(name)||[]])fn({type:name}); }
    removeAttribute(name) { if(name==='src')this.src=''; }
    load() { if(!this.src)return;peak=Math.max(peak,media.filter(item=>item.src).length);const result=policy(this.src);queueMicrotask(()=>{if(result==='ready'){this.readyState=4;this.emit('canplay');}if(result==='error')this.emit('error');}); }
    pause() {this.paused=true;} play() {this.paused=false;this.emit('playing');return Promise.resolve();} canPlayType(){return '';}
  }
  const sandbox={Audio,URL,Event,AbortController,location:{href:'https://vk.ru/audio',origin:'https://vk.ru'},vk:{id:101},Date:{now:()=>now},setTimeout(callback,delay){const id=++sequence;timers.set(id,{callback,at:now+delay});return id;},clearTimeout(id){timers.delete(id);}};
  sandbox.window=sandbox;sandbox.top=sandbox;vm.runInNewContext(source,sandbox);
  return {media,timers,sandbox,transport:sandbox.__PULSE_CREATE_DIRECT_AUDIO__(),now:()=>now,peak:()=>peak,
    async advance(){await flush();const first=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];assert.ok(first,'test exhausted pending timers');timers.delete(first[0]);now=first[1].at;first[1].callback();await flush();},
  };
}
const listeners = audio => [...audio.listeners.values()].reduce((sum,items)=>sum+items.size,0);
async function settle(f, promise) { let done=false;promise.then(()=>{done=true;},()=>{done=true;});for(let i=0;i<100&&!done;i++){await flush();if(!done)await f.advance();}assert.equal(done,true,'bounded pipeline did not settle');return promise; }

test('sixteen silent deliveries terminate within the source budget without residual timers or requests',async()=>{
  const f=fixture();try{
    const load=f.transport.load(raw(Array.from({length:16},(_,n)=>url(n))),{});const rejected=assert.rejects(load);
    await settle(f,rejected);assert.ok(f.now()<=45000);assert.equal(f.peak(),3);assert.equal(f.timers.size,0);
    assert.ok(f.media.every(item=>item.src===''&&item.paused&&listeners(item)===0));assert.equal(f.transport.read().buffering,false);assert.ok(f.transport.read().error);
  }finally{f.transport.destroy();}
});

test('immediately failing sixteen deliveries yield a terminal error rather than an event-loop retry spin',async()=>{
  const f=fixture(()=>'error');try{
    const load=f.transport.load(raw(Array.from({length:16},(_,n)=>url(n))),{});const rejected=assert.rejects(load);await settle(f,rejected);
    assert.equal(f.media.length,16);assert.equal(f.now(),0);assert.equal(f.timers.size,0);assert.ok(f.media.every(item=>item.src===''&&listeners(item)===0));
  }finally{f.transport.destroy();}
});

test('simultaneous readiness of all three alternatives commits one and removes every losing listener',async()=>{
  const f=fixture();try{
    const load=f.transport.load(raw([url(0),url(1),url(2)]),{});await f.advance();await f.advance();assert.equal(f.media.length,3);
    for(const item of f.media){item.readyState=4;item.emit('canplay');}
    await load;await f.transport.play();assert.equal(f.media.filter(item=>item.src).length,1);assert.equal(f.media.filter(item=>!item.paused).length,1);assert.equal(f.timers.size,0);
    assert.ok(f.media.filter(item=>!item.src).every(item=>listeners(item)===0));f.transport.stop();assert.ok(f.media.every(item=>listeners(item)===0));
  }finally{f.transport.destroy();}
});

test('repeated replacement of a successful delivery leaves no old timers, sources or media listeners',async()=>{
  const f=fixture(()=>'ready');try{
    for(let n=0;n<30;n++){
      await f.transport.load(raw([url(n)]),{});await f.transport.play();assert.equal(f.timers.size,0);assert.equal(f.media.filter(item=>item.src).length,1);
      assert.ok(f.media.slice(0,-1).every(item=>item.src===''&&item.paused&&listeners(item)===0));
    }
    f.transport.stop();assert.ok(f.media.every(item=>item.src===''&&item.paused&&listeners(item)===0));assert.equal(f.timers.size,0);
  }finally{f.transport.destroy();}
});

test('destroy just before the third stagger releases both active candidates and prevents candidate creation',async()=>{
  const f=fixture();try{
    const load=f.transport.load(raw([url(0),url(1),url(2)]),{});const rejected=assert.rejects(load,error=>error.code==='PULSE_DIRECT_CANCELLED');await f.advance();assert.equal(f.media.length,2);
    f.transport.destroy();await rejected;assert.equal(f.timers.size,0);assert.equal(f.media.length,2);assert.ok(f.media.every(item=>item.src===''&&listeners(item)===0));
  }finally{f.transport.destroy();}
});

test('prototype discovery skips shadowing accessors and unrelated node-provider methods without reading them',async()=>{
  const f=fixture(()=>'ready');let getters=0;try{
    class Base { __private_77_createAudio(){return{sources:[{url:url(9),format:'mp3'}]};} }
    class Middle extends Base {}
    Object.defineProperty(Middle.prototype,'_private__createAudio',{get(){getters++;throw Error('accessor executed');}});
    const impl=new Middle();Object.defineProperty(impl,'_private__ensureNodeProvider',{get(){getters++;throw Error('provider accessor executed');}});
    await f.transport.load({...raw([]),url:'https://vk.ru/audio_api_unavailable?extra=masked'},{_impl:impl});
    assert.equal(getters,0);assert.equal(f.media.at(-1).src,url(9));
  }finally{f.transport.destroy();}
});
