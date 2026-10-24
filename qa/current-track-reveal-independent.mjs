import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// Clean Edge renders the actual hook, TrackRow and ArtistView. All collections
// are synthetic, provider receipts are fixtures, and no installed profile opens.
const base = process.env.PULSE_QA_URL || 'http://127.0.0.1:5193';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [], errors = [];
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', error => errors.push(error.message));
page.setDefaultTimeout(5000);
const pass = name => { results.push(name); console.log('PASS ' + name); };
const visible = id => page.waitForFunction(id => {
  const row = [...document.querySelectorAll('[data-track-id]')].find(row => row.dataset.trackId === id);
  if (!row) return false;
  const bounds = row.getBoundingClientRect(), container = document.querySelector('.content-scroll').getBoundingClientRect(), hud = document.querySelector('.player-wrap').getBoundingClientRect();
  return bounds.height > 0 && bounds.top >= container.top + 13 && bounds.bottom <= Math.min(container.bottom, hud.top) - 13;
}, id);
const focus = async () => { await page.waitForTimeout(140); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); };
try {
  await page.route(base + '/__current-track-reveal-qa', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div>' }));
  await page.goto(base + '/__current-track-reveal-qa');
  await page.evaluate(async () => {
    const runtime = (await import('/@react-refresh')).default;
    runtime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
    const [react, dom, { useCurrentTrackReveal }, { TrackRow }, { ArtistView }] = await Promise.all([import('/node_modules/.vite/deps/react.js'), import('/node_modules/.vite/deps/react-dom_client.js'), import('/src/useCurrentTrackReveal.ts'), import('/src/TrackRow.tsx'), import('/src/ArtistView.tsx'), import('/src/styles.css')]);
    const React = react.default || react, { createRoot } = dom.default || dom;
    window.__scrolls = [];
    const nativeScrollTo = HTMLElement.prototype.scrollTo;
    HTMLElement.prototype.scrollTo = function (...args) { if (this.matches('.content-scroll')) window.__scrolls.push(args[0]); return nativeScrollTo.apply(this, args); };
    window.__track = index => ({ id: 'reveal-' + index, title: 'Track ' + index, artist: 'Fixture Artist', album: '', duration: 120, source: 'vk', url: '', available: true, addedAt: 1000 - index });
    const all = Array.from({ length: 600 }, (_, index) => window.__track(index));
    const style = document.createElement('style');
    style.textContent = '.content-scroll{position:fixed;left:250px;right:0;top:68px;height:800px;overflow:auto}.player-wrap{position:fixed;left:250px;right:0;bottom:0;height:120px;background:#111}.fixture-heading{height:180px}.page-content{padding-bottom:160px}';
    document.head.appendChild(style);
    const root = createRoot(document.getElementById('root'));
    const empty = () => {};
    function Harness() {
      const [state, setState] = React.useState({ currentId: all[0].id, context: 'library', visible: 120, reduced: false, duplicates: false });
      window.__set = patch => setState(previous => ({ ...previous, ...patch })); window.__snapshot = state;
      const tracks = React.useMemo(() => state.duplicates ? [...all, all[0]] : all, [state.duplicates]);
      const ref = useCurrentTrackReveal({ currentId: state.currentId, tracks, contextKey: state.context, renderedCount: state.visible, ensureRendered: count => setState(previous => ({ ...previous, visible: Math.max(previous.visible, count) })), reducedMotion: state.reduced });
      return React.createElement(React.Fragment, null,
        React.createElement('div', { className: 'content-scroll' }, React.createElement('div', { className: 'page-content' }, React.createElement('div', { className: 'fixture-heading' }), React.createElement('div', { className: 'track-list', role: 'list', ref }, tracks.slice(0, state.visible).map((track, index) => React.createElement(TrackRow, { key: index, track, index, active: track.id === state.currentId, playing: false, onPlay: () => setState(previous => ({ ...previous, currentId: track.id })), onArtist: empty, onInfo: empty, onQueue: empty }))))),
        React.createElement('div', { className: 'player-wrap' }, 'Fixed HUD'));
    }
    window.__root = root; window.__React = React; window.__ArtistView = ArtistView; window.__all = all;
    root.render(React.createElement(Harness));
  });
  await page.locator('.track-row').first().waitFor();
  assert.equal(await page.locator('.track-row').count(), 120);
  await page.evaluate(() => window.__set({ currentId: 'reveal-350', context: 'restored-library' }));
  await focus(); await visible('reveal-350');
  assert.equal(await page.locator('.track-row').count(), 351);
  assert.equal(await page.locator('[data-track-id="reveal-350"]').getAttribute('aria-current'), 'true');
  assert.ok(await page.evaluate(() => window.__scrolls.some(call => call.behavior === 'smooth')));
  assert.equal(await page.evaluate(() => document.scrollingElement.scrollTop), 0);
  pass('returning reveals the active track beyond the 120-row page smoothly above the fixed HUD');

  await page.evaluate(() => { window.__set({ currentId: 'reveal-0', context: 'manual-visible-reset', visible: 120, reduced: true }); document.querySelector('.content-scroll').scrollTo({ top: 0, behavior: 'instant' }); });
  await focus(); await visible('reveal-0');
  await page.locator('[data-track-id="reveal-0"]').dispatchEvent('wheel', { deltaY: 1 });
  await page.waitForTimeout(1600); await page.evaluate(() => window.__set({ currentId: 'reveal-250' })); await visible('reveal-250');
  assert.equal(await page.locator('.track-row').count(), 251);
  pass('following resumes when the previous track is visible and preserves that decision through pagination');
  await page.evaluate(() => window.__set({ currentId: 'reveal-350', reduced: false })); await visible('reveal-350');

  const before = await page.evaluate(() => window.__scrolls.length);
  await focus(); await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.__scrolls.length), before);
  pass('a fully visible active row stays still on focus');

  await page.evaluate(() => window.__set({ currentId: 'reveal-560' })); await visible('reveal-560');
  assert.equal(await page.locator('.track-row').count(), 561);
  pass('an automatic track change reveals a new offscreen row in the same collection');

  await page.evaluate(() => { const scroller = document.querySelector('.content-scroll'); scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -400 })); scroller.scrollTo({ top: 0, behavior: 'instant' }); window.__set({ currentId: 'reveal-430' }); });
  await page.waitForTimeout(250);
  assert.ok(await page.locator('.content-scroll').evaluate(element => element.scrollTop < 100), 'Cancelled smooth scroll must remain at the manually chosen start');
  await page.waitForTimeout(1550); await page.evaluate(() => window.__set({ currentId: 'reveal-431' })); await page.waitForTimeout(250);
  assert.ok(await page.locator('.content-scroll').evaluate(element => element.scrollTop < 100), 'Cancelled smooth scroll must remain at the manually chosen start');
  await focus(); await visible('reveal-431');
  pass('manual browsing is preserved across later song changes until explicitly returning to the window');

  await page.evaluate(() => window.__set({ currentId: 'outside-this-context' }));
  await page.waitForTimeout(100);
  const isolated = await page.evaluate(() => ({ top: document.querySelector('.content-scroll').scrollTop, count: document.querySelectorAll('.track-row').length, url: location.href }));
  await focus(); await page.waitForTimeout(150);
  assert.deepEqual(await page.evaluate(() => ({ top: document.querySelector('.content-scroll').scrollTop, count: document.querySelectorAll('.track-row').length, url: location.href })), isolated);
  await page.evaluate(() => { document.querySelector('.content-scroll').scrollTo({ top: 0, behavior: 'instant' }); window.__set({ currentId: 'reveal-400', context: 'a-different-album' }); });
  await page.waitForTimeout(150); assert.ok(await page.locator('.content-scroll').evaluate(element => element.scrollTop < 100), 'Cancelled smooth scroll must remain at the manually chosen start');
  pass('tracks absent from the open collection and navigation to another album do not hijack route or scroll');

  await page.evaluate(() => { window.__scrolls = []; window.__set({ currentId: 'reveal-590', reduced: true }); });
  await visible('reveal-590');
  assert.ok(await page.evaluate(() => window.__scrolls.some(call => call.behavior === 'auto')));
  await page.evaluate(() => { window.__set({ reduced: false }); document.querySelector('.content-scroll').scrollTo({ top: 0, behavior: 'instant' }); window.__scrolls = []; });
  await page.emulateMedia({ reducedMotion: 'reduce' }); await focus(); await visible('reveal-590');
  assert.ok(await page.evaluate(() => window.__scrolls.some(call => call.behavior === 'auto')));
  pass('both application and OS reduced motion use an immediate reveal');

  await page.evaluate(() => { window.__set({ currentId: 'reveal-0', duplicates: true, visible: 601, context: 'duplicate-import' }); });
  await page.locator('.track-row').nth(600).waitFor();
  await page.evaluate(() => { const scroller = document.querySelector('.content-scroll'), row = [...document.querySelectorAll('[data-track-id="reveal-0"]')].at(-1); scroller.scrollTo({ top: scroller.scrollTop + row.getBoundingClientRect().top - 300, behavior: 'instant' }); window.__scrolls = []; });
  await focus(); await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => window.__scrolls.length), 0);
  pass('an already visible duplicate occurrence does not jump back to the first occurrence');

  await page.evaluate(() => { window.__visibility = 'hidden'; Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.__visibility }); document.dispatchEvent(new Event('visibilitychange')); window.__scrolls = []; window.__set({ currentId: 'reveal-300' }); });
  await page.waitForTimeout(150); assert.equal(await page.evaluate(() => window.__scrolls.filter(call => call.behavior === 'smooth').length), 0, 'No reveal animation is allowed while hidden');
  await page.evaluate(() => { window.__visibility = 'visible'; document.dispatchEvent(new Event('visibilitychange')); }); await visible('reveal-300');
  await page.evaluate(() => { delete document.visibilityState; });
  pass('hidden playback does not scroll and becoming visible reveals the new active row');

  await page.evaluate(() => { const overlay = document.createElement('div'); overlay.id = 'fixture-dialog'; overlay.setAttribute('aria-modal', 'true'); overlay.style.cssText = 'position:fixed;width:100px;height:100px'; document.body.appendChild(overlay); document.querySelector('.content-scroll').scrollTo({ top: 0, behavior: 'instant' }); window.__scrolls = []; });
  await focus(); await page.waitForTimeout(100);
  assert.ok(await page.locator('.content-scroll').evaluate(element => element.scrollTop < 100));
  await page.evaluate(() => document.getElementById('fixture-dialog').remove()); await focus(); await visible('reveal-300');
  pass('returning while a dialog is open leaves the background list in place');

  // Real artist/release component integration, with no network or profile.
  await page.evaluate(() => {
    const React = window.__React, ArtistView = window.__ArtistView;
    window.desktop = { artistMusic: async input => input.action === 'release' ? { release: { id: input.releaseId, title: 'Fixture Album', artist: 'Fixture Artist', kind: 'album', trackCount: 80 }, tracks: window.__all.slice(0, 80), checkedAt: 1 } : { artist: { id: input.artistId, name: 'Fixture Artist', tracks: window.__all.slice(0, 80), releases: [], checkedAt: 1 }, checkedAt: 1 } };
    window.__renderArtist = (action = 'artist', currentId = 'reveal-70') => window.__root.render(React.createElement(React.Fragment, null, React.createElement('div', { className: 'content-scroll' }, React.createElement('div', { className: 'page-content' }, React.createElement(ArtistView, { request: { action, artistId: '123', releaseId: 'album-123' }, connected: true, library: [], currentId, onNavigate() {}, onPlay() {}, onAdd() {}, onSnippet() {}, onConnect() {} }))), React.createElement('div', { className: 'player-wrap' })));
    window.__renderArtist();
  });
  await page.getByRole('heading', { name: 'Fixture Artist', exact: true }).waitFor();
  await focus(); await visible('reveal-70'); assert.equal(await page.locator('.artist-track').count(), 71);
  await page.evaluate(() => window.__renderArtist('release', 'reveal-65'));
  await page.getByRole('heading', { name: 'Fixture Album', exact: true }).waitFor();
  await focus(); await visible('reveal-65'); assert.equal(await page.locator('.artist-track').count(), 66);
  pass('artist and album views reveal current rows beyond their initial 30-row pagination');

  const appPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  appPage.on('pageerror', error => errors.push(error.message));
  await appPage.addInitScript(() => {
    const tracks = Array.from({ length: 600 }, (_, index) => ({ id: 'app-reveal-' + index, title: 'App track ' + index, artist: 'Fixture Artist', album: '', duration: 120, source: 'vk', url: 'vk-web://42/' + index, available: true, addedAt: 1000 - index, remote: { ownerId: 42, audioId: index, inLibrary: true } }));
    localStorage.setItem('pulse-preview', JSON.stringify({ version: 1, tracks, playlists: [{ id: 'fixture-album', title: 'Fixture collection', trackIds: tracks.slice(100, 200).map(track => track.id), createdAt: 1 }], history: [], queue: ['app-reveal-350', 'app-reveal-570'], currentTrackId: 'app-reveal-350', position: 0, settings: { theme: 'dark', palette: 'graphite', style: 'minimal', volume: 0, repeat: 'off', shuffle: false, autoplay: false, autoSkip: false, preferSoundCloud: false } }));
  });
  await appPage.goto(base);
  const appVisible = id => appPage.waitForFunction(id => {
    const row = document.querySelector(`[data-track-id="${id}"]`);
    if (!row) return false;
    const bounds = row.getBoundingClientRect(), container = document.querySelector('.content-scroll').getBoundingClientRect(), hud = document.querySelector('.player-wrap').getBoundingClientRect();
    return bounds.top >= container.top + 13 && bounds.bottom <= hud.top - 13;
  }, id);
  await appVisible('app-reveal-350');
  await appPage.getByRole('button', { name: 'Следующий трек', exact: true }).click(); await appVisible('app-reveal-570');
  await appPage.getByRole('button', { name: 'Fixture collection', exact: false }).click();
  await appPage.getByRole('heading', { name: 'Fixture collection', exact: true }).waitFor();
  const collectionPosition = await appPage.locator('.content-scroll').evaluate(element => element.scrollTop);
  await appPage.evaluate(() => window.dispatchEvent(new Event('focus'))); await appPage.waitForTimeout(150);
  assert.equal(await appPage.getByRole('heading', { name: 'Fixture collection', exact: true }).count(), 1);
  assert.equal(await appPage.locator('.content-scroll').evaluate(element => element.scrollTop), collectionPosition);
  await appPage.getByRole('button', { name: 'Моя музыка', exact: true }).click();
  await appPage.getByRole('heading', { name: 'Моя музыка', exact: true }).waitFor();
  await appPage.waitForTimeout(150); await appPage.evaluate(() => window.dispatchEvent(new Event('focus'))); await appVisible('app-reveal-570');
  await appPage.close();
  pass('the complete App restores and follows deep rows, preserves another playlist, and reveals again on returning to My Music');

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: results.length, results, realProfiles: false, nativeAltTab: false, physicalMac: false }));
} finally { await browser.close(); }
