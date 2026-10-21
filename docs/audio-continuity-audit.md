# Independent audio continuity audit

2026-10-20. Scope: short audible interruptions in the Tauri/WebView2 VK player.

The prior full-track media-clock test established that playback eventually
reached the end. It did not establish uninterrupted PCM audio.

## Static review

Normal native polling does not call pause/play/seek. Same-account library
refresh preserves the direct transport. The frontend source-loading effect
depends on track ID, URL, or explicit reload rather than on each progress update.
Source renewal begins on a fatal source error or an eight-second stopped media
clock, so its timer alone cannot explain sub-second interruptions.

The previous configuration explicitly disabled HLS transmuxing workers.
Moving transmuxing to a worker reduces competition with the official site's
JavaScript. This is a reasonable performance change; the audit did not prove
it caused the user's interruptions. Hidden WebView scheduling and real source
timestamp/segment gaps require live diagnostics.

## PCM test

Run `node qa/hls-pcm-continuity-independent.mjs`, with optional `--stress`,
`--worker`, and `--control-gap` flags. `--worker --blocked-worker` denies worker
construction with a `SecurityError` and verifies the bundled engine's inline
fallback rather than allowing the fixture to silently skip worker coverage.

The fixture generates a continuous 440 Hz AAC sine in 25 HLS TS segments. It
loads the actual bundled HLS library and actual direct transport in an isolated
Chromium document. An AudioWorklet measures samples on the audio rendering
thread. The first second and final 750 ms are excluded. Empty input quanta
after the first signal are counted as silence rather than omitted.

The worklet outputs silence after inspecting input, so it does not play through
physical speakers. It records only test-generated audio. No user account,
media, authentication data, or cloud mutation is involved.

Stress delays each TS response 600–750 ms and occupies the page's main thread
for 75 ms every 500 ms. Worker instrumentation separately checks construction,
initialization, and successful transmux responses.

| Scenario | PCM observed | Longest zero run | Discontinuous sample steps |
| --- | ---: | ---: | ---: |
| Worker disabled, baseline | 22.25 s | 0.0208 ms | 0 |
| Worker disabled, network and main-thread stress | 22.25 s | 0.0208 ms | 0 |
| Worker enabled, same stress | 22.25 s | 0.0208 ms | 0 |
| Worker requested but construction denied, same stress | 22.25 s | 0.0208 ms | 0 |
| Positive control: scheduled 80 ms mute | 22.25 s | 80.000 ms | 2 |

A single sample near a sine zero crossing is expected and is not a gap.
The enabled-worker stress run created one worker, observed one initialization,
50 transmux-complete responses, 25 flush responses, and 46 main-thread long
tasks with a maximum of 75 ms. It had no worker or renderer errors.
The denied-worker run made one worker attempt, constructed none, received no
worker messages, and still decoded continuous PCM through the inline fallback.

These results demonstrate that the measurement detects a known short audio
gap, and that the synthetic continuous source remains continuous under the
tested conditions. They do not prove that real VK sources or the physical
Windows audio output are free of interruptions. The synthetic test also does
not reproduce account-specific CDN responses, source timestamp discontinuities,
audio device changes, system driver underruns, or VK page workloads.

Machine-readable evidence is in `qa/hls-pcm-*-result.json`.

## Real source diagnosis and installed release, 2026-10-21

Live probes of the previous transport reproduced HLS fragment decryption
failures on “Скоро лето — Три дня дождя”: `fragParsingError`, then fatal
`WebCrypto and softwareDecrypt: failed to decrypt data`. Enabling the HLS
worker alone reproduced the same failures. The signed-in VK session also
supplies progressive sources for this track.

The release now tries the progressive sources explicitly supplied by VK in
provider order, retains other supplied sources and `fallback_url` candidates,
and keeps HLS as a fallback. It does not transcode or invent media URLs.
Independent source-selection tests exercise both website factory variants,
an encrypted HLS negative control, real progressive decoding, and HLS fallback.

`qa/installed-audio-continuity-release-result.json`, checked at
2026-10-21T04:27:14.282Z, records the installed packaged transport without a
candidate source injection or worker override. The first candidate failed
with media error 4 before playback; the next progressive candidate started
at exactly 0.000 s and reached native `ended` at 207.360 s. Elapsed time
between `playing` and `ended` was 207.400 s. There were no subsequent
waiting/stalled/seeking/error events, audio-element replacements, HLS instances,
or measured clock gaps. The only subsequent pause was at the natural end.
An independent agent inspected the events and 8,296 clock samples during
playback (8,311 samples in the full observation, including setup/end).
The result does not identify the codec/bitrate of the successful candidate.

This actual-track test was muted and measures media events and clocks. It
does not establish physical output or decoded PCM continuity for every VK
track. The synthetic PCM evidence above remains separately scoped.

## Windows volume control and cleanup

Windows 11 Settings → System → Sound → Volume displayed the genuine WebView2
audio session as VK Player with its icon and slider. Changing that slider
from 100 to 76 changed the corresponding WASAPI session master volume to
0.76; it was then restored to 1.0, unmuted. See
`qa/windows-audio-sessions-slider-check.json` and
`qa/windows-audio-sessions-after.json`. The production worker only brands
sessions belonging to this app and its verified WebView2 descendants.

The playback fixture's immediate native state readback passed, but restart
inspection exposed a cleanup race: the renderer could persist the temporary
zero volume on unload after native restoration. This was a test harness
problem, not the source of the playback failures. The normal player was
restarted, its signed-in account and catalog were observed, and app volume
was set to 0.54 through its UI and verified in persisted settings. The exact
pre-test volume was not retained in old artifacts. Native readback alone
must not be described as proof that every preference survives a restart.

Future continuity and midtrack fixtures use `qa/installed-state-restore.mjs`:
it drains pending renderer saves and blocks later renderer saves before the
final native restore, retaining that guard until the diagnostic process closes.
Three isolated regressions in `qa/installed-state-restore.node.mjs` passed,
including an unload-overwrite negative control and fresh-process disk readback.
This cleanup change was tested in isolation after the full-track run; it did
not change production code or require rebuilding the installer.

The continuity and midtrack QA fixtures now install a temporary save guard
before playback. Cleanup drains earlier renderer saves and blocks later
pause, pagehide and unload saves until process close, then restores through
the captured native API. Future reports also retain the original volume.
`node --test qa/installed-state-restore.node.mjs` passes three isolated
regressions: the former cleanup reproduces the overwrite, the guard protects
against a delayed save plus unload, and a rejected in-flight save still allows
restoration. A fresh process reads the fixture's saved file after simulated
close. This validates the QA helper separately; the live playback evidence
above predates this cleanup fix and was not rerun.

The installed executable and release executable have matching SHA-256 hashes;
the ordinary app runs without the diagnostic port. Consolidated evidence is
in `qa/audio-continuity-release-proof.json`.
