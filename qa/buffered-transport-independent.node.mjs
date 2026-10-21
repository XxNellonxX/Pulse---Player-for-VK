import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../src-tauri/src/vk_direct_audio.js', import.meta.url), 'utf8');
const settle = async () => { for (let n = 0; n < 10; n++) await new Promise(resolve => setImmediate(resolve)); };
function fixture() {
  let now = 1000;
  const elements = [], calls = [];
  class Audio extends EventTarget {
    constructor() { super(); this.currentTime = 0; this.duration = 600; this.readyState = 0; this.paused = true; this.ended = false; this.networkState = 2; this.src = ''; this.ranges = []; elements.push(this); }
    get buffered() { return { length: this.ranges.length, start: n => this.ranges[n][0], end: n => this.ranges[n][1] }; }
    load() { if (this.src) queueMicrotask(() => { this.readyState = 4; this.dispatchEvent(new Event('loadedmetadata')); this.dispatchEvent(new Event('canplay')); }); }
    play() { this.paused = false; this.dispatchEvent(new Event('playing')); return Promise.resolve(); }
    pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
    removeAttribute() { this.src = ''; }
    canPlayType() { return ''; }
    fail() { this.paused = true; this.dispatchEvent(new Event('error')); }
  }
  const w = { Audio, Event, location: { href: 'https://vk.com/audio' }, vk: { id: 42 }, navigator: { onLine: true } }; w.top = w;
  vm.runInNewContext(source, { window: w, URL, setTimeout, clearTimeout, Date: class extends Date { static now() { return now; } } });
  const player = { _ensureHasURL: async input => { calls.push(input); return { ...input, url: `https://fixture.test/${calls.length}.mp3` }; } };
  const audio = w.__PULSE_CREATE_DIRECT_AUDIO__();
  return { audio, elements, calls, w, player, advance(seconds) { now += seconds * 1000; elements.at(-1).currentTime += seconds; } };
}
async function start(f) { await f.audio.load({ ownerId: 42, id: 1 }, f.player); await f.audio.play(); }

test('real buffered islands and gap-aware seconds remain public metadata without signed URLs', async () => {
  const f = fixture(); try {
    await start(f); const media = f.elements.at(-1); media.ranges = [[0, 20], [60, 90]]; media.currentTime = 10;
    let value = f.audio.read(); assert.deepEqual(Array.from(value.buffered, range => [...range]), [[0, 20], [60, 90]]); assert.equal(value.bufferedAhead, 10); assert.equal(value.network, 'ready');
    f.audio.seek(30); assert.equal(f.audio.read().bufferedAhead, 0, 'A future island was incorrectly counted as immediately playable');
    f.w.navigator.onLine = false; assert.equal(f.audio.read().network, 'offline');
    f.audio.stop(); value = f.audio.read(); assert.equal(value.buffered.length, 0); assert.equal(value.bufferedAhead, 0); assert.equal(value.network, 'idle'); assert.equal(JSON.stringify(value).includes('https:'), false);
  } finally { f.audio.destroy(); }
});

test('healthy playback replenishes renewal attempts instead of exhausting a long track permanently', async () => {
  const f = fixture(); try {
    await start(f);
    for (let failure = 0; failure < 4; failure++) {
      const previous = f.elements.length; f.elements.at(-1).fail(); await settle();
      assert.ok(f.elements.length > previous && f.audio.read().playing, `Unrelated transient failure ${failure + 1} became terminal`);
      for (let second = 0; second < 31; second++) { f.advance(1); f.audio.read(); }
      assert.equal(f.audio.read().error, null);
    }
    assert.equal(f.calls.length, 5);
  } finally { f.audio.destroy(); }
});

test('seeking jumps do not replenish the bounded failure budget', async () => {
  const f = fixture(); try {
    await start(f);
    for (let n = 0; n < 2; n++) { f.elements.at(-1).fail(); await settle(); assert.equal(f.audio.read().error, null); f.audio.seek(100 + n * 100); }
    const calls = f.calls.length; f.elements.at(-1).fail(); await settle();
    assert.equal(f.calls.length, calls, 'Seeking fabricated healthy progress and reopened an infinite retry cycle');
    assert.match(f.audio.read().error, /восстановить/); assert.equal(f.audio.read().playing, false);
  } finally { f.audio.destroy(); }
});

test('artist API sources renew through their session closure without missing website hashes', async () => {
  const f = fixture(); let renewals=0;
  const tuple=[];tuple[0]=5;tuple[1]=42;tuple[2]='https://fixture.test/initial.aac';tuple[12]={audio_streams:[{type:'aac',url:'https://fixture.test/initial.aac'}]};tuple[13]='';
  tuple.__pulseResolveSource=async()=>({owner_id:42,id:5,url:`https://fixture.test/fresh-${++renewals}.aac`,extra:{audio_streams:[{type:'aac',url:`https://fixture.test/fresh-${renewals}.aac`}]}});
  f.player._ensureHasURL=()=>{throw new Error('Artist source must not use the missing website reload hashes');};
  try{
    await f.audio.load(tuple,f.player);await f.audio.play();
    assert.equal(renewals,1);assert.equal(f.elements.at(-1).src,'https://fixture.test/fresh-1.aac');
    f.advance(14);f.audio.read();f.elements.at(-1).fail();await settle();
    assert.equal(renewals,2);assert.equal(f.elements.at(-1).src,'https://fixture.test/fresh-2.aac');
    assert.equal(f.audio.read().position,14);assert.equal(f.audio.read().playing,true);
    assert.equal(JSON.stringify(f.audio.read()).includes('https:'),false);
  }finally{f.audio.destroy();}
});

test('artist source refresh cannot replace the requested identity or survive an account switch', async () => {
  const f=fixture();const raw={ownerId:42,id:5,__pulseResolveSource:async()=>({ownerId:42,id:6,url:'https://fixture.test/wrong.mp3'})};
  try{
    await assert.rejects(f.audio.load(raw,f.player),/другой трек/);assert.equal(f.elements.length,0);
    let complete;raw.__pulseResolveSource=()=>new Promise(resolve=>{complete=resolve;});
    const load=f.audio.load(raw,f.player);f.w.vk.id=99;complete({ownerId:42,id:5,url:'https://fixture.test/old-account.mp3'});
    await assert.rejects(load,error=>error.code==='PULSE_DIRECT_CANCELLED');assert.equal(f.elements.length,0);
  }finally{f.audio.destroy();}
});
