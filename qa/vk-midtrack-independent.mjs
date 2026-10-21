import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// An independent frontend regression: bridge event flags can be stale while
// actual audio position advances. This reproduces a mid-song false timeout.
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const baseURL = process.env.QA_BASE_URL || 'http://127.0.0.1:5173';
const track = { id: 'vk-101-1', title: 'Midtrack independent', artist: 'QA', album: '', duration: 108, url: 'vk-web://101/1', source: 'vk', addedAt: 1, available: true, remote: { ownerId: 101, audioId: 1, inLibrary: true } };
const second = { ...track, id: 'vk-101-2', title: 'Second independent', url: 'vk-web://101/2', remote: { ownerId: 101, audioId: 2, inLibrary: true } };
const state = { version: 1, tracks: [track, second], playlists: [], history: [], queue: [track.id, second.id], currentTrackId: null, position: 0, settings: { theme: 'dark', style: 'minimal', accent: '#bdff62', density: 'comfortable', textScale: 1, reducedMotion: false, volume: .01, repeat: 'off', shuffle: false, closeToTray: false, autoplay: false, autoSkip: false } };
let failures = 0;

async function run(name, fn, { prime = true } = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(state => {
    const status = { state: 'connected', mode: 'web', message: '', user: { id: 101, name: 'QA' }, capabilities: [] };
    window.__commands = [];
    window.__emit = overrides => window.__playback?.({ id: 'vk-101-1', requestedId: 'vk-101-1', playing: true, buffering: false, advertising: false, position: 29, duration: 108, ended: false, error: null, runId: 'independent', ...overrides });
    window.desktop = {
      getState: async () => state, saveState: async () => {}, getVkStatus: async () => status,
      refreshVk: async () => ({ status, complete: false, tracks: [], playlists: [] }),
      getVersion: async () => 'qa', onCommand: () => () => {}, onVkUpdate: () => () => {},
      onVkPlayback: callback => { window.__playback = callback; return () => { window.__playback = null; }; },
      vkWebControl: async command => {
        window.__commands.push(command);
        if (window.__holdPlay && command.operation === 'play') return new Promise(resolve => { window.__releasePlay = resolve; });
        if (window.__recoverModel) {
          // A fresh direct load begins at zero; resume keeps its position;
          // seek or a start offset is the only way to restore a reloaded song.
          if (command.operation === 'play') window.__mediaPosition = Number.isFinite(command.position) ? command.position : 0;
          if (command.operation === 'stop') window.__mediaPosition = 0;
          if (command.operation === 'seek') window.__mediaPosition = command.position;
          if (['play', 'resume', 'seek'].includes(command.operation)) queueMicrotask(() => window.__emit({ position: window.__mediaPosition }));
        }
        return { accepted: true, pending: command.operation === 'play' };
      },
    };
  }, state);
  try {
    await page.goto(baseURL);
    await page.waitForFunction(() => Boolean(window.__playback));
    await page.clock.install();
    if (prime) {
      await page.getByRole('button', { name: 'Воспроизвести Midtrack independent', exact: true }).click();
      // Drain startup grace through actual progressing polls, without making
      // silence from the bridge look like a frozen source during setup.
      for (let poll = 0; poll <= 80; poll++) {
        await page.evaluate(position => window.__emit({ position }), 1 + poll * .35);
        await page.clock.fastForward(1000);
      }
    }
    await fn(page);
    console.log(`PASS ${name}`);
  } catch (error) { failures++; console.log(`FAIL ${name}: ${error.stack}`); }
  finally { await context.close(); }
}

await run('position keeps advancing despite stale buffering flag: audio must not be paused', async page => {
  for (let position = 30; position <= 52; position++) {
    await page.evaluate(position => window.__emit({ position, buffering: true }), position);
    await page.clock.fastForward(1000);
  }
  assert.equal(await page.locator('.player-error').count(), 0, 'advancing audio received a false mid-track timeout');
  const commands = await page.evaluate(() => window.__commands);
  assert.equal(commands.some(command => command.operation === 'pause'), false, 'watchdog interrupted healthy buffered audio');
});

for (const playing of [false, true]) {
  await run(`constant position during real buffering still times out with playing=${playing}`, async page => {
    for (let poll = 0; poll < 18; poll++) {
      // HTMLAudioElement.paused is false while a live play intent is waiting
      // for data, so the adapter can truthfully report playing=true here.
      await page.evaluate(playing => window.__emit({ position: 44, buffering: true, playing }), playing);
      await page.clock.fastForward(1000);
    }
    assert.equal(await page.locator('.player-error').count(), 1, 'a genuine frozen source never reached its deadline');
  });
}

await run('progress after a short network gap cancels the old mid-track deadline', async page => {
  await page.evaluate(() => window.__emit({ position: 44, buffering: true, playing: false }));
  await page.clock.fastForward(7000);
  await page.evaluate(() => window.__emit({ position: 44.5, buffering: false }));
  await page.clock.fastForward(10000);
  assert.equal(await page.locator('.player-error').count(), 0, 'the recovered source inherited its old deadline');
});

await run('Retry restores the latest mid-song position instead of playing from zero', async page => {
  await page.evaluate(() => window.__emit({ position: 44 }));
  await page.evaluate(() => window.__emit({ position: 44.6 }));
  // A recoverable network gap expires the watchdog. Keep the source model at
  // that position, then exercise the actual Retry control as a user would.
  await page.evaluate(() => window.__emit({ position: 44.6, buffering: true }));
  await page.clock.fastForward(16000);
  await page.locator('.player-error').waitFor();
  await page.evaluate(() => { window.__recoverModel = true; window.__mediaPosition = 44.6; });
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  // Flush the async source/retry chain, then deliver the native poll snapshot.
  for (let poll = 0; poll < 6; poll++) await page.evaluate(() => new Promise(resolve => queueMicrotask(resolve)));
  await page.evaluate(() => window.__emit({ position: window.__mediaPosition }));
  const actualPosition = Number(await page.getByLabel('Позиция воспроизведения').inputValue());
  assert.ok(actualPosition >= 44.5, `Retry restarted at ${actualPosition}s instead of preserving 44.6s`);
  assert.equal(await page.locator('.player-error').count(), 0);
});

await run('a slow but valid source can finish resolving loading and playing before its total budget', async page => {
  await page.evaluate(() => { window.__holdPlay = true; });
  await page.getByRole('button', { name: 'Воспроизвести Midtrack independent', exact: true }).click();
  await page.waitForFunction(() => Boolean(window.__releasePlay));
  // Resolver, media metadata, and the pending play promise are sequential.
  // A valid response at 66s must not be paused by a 15s native / 45s UI cap.
  await page.clock.fastForward(66000);
  assert.equal(await page.locator('.player-error').count(), 0, 'a valid slow start was cancelled before its allowed stages could finish');
  assert.equal(await page.evaluate(() => window.__commands.some(command => command.operation === 'pause')), false);
  await page.evaluate(() => { window.__releasePlay({ accepted: true }); window.__emit({ position: 1 }); });
  await page.getByRole('button', { name: 'Пауза', exact: true }).waitFor();
}, { prime: false });

await run('playing without position progress must time out even if buffering flags are missing', async page => {
  for (let poll = 0; poll < 18; poll++) {
    await page.evaluate(() => window.__emit({ position: 44, buffering: false, playing: true }));
    await page.clock.fastForward(1000);
  }
  assert.equal(await page.locator('.player-error').count(), 1, 'a frozen decoder with paused=false escaped detection');
});

await run('forward seeking cannot keep a source alive when the target position never progresses', async page => {
  await page.getByLabel('Позиция воспроизведения').fill('80');
  for (let poll = 0; poll < 18; poll++) {
    await page.evaluate(() => window.__emit({ position: 80, buffering: true, playing: true }));
    await page.clock.fastForward(1000);
  }
  assert.equal(await page.locator('.player-error').count(), 1, 'a seek jump was repeatedly counted as playback');
});

await run('pausing during a network gap cancels its eventual error', async page => {
  await page.evaluate(() => window.__emit({ position: 44, buffering: true }));
  await page.clock.fastForward(7000);
  await page.locator('.play-button').click();
  await page.clock.fastForward(90000);
  assert.equal(await page.locator('.player-error').count(), 0, 'paused playback inherited a network timeout');
});

await run('switching tracks prevents late frozen polls from pausing the new song', async page => {
  await page.evaluate(() => window.__emit({ position: 44, buffering: true }));
  await page.clock.fastForward(7000);
  await page.getByRole('button', { name: 'Воспроизвести Second independent', exact: true }).click();
  for (let position = 1; position <= 20; position++) {
    await page.evaluate(position => {
      window.__emit({ id: 'vk-101-2', requestedId: 'vk-101-2', position });
      window.__emit({ id: 'vk-101-1', requestedId: 'vk-101-1', position: 44, buffering: true });
    }, position);
    await page.clock.fastForward(1000);
  }
  assert.equal(await page.locator('.player-error').count(), 0, 'old track buffering interrupted the new song');
  assert.equal(await page.locator('.now-meta strong').innerText(), 'Second independent');
});

await run('the main Play button retries a failed mid-song source on its first click', async page => {
  await page.evaluate(() => window.__emit({ position: 44.6 }));
  await page.evaluate(() => window.__emit({ position: 44.6, playing: false, error: 'Источник VK не загрузился. Повторите запуск трека.' }));
  await page.locator('.player-error').waitFor();
  const commandsBefore = await page.evaluate(() => window.__commands.length);
  await page.locator('.play-button').click();
  for (let poll = 0; poll < 6; poll++) await page.evaluate(() => new Promise(resolve => queueMicrotask(resolve)));
  const commands = await page.evaluate(from => window.__commands.slice(from), commandsBefore);
  assert.ok(commands.some(command => command.operation === 'play'), 'the first Play click only paused or resumed the already failed audio element');
  assert.ok(commands.some(command => command.operation === 'play' && command.position >= 44.5), 'the main Play retry discarded the saved mid-song position');
});

await run('a late accepted command receipt after a source failure cannot turn the next retry into resume', async page => {
  await page.evaluate(() => { window.__holdPlay = true; });
  await page.getByRole('button', { name: 'Воспроизвести Midtrack independent', exact: true }).click();
  await page.waitForFunction(() => Boolean(window.__releasePlay));
  await page.evaluate(() => window.__emit({ position: 44.6 }));
  await page.evaluate(() => window.__emit({ position: 44.6, playing: false, error: 'Источник VK не загрузился. Повторите запуск трека.' }));
  await page.locator('.player-error').waitFor();
  await page.evaluate(() => { window.__holdPlay = false; window.__releasePlay({ accepted: true }); });
  for (let poll = 0; poll < 6; poll++) await page.evaluate(() => new Promise(resolve => queueMicrotask(resolve)));
  const commandsBefore = await page.evaluate(() => window.__commands.length);
  await page.locator('.play-button').click();
  for (let poll = 0; poll < 6; poll++) await page.evaluate(() => new Promise(resolve => queueMicrotask(resolve)));
  const commands = await page.evaluate(from => window.__commands.slice(from), commandsBefore);
  assert.ok(commands.some(command => command.operation === 'play' && command.position >= 44.5), 'an old accepted receipt restored failed-source ownership and made retry resume it');
}, { prime: false });

await run('terminal-error snapshot preserves its newer mid-song position for Retry', async page => {
  await page.evaluate(() => window.__emit({ position: 44.6 }));
  // The fatal status may be the first poll containing the final audible
  // position. Error handling must consume it before returning early.
  await page.evaluate(() => window.__emit({ position: 45.9, playing: false, error: 'Не удалось воспроизвести доступный источник VK. Повторите запуск трека.' }));
  await page.locator('.player-error').waitFor();
  const failedPosition = Number(await page.getByLabel('Позиция воспроизведения').inputValue());
  assert.ok(failedPosition >= 45.8, `terminal status lost its final position: ${failedPosition}s`);
  await page.evaluate(() => { window.__recoverModel = true; window.__mediaPosition = 45.9; });
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  for (let poll = 0; poll < 6; poll++) await page.evaluate(() => new Promise(resolve => queueMicrotask(resolve)));
  const commands = await page.evaluate(() => window.__commands);
  assert.ok(commands.some(command => command.operation === 'play' && command.position >= 45.8), 'Retry discarded the final position carried by the error status');
});

await run('automatic source renewal receives its own bounded budget without a false fifteen-second pause', async page => {
  await page.evaluate(() => window.__emit({ position: 44.6, playing: false, buffering: true, recovering: true }));
  await page.clock.fastForward(60000);
  assert.equal(await page.locator('.player-error').count(), 0, 'automatic source refresh inherited the short frozen-source deadline');
  assert.equal(await page.evaluate(() => window.__commands.some(command => command.operation === 'pause')), false);
  await page.evaluate(() => window.__emit({ position: 45, playing: true, buffering: false, recovering: false }));
  for (let position = 46; position <= 66; position++) {
    await page.evaluate(position => window.__emit({ position }), position);
    await page.clock.fastForward(1000);
  }
  assert.equal(await page.locator('.player-error').count(), 0, 'successful renewal retained a stale watchdog');
});

await run('automatic renewal that never resolves eventually terminates instead of spinning forever', async page => {
  await page.evaluate(() => window.__emit({ position: 44.6, playing: false, buffering: true, recovering: true }));
  await page.clock.fastForward(151000);
  assert.equal(await page.locator('.player-error').count(), 1, 'unresponsive source recovery had no final deadline');
  assert.equal(await page.evaluate(() => window.__commands.some(command => command.operation === 'pause')), true);
});

await run('the main button pauses an automatic source refresh and suppresses late playback', async page => {
  await page.evaluate(() => window.__emit({ position: 44.6, playing: false, buffering: true, recovering: true }));
  const from = await page.evaluate(() => window.__commands.length);
  await page.locator('.play-button').click();
  const commands = await page.evaluate(from => window.__commands.slice(from), from);
  assert.ok(commands.some(command => command.operation === 'pause'), 'click during renewal incorrectly started or resumed an additional source');
  assert.equal(commands.some(command => ['play', 'resume'].includes(command.operation)), false);
  await page.evaluate(() => window.__emit({ position: 44.6, playing: true, buffering: false, recovering: false }));
  await page.clock.fastForward(151000);
  assert.equal(await page.locator('.player-error').count(), 0, 'user-paused recovery inherited an error deadline');
  const actualPosition = Number(await page.getByLabel('Позиция воспроизведения').inputValue());
  assert.ok(actualPosition >= 44.5);
});

await run('resuming after pausing automatic renewal reloads the disposed source from its saved offset', async page => {
  await page.evaluate(() => window.__emit({ position: 44.6, playing: false, buffering: true, recovering: true }));
  await page.locator('.play-button').click();
  // The direct transport must destroy a pending source load to cancel it.
  // A later resume must therefore load, rather than reuse that dead element.
  await page.evaluate(() => window.__emit({ position: 44.6, playing: false, buffering: false, recovering: false }));
  const from = await page.evaluate(() => window.__commands.length);
  await page.locator('.play-button').click();
  for (let poll = 0; poll < 6; poll++) await page.evaluate(() => new Promise(resolve => queueMicrotask(resolve)));
  const commands = await page.evaluate(from => window.__commands.slice(from), from);
  assert.ok(commands.some(command => command.operation === 'play' && command.position >= 44.5), 'resuming a cancelled renewal tried to use the destroyed audio element');
});

await browser.close();
process.exitCode = failures ? 1 : 0;
