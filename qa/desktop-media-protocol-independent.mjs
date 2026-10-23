import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

// Actual desktop.ts -> actual Tauri core.js invoke/converter -> fake Rust IPC.
// No native profile, provider grants, media network or credentials are accessed.
const base=process.env.PULSE_QA_URL||'http://127.0.0.1:5191';
const token='0123456789abcdef'.repeat(3), other='fedcba9876543210'.repeat(3);
let coreScript;
try {coreScript=await readFile(new URL('./fixtures/tauri-2.12.4-core.js',import.meta.url),'utf8');}
catch {
  const registry=path.join(process.env.CARGO_HOME||path.join(os.homedir(),'.cargo'),'registry','src');
  for(const entry of await readdir(registry)){try{coreScript=await readFile(path.join(registry,entry,'tauri-2.12.4','scripts','core.js'),'utf8');break;}catch{}}
}
assert.ok(coreScript?.includes('const path = encodeURIComponent(filePath)'),'Exact Tauri2.12.4 core.js fixture unavailable');
assert.equal(createHash('sha256').update(coreScript).digest('hex'),'71056442a732cca1f03572ccae96d68e16104c3a591c64de9618cd304e063070','Tauri core fixture differs from the unmodified2.12.4 crate script');
const browser=await chromium.launch({channel:'msedge',headless:true});
const results=[];
async function run(platform,scheme){
  const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  try{
    const core=coreScript.replace('__TEMPLATE_os_name__',JSON.stringify(platform)).replace('__TEMPLATE_protocol_scheme__',JSON.stringify(scheme));
    await page.addInitScript({content:`window.isTauri=true;window.__calls=[];window.__sessions=new Set(${JSON.stringify([token,other])});window.__prepared=${JSON.stringify({path:token+'/0',title:'breath',sourceId:'2408295021',explicit:true})};window.__TAURI_INTERNALS__={ipc(action){window.__calls.push({command:action.cmd,args:structuredClone(action.payload)});let result;if(action.cmd==='resolve_soundcloud')result=structuredClone(window.__prepared);if(action.cmd==='release_soundcloud'){if(action.payload.sessionId===null)window.__sessions.clear();else window.__sessions.delete(action.payload.sessionId);}queueMicrotask(()=>window.__TAURI_INTERNALS__.runCallback(action.callback,result));}};${core}`});
    await page.route(base+'/__desktop-media-protocol-qa',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><script type="module">import "/src/desktop.ts";window.__bridgeReady=true;</script>'}));
    await page.goto(base+'/__desktop-media-protocol-qa');await page.waitForFunction(()=>window.__bridgeReady&&window.desktop);
    const expected=platform==='windows'?`${scheme}://pulse-media.localhost/${token}/0`:`pulse-media://localhost/${token}/0`;
    const resolution=await page.evaluate(async()=>({converted:window.__TAURI_INTERNALS__.convertFileSrc(window.__prepared.path,'pulse-media'),source:await window.desktop.resolveSoundCloud('vk-101-7'),calls:window.__calls}));
    // Negative control: the real framework encodes the slash. Replacing this
    // converter with an identity function would hide the original regression.
    assert.match(new URL(resolution.converted).pathname,/%2F0$/u);
    assert.notEqual(new URL(resolution.converted).pathname.split('/').filter(Boolean)[0],token,'Negative control did not reproduce the old release-session mismatch');
    assert.equal(resolution.source.url,expected);assert.equal(new URL(resolution.source.url).pathname,`/${token}/0`);assert.equal(resolution.source.sourceId,'2408295021');assert.equal(resolution.source.explicit,true);
    assert.deepEqual(resolution.calls,[{command:'resolve_soundcloud',args:{trackId:'vk-101-7'}}]);
    results.push({platform,scheme,case:'literal native protocol resource path',ok:true});

    const released=await page.evaluate(async source=>{await window.desktop.releaseSoundCloud(source);return{calls:window.__calls,sessions:[...window.__sessions],callbacks:window.__TAURI_INTERNALS__.callbacks.size};},resolution.source.url);
    assert.deepEqual(released.calls.at(-1),{command:'release_soundcloud',args:{sessionId:token}});assert.deepEqual(released.sessions,[other]);assert.equal(released.callbacks,0);
    results.push({platform,scheme,case:'release only the exact resource capability',ok:true});

    const prefix=platform==='windows'?`${scheme}://pulse-media.localhost`:'pulse-media://localhost';
    const malformed=[
      '',null,42,'relative/path',`https://example.test/${token}/0`,`http://asset.localhost/${token}/0`,`pulse-media://evil.example/${token}/0`,
      `${prefix}/${token}%2F0`,`${prefix}/${token}/0/extra`,`${prefix}/${token}/-1`,`${prefix}/${token}/0?anything=1`,`${prefix}/${token}/0#fragment`,
      `${prefix}/${token.slice(1)}/0`,`${prefix}/${token.toUpperCase()}/0`,`${prefix}:8080/${token}/0`,`${prefix.replace('://','://user:pass@')}/${token}/0`,
    ];
    const invalid=await page.evaluate(async malformed=>{window.__calls=[];const outcomes=[];for(const value of malformed){try{await window.desktop.releaseSoundCloud(value);outcomes.push({rejected:false});}catch{outcomes.push({rejected:true});}}return{outcomes,calls:window.__calls,sessions:[...window.__sessions]};},malformed);
    assert.ok(invalid.outcomes.every(result=>result.rejected),'invalid supplied resource URL was accepted');assert.deepEqual(invalid.calls,[],'malformed/foreign source reached native release');assert.deepEqual(invalid.sessions,[other]);
    results.push({platform,scheme,case:'malformed and foreign URLs cannot release any private source',ok:true,count:malformed.length});

    const malformedPaths=['',token,token+'%2F0',token+'/1','/'+token+'/0',token+'/0/other',other.toUpperCase()+'/0','../'+token+'/0'];
    const badPrepared=await page.evaluate(async paths=>{window.__calls=[];const outcomes=[];for(const value of paths){window.__prepared.path=value;try{await window.desktop.resolveSoundCloud('vk-101-7');outcomes.push({rejected:false});}catch{outcomes.push({rejected:true});}}return{outcomes,calls:window.__calls};},malformedPaths);
    assert.ok(badPrepared.outcomes.every(result=>result.rejected),'invalid prepared source path became a media URL');assert.ok(badPrepared.calls.every(call=>call.command==='resolve_soundcloud'),'invalid source resolution triggered unrelated native commands');
    results.push({platform,scheme,case:'malformed Prepared paths never become playable media URLs',ok:true,count:malformedPaths.length});

    const all=await page.evaluate(async()=>{window.__calls=[];await window.desktop.releaseSoundCloud();return{calls:window.__calls,sessions:[...window.__sessions]};});
    assert.deepEqual(all.calls,[{command:'release_soundcloud',args:{sessionId:null}}]);assert.deepEqual(all.sessions,[]);assert.deepEqual(errors,[]);
    results.push({platform,scheme,case:'only an explicit no-argument clear requests all sessions',ok:true});
    console.log(`PASS ${platform}/${scheme}: actual Tauri converter, desktop resolve/release,16 invalid URLs,8 invalid Prepared paths`);
  }catch(error){results.push({platform,scheme,ok:false,error:error.message});console.log(JSON.stringify(results.at(-1)));process.exitCode=1;}
  finally{await page.close();}
}
try{await run('windows','http');await run('windows','https');await run('macos','http');console.log(JSON.stringify({summary:results,scope:'Actual framework core.js and desktop bridge on Edge with fake Rust IPC. No physical Windows/macOS custom-protocol or live audio verification.'}));}
finally{await browser.close();}
