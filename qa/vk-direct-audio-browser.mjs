import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src-tauri/src/vk_direct_audio.js', import.meta.url), 'utf8');
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const wave = Buffer.alloc(44 + 8000 * 3 * 2);
wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVE', 8); wave.write('fmt ', 12); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(wave.length - 44, 40);
try {
  await page.route('https://vk.com/audio', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>Isolated direct audio QA</title>' }));
  await page.route('https://cdn.example.test/qa.wav', route => route.fulfill({ status: 200, contentType: 'audio/wav', body: wave }));
  await page.goto('https://vk.com/audio');
  await page.evaluate(() => {
    window.vk = { id: 101 };
    window.__qaOfficialPlayCalls = 0;
    window.__qaPlayer = {
      _ensureHasURL: async data => ({ ...data, url: 'https://cdn.example.test/qa.wav' }),
      play() { window.__qaOfficialPlayCalls++; throw new Error('Official play must never run.'); },
      ads: { startPlay() { throw new Error('Ad scheduler must never run.'); } },
    };
  });
  await page.addScriptTag({ content: source });
  await page.evaluate(async () => {
    const raw = []; raw[0] = 7; raw[1] = 42; raw[5] = 3;
    window.__qaTransport = window.__PULSE_CREATE_DIRECT_AUDIO__();
    window.__qaTransport.volume(0);
    await window.__qaTransport.load(raw, window.__qaPlayer);
    await window.__qaTransport.play();
  });
  await page.waitForFunction(() => window.__qaTransport.read().position > .3);
  const playing = await page.evaluate(() => window.__qaTransport.read());
  assert.equal(playing.playing, true); assert.ok(playing.duration > 2.9);
  console.log('PASS independent real HTMLAudio advances without official player or ad calls');
  await page.evaluate(() => window.__qaTransport.pause());
  const pausedAt = await page.evaluate(() => window.__qaTransport.read().position);
  await page.waitForTimeout(220);
  const paused = await page.evaluate(() => window.__qaTransport.read());
  assert.equal(paused.playing, false); assert.ok(Math.abs(paused.position - pausedAt) < .08);
  console.log('PASS pause holds actual HTML media position');
  await page.evaluate(async () => { window.__qaTransport.seek(2.65); await window.__qaTransport.play(); });
  await page.waitForFunction(() => window.__qaTransport.read().ended);
  assert.equal(await page.evaluate(() => window.__qaTransport.read().playing), false);
  assert.equal(await page.evaluate(() => window.__qaOfficialPlayCalls), 0);
  console.log('PASS seek and natural end retain direct transport ownership');
  await page.evaluate(() => window.__qaTransport.destroy());
  assert.equal(await page.evaluate(() => window.__qaTransport.read().playing), false);
  assert.deepEqual(errors, []);
  console.log('PASS cleanup has no renderer errors');
} finally { await context.close(); await browser.close(); }
