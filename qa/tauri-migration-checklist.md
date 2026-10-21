# Tauri 2 migration checklist (Windows 10/11)

This checklist is independent of the product happy path. It is intended for the migration branch before replacing the Electron build.

## Baseline and acceptance targets

- Record cold-start working-set and private bytes for the current Electron build and the Tauri build on the same Windows machine. Measure after the first window is idle for 60 seconds, after importing a 100 MB file, and with the official VK window open. Report the WebView2 browser process separately instead of comparing only the UI process.
- Record installer size, first-launch time, and time to first audio. Tauri's installer is expected to be much smaller, but WebView2 may already be installed or may be downloaded by the installer.
- Accept a migration only if local playback, persistence, OAuth, tray, media keys, and the official VK window pass the same functional tests as Electron and no audio path loads an entire large file into memory.

## Functional parity

- Import MP3, M4A, AAC, FLAC, OGG/Opus, WAV, and WebM; verify metadata, duplicate policy, missing-file handling, and persistence after restart.
- Play, pause, seek, next, previous, repeat, shuffle, auto-skip, history, restore position, media-session actions, and playback while the main window is hidden.
- Exercise rapid play/next/clear and a stream failure loop; verify stale callbacks cannot change the selected track and retries remain bounded.
- Create, rename, delete, and populate playlists; verify empty playlists and deletion of the active track.
- Change every theme/style/density/accessibility setting during playback, restart, and restore the same state.

## Tauri-specific protocol and security tests

- Request local audio with no range, a valid range, an invalid range, an open-ended range, and a multi-range header. Return correct 200/206/416 status and `Content-Range`; never serve a path outside the imported-file map.
- Attempt path traversal, encoded traversal, symlink escape, and a `file:`/external URL from the renderer. All must be rejected.
- Import a file, move/delete it, restart, and confirm the UI reports it unavailable without crashing.
- Verify the renderer has no Node or filesystem globals and that only allowlisted Tauri commands are callable.
- Confirm CSP and capability files allow only the commands/windows actually used; keep the VK webview on HTTPS and an explicit VK host allowlist.

## VK ID OAuth and token handling

- Start OAuth twice concurrently; verify one in-flight flow, state and PKCE validation, and safe cancellation.
- Return a malformed callback, a wrong state, an error callback, and a callback after timeout; no token is stored.
- Expire/revoke the access token during `audio.get`, `audio.search`, and `audio.getById`; verify single-flight refresh and one clear re-auth action.
- Verify the Windows Credential Manager/Stronghold storage is unavailable to the renderer and that logout removes the token and refresh state.
- A migration from Electron `safeStorage` may require one re-login because its DPAPI ciphertext is not portable to Tauri's keyring/Stronghold format. Document and test this explicitly.

## Official VK web window

- Open/close/reopen the VK window and confirm cookies survive an app restart in its dedicated WebView2 data directory.
- Reject non-HTTPS navigation and non-VK hosts, including popup targets and redirects; allow only the intended VK ID/audio hosts.
- Confirm the app never reads DOM, cookies, local storage, or network responses from the official window.

## Windows integration

- Register/unregister MediaPlayPause, MediaNextTrack, and MediaPreviousTrack; test conflicts with another media player and app restart.
- Hide to tray, restore from tray, close-to-tray, quit from tray, and verify a single-instance launch focuses the existing window.
- Verify Windows 10 and 11 with WebView2 Evergreen present and absent. Test both online bootstrapper and offline installer modes.
- Test per-user installation, upgrade, uninstall, and rollback. Verify user library/token files survive upgrade and are removed only by an explicit uninstall choice.

## Commands for the migration branch

```powershell
# Frontend parity
npm run typecheck
npm run build
npm test
node qa/browser-adversarial.mjs

# Tauri checks (after Rust/Tauri toolchain is installed)
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
npm run tauri build -- --debug

# Native smoke tests
node qa/tauri-integration.mjs
node qa/tauri-adversarial.mjs
```

`tauri-integration.mjs` should cover real WAV import, range playback, state persistence, tray restore, and renderer error capture. `tauri-adversarial.mjs` should cover protocol traversal/range cases, OAuth callback races, rapid playback races, and VK webview navigation policy. Keep the existing Electron suites until the Tauri build reaches parity.
