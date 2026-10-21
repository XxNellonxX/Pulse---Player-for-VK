# Playback recovery verification — 2026-10-20

## Confirmed failure and change

The installed Windows player reproduced a playback failure on “Скоро лето” by Три дня дождя. WebView2 reported native HLS support as `maybe`, but the media request failed with `net::ERR_BLOCKED_BY_ORB` and HTML media error 4. The transport now prefers the bundled HLS/MSE engine when supported.

The transport also renews the current session source after an actual media/HLS error or an established playback clock that stops advancing. Renewal preserves the playback position, allows at most two attempts per load, and is cancelled by pause, stop, track/account changes and destruction. HLS forward-buffer target is 120 seconds, maximum target 180 seconds, and back buffer 30 seconds. The configured 8 MiB buffer size is not a total application RAM limit.

The supplied VK X APK was inspected as an architecture reference: explicit buffering, bounded retries and recovery informed the Windows implementation. Android application code was not copied. The APK's disk cache was not implemented in this change. See `apk-playback-reference.md` for evidence.

## Installed release acceptance

`qa/installed-midtrack-smoke.mjs` ran with `QA_SOURCE_RECOVERY=1` against the final packaged executable in the existing authorized VK session. Its report is `qa/installed-source-recovery-result.json` (2026-10-20 09:14:38 UTC).

- Target track reached native `ended` at **207.36 / 207.36 seconds**. The event was captured directly on the target audio element before automatic next-track playback.
- Synthetic `stalled`, `waiting` and media `error` events were exercised during playback. Source replacement and subsequent clock progress were observed without a Retry click.
- A same-account background synchronization was requested during playback; this test does not assert that the full synchronization completed.
- No main-renderer `pageerror` exceptions were observed.
- Settings, queue, current track, position, history and local playlists were restored and compared through the native state bridge before clean exit.

This acceptance run was muted. It proves media-clock progress, source replacement and actual completion, not uninterrupted audible output. The injected error event is not a real network outage; the separate HLS test below covers real failing requests. State readback is not a complete crash-durability test.

## Independent regression coverage

- `qa/vk-file-recovery-independent.node.mjs`: 19 passing transport scenarios, including cancellation, seek and late-play races.
- `qa/vk-midtrack-independent.mjs`: 17 passing interface scenarios.
- `qa/hls-transient-independent.mjs --fatal`: real bundled HLS requests receive repeated HTTP 503 responses, escalate to a fatal engine error, then renew the source/engine and finish generated 20-second media. Native HLS support is explicitly reported as `maybe` to exercise MSE selection. Retry delays and prefetch size are reduced in this isolated fixture only.
- TypeScript/Vite production build and 59 Rust tests passed before packaging.

Recovery can still introduce a short pause, and cannot guarantee availability when VK or the network is unavailable. Alternative stream encoding and quality depend on the sources supplied by VK.
