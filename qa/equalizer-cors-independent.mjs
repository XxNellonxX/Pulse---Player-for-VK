import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

// Synthetic origins and generated PCM only. The VK account is never opened.
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
const dsp=await readFile(new URL('../src/shared/audioEqualizer.js',import.meta.url),'utf8');
const direct=await readFile(new URL('../src-tauri/src/vk_direct_audio.js',import.meta.url),'utf8');
const sampleRate=48000,duration=8,wave=Buffer.alloc(44+sampleRate*duration*2);
wave.write('RIFF');wave.writeUInt32LE(wave.length-8,4);wave.write('WAVE',8);wave.write('fmt ',12);wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);wave.writeUInt32LE(sampleRate,24);wave.writeUInt32LE(sampleRate*2,28);wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(wave.length-44,40);
for(let n=0;n<sampleRate*duration;n++)wave.writeInt16LE(Math.round(Math.sin(n/sampleRate*2*Math.PI*440)*4000),44+n*2);
const results=[];
async function run(name,{cors,enabled=true,late=false}) {
 const page=await browser.newPage(),requests=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
 page.on('request',r=>{if(r.url().endsWith('.wav'))requests.push({headers:r.headers()});});
 await page.route('https://vk.com/audio',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><title>Independent EQ CORS</title>'}));
 await page.route('https://cdn.example.test/fixture.wav',r=>{
  // Browser request interception does not consistently enforce missing CORS
  // response headers. Deny the dedicated fetch probe explicitly; ordinary
  // native media remains accessible, exercising the actual fail-open branch.
  if(!cors&&r.request().headers().range==='bytes=0-0')return r.abort('blockedbyresponse');
  return r.fulfill({contentType:'audio/wav',body:wave,headers:{'Access-Control-Allow-Origin':'*'}});
 });
 await page.goto('https://vk.com/audio');await page.addScriptTag({content:dsp});await page.addScriptTag({content:direct});
 try {
  await page.evaluate(async ({enabled,late,mediaUrl})=>{
   window.vk={id:101};window.__sources=0;window.__media=[];window.__events=[];window.__pcm=[];
   const NativeAudio=window.Audio;window.Audio=function(){const media=new NativeAudio();window.__media.push(media);for(const type of ['playing','pause','error','waiting','stalled'])media.addEventListener(type,()=>window.__events.push({type,at:performance.now(),position:media.currentTime}));return media;};
   const context=window.__context=new AudioContext({sampleRate:48000});
   await context.audioWorklet.addModule(URL.createObjectURL(new Blob([`class Meter extends AudioWorkletProcessor{constructor(){super();this.n=0;this.sum=0;this.max=0;this.zeros=0;this.maxZero=0;this.started=false;}process(inputs,outputs){const data=inputs[0]?.[0];for(let n=0;n<(data?.length||128);n++){const v=data?.[n]||0;if(Math.abs(v)>.00001)this.started=true;if(!this.started)continue;this.n++;this.sum+=v*v;if(Math.abs(v)<.000001){this.zeros++;this.maxZero=Math.max(this.maxZero,this.zeros);}else this.zeros=0;this.max=Math.max(this.max,Math.abs(v));}if(this.n>=4800){this.port.postMessage({rms:Math.sqrt(this.sum/this.n),peak:this.max,maxSilenceMs:this.maxZero/sampleRate*1000});this.n=0;this.sum=0;this.max=0;this.maxZero=0;}return true;}}registerProcessor('meter',Meter);`],{type:'application/javascript'})));
   const meter=window.__meter=new AudioWorkletNode(context,'meter');meter.port.onmessage=e=>window.__pcm.push(e.data);meter.connect(context.destination);
   const base=window.__PULSE_CREATE_EQUALIZER__;
   const shim=function(){return new Proxy(context,{get(target,key){if(key==='destination')return meter;if(key==='createMediaElementSource')return media=>{window.__sources++;return target.createMediaElementSource(media)};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}})};
   Object.defineProperty(window,'__PULSE_CREATE_EQUALIZER__',{configurable:true,value:media=>base(media,{AudioContext:shim})});
   window.__transport=window.__PULSE_CREATE_DIRECT_AUDIO__();window.__transport.volume(.5);
   const eq={enabled:enabled&&!late,bands:Array(10).fill(0),preamp:0};await window.__transport.equalizer(eq);
   const raw=[];raw[0]=7;raw[1]=101;raw[2]=mediaUrl;raw[5]=8;raw[12]={};
   await window.__transport.load(raw,{});await window.__transport.play();
   if(late)await window.__transport.equalizer({...eq,enabled:true});
   window.__poll=setInterval(()=>window.__transport.read(),100);
  },{enabled,late,mediaUrl:'https://cdn.example.test/fixture.wav'});
  await page.waitForFunction(()=>window.__transport.read().position>.6,null,{timeout:10000});
  if(cors&&!late&&enabled)await page.waitForFunction(()=>window.__pcm.length>=3);
  const report=await page.evaluate(()=>({state:window.__transport.read(),sources:window.__sources,pcm:window.__pcm,media:window.__media.map(m=>({position:m.currentTime,paused:m.paused,crossOrigin:m.crossOrigin})),events:window.__events}));
  assert.equal(report.state.playing,true);assert.ok(report.state.position>.5);assert.deepEqual(errors,[]);
  if(cors&&!late&&enabled){assert.equal(report.sources,1);assert.equal(report.state.equalizerEnabled,true);assert.ok(report.pcm.some(p=>p.rms>.02));assert.ok(Math.max(...report.pcm.map(p=>p.maxSilenceMs))<10);assert.equal(report.media[0].crossOrigin,'anonymous');}
  else{assert.equal(report.sources,0);assert.equal(report.state.equalizerEnabled,false);if(enabled)assert.match(report.state.equalizerError,/недоступен/);}
  results.push({name,pass:true,requests:requests.length,...report});console.log(`PASS ${name}`);
 }catch(e){results.push({name,pass:false,error:e.stack,requests,diagnostics:await page.evaluate(()=>({state:window.__transport?.read(),sources:window.__sources,pcm:window.__pcm,contextState:window.__context?.state})).catch(()=>null)});console.error(`FAIL ${name}: ${e.stack}`);}
 finally{await page.evaluate(()=>{window.__transport?.destroy();window.__context?.close().catch(()=>{});}).catch(()=>{});await page.close();}
}
try{
 await run('readable-cross-origin-source-has-nonzero-post-eq-pcm',{cors:true});
 await run('denied-readability-probe-keeps-native-audio-and-shows-eq-unavailable',{cors:false});
 await run('disabled-eq-does-not-capture-or-probe-media',{cors:false,enabled:false});
 await run('late-enable-does-not-silence-an-already-tainted-element',{cors:false,late:true});
}finally{await writeFile(new URL('./equalizer-cors-independent-results.json',import.meta.url),JSON.stringify({checkedAt:new Date().toISOString(),results},null,2)+'\n');await browser.close();}
process.exitCode=results.some(r=>!r.pass)?1:0;
