import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { File } from 'node:buffer';

const source = await readFile(new URL('../src-tauri/src/vk_upload_adapter.js', import.meta.url), 'utf8');
const id = 'a'.repeat(48);
const bytes = Buffer.from([73, 68, 51, 0, 255, 32, 128, 9, 222, 43]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function makeSite({ rejectUpload = false, failSave = false, missingReadback = false, wrongHost = false, alteredScript = false, metadata = false } = {}) {
  const calls = [], transfers = [];
  let tuple = [501, 42, 'private-media', metadata ? 'Old' : 'Title', metadata ? 'Old artist' : 'Artist', 20];
  const site = { window: null, top: null, vk: { id: 42 }, location: { origin: 'https://vk.ru' }, URL, URLSearchParams, Uint8Array, FormData, File, setTimeout, clearTimeout, setInterval() {}, atob, console };
  site.window = site; site.top = site;
  site.XMLHttpRequest = class {
    constructor() { this.upload = {}; this.status = 200; }
    open(method, url) { this.url = url; }
    send(form) {
      transfers.push(form);
      setTimeout(() => {
        if (rejectUpload) return this.onerror();
        this.responseText = JSON.stringify({ response: 'PRIVATE_SIGNATURE' }); this.onload();
      }, 1);
    }
    abort() { this.onabort?.(); }
  };
  site.ajax = { post(_url, params, callback) {
    calls.push(params);
    setTimeout(() => {
      if (params.act === 'new_audio') {
        const values = [null, {}, `https://${wrongHost ? 'evil.test' : 'pu.vk.ru'}/upload?token=PRIVATE_TOKEN`, { act: 'load_audio', mid: 42, gid: 0, hash: 'PRIVATE_HASH' }, 209715200, {}, 20, 1, '1', 'hash', '', true];
        const script = `AudioUtils.initUpload(box,${values.slice(1).map(value => JSON.stringify(value)).join(',')});${alteredScript ? 'window.malicious=true;' : ''}`;
        return callback.onDone('title', '<div/>', script);
      }
      if (params.act === 'done_add') return failSave ? callback.onFail() : callback.onDone(tuple);
      if (params.act === 'edit_audio_box') return callback.onDone('title', '<input/>', "var id = 501; var query = { act: 'edit_audio', aid: id, oid: 42, hash: 'valid_edit_hash_123', force_edit_hash: '', performer: performer, title: title, genre: genre }; var genreDD={selectedItems: '0'};");
      if (params.act === 'edit_audio') { tuple = [501, 42, 'private-media', params.title, params.performer, 20]; return callback.onDone(tuple); }
      if (params.act === 'load_section') return callback.onDone({ list: missingReadback ? [] : [tuple] });
      throw Error('Unexpected action');
    }, 1);
  } };
  vm.runInNewContext(source, site);
  return { site, api: site.__PULSE_VK_UPLOAD__, calls, transfers };
}

function begin(api, extra = {}) {
  assert.equal(api.start({ id, account: 42, name: 'Artist - Title.mp3', title: 'Title', artist: 'Artist', size: bytes.length, ...extra }).accepted, true);
  assert.equal(api.append(id, 0, bytes.toString('base64')).accepted, true);
  assert.equal(api.commit(id).accepted, true);
}

async function settled(api) {
  for (let i = 0; i < 100; i++) { const state = api.read(id); if (state.status !== 'pending') return state; await sleep(5); }
  throw new Error('Probe did not settle');
}

test('uploads exactly the original bytes and confirms fresh VK library before success', async () => {
  const { api, transfers, calls } = makeSite(); begin(api);
  const state = await settled(api);
  assert.equal(state.status, 'uploaded'); assert.equal(state.trackId, 'vk-42-501');
  assert.deepEqual(Buffer.from(await transfers[0].get('file').arrayBuffer()), bytes);
  assert.deepEqual(calls.map(call => call.act), ['new_audio', 'done_add', 'load_section']);
  assert.equal(/PRIVATE|token|hash|https:/.test(JSON.stringify(state)), false);
});

test('preserves supplied title and artist by the official metadata editor', async () => {
  const { api, calls } = makeSite({ metadata: true }); begin(api);
  assert.equal((await settled(api)).status, 'uploaded');
  const edit = calls.find(call => call.act === 'edit_audio');
  assert.equal(edit.title, 'Title'); assert.equal(edit.performer, 'Artist');
});

test('a server save failure cannot look like a successful local import', async () => {
  const { api } = makeSite({ failSave: true }); begin(api);
  assert.equal((await settled(api)).status, 'uncertain');
});

test('a failed byte transfer does not issue a save request', async () => {
  const { api, calls } = makeSite({ rejectUpload: true }); begin(api);
  assert.equal((await settled(api)).status, 'failed');
  assert.equal(calls.some(call => call.act === 'done_add'), false);
});

test('an unknown upload destination fails before sending file bytes', async () => {
  const { api, transfers } = makeSite({ wrongHost: true }); begin(api);
  assert.equal((await settled(api)).status, 'failed'); assert.equal(transfers.length, 0);
});

test('remote scripts are parsed only as data and never executed', async () => {
  const { api, site } = makeSite({ alteredScript: true }); begin(api);
  assert.equal((await settled(api)).status, 'uploaded'); assert.equal(site.malicious, undefined);
});

test('concurrent uploads and changed account cannot send original bytes', async () => {
  const { api, site, transfers } = makeSite();
  assert.equal(api.start({ id, account:42,name:'x.mp3',size:bytes.length }).accepted,true);
  assert.equal(api.start({ id:'b'.repeat(48),account:42,name:'y.mp3',size:bytes.length }).accepted,false);
  site.vk.id = 99;
  assert.equal(api.append(id,0,bytes.toString('base64')).accepted,false);
  assert.equal(api.commit(id).accepted,false); assert.equal(transfers.length,0);
});

test('missing or reordered chunks prevent transmission', async () => {
  const { api, transfers } = makeSite();
  assert.equal(api.start({id,account:42,name:'x.mp3',size:bytes.length}).accepted,true);
  assert.equal(api.append(id,5,bytes.toString('base64')).accepted,false);
  api.commit(id); assert.equal((await settled(api)).status,'failed'); assert.equal(transfers.length,0);
});
