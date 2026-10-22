# VK X playback reference

Read-only inspection on 2026-10-20 of the user-supplied `VKX_8.14.2_pub_100150.apk`. The APK was not installed or executed. This note records architecture and numeric configuration; no application source, authentication material, or media URLs were copied into this project. Obfuscated names below identify evidence in that exact APK and are not stable API names.

## Observed implementation

- **Engine:** AndroidX Media3 / ExoPlayer **1.11.1**. `classes.dex` contains the runtime version marker and module registrations for `media3.exoplayer`, `media3.exoplayer.hls`, `media3.datasource.okhttp`, `media3.session`, and `media3.database`. `classes3.dex`, `Lzؚؚ۠;->ads(Context, Lzًّؐ;, Lzٕٚؗ;, Function0, Function0, Lzؙ٘ۗ;)Lzٗٛؕ;` constructs the player and wires its transport. HLS support is present as `androidx.media3.exoplayer.hls.HlsMediaSource$Factory`.
- **Forward loading:** that player factory explicitly configures the Media3 load control with minimum buffer **480,000 ms**, maximum **600,000 ms**, initial playback threshold **2,500 ms**, rebuffer threshold **5,000 ms**, and back buffer **60,000 ms**. It prioritizes time over size thresholds. `classes.dex`, `Lzؙؖؖ;` identifies the corresponding load-control fields through its validation strings. Its allocator uses **1,048,576-byte** segments. These are configured targets, not proof that every source is fully buffered before playback.
- **Disk cache:** `classes.dex`, `Lzَۦؕ;->Signature(Context)` creates the Media3 `SimpleCache` implementation (`Lzٕٚؗ;`) in the application cache directory `oc_exocache2`, backed by `exoplayer_internal.db`, and passes it into the playback controller. `Lzؙۥَ;->Signature(Lzٕٚؗ;, long)` evicts spans while cached bytes plus incoming bytes exceed **134,217,728 bytes (128 MiB)**. `classes3.dex`, the player factory and `Lz٘ؒٓ;->subs()` wire this cache to the upstream datasource and `CacheDataSink`. The sink fragment size in this factory is **-1**, rather than the library default of 5 MiB.
- **HTTP transport:** the player factory supplies the request header **`Accept-Encoding: identity`** to its OkHttp datasource factory. This is consistent with uncompressed, byte-addressable media requests. It is not an access-control bypass and does not prove a fix for a browser ORB rejection.
- **Retry policy:** the factory explicitly constructs the Media3 error policy represented by `Lzؙْٝ;` with a minimum load-retry value **3**. The constructor's second integer **6** is an obfuscator class discriminator, not a retry count. `classes.dex`, `Lzؙْٝ;->admob(Lzٌۙ۟;)long` returns retry delay **min((errorCount - 1) × 1,000 ms, 5,000 ms)** for eligible errors, and a no-retry sentinel for terminal error categories. `->vip(...)` contains HTTP 403/404/410/416/500/503 fallback exclusions of **300,000 ms** for one fallback category and **60,000 ms** for the other when alternatives exist. These are temporary exclusion periods, not retry delays; the exact fallback-category enum names were not independently resolved.

## Applicable decisions for the Windows player

The useful pattern is a separate media transport with explicit forward loading, bounded caching, bounded retries, and recovery at the current playback position. Increasing a UI stall timeout does not implement any of these mechanisms. Browser `Audio.preload = auto` also does not guarantee a chosen forward-buffer duration.

For HLS/MSE, use an audio-appropriate forward-buffer target and a bounded back buffer, then measure actual buffered seconds, recovery, and memory consumption. Do not blindly copy the Android app's eight-to-ten-minute RAM target into Windows WebView2: engine memory accounting and cache placement differ. A larger forward target does not fix an invalid, expired, unsupported, or blocked media response; those need source validation and a bounded refresh of session-provided source alternatives.

No APK evidence here establishes a universal no-stall guarantee, source-priority order, or recovery on the exact Windows track that failed. Those require independent Windows tests with transient network failures, mid-track source expiry, pause/seek/switch races, and a real track played through its end.

## Follow-up inspection: 2026-10-22

The newly supplied APK ending in `(1).apk` is byte-for-byte identical to the
previous file. Both have SHA-256
`56c33336b347d7126227174b34d2cf92f6d9d43d0e70c78638903f305cb64b92`.
The file was inspected statically, never installed or executed. The additional
inspection followed the playback service into its datasource factories and
URI resolver; the presence of an unused library alone is not treated as
evidence that a feature runs during playback.

### What the actual playback wiring shows

`Lua/itaysonlab/vkxreborn/playback/service/PlaybackService;->yandex()` passes
the shared HTTP client and cache into the previously identified
`Lzؚؚ۠;->ads(...)` player factory. The factory constructs an OkHttp datasource
factory (`Lzَْؗ;`), a context-aware datasource, resolving datasource wrappers
(`Lzٌۦٜ;`), and the cache datasource (`Lz٘ؒٓ;`). Its final `Lzؙؙُ;` resolver
can use an existing local `CachedTrack` while preserving the original item.

`Lzَْؗ;->subs()` creates `Lzِ۠ؑ;`, the OkHttp datasource. In
`Lzِ۠ؑ;->ads(DataSpec)` the datasource builds an HTTP request directly from
the resolved `DataSpec` URI, merges its request properties and per-item
headers, adds a `Range` header for offset/length requests, and calls its
HTTP client. It explicitly handles response length, `Content-Range`, and
HTTP 416. The response is consumed as an `InputStream`; this observed path
does not rewrite every media URI to a localhost HTTP URL.

There are resolving wrappers around that datasource, including one that can
add an `Authorization` value obtained from a runtime callback. A header name
alone does not establish what credential is used, which origin it belongs
to, or that desktop session cookies should be sent to every CDN. No
credential values were copied or incorporated into Pulse.

### Source resolution

The app uses a private `vkx` URI scheme with two path components. The
`Lzؑٗۡ;->loadAd(DataSpec)` resolving step recognizes that scheme and invokes
the coroutine represented by `Lzٖؕؗ;`, which calls the URI resolver
`Lzؔٚٚ;->Signature(Uri, Continuation)` before constructing a replacement
`DataSpec`. Its original byte offset, length, headers and cache-key field are
carried into that replacement.

The `vk` provider is registered in `Lzَۦؕ;->Signature(Context)`. Its provider,
`Lzؕۨۜ;->Signature(String, Continuation)`, requests an exact audio identity
using `Lzٖۧؕ;-><init>(String[])`. That constructor configures
`audio.getById` with the `audios` parameter. The provider selects the returned
`AudioTrack` URL. This establishes on-demand same-item resolution in this
path, but does **not** by itself prove a special refresh specifically
triggered by a 403 response, or that its API session returns the same URL as
the desktop website session.

### Local proxy and User-Agent claims

The APK does include Ktor server code, general `localhost` strings and
network-proxy settings/models, including `VkConfigNetworkProxyProduct`.
The inspected localhost references resolve to generic Ktor client/server
initialization and logging. They do **not** establish that the normal audio
chain starts a loopback HTTP relay. The directly traced playback chain above
uses native HTTP/resolving/cache datasources. A loopback relay remains a
possible desktop implementation technique, not a confirmed requirement
copied from this APK.

The media factory explicitly supplies `Accept-Encoding: identity`; the
datasource also enforces it for requests that do not permit compression.
No explicit official-client User-Agent is set in that factory. The DEX files
contain generic User-Agent handling elsewhere, but no plaintext
`VKAndroidApp/...` marker was found. This is not proof that the upstream
shared HTTP client never adds a computed header. An official-client header
spoof or a universal bandwidth-throttling explanation is **not established**
by this inspection and must not be reported as a measured cause.

### Clean-room implications for Pulse

The applicable pattern is a native, byte-range-aware downloader behind a
stable track identity, with bounded cache and forward loading. It can be
exposed through a loopback relay or a native asset protocol on desktop if
live comparisons show an advantage over WebView networking. HLS segment
formats must remain supported by the decoder/transmuxer; concatenating TS
bytes and calling the result MP3 is not a valid generic conversion.

No license granting reuse of VK X's application implementation was
established. Bundled third-party notices do not establish a license for the
entire application. No decompiled application source, keys, endpoint
credentials, or vendor proxy configurations were copied into production.
Any implementation should be written independently and validated against
actual response statuses, first-byte timing, byte throughput, and full-track
playback for the failing imported tracks.
