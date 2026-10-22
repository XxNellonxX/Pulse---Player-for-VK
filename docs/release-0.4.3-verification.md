# Pulse 0.4.3 verification

## Change and scope

The shared VK transport keeps a viable initial HLS attempt alive while it
looks for another delivery. The former four-second cutoff could abort the
first segment before its own retry succeeded, even when metadata supplied
the identical URL. A four-second cold/eight-second warm timer now starts a
parallel metadata lookup; a distinct validated candidate is prepared alongside
the original and can replace it only after audio becomes playable. Duplicate,
empty or hung metadata does not reset the original. At most two decoder
candidates prepare at once; the losing candidate is closed after selection.
Per-candidate and overall load budgets remain bounded, and cancellation
closes scoped waits, timers and equalizer probes.

The source adapter also preserves a collection tuple that the signed-in
website's pure source factory can already decode. It does not replace that
candidate with an exact-API response before trying it. If an exact-API delivery
fails, the fallback tries the original tuple before requesting a hash reload.
Both fallback stages preserve account, track identity and restriction checks;
the same URL is not attempted twice during one load.

An independent fixture using the real adapter and transport reproduced the old
roughly 15-second failure and successful startup in under 100 ms after this
change. These are controlled timings, not live CDN performance measurements.

Before the HLS correction, the live Windows check found seven distinct
non-official tracks that made no media-clock progress and failed after
approximately 4.6 seconds. The same affected track later started in the
ordinary VK website player after approximately 21.9 seconds, proving that
the early failure did not establish a permanently unavailable source. An official
catalog control started after 537 ms and advanced for 15.7 seconds without an
observed interruption; its full 108.8-second duration was buffered. This was
a short observation, not a full-track completion test.

The separate [network investigation](playback-network-investigation-2026-10-22.md)
records why a local proxy, User-Agent replacement or native HTTP/2 is not being
presented as a demonstrated fix for these unavailable media responses.
The [APK notes](apk-playback-reference.md) distinguish traced VK X architecture
from unverified claims. No decompiled application code or credentials were
incorporated into Pulse.

## Checks completed

| Check | Result |
| --- | --- |
| Full Node regression suite | 279 passed |
| Independent review of changed adapter/transport | Two reproduced candidate/commit races corrected; no remaining confirmed blocker in the reviewed changes |
| Rust suite | 93 passed; 4 existing codec tests ignored in this run |
| Frontend unit tests | 13 passed |
| TypeScript and frontend production build | Passed |
| Retained-upload playback hook harness | 10 passed |
| Snippet/buffering hook harness | 8 passed |
| Real HTMLAudio direct-transport harness | Playback, pause, seek/end and cleanup passed |
| Independent slow-source VM cases | 23 passed, including both candidates cancelled, losing-engine cleanup, and a restriction arriving during EQ preparation |
| Real Chromium/bundled HLS slow-source cases | 4 passed; same-source delay 7.002 s, responsive alternate 4.035 s, original surviving a hung alternate 6.841 s and HTTP 503 alternate 6.843 s |
| Windows x64 production NSIS package | Built, embedded version 0.4.3, product VK Player |

The hook and VM harnesses use controlled data and do not validate audible
output or VK service availability. The real-account QA instance used an
isolated profile and performed no upload, deletion or library mutation.

The synthetic HLS fixtures use separate manifest/segment paths for each
candidate. The two-source cases observed at most two active engines and one
remaining after selection. This is a lifecycle assertion, not a measurement
of total application RAM.

## Live playback limits

An intermediate soft-hedge build played one affected track through its normal
`ended` event at **128.78 seconds**, with no observed post-start buffering,
recovery or media error. Startup was 549 ms, but the earlier website comparison
could have warmed that source; it is not a cold-start performance claim.
Another non-official track started after 4.604 seconds and advanced for
16 seconds, but failed to start in a later run. These results are not evidence
of stable service availability.

In the subsequent two-candidate native UI batch, six selected non-official
tracks still made no media-clock progress and ended with a new confirmed
play-command failure after approximately **25.5 seconds**. The observer
correlated each result with the newly issued play command, avoiding stale
same-track errors. A catalog control started after approximately **1.035 s**
and advanced for another 16 seconds without interruption. Passive observation
captured an affected manifest request aborted after five seconds without any
HTTP response; the control manifest, key and segments returned HTTP 200 in
approximately 22–103 ms.

That native batch used the candidate/preparation change with EQ disabled.
The final additional restriction check after EQ preparation was verified by
the independent controlled regression above. No claim is made that the final
package resolves every affected live upload.

A final independent, muted HLS observation requested the exact same affected
item with a **45-second** budget outside Pulse's candidate cutoff. The manifest
requests both reached approximately **20 seconds** without any HTTP status or
body bytes. HLS reported fatal `manifestLoadTimeOut` after **40.003 seconds**;
at **45.254 seconds** the media clock, ready state and buffer were still zero.
This case is not explained solely by Pulse's 25-second candidate budget.

The final Windows release executable was checked to contain the complete
current shared transport source and to exclude the debug-only QA profile
marker. QA processes were stopped after the read-only checks.

Local Windows installer from source revision
`cd1b6b591b21d0840062ec4ff77db331d93f1766`: **107,376,807 bytes**, SHA-256:

`76e3d2f06b6a3f0a9f203818171ca46bf2b6875b23f58d9786e8206e27d3e919`

## Platform and release limits

Windows and macOS use the same changed source files and version. The existing
application identifier and profile/data paths are unchanged. This local
package is not a new published stable GitHub Release.

macOS 0.4.3 arm64/x64 build verification of that exact source revision is
running in [GitHub Actions run 39754949469](https://github.com/XxNellonxX/Pulse---Player-for-VK/actions/runs/39754949469).
Earlier successful 0.4.3 builds do not verify this source revision. Physical-Mac login, playback,
imports, persistence and updates remain unverified; macOS remains an unsigned
preview. Android support is planned and has not been implemented or tested.

There is no claim that every track or every imported source plays without
interruption. The failing live cases remain open.
