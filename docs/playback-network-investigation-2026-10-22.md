# Playback network investigation — 2026-10-22

Some uploaded tracks still stalled or failed in Pulse 0.4.2 while catalog
tracks played. These read-only Windows measurements compared the same
session-granted sources through WebView networking, Node HTTP, and a separate
Rust/reqwest diagnostic. No cloud uploads, deletions or other account mutations
were performed. Source URLs and request data stayed in memory; this report
contains no signed URLs, account or audio IDs, IP addresses, or private paths.

## Observations

An affected track's HLS manifest returned HTTP 200 in **136 ms** through Node
and **148 ms** through WebView fetch. A Node request carrying browser-style
headers timed out after **9 seconds**. Another affected manifest timed out
through all three variants in that comparison, but later exact-item resolution
produced a manifest that returned 200 in **112–190 ms**. Catalog control requests
worked. These changing results do not establish a header-based fix.

A wider sample found nine readable manifests and nine readable first segments
in both Node and WebView checks; successful requests generally took
**20–220 ms**. Two other requests reached the **6.5-second** observation limit.
Native HTTP therefore did not provide a consistent advantage over WebView.

In an actual HLS start, a cached manifest returned 200 almost immediately, but
its first segment made no progress before the current candidate's **4-second**
budget aborted it. A parallel Node request eventually obtained response
headers and its first **15,858-byte chunk after 6,874 ms**. That was a partial
read, not a completed segment or proof of sustained throughput. A separate
30-second HLS observation recorded repeated segment timeouts without audio
progress. Faster manifest lookup alone did not establish playable audio.

The Rust probe explicitly enabled HTTP/2 for comparison. Pulse's existing
`reqwest` feature set does not enable HTTP/2 or system-proxy support; these
diagnostic features were not added to production as part of this experiment.

| Rust comparison | Affected source A | Affected source B | Catalog control |
| --- | --- | --- | --- |
| Manifest, direct HTTP/1.1 | 5-second timeout | 5-second timeout | 200, 96 ms |
| Manifest, direct negotiated HTTP/2 | 200, 104 ms | 5-second timeout | 200, 101 ms |
| Manifest, HTTP/1.1 default proxy discovery | 5-second timeout | 5-second timeout | 200, 158 ms |
| Source A first segment, HTTP/1.1, HTTP/2, or `Accept-Encoding: identity` | All three reached 7-second timeout | Not tested in this comparison | — |

Default proxy discovery is a client mode, not evidence that an external proxy
was configured or used. The isolated HTTP/2 manifest success did not extend to
the audio segment and was not a reliable playback improvement.

## DNS-address comparison

The next comparison pinned each request to one of the hostname's two public
DNS answers. It preserved the original hostname, TLS SNI and certificate
validation. Requests were sequential, direct, and HTTP/2-capable. The second
pass reversed the resource and address order to reduce ordering bias. Each
row below includes both addresses and both passes.

| Resource | Completed responses | Remaining observations |
| --- | --- | --- |
| Affected A manifest | 1/4, 200, 467 bytes, 130 ms | Three 5-second timeouts |
| Affected A fresh first segment | **0/4** | Four 7-second timeouts, no response headers or body bytes |
| Affected B manifest | **0/4** | Four 5-second timeouts, no response headers or body bytes |
| Catalog manifest | **4/4**, 200, 615 bytes, 96–112 ms | No timeout |
| Catalog first segment | **4/4**, 200, 93,624 bytes, 164–884 ms | No timeout |

The affected segment failed on both addresses. This does not support selecting
one DNS address as a dependable remedy. No HTTP 403 was observed in these
failures: the diagnostic timed out before receiving headers. Advertising,
client throttling, token expiry and regional blocking remain unproven causes.

## Consequences for implementation

A local relay is an in-process or loopback downloader/cache used only by Pulse.
It does **not** give the computer a foreign IP address or change its upstream
network route. It can preserve bytes already downloaded and isolate playback
from short gaps, but cannot serve a segment that neither native HTTP nor the
WebView can obtain. These tests do not justify presenting a local relay,
User-Agent replacement, HTTP/2, or a different DNS answer as a completed fix
for the affected tracks. No public third-party proxy was used.

A separate source-candidate retention bug was reproduced in a controlled VM.
The adapter could overlook an original masked tuple that the website's pure
source factory could decode, replace it with a failing exact-API delivery, and
then reload hashes without first trying the original candidate. The shared
source fix preserves the chain of exact API, original/decodable tuple, and
hash reload, with URL deduplication and account/identity/restriction checks.
The controlled case previously reached a roughly 15-second failure; the fixed
case obtained playable data in under 100 ms. This is source selection, not
the retained-upload file binding. Both affected live records in this network
investigation had empty original tuple URLs, so that controlled fix is not
evidence that their unavailable CDN segments are repaired.

A verified retained original can play without downloading VK segments. That
file-persistence path remains separate from these network and candidate tests.
Old imports are not reconstructed from title or artist, and one manually
associated original does not validate all other imports.

The [VK X APK inspection](apk-playback-reference.md#follow-up-inspection-2026-10-22)
supports a native HTTP, resolving-datasource and bounded-cache architecture.
The traced playback chain does not establish that a localhost relay or an
official-client User-Agent spoof is required. Its byte-range handling and
same-item source resolution are useful clean-room patterns; APK implementation
code and credentials were not copied.

All live network observations here were on Windows. They do not establish
WKWebView behavior or audible playback on a physical Mac. Shared code should
remain shared across Windows and macOS, with target builds and runtime checks
reported separately. Android support is not implemented or validated.
