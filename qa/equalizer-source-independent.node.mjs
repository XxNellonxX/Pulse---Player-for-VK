import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src-tauri/src/vk_direct_audio.js', import.meta.url), 'utf8');
const tuple = (url = 'https://cdn.example.test/own-upload.mp3') => { const value=[];value[0]=7;value[1]=101;value[2]=url;value[5]=120;value[12]={};value[13]='//////';return value; };

function fixture({hangPrimary=false}={}) {
  const media=[],calls=[];
  let now=Date.now();
  class Audio {
    constructor() { this.listeners=new Map();this.currentTime=0;this.duration=120;this.readyState=0;this.paused=true;this.ended=false;this.src='';media.push(this); }
    addEventListener(type,handler) { const set=this.listeners.get(type)||new Set();set.add(handler);this.listeners.set(type,set); }
    removeEventListener(type,handler) {this.listeners.get(type)?.delete(handler);}
    emit(type) {for(const handler of this.listeners.get(type)||[]) handler({type});}
    load() {if(this.src&&!(hangPrimary&&this.src.includes('/primary.'))) queueMicrotask(()=>{this.readyState=4;this.emit('loadedmetadata');this.emit('canplay');});}
    removeAttribute(name) {if(name==='src') this.src='';}
    play() {this.paused=false;this.emit('playing');return Promise.resolve();}
    pause() {this.paused=true;}
    canPlayType() {return '';}
  }
  const sandbox={location:{href:'https://vk.com/audio'},vk:{id:101},Audio,URL,Event,Date:{now:()=>now},setTimeout:(callback,ms)=>setTimeout(()=>{now+=ms;callback();},Math.min(ms,30)),clearTimeout};sandbox.window=sandbox;sandbox.top=sandbox;
  vm.runInNewContext(source,sandbox);
  return {media,calls,transport:sandbox.__PULSE_CREATE_DIRECT_AUDIO__()};
}

test('a session-granted own MP3 source survives a stalled shared website resolver',async()=>{
  const f=fixture();
  const player={_ensureHasURL(input){f.calls.push(input);return new Promise(()=>{});}};
  try {await f.transport.load(tuple(),player);await f.transport.play();assert.equal(f.transport.read().playing,true);assert.match(f.media.at(-1).src,/own-upload\.mp3/);}
  finally {f.transport.destroy();}
});

test('masked own MP3 without a resolved source fails visibly and clears loading',async()=>{
  const f=fixture();
  const player={_ensureHasURL(){return new Promise(()=>{});}};
  try {await assert.rejects(f.transport.load(tuple('https://vk.com/audio_api_unavailable?extra=masked'),player));assert.equal(f.transport.read().buffering,false);assert.ok(f.transport.read().error);}
  finally {f.transport.destroy();}
});

test('an unresponsive preferred progressive URL does not consume the entire fallback budget',async()=>{
  const f=fixture({hangPrimary:true});
  const player={_ensureHasURL:async input=>({...input,url:undefined,extra:{audio_streams:[{type:'aac',url:'https://cdn.example.test/primary.aac'},{type:'mp3',url:'https://cdn.example.test/fallback.mp3'}]}})};
  try {await f.transport.load(tuple('https://vk.com/audio_api_unavailable?extra=masked'),player);await f.transport.play();assert.equal(f.transport.read().playing,true);assert.match(f.media.at(-1).src,/fallback\.mp3/);}
  finally {f.transport.destroy();}
});
