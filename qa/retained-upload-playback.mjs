import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// Exercise the public hook with synthetic native receipts and media. No real
// account, uploads, sound, or library mutations are involved.
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const results = [];
const owned = 'vk-42-7', remote = 'vk-42-8';
async function run(name, action, options = {}) {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.route('http://127.0.0.1:5173/__owned-upload-qa', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div></body></html>' }));
    await page.goto('http://127.0.0.1:5173/__owned-upload-qa');
    await page.evaluate(async () => { const runtime = (await import('/@react-refresh')).default; runtime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true; });
    await page.evaluate(async options => {
      const owned = 'vk-42-7';
      window.__audio = []; window.__controls = []; window.__resolves = []; window.__listeners = new Set(); window.__gates = []; window.__hold = options.hold === true; window.__eq = []; window.__actions = {};
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => options.offline !== true });
      Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: { metadata: null, setActionHandler(name, callback) { window.__actions[name] = callback; } } });
      window.Audio = class extends EventTarget {
        constructor() { super(); Object.assign(this, { paused: true, error: null, currentTime: 0, duration: 300, readyState: 0, networkState: 1, buffered: { length: 1, start: () => 0, end: () => 300 }, src: '', volume: 0 }); window.__audio.push(this); }
        load() { if (!this.src) return; this.readyState = 4; queueMicrotask(() => { if (options.failCopy) { this.error = { code: 4 }; this.dispatchEvent(new Event('error')); } else { this.dispatchEvent(new Event('loadedmetadata')); this.dispatchEvent(new Event('canplay')); } }); }
        play() { this.paused = false; this.dispatchEvent(new Event('playing')); return Promise.resolve(); }
        pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
        removeAttribute(name) { if (name === 'src') this.src = ''; }
        getAttribute(name) { return name === 'src' ? this.src : null; }
      };
      const track = id => ({ id, title: id, artist: 'QA', album: '', duration: 300, url: `vk-web://42/${id.endsWith('7') ? 7 : 8}`, source: 'vk', addedAt: 1, available: true, remote: { ownerId: 42, audioId: id.endsWith('7') ? 7 : 8, inLibrary: true } });
      window.desktop = {
        async resolveVkTrack(id) { window.__resolves.push(id); if (id === owned && window.__hold) await new Promise(resolve => window.__gates.push(resolve)); const value = track(id); return id === owned && !options.missing ? { ...value, source: 'local', url: 'http://asset.localhost/verified-owned.mp3' } : value; },
        async vkWebControl(command) { window.__controls.push(command); return { accepted: true }; },
        onVkPlayback(callback) { window.__listeners.add(callback); return () => window.__listeners.delete(callback); },
      };
      window.__emit = patch => { const status = { id: owned, requestedId: owned, playing: true, buffering: false, position: 0, duration: 300, ended: false, buffered: [[0, 60]], network: 'ready', ...patch }; for (const listener of window.__listeners) listener(status); };
      const [react, reactDom, { usePlayback }, eq] = await Promise.all([import('/node_modules/.vite/deps/react.js'), import('/node_modules/.vite/deps/react-dom_client.js'), import('/src/usePlayback.ts'), import('/src/shared/equalizer.ts')]);
      Object.defineProperty(globalThis, '__PULSE_CREATE_EQUALIZER__', { configurable: true, value: () => ({ active: true, connected: true, prepare: async () => {}, resume: async () => {}, destroy() {}, apply: value => window.__eq.push(structuredClone(value)) }) });
      const { createElement, useState } = react.default || react, { createRoot } = reactDom.default || reactDom;
      const initial = { version: 1, tracks: [track(owned), track('vk-42-8')], playlists: [], history: [], queue: [owned, 'vk-42-8'], currentTrackId: options.current || null, position: options.position || 0, settings: { theme: 'dark', style: 'minimal', accent: '#bdff62', density: 'comfortable', textScale: 1, reducedMotion: false, volume: .4, repeat: 'all', shuffle: false, closeToTray: false, autoplay: options.autoplay || false, autoSkip: true, equalizer: eq.normalizeEqualizer(undefined) } };
      function Harness() { const [state, setState] = useState(initial); window.__state = state; window.__setState = setState; window.__playback = usePlayback(state, setState); return createElement('span', null, state.currentTrackId || 'empty'); }
      createRoot(document.getElementById('root')).render(createElement(Harness));
    }, options);
    await page.waitForFunction(() => window.__playback);
    await action(page);
    assert.deepEqual(errors, []); results.push(name); console.log(`PASS ${name}`);
  } catch (error) {
    console.error(name, errors, await page.evaluate(() => ({ controls: window.__controls, state: window.__state, eq: window.__eq, audio: window.__audio.map(a => ({ src: a.src, volume: a.volume, time: a.currentTime, paused: a.paused })), playback: { error: window.__playback.error, eq: window.__playback.equalizerError, playing: window.__playback.playing } })));
    throw error;
  } finally { await page.close(); }
}
const startOwned = async page => { await page.evaluate(() => window.__playback.playTrack('vk-42-7')); await page.waitForFunction(() => window.__audio.at(-1)?.paused === false); };
try {
  await run('confirmed upload plays locally while offline and preserves VK identity', async page => {
    await startOwned(page);
    const result = await page.evaluate(() => ({ controls: window.__controls, source: window.__state.tracks[0].source, url: window.__state.tracks[0].url, id: window.__state.currentTrackId, network: window.__playback.network, src: window.__audio.at(-1).src }));
    assert.deepEqual(result, { controls: [], source: 'vk', url: 'vk-web://42/7', id: owned, network: 'ready', src: 'http://asset.localhost/verified-owned.mp3' });
  }, { offline: true });

  await run('local upload routes pause, resume, seek, volume, EQ and snippet controls locally', async page => {
    await startOwned(page);
    await page.evaluate(() => window.__playback.toggle());
    assert.equal(await page.evaluate(() => window.__audio.at(-1).paused), true);
    await page.evaluate(() => window.__playback.toggle());
    await page.waitForFunction(() => !window.__audio.at(-1).paused);
    await page.evaluate(() => { window.__playback.seek(81); window.__setState(previous => ({ ...previous, settings: { ...previous.settings, volume: .72, equalizer: { ...previous.settings.equalizer, enabled: true } } })); });
    await page.waitForFunction(() => window.__audio.at(-1).volume === .72 && window.__eq.length > 0);
    assert.equal(await page.evaluate(() => window.__audio.at(-1).currentTime), 81);
    await page.evaluate(() => window.__playback.playSnippet('vk-42-7', 20, 30));
    await page.waitForFunction(() => window.__audio.at(-1).currentTime === 20 && !window.__audio.at(-1).paused);
    await page.evaluate(() => { const a = window.__audio.at(-1); a.currentTime = 30; a.dispatchEvent(new Event('timeupdate')); });
    await page.waitForFunction(() => window.__playback.snippet === null && window.__audio.at(-1).paused);
    assert.equal(await page.evaluate(() => window.__state.currentTrackId), owned);
    assert.deepEqual(await page.evaluate(() => window.__controls), []);
  });

  await run('stale VK events cannot replace local timing, network, EQ or playback state', async page => {
    await startOwned(page);
    await page.evaluate(() => { const a = window.__audio.at(-1); a.currentTime = 44; a.dispatchEvent(new Event('timeupdate')); window.__emit({ position: 190, error: 'stale VK failure', network: 'error', equalizerError: 'stale EQ failure' }); });
    assert.deepEqual(await page.evaluate(() => ({ position: window.__playback.position, network: window.__playback.network, error: window.__playback.error, eq: window.__playback.equalizerError, playing: window.__playback.playing })), { position: 44, network: 'ready', error: '', eq: '', playing: true });
  });

  await run('owned to VK to owned transition stops only the actual VK transport', async page => {
    await startOwned(page);
    await page.evaluate(() => window.__playback.playTrack('vk-42-8'));
    await page.waitForFunction(() => window.__controls.some(c => c.operation === 'play' && c.id === 'vk-42-8'));
    await page.evaluate(() => window.__emit({ id: 'vk-42-8', position: 7 }));
    await page.evaluate(() => window.__playback.playTrack('vk-42-7'));
    await page.waitForFunction(() => window.__audio.at(-1)?.paused === false);
    assert.equal(await page.evaluate(() => window.__controls.filter(c => c.operation === 'stop').length), 1);
    assert.equal(await page.evaluate(() => window.__controls.filter(c => c.operation === 'play').length), 1);
    assert.equal(await page.evaluate(() => window.__state.currentTrackId), owned);
  });

  await run('a delayed native local receipt cannot start a previously selected track', async page => {
    await page.evaluate(() => window.__playback.playTrack('vk-42-7'));
    await page.waitForFunction(() => window.__gates.length === 1);
    await page.evaluate(() => window.__playback.playTrack('vk-42-8'));
    await page.waitForFunction(() => window.__controls.some(c => c.operation === 'play'));
    await page.evaluate(() => { window.__hold = false; window.__gates.shift()(); });
    await page.waitForTimeout(40);
    assert.equal(await page.evaluate(() => window.__state.currentTrackId), remote);
    assert.equal(await page.evaluate(() => window.__audio.some(a => a.src.includes('verified-owned'))), false);
    assert.equal(await page.evaluate(() => window.__controls.some(c => c.operation === 'play' && c.id === 'vk-42-7')), false);
  }, { hold: true });

  for (const mediaAction of [false, true]) await run(`${mediaAction ? 'media session' : 'UI'} pause during pending source cannot resurrect playback`, async page => {
    await page.evaluate(() => window.__playback.playTrack('vk-42-7'));
    await page.waitForFunction(() => window.__gates.length === 1);
    await page.evaluate(mediaAction => { window.__emit({ error: 'previous VK source', position: 45 }); if (mediaAction) window.__actions.pause(); else window.__playback.toggle(); window.__hold = false; window.__gates.shift()(); }, mediaAction);
    await page.waitForTimeout(40);
    assert.equal(await page.evaluate(() => window.__audio.some(a => !a.paused)), false);
    assert.deepEqual(await page.evaluate(() => window.__controls), []);
    await page.evaluate(() => window.__playback.toggle());
    await page.waitForFunction(() => window.__audio.at(-1)?.paused === false);
    assert.equal(await page.evaluate(() => window.__playback.error), '');
  }, { hold: true });

  await run('unreadable local source retries the exact VK item once without auto-skip', async page => {
    await page.evaluate(() => window.__playback.playTrack('vk-42-7'));
    await page.waitForFunction(() => window.__controls.some(c => c.operation === 'play'));
    assert.equal(await page.evaluate(() => window.__state.currentTrackId), owned);
    assert.deepEqual(await page.evaluate(() => window.__resolves), [owned]);
    assert.deepEqual(await page.evaluate(() => window.__controls.filter(c => c.operation === 'play').map(c => c.id)), [owned]);
  }, { failCopy: true });

  await run('missing verified source uses ordinary VK playback', async page => {
    await page.evaluate(() => window.__playback.playTrack('vk-42-7'));
    await page.waitForFunction(() => window.__controls.some(c => c.operation === 'play'));
    assert.equal(await page.evaluate(() => window.__audio.some(a => a.src)), false);
    assert.deepEqual(await page.evaluate(() => window.__controls.filter(c => c.operation === 'play').map(c => c.id)), [owned]);
  }, { missing: true });

  await run('owned upload resumes saved position and repeats without VK control', async page => {
    await page.waitForFunction(() => window.__audio.at(-1)?.paused === false);
    assert.equal(await page.evaluate(() => window.__audio.at(-1).currentTime), 63);
    await page.evaluate(() => window.__setState(previous => ({ ...previous, settings: { ...previous.settings, repeat: 'one' } })));
    await page.waitForFunction(() => window.__state.settings.repeat === 'one');
    await page.evaluate(() => { const a = window.__audio.at(-1); a.currentTime = 300; a.dispatchEvent(new Event('ended')); });
    await page.waitForFunction(() => window.__audio.at(-1).currentTime === 0 && !window.__audio.at(-1).paused);
    assert.equal(await page.evaluate(() => window.__state.currentTrackId), owned);
    assert.deepEqual(await page.evaluate(() => window.__controls), []);
  }, { current: owned, position: 63, autoplay: true });

  console.log(`Retained upload playback QA: ${results.length} passed`);
} finally { await browser.close(); }
