# Audio engine options for Pulse

Research reviewed on 23 October 2026. This document proposes a separate
prototype; it does not report a shipped engine change or memory benchmark.
Windows 10/11 and macOS 14+ must retain the shared behavior. Android is planned.

## Current architecture and the browser boundary

`src/usePlayback.ts` plays local files and SoundCloud with `HTMLAudioElement`;
SoundCloud HLS uses `hls.js` where supported. The ten-band EQ runs in Web Audio
(`src/shared/audioEqualizer.js`). The legacy VK route controls audio in the
private VK WebView. Rust resolves sources, enforces account/session guards and
relays SoundCloud media through Tauri's custom protocol.

[Tauri's supported WebViews](https://v2.tauri.app/reference/webview-versions/)
and [Wry's platform documentation](https://docs.rs/wry/latest/wry/) specify
WebView2 on Windows and WKWebView on macOS. WebView2 uses Edge Chromium;
running Pulse does not require a Google Chrome browser window. Installing
Firefox does not switch Tauri/Wry to Firefox. The standard Windows backend
does not offer a Firefox engine selection.

Removing the browser **audio pipeline** can preserve Tauri and the existing
React interface. Removing Chromium **from the Windows interface too** would
require another UI/runtime architecture; choosing a native audio engine alone
does not accomplish that.

## Candidates

| Engine | Relevant capabilities | Work needed in Pulse | Assessment |
| --- | --- | --- | --- |
| libmpv, audio only | Asynchronous commands/events; network playback, seek, bounded demux cache; custom HTTP fields; libavfilter audio filters | Rust FFI adapter, private media transport, native EQ mapping, output/session integration, packaged DLL/dylib and dependencies | First candidate for a bounded native prototype |
| libVLC | Mature network/media playback, seek and buffering events; built-in multiband EQ API | Rust FFI adapter, native plugins/runtime packaging and loading, same transport/session work | Strong second candidate; compare measured behavior with libmpv |
| GStreamer | HLS demuxer, configurable `playbin`/`playbin3`, buffering messages, source setup, N-band EQ | Pipeline/plugin selection, Rust bindings, deployment on both systems, more pipeline ownership | Capable if custom pipelines become a product requirement |
| Rodio + Symphonia | Rust playback/output, seek on supported sources, MP3/AAC-LC and common audio containers | Implement HLS transport/demux orchestration, encrypted segments, reconnect and timeline handling; native DSP | Attractive for controlled/local audio; not a ready replacement for this network HLS stack |
| Windows Media Foundation/MediaPlayer + macOS AVPlayer | OS-native playback; Windows adaptive streaming supports HLS; AVPlayer supports local files and HLS | Two platform implementations behind one shared interface; consistent headers, buffering, errors, seeking and EQ require separate verification | Potentially small deployment footprint, highest platform-parity burden |

These are capability comparisons, not evidence that one uses less RAM in
Pulse. Codec/format/filter support depends on the exact packaged version and
build options. A decoder cannot repair an upstream 403/500, inaccessible CDN,
expired capability or missing source data.

## Proposed incremental prototype

1. Add one shared `AudioEngine` contract: load, play, pause, stop, seek, volume,
   EQ; events for position/duration, buffered ranges, underruns, ended and
   structured failures. Keep library/queue/shuffle/history logic shared.
2. Implement an audio-only libmpv adapter on a dedicated native control/event
   thread. Start with local test files, then approved SoundCloud HLS through
   the existing gateway. Keep the current engine available for controlled
   comparison until both supported targets pass.
3. Preserve the existing Rust source/session validation and bounded cache.
   `pulse-media://` and `http://pulse-media.localhost` are Tauri/WebView custom
   protocols, not ordinary HTTP servers that libmpv can automatically read.
   A native engine therefore needs a transport adapter. A bounded private
   loopback HTTP relay can reuse the guarded handler, with a random port,
   unguessable short-lived session path, strict methods/limits and no arbitrary
   upstream URLs. Stop/revoke it on account change. Never forward credentials
   or use mpv's general HTTP headers to spread authorization across CDN hosts.
4. Alternatively evaluate libmpv's custom read/seek callbacks. Its upstream
   header explicitly marks this API unstable and prohibits re-entering libmpv
   from callbacks. It also requires cancellation/lifetime ownership and testing
   that all HLS child resources use the guarded transport. It is not a
   drop-in registration of Tauri's existing protocol.
5. Disable video output, unnecessary user scripts/config loading and disk
   caching; explicitly bound demux cache/readahead. Transfer current EQ band
   frequencies, preamp/headroom and limiter behavior to native filters. Verify
   flat-profile output and preset changes rather than assuming a built-in EQ
   sounds identical. Native audio does not pass through the Web Audio graph.
6. Preserve Windows volume-mixer identity and media controls, then validate
   macOS output/device and sleep/resume behavior. Package audited dependencies
   for Windows x64 and macOS arm64/x64 from the same revision/version. Record
   actual build licenses; libmpv's permissive client header does not determine
   the license of its core or FFmpeg build.

Keep legacy VK WebView playback outside the first prototype. Moving it to a
native decoder requires a separately verified, authorized stream transport;
changing the decoder alone does not establish that VK URLs work independently.

## Evidence needed before selecting a default

Use the same deterministic MP3, AAC/HLS and encrypted HLS fixtures in each
engine, plus separately authorized live provider tests. Record startup to
first audio, underruns, buffered seconds, seek-to-audio time, repeat-track
cache hits, cancellation/account-switch behavior and per-process RSS/CPU.
Include rapid next/previous, shuffle, pause longer than capability validity,
network interruption/recovery, EQ changes, output-device changes and window
minimize/restore. Repeat on physical Windows and Mac hardware. A successful
decode-to-null test proves decoding, not continuous audible output or device
stability. No candidate was installed, integrated or benchmarked for this
research note.

## Primary references

- [Tauri WebView versions](https://v2.tauri.app/reference/webview-versions/)
  and [Wry platforms](https://docs.rs/wry/latest/wry/).
- [libmpv client API](https://github.com/mpv-player/mpv/blob/master/include/mpv/client.h),
  [custom stream callbacks](https://github.com/mpv-player/mpv/blob/master/include/mpv/stream_cb.h),
  [mpv options](https://github.com/mpv-player/mpv/blob/master/DOCS/man/options.rst)
  and [audio filters](https://github.com/mpv-player/mpv/blob/master/DOCS/man/af.rst).
- [LibVLC 3 playback/EQ API header](https://github.com/videolan/vlc/blob/3.0.x/include/vlc/libvlc_media_player.h).
- [GStreamer playbin](https://gstreamer.freedesktop.org/documentation/playback/playbin.html),
  [HLS demuxer](https://gstreamer.freedesktop.org/documentation/adaptivedemux2/hlsdemux2.html),
  [N-band EQ](https://gstreamer.freedesktop.org/documentation/equalizer/equalizer-nbands.html)
  and [platform installation](https://gstreamer.freedesktop.org/documentation/installing/index.html).
- [Rodio](https://docs.rs/rodio/latest/rodio/),
  [Rodio seek API](https://docs.rs/rodio/latest/rodio/struct.Player.html#method.try_seek)
  and [Symphonia formats/codecs](https://github.com/pdeljanov/Symphonia).
- [Windows adaptive streaming/HLS](https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/adaptive-streaming),
  [Media Foundation format support](https://learn.microsoft.com/en-us/windows/win32/medfound/supported-media-formats-in-media-foundation)
  and [Apple AVPlayer](https://developer.apple.com/documentation/avfoundation/avplayer).
