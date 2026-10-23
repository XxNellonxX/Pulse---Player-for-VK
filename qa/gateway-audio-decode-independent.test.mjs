// Independent decoder regression: actual gateway HTTP/HLS rewriting, generated
// AAC segments and an actual bundled FFmpeg. No provider credentials, external
// network, VK account, user profile or persistent audio library are used.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../services/pulse-gateway/src/gateway.mjs';

const ffmpeg = process.env.PULSE_QA_FFMPEG || path.resolve('src-tauri/resources/import-tools', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const origin = 'https://gateway.example.org';
const grant = 'https://cf-media.sndcdn.com/fixture/stream.m3u8';
const mediaPath = /^\/v1\/media\/[a-f0-9]{48}\/(?:0|[1-9]\d{0,3})$/;
const config = { origin, clientId: 'fixture-client', clientSecret: 'fixture-secret', userAgent: 'PulseIndependentQA/1.0 (qa@example.org)', trustLoopbackProxy: true, maxGlobalConcurrent: 16, maxIpConcurrent: 6, metadataPerMinute: 60, mediaPerMinute: 600, globalPerMinute: 6000 };

async function decoder(args) {
  return await new Promise((resolve, reject) => {
    let stderr = '', progress = '';
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill(), 15000);
    child.stdout.on('data', value => { progress = (progress + value.toString()).slice(-16384); });
    child.stderr.on('data', value => { stderr = (stderr + value.toString()).slice(-16384); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); resolve({ code, stderr, progress }); });
  });
}

test('actual gateway opaque HLS decodes and seeks through the numeric-path QA adapter', { skip: !existsSync(ffmpeg) ? 'Bundled FFmpeg is unavailable; live/provider playback is not verified by this fixture' : false }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pulse-gateway-decoder-'));
  let gateway, adapter;
  const requests = [];
  try {
    const generated = await decoder(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-c:a', 'aac', '-b:a', '128k', '-hls_time', '2', '-hls_list_size', '0', '-hls_segment_filename', path.join(directory, '%d.ts'), path.join(directory, 'stream.m3u8')]);
    assert.equal(generated.code, 0, 'The generated AAC fixture could not be encoded');
    const json = (value, url) => ({ status: 200, bytes: Buffer.from(JSON.stringify(value)), headers: { 'content-type': 'application/json' }, finalUrl: String(url) });
    const transport = { close() {}, async request(value, options) {
      const url = new URL(value); requests.push({ kind: options.kind, pathname: url.pathname });
      if (options.kind === 'token') return json({ access_token: 'fixture-token', expires_in: 3600 }, url);
      if (options.kind === 'api' && url.pathname.endsWith('/streams')) return json({ hls_aac_160_url: grant }, url);
      if (options.kind !== 'media' || url.origin !== 'https://cf-media.sndcdn.com') throw Error('The fixture rejected an unexpected target');
      const file = path.basename(url.pathname);
      if (!/^(?:stream\.m3u8|[0-9]+\.ts)$/.test(file)) throw Error('The fixture rejected an unexpected media path');
      let bytes = await readFile(path.join(directory, file));
      let status = 200;
      const headers = { 'content-type': file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t' };
      if (!file.endsWith('.m3u8') && options.headers.range) {
        const range = /^bytes=(\d+)-(\d*)$/.exec(options.headers.range);
        assert.ok(range, 'The decoder adapter sent an unsupported Range');
        const start = Number(range[1]), end = range[2] ? Number(range[2]) : bytes.length - 1;
        headers['content-range'] = `bytes ${start}-${end}/${bytes.length}`;
        bytes = bytes.subarray(start, end + 1); status = 206;
      }
      return { status, bytes, headers, finalUrl: url.href };
    } };
    gateway = createServer(config, { transport }); gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
    const localGateway = `http://127.0.0.1:${gateway.address().port}`;
    const streams = await fetch(localGateway + '/v1/soundcloud/tracks/123/streams');
    assert.equal(streams.status, 200);
    const manifest = (await streams.json()).hls_aac_160_url;
    assert.equal(new URL(manifest).origin, origin); assert.match(new URL(manifest).pathname, mediaPath);
    let localAdapter;
    adapter = http.createServer(async (request, response) => {
      try {
        if (request.method !== 'GET' || !mediaPath.test(request.url)) throw Error('Invalid fixture adapter path');
        const upstream = await fetch(localGateway + request.url, { headers: request.headers.range ? { range: request.headers.range } : undefined });
        if (![200, 206].includes(upstream.status)) throw Error('Gateway fixture failed');
        let bytes = Buffer.from(await upstream.arrayBuffer());
        const type = upstream.headers.get('content-type');
        if (/mpegurl/.test(type)) {
          const lines = bytes.toString('utf8').split('\n').map(line => {
            if (!line || line.startsWith('#')) return line;
            const url = new URL(line);
            assert.equal(url.origin, origin); assert.match(url.pathname, mediaPath);
            return localAdapter + url.pathname;
          });
          bytes = Buffer.from(lines.join('\n'));
        }
        const headers = { 'content-type': type, 'content-length': bytes.length, 'accept-ranges': 'bytes' };
        if (upstream.headers.has('content-range')) headers['content-range'] = upstream.headers.get('content-range');
        response.writeHead(upstream.status, headers); response.end(bytes);
      } catch { response.writeHead(502, { 'content-length': '0' }); response.end(); }
    });
    adapter.listen(0, '127.0.0.1'); await once(adapter, 'listening'); localAdapter = `http://127.0.0.1:${adapter.address().port}`;
    const input = localAdapter + new URL(manifest).pathname;
    const options = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'http,tcp,crypto,data', '-allowed_extensions', 'ALL'];
    const capabilities = await decoder(['-hide_banner', '-h', 'demuxer=hls']);
    const extensionCheck = /(?:^|\s)-extension_picky\s/.test(capabilities.progress);
    const original = await decoder([...options, '-i', input, '-t', '3', '-f', 'null', '-']);
    if (extensionCheck) {
      assert.notEqual(original.code, 0, 'The fixture no longer reproduces the old opaque-path decoder rejection; review the adapter options');
      assert.match(original.stderr, /extension/i, 'Failure was unrelated to the opaque-path extension heuristic');
    } else {
      assert.equal(original.code, 0, 'This decoder has no extension-name heuristic and must decode the numeric paths normally');
    }
    for (const offset of [0, 4]) {
      const actual = await decoder([...options, ...(extensionCheck ? ['-extension_picky', '0'] : []), '-progress', 'pipe:1', ...(offset ? ['-ss', String(offset)] : []), '-i', input, '-t', '3', '-f', 'null', '-']);
      assert.equal(actual.code, 0, `Generated HLS ${offset ? 'seek' : 'start'} decode failed`);
      assert.equal(actual.stderr, '', 'Generated clean AAC fixture produced decoder errors');
      const decoded = [...actual.progress.matchAll(/^out_time_us=(\d+)$/gm)].map(match => Number(match[1]));
      assert.ok(Math.max(0, ...decoded) >= 2_900_000, 'Decoder did not produce the requested three seconds of audio');
    }
    assert.ok(requests.some(request => request.kind === 'media' && request.pathname.endsWith('.ts')), 'No segment was requested through the actual gateway');
  } finally {
    for (const server of [adapter, gateway]) if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith('pulse-gateway-decoder-'));
    await rm(directory, { recursive: true, force: true });
  }
});
