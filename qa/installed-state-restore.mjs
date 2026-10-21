// These functions run only inside an installed-player QA page. The production
// desktop API is frozen, so wrap its window binding rather than mutating it.
export async function captureInstalledStateForRestore() {
  if (window.__qaLocalStateRestore) throw new Error('A QA state-restore guard already exists');
  const original = window.desktop;
  if (!original?.saveState || !original?.getState) throw new Error('Native state API unavailable');
  const guard = { original, pending: new Set(), blocking: false, blockedSaves: 0, drainedSaves: 0 };
  window.__qaLocalStateRestore = guard;
  window.desktop = Object.freeze({
    ...original,
    saveState(value) {
      if (guard.blocking) { guard.blockedSaves++; return Promise.resolve(); }
      const pending = Promise.resolve().then(() => original.saveState(value));
      guard.pending.add(pending);
      const complete = () => guard.pending.delete(pending);
      pending.then(complete, complete);
      return pending;
    },
  });
  if (window.desktop === original) throw new Error('Could not install QA state-restore guard');
  return original.getState();
}

export async function restoreInstalledStateBeforeClose(saved) {
  const guard = window.__qaLocalStateRestore;
  if (!guard) throw new Error('QA state-restore guard unavailable');
  // React still holds the temporary playback state. Its pause polls, save timer,
  // visibility and unload handlers must not overwrite the final native restore.
  // Keep this guard installed until the QA script closes this app process.
  guard.blocking = true;
  await guard.original.vkWebControl?.({ operation: 'pause' }).catch(() => {});
  while (guard.pending.size) {
    const pending = [...guard.pending];
    guard.drainedSaves += pending.length;
    await Promise.allSettled(pending);
  }
  await guard.original.saveState(saved);
  const actual = await guard.original.getState();
  const view = state => ({ settings: state.settings, queue: state.queue, currentTrackId: state.currentTrackId, position: state.position, history: state.history, localPlaylists: state.playlists.filter(item => !item.remote) });
  return {
    nativeReadbackMatched: JSON.stringify(view(actual)) === JSON.stringify(view(saved)),
    originalVolume: saved.settings.volume,
    blockedRendererSaves: guard.blockedSaves,
    drainedRendererSaves: guard.drainedSaves,
    rendererSaveGuardHeldUntilClose: true,
  };
}
