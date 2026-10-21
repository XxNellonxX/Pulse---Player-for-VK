import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { captureInstalledStateForRestore, restoreInstalledStateBeforeClose } from './installed-state-restore.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'vk-player-qa-restore-'));
  const file = join(directory, 'library.json');
  const original = { settings: { volume: 0.54, theme: 'dark' }, queue: ['original'], currentTrackId: 'original', position: 12, history: ['original'], playlists: [{ id: 'local', remote: false, trackIds: ['original'] }], tracks: [] };
  const temporary = { ...structuredClone(original), settings: { volume: 0, theme: 'dark' }, queue: ['test'], currentTrackId: 'test', position: 207.36, history: ['test'] };
  let state = structuredClone(original), gate;
  const entered = deferred(), flushes = [], events = new EventTarget();
  const window = {
    addEventListener: events.addEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  };
  const desktop = Object.freeze({
    getState: async () => structuredClone(state),
    saveState: async value => {
      if (gate) { const waiting = gate; gate = null; entered.resolve(); await waiting.promise; }
      state = structuredClone(value);
      await writeFile(file, JSON.stringify(state));
    },
    vkWebControl: async () => {
      // The actual renderer can persist temporary state when a pause poll lands.
      flushes.push(window.desktop.saveState(temporary));
    },
  });
  window.desktop = desktop;
  const staleRendererFlush = () => { flushes.push(window.desktop.saveState(temporary)); };
  window.addEventListener('pagehide', staleRendererFlush);
  window.addEventListener('beforeunload', staleRendererFlush);
  await desktop.saveState(original);
  return {
    window, desktop, original, temporary, entered,
    delayNextSave() { gate = deferred(); return gate; },
    evaluate(fn, value) { return runInNewContext(`(${fn.toString()})(saved)`, { window, saved: value, Promise, Set, Object, Error, JSON }); },
    async finishClose() {
      window.dispatchEvent(new Event('pagehide'));
      window.dispatchEvent(new Event('beforeunload'));
      await Promise.allSettled(flushes);
    },
    readAfterRestart() {
      // A fresh Node process reads the file: native in-memory readback alone
      // would miss an unload write that occurs after the successful assertion.
      return JSON.parse(execFileSync(process.execPath, ['-e', 'process.stdout.write(require("node:fs").readFileSync(process.argv[1], "utf8"))', file], { encoding: 'utf8' }));
    },
    async readDisk() { return JSON.parse(await readFile(file, 'utf8')); },
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}

test('negative control: native restore/readback is overwritten by stale unload flush', async () => {
  const f = await fixture();
  try {
    await f.desktop.saveState(f.temporary);
    await f.desktop.saveState(f.original);
    assert.equal((await f.desktop.getState()).settings.volume, 0.54);
    await f.finishClose();
    assert.equal(f.readAfterRestart().settings.volume, 0, 'The control must reproduce the reported QA restore defect');
  } finally { await f.dispose(); }
});

test('guard drains an in-flight save and blocks pause, pagehide and unload writes through process close', async () => {
  const f = await fixture();
  try {
    const saved = await f.evaluate(captureInstalledStateForRestore);
    assert.ok(Object.isFrozen(f.desktop), 'Fixture must match the frozen production desktop API');
    assert.notEqual(f.window.desktop, f.desktop);
    const gate = f.delayNextSave();
    const pending = f.window.desktop.saveState(f.temporary);
    await f.entered.promise;
    let finished = false;
    const restore = f.evaluate(restoreInstalledStateBeforeClose, saved).then(value => { finished = true; return value; });
    f.window.dispatchEvent(new Event('pagehide'));
    await Promise.resolve();
    assert.equal(finished, false, 'Final restore must wait for a previously started native write');
    gate.resolve();
    await pending;
    const result = await restore;
    assert.equal(result.nativeReadbackMatched, true);
    assert.equal(result.originalVolume, 0.54);
    assert.equal(result.drainedRendererSaves, 1);
    assert.ok(result.blockedRendererSaves >= 2, 'Pause and pagehide must both be intercepted');
    await f.finishClose();
    assert.deepEqual(f.readAfterRestart(), f.original, 'Stale renderer flush must not change any restored preference or reference');
  } finally { await f.dispose(); }
});

test('a rejected in-flight renderer save does not prevent final restore', async () => {
  const f = await fixture();
  try {
    const saved = await f.evaluate(captureInstalledStateForRestore);
    const gate = f.delayNextSave();
    const pending = f.window.desktop.saveState(f.temporary);
    const expectedFailure = assert.rejects(pending, /test disk failure/);
    await f.entered.promise;
    const restore = f.evaluate(restoreInstalledStateBeforeClose, saved);
    gate.reject(new Error('test disk failure'));
    await expectedFailure;
    assert.equal((await restore).nativeReadbackMatched, true);
    await f.finishClose();
    assert.deepEqual(f.readAfterRestart(), f.original);
  } finally { await f.dispose(); }
});
