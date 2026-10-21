import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const results = [];
try {
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:5173');
  await page.evaluate(async () => { await import('/src/shared/audioEqualizer.js'); });
  const report = await page.evaluate(async () => {
    async function render(settings, frequencies = [62, 500, 2000], { disable = false, sampleRate = 48000, transient = false } = {}) {
      const context = new OfflineAudioContext(1, sampleRate, sampleRate);
      const buffer = context.createBuffer(1, sampleRate, sampleRate), input = buffer.getChannelData(0);
      for (let sample = 0; sample < input.length; sample++) {
        input[sample] = transient ? (sample % 499 === 0 ? (sample % 998 === 0 ? .99 : -.99) : 0) : frequencies.reduce((sum, frequency) => sum + Math.sin(sample / sampleRate * 2 * Math.PI * frequency), 0) * .12;
      }
      const source = context.createBufferSource(); source.buffer = buffer;
      let sources = 0, filters = 0, disconnected = 0, closed = 0;
      const shim = {
        sampleRate, currentTime: 0, state: 'running', destination: context.destination,
        createBiquadFilter() { filters++; return context.createBiquadFilter(); },
        createGain: () => context.createGain(), createDynamicsCompressor: () => context.createDynamicsCompressor(),
        createMediaElementSource() { sources++; return source; },
        close() { closed++; return Promise.resolve(); },
      };
      const factory = function () { return shim; };
      const graph = window.__PULSE_CREATE_EQUALIZER__({}, { AudioContext: factory });
      graph.apply(settings);
      if (disable) graph.apply({ ...settings, enabled: false });
      source.start();
      const output = (await context.startRendering()).getChannelData(0);
      const amplitudes = frequencies.map(frequency => {
        let real = 0, imaginary = 0, count = 0;
        for (let sample = Math.floor(sampleRate * .35); sample < Math.floor(sampleRate * .95); sample++) { const angle = sample / sampleRate * 2 * Math.PI * frequency; real += output[sample] * Math.cos(angle); imaginary += output[sample] * Math.sin(angle); count++; }
        return Math.hypot(real, imaginary) * 2 / count;
      });
      const peak = Math.max(...output.map(Math.abs));
      graph.destroy(); graph.destroy();
      return { amplitudes, peak, sources, filters, closed, active: graph.active, connected: graph.connected };
    }
    const flat = { enabled: true, bands: Array(10).fill(0), preamp: 0 };
    const neutral = await render(flat);
    const rap = await render({ enabled: true, bands: [4, 4, 2, -1, -2, 1, 3, 3, 2, 1], preamp: 0 });
    const disabled = await render({ enabled: true, bands: Array(10).fill(12), preamp: -12 }, [62, 500, 2000], { disable: true });
    const attenuation = await render({ ...flat, preamp: -6 });
    const worst = await render({ enabled: true, bands: Array(10).fill(12), preamp: 0 }, [31, 62, 125, 250, 500, 1000, 2000], { transient: true });
    const lowRate = await render({ enabled: true, bands: Array(10).fill(12), preamp: 0 }, [62, 500, 2000], { sampleRate: 8000 });
    // Invalid values and updates are applied to one graph, not rebuilt for every slider movement.
    let contexts = 0, sourceCount = 0, closeCount = 0; const nodes = [];
    const param = () => ({ value: 0, target: null, cancelScheduledValues() {}, setValueAtTime(v) { this.value = v; }, setTargetAtTime(v) { this.target = v; this.value = v; } });
    const node = () => { const value = { gain: param(), frequency: param(), Q: param(), threshold: param(), ratio: param(), knee: param(), attack: param(), release: param(), connect() {}, disconnect() { this.disconnected = true; }, getFrequencyResponse(f, m, p) { m.fill(1); p.fill(0); } }; nodes.push(value); return value; };
    const fake = function () { contexts++; return { sampleRate: 48000, currentTime: 5, state: 'running', destination: {}, createBiquadFilter: node, createGain: node, createDynamicsCompressor: node, createMediaElementSource() { sourceCount++; return node(); }, close() { closeCount++; return Promise.resolve(); } }; };
    const graph = window.__PULSE_CREATE_EQUALIZER__({}, { AudioContext: fake });
    graph.apply({ enabled: false }); const lazyContexts = contexts;
    for (let index = 0; index < 100; index++) graph.apply({ enabled: true, bands: Array(10).fill(index % 13), preamp: -index % 12 });
    graph.apply({ enabled: true, bands: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], preamp: -2 });
    const targets = nodes.slice(0, 10).map(node => node.gain.target);
    graph.destroy(); graph.destroy(); const closedOnce = closeCount;
    graph.apply({ enabled: true, bands: Array(10).fill(0) });
    return { neutral, rap, disabled, attenuation, worst, lowRate, lifecycle: { contexts, sourceCount, lazyContexts, targets, closedOnce, noRecreationAfterDestroy: contexts === 1, disconnected: nodes.every(node => node.disconnected) } };
  });
  results.push({ report });
  for (const number of report.neutral.amplitudes) assert.ok(Math.abs(number - .12) < .001, `neutral tone amplitude ${number}`);
  for (const number of report.disabled.amplitudes) assert.ok(Math.abs(number - .12) < .001, `disabled EQ altered tone amplitude ${number}`);
  assert.ok(report.rap.amplitudes[0] / report.rap.amplitudes[1] > 1.6, 'Rap must lift bass relative to low-mid');
  assert.ok(report.rap.amplitudes[2] / report.rap.amplitudes[1] > 1.5, 'Rap must lift presence relative to low-mid');
  for (let index = 0; index < 3; index++) assert.ok(Math.abs(report.attenuation.amplitudes[index] / report.neutral.amplitudes[index] - 10 ** (-6 / 20)) < .005, '-6dB preamp not applied');
  assert.ok(report.worst.peak <= 1.005, `full-scale transient clipped: ${report.worst.peak}`);
  assert.ok(report.lowRate.amplitudes.every(Number.isFinite) && report.lowRate.peak <= 1.005);
  assert.equal(report.lifecycle.lazyContexts, 0); assert.equal(report.lifecycle.contexts, 1); assert.equal(report.lifecycle.sourceCount, 1); assert.equal(report.lifecycle.closedOnce, 1); assert.equal(report.lifecycle.noRecreationAfterDestroy, true); assert.equal(report.lifecycle.disconnected, true); assert.deepEqual(report.lifecycle.targets, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  for (const item of [report.neutral, report.rap, report.disabled, report.worst]) { assert.equal(item.sources, 1); assert.equal(item.filters, 10); assert.equal(item.closed, 1); assert.equal(item.active, false); assert.equal(item.connected, false); }
  results.push({ pass: true, report });
  console.log('PASS independent real OfflineAudioContext PCM: neutral/bypass, rap spectral shape, -6dB preamp, +12dB transient safety, 8kHz source, latest-wins/lazy lifecycle');
} finally {
  await writeFile(new URL('./equalizer-dsp-independent-results.json', import.meta.url), JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2) + '\n');
  await browser.close();
}
