import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { installDirectFixture } from './vk-direct-fixture.mjs';
const source=await readFile(new URL('../src-tauri/src/vk_web_adapter.js',import.meta.url),'utf8');
const song=(id,owner=42)=>[id,owner,`https://fixture.invalid/${id}.mp3`,`Song ${id}`,'Artist',60];
const settle=async()=>{for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r));};
function fixture(){
 const calls=[],timers=new Set();let library=[song(1),song(2)],hold;
 const w={location:{href:'https://vk.com/audio'},vk:{id:42},getAudioPlayer:()=>({})};w.top=w;
 w.ajax={post(url,p,cb){calls.push(p);if(hold?.(url,p,cb))return;queueMicrotask(()=>url.includes('owner_playlists')?cb.onDone([{id:3,owner_id:42,title:'Mix',size:1,update_time:2}],1):cb.onDone({list:p.type==='search'?[song(55,9)]:p.playlist_id===-1?library:[song(2)],totalCount:p.playlist_id===-1?library.length:1,ownerId:p.owner_id,id:p.playlist_id}));}};
 const direct=installDirectFixture(w);
 vm.runInContext(source,vm.createContext({window:w,URL,Date,console,document:{querySelector:()=>null,createElement:()=>({set innerHTML(v){this.value=v;},value:''})},setTimeout(fn,ms){const t=setTimeout(()=>{timers.delete(t);fn();},ms);timers.add(t);return t;},clearTimeout(t){clearTimeout(t);timers.delete(t);}}));
 const api=w.__PULSE_VK_WEB__;api.start('r');
 return {w,api,calls,direct,setLibrary(v){library=v;},hold(v){hold=v;},close(){for(const t of timers)clearTimeout(t);}};
}
test('add receipt publishes exact verified top order without rescanning playlist contents',async()=>{
 const f=fixture();try{await settle();const before=f.api.read(true);f.calls.length=0;f.api.acceptSearch([song(55,9)]);let writes=0;
 const receipt=await f.api.libraryAction('add','vk-9-55',42,async raw=>{assert.equal(raw[0],55);writes++;f.setLibrary([song(7),song(1),song(2)]);return{id:7,ownerId:42};});
 assert.equal(writes,1);assert.deepEqual({...receipt},{ownerId:42,audioId:7});const next=f.api.read();assert.equal(next.complete,true);assert.deepEqual(Array.from(next.tracks.filter(t=>t.remote.inLibrary),t=>t.id),['vk-42-7','vk-42-1','vk-42-2']);assert.deepEqual(next.playlists,before.playlists);assert.equal(f.calls.filter(p=>p.playlist_id===3).length,0);
 }finally{f.close();}
});
test('delete readback removes library membership while preserving saved playlist references',async()=>{
 const f=fixture();try{await settle();f.api.read(true);await f.api.libraryAction('delete','vk-42-2',42,async()=>{f.setLibrary([song(1)]);return true;});const next=f.api.read();assert.equal(next.complete,true);assert.deepEqual(Array.from(next.tracks.filter(t=>t.remote.inLibrary),t=>t.id),['vk-42-1']);assert.equal(next.tracks.find(t=>t.id==='vk-42-2').remote.inLibrary,false);assert.deepEqual([...next.playlists[0].trackIds],['vk-42-2']);
 }finally{f.close();}
});
test('a mutation waits for a background collector and cannot be overwritten by its stale response',async()=>{
 const f=fixture();try{await settle();let callback;f.hold((_url,p,cb)=>{if(p.playlist_id===-1&&!callback){callback=cb;return true;}return false;});f.api.start('refresh');await settle();let writes=0;const pending=f.api.libraryAction('delete','vk-42-1',42,async()=>{writes++;f.setLibrary([song(2)]);return true;});await settle();assert.equal(writes,0);callback.onDone({list:[song(1),song(2)],totalCount:2,ownerId:42,id:-1});await pending;assert.equal(writes,1);assert.equal(f.api.read(true).tracks.some(t=>t.id==='vk-42-1'&&t.remote.inLibrary),false);
 }finally{f.close();}
});
test('account change in mutation callback cannot publish success into another account',async()=>{
 const f=fixture();try{await settle();await assert.rejects(f.api.libraryAction('delete','vk-42-1',42,async()=>{f.w.vk.id=43;return true;}),/session_changed/);assert.notEqual(f.api.read().status,'complete');}finally{f.close();}
});
test('foreign deletion and forged add identity reject without authoritative success',async()=>{
 const f=fixture();try{await settle();f.api.acceptSearch([song(55,9)]);let writes=0;await assert.rejects(f.api.libraryAction('delete','vk-9-55',42,async()=>{writes++;}),/not_owned_library_track/);assert.equal(writes,0);await assert.rejects(f.api.libraryAction('add','vk-9-55',42,async()=>({id:8,ownerId:9})),/invalid_mutation_receipt/);}finally{f.close();}
});
test('bounded search tuples discard old searches and rehydrate an old pinned result through native metadata',async()=>{
 const f=fixture();try{await settle();const old=f.api.acceptSearch([song(55,9)])[0];for(let n=0;n<7;n++)f.api.acceptSearch(Array.from({length:100},(_,i)=>song(1000+n*100+i,9)));assert.equal(f.api.command({operation:'play',id:old.id}).accepted,false);const cmd=f.api.command({operation:'play',id:old.id,cachedTrack:old});assert.equal(cmd.accepted,true);await settle();assert.equal(cmd.pending,false);assert.equal(f.direct.loads.at(-1)[0],55);assert.equal(f.calls.filter(p=>p.type==='search').length,1);
 }finally{f.close();}
});
test('a warm run reports actual page reuse without private metadata in counters',async()=>{
 const f=fixture();try{await settle();const initial=f.api.read(true);assert.deepEqual({...initial.cacheStats},{libraryPages:1,playlistPages:1,reusedPlaylists:0});f.api.start('warm',{accountId:42,tracks:initial.tracks,playlists:initial.playlists,index:initial.cacheIndex});await settle();assert.deepEqual({...f.api.read(true).cacheStats},{libraryPages:1,playlistPages:0,reusedPlaylists:1});}finally{f.close();}
});
