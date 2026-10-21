import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../src-tauri/src/vk_web_adapter.js', import.meta.url), 'utf8');
const song = id => [id, 42, `https://fixture.invalid/${id}.mp3`, `Song ${id}`, 'Artist', 60];
const settle = async () => { for(let i=0;i<20;i++) await new Promise(r=>setImmediate(r)); };
function fixture({seed=null,owner=42,offline=false}={}) {
  const calls=[],timers=new Map(); let timerId=0;
  let offlineNow=offline;
  const w={location:{href:'https://vk.com/audio'},vk:{id:owner},getAudioPlayer:()=>({})};w.top=w;
  w.ajax={post(url,params,cb){calls.push({url,params});queueMicrotask(()=>{if(offlineNow)return cb.onFail();if(url.includes('owner_playlists'))return cb.onDone([{owner_id:42,id:3,title:'Mix',size:1,update_time:5}],1);const list=[song(params.playlist_id===-1?1:2)];return cb.onDone({list,totalCount:1,ownerId:params.owner_id,id:params.playlist_id});});}};
  const context=vm.createContext({window:w,URL,Date,console,document:{querySelector:()=>null,createElement:()=>({set innerHTML(v){this.value=v;},value:''})},setTimeout(fn,delay){const id=++timerId;timers.set(id,{fn,delay});return id;},clearTimeout(id){timers.delete(id);}});
  vm.runInContext(source,context);
  w.__PULSE_VK_WEB__.start('r',seed);
  return {w,api:w.__PULSE_VK_WEB__,calls,timers,setOffline(value){offlineNow=value;},reinject(){vm.runInContext(source,context);},fireTimer(){assert.equal(timers.size,1,'Exactly one scheduled background task should remain');const [id,timer]=[...timers][0];timers.delete(id);timer.fn();return timer.delay;}};
}
async function seed() {const f=fixture();await settle();const s=f.api.read(true);assert.equal(s.status,'complete');return {accountId:42,tracks:s.tracks,playlists:s.playlists,index:s.cacheIndex};}
test('cached startup waits for delayed account globals without losing the cache seed',async()=>{const f=fixture({seed:await seed(),owner:0});assert.equal(f.api.read().status,'waiting-login');f.w.vk.id=42;f.api.read();await settle();assert.equal(f.api.read(true).status,'complete');assert.equal(f.calls.filter(c=>c.params.playlist_id===3).length,0,'An unchanged playlist was downloaded again because early identity was absent');});
test('offline initial refresh schedules a bounded automatic retry instead of permanently stopping updates',async()=>{const f=fixture({seed:await seed(),offline:true});await settle();assert.equal(f.api.read().status,'error');assert.ok([...f.timers.values()].some(t=>t.delay>=5000&&t.delay<=300000),'No bounded retry remains after the first network failure');});
test('delayed identity from a different account rejects the old cache seed',async()=>{const f=fixture({seed:await seed(),owner:0});f.w.vk.id=43;f.api.read();await settle();assert.equal(f.api.read(true).status,'complete');assert.equal(f.calls.filter(c=>c.params.playlist_id===3).length,1,'Another account must verify playlist contents even if the card identity matches');});
test('actual script reinjection forwards manual full-refresh intent to an existing adapter',async()=>{const cached=await seed();const f=fixture({seed:cached});await settle();assert.equal(f.calls.filter(c=>c.params.playlist_id===3).length,0);f.w.__PULSE_VK_WEB_RUN_ID='manual-reinjection';f.w.__PULSE_VK_WEB_CACHE=cached;f.w.__PULSE_VK_WEB_FULL_REFRESH=true;f.reinject();await settle();assert.equal(f.api.read(true).runId,'manual-reinjection');assert.equal(f.calls.filter(c=>c.params.playlist_id===3).length,1,'Reinjection must really bypass the warm manifest');});
test('offline retries back off to five minutes and successful recovery clears errors',async()=>{const f=fixture({seed:await seed(),offline:true});await settle();for(const expected of [30000,60000,120000,240000,300000,300000]){assert.equal(f.fireTimer(),expected);await settle();assert.equal(f.api.read().status,'error');}f.setOffline(false);assert.equal(f.fireTimer(),300000);await settle();const state=f.api.read(true);assert.equal(state.status,'complete');assert.equal(state.error,undefined);assert.equal(state.errorCode,undefined);assert.equal([...f.timers.values()][0].delay,300000);});
test('a stale failed run cannot retry after manual restart or account change',async()=>{const f=fixture({offline:true});await settle();const stale=[...f.timers.values()][0];f.api.start('new-run');await settle();const count=f.calls.length;stale.fn();await settle();assert.equal(f.calls.length,count,'Restart must invalidate the previous retry callback');f.w.vk.id=43;f.fireTimer();await settle();assert.equal(f.calls.length,count,'An old account retry must never fetch after identity changed');});
