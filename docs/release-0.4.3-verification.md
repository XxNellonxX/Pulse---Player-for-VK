# Pulse 0.4.3 verification

## Change and scope

The shared VK source adapter now preserves a collection tuple that the signed-in
website's pure source factory can already decode. It does not replace that
candidate with an exact-API response before trying it. If an exact-API delivery
fails, the fallback tries the original tuple before requesting a hash reload.
Both fallback stages preserve account, track identity and restriction checks;
the same URL is not attempted twice during one load.

An independent fixture using the real adapter and transport reproduced the old
roughly 15-second failure and successful startup in under 100 ms after this
change. These are controlled timings, not live CDN performance measurements.

This update does **not** establish a repair for all old uploads. The live
Windows check still found seven distinct non-official tracks that made no
media-clock progress and failed after approximately 4.6 seconds. An official
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
| Full Node regression suite | 256 passed |
| Independent review of changed adapter/transport | No confirmed regression; 60 targeted tests passed |
| Rust suite | 93 passed; 4 existing codec tests ignored in this run |
| Frontend unit tests | 13 passed |
| TypeScript and frontend production build | Passed |
| Retained-upload playback hook harness | 10 passed |
| Snippet/buffering hook harness | 8 passed |
| Real HTMLAudio direct-transport harness | Playback, pause, seek/end and cleanup passed |
| Windows x64 production NSIS package | Built, embedded version 0.4.3, product VK Player |

The hook and VM harnesses use controlled data and do not validate audible
output or VK service availability. The real-account QA instance used an
isolated profile and performed no upload, deletion or library mutation.

Local Windows installer: **107,357,657 bytes**, SHA-256:

`b6240bfd3fa44ca7a311f987f8fd72b0f16b07423b06563e06b4e2bd6df2b66f`

## Platform and release limits

Windows and macOS use the same changed source files and version. The existing
application identifier and profile/data paths are unchanged. This local
package is not a new published stable GitHub Release.

macOS 0.4.3 arm64/x64 build verification is pending. The successful 0.4.2 macOS
builds do not verify this source revision. Physical-Mac login, playback,
imports, persistence and updates remain unverified; macOS remains an unsigned
preview. Android support is planned and has not been implemented or tested.

There is no claim that every track or every imported source plays without
interruption. The failing live cases remain open.
