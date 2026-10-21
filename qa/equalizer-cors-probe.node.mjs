import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source=await readFile(new URL('../src-tauri/src/vk_direct_audio.js',import.meta.url),'utf8');
function fixture({cors}){
 const media=[];let fetches=0;
 class Audio{constructor(){this.listeners=new Map();this.src='';this.duration=20;this.currentTime=0;this.readyState=0;this.paused=true;this.ended=false;this.buffered={length:0};media.push(this)}addEventListener(t,f){const s=this.listeners.get(t)||new Set();s.add(f);this.listeners.set(t,s)}removeEventListener(t,f){this.listeners.get(t)?.delete(f)}emit(type){for(const f of this.listeners.get(type)||[])f({type})}load(){queueMicrotask(()=>{this.readyState=4;this.emit('loadedmetadata');this.emit('canplay')})}play(){this.paused=false;this.emit('playing');return Promise.resolve()}pause(){this.paused=true}removeAttribute(n){if(n==='src')this.src=''}canPlayType(){return ''}}
 const sandbox={location:{href:'https://vk.com/audio',origin:'https://vk.com'},vk:{id:101},Audio,URL,Event,AbortController,fetch:async()=>{fetches++;return {ok:cors,type:cors?'cors':'opaque',body:{cancel:async()=>{}}}},setTimeout,clearTimeout,navigator:{onLine:true}};sandbox.window=sandbox;sandbox.top=sandbox;vm.runInNewContext(source,sandbox);
 return {transport:sandbox.__PULSE_CREATE_DIRECT_AUDIO__(),media,get fetches(){return fetches}};
}
for(const [name,cors] of [['probe-allows-cross-origin-EQ',true],['probe-denies-cross-origin-EQ',false]]) test(name,async()=>{const f=fixture({cors});try{await f.transport.equalizer({enabled:true,bands:Array(10).fill(0),preamp:0});const raw=[];raw[0]=7;raw[1]=101;raw[2]='https://cdn.example.test/track.mp3';raw[5]=20;await f.transport.load(raw,{});await f.transport.play();assert.equal(f.fetches,1);assert.equal(f.media[0].crossOrigin,cors?'anonymous':undefined);assert.equal(f.transport.read().playing,true);assert.equal(f.transport.read().equalizerEnabled,false);if(!cors)assert.match(f.transport.read().equalizerError,/недоступен/); }finally{f.transport.destroy()}});
