# Pulse 0.4.2 verification

Date: 2026-10-21. Production source: `6ee587e4e4e6b002b28ed7528d68beca5bb9fac7`.
This record distinguishes completed checks from outstanding platform checks.
No account identifiers, source URLs, credentials or machine-specific paths are
included in this report.

## Changes under verification

Pulse retains a private local copy of audio uploaded through the application.
The copy is associated only with the exact upload record confirmed by VK for
the same account. Failed or uncertain uploads do not establish this binding.
The persisted library item keeps its VK identity, membership, ordering and
canonical playback reference. The native resolver can return the retained
copy for playback without rewriting the library item as a local import.

Existing imports are not backfilled automatically. The track menu provides an
explicit action to choose an original audio file for an existing track in the
current account's VK library. The native file picker, audio validation and
account/membership checks establish this local association. This action does
not upload, replace or otherwise modify a VK record. It does not match files
to tracks by filename, title or artist.

The local playback path handles playback controls, seeking, snippets,
equalizer processing and media-session actions. Stale VK playback events
cannot overwrite the local source's state. A retained copy that becomes
unreadable falls back once to playback of the exact VK item. A missing or
invalid binding follows the ordinary VK path.

The shared transport and cache changes also address source-startup delays,
fallback ordering, and playback receipt polling that could consume a pending
catalog snapshot. Hidden VK WebView background throttling is disabled through
platform-specific integration. These changes do not establish that every VK
source or network connection is available.

## Automated checks completed

| Check | Result | Scope |
| --- | --- | --- |
| Rust | 93 passed, plus 4 native codec checks passed separately | Full default suite followed by the ignored codec suite using bundled ffmpeg/ffprobe |
| Node | 247 passed | Full `qa/*.node.mjs` suite, including independent cache/startup/recovery regressions |
| Vitest | 13 passed | Shared frontend unit tests |
| Retained upload playback harness | 10 passed | Actual React playback hook with isolated synthetic media/native bridge |
| Snippet and buffering harness | 8 passed | Existing React hook regression suite |
| Native retained-source tests | 5 passed | Included in the Rust total; exact receipt/account binding, restart persistence, rejected paths, corruption, removal and explicit file association |
| Isolated native upload integration | 7 passed | Real native upload/receipt/persistence path with a controlled VK fixture, exact retained-file SHA-256, real muted Audio playback and process restart after original files move |
| TypeScript | Passed | Shared frontend type checking |

The React harness results
exercise control flow and adverse event ordering; they do not measure audible
output or establish real VK/CDN availability.

The isolated native integration used synthetic upload responses, never a real
account mutation. Its retained file reached `canplay` and advanced the actual
media clock within three seconds, including after moving the original files
and restarting the native process. Restart performed no upload/save mutation.
An uncertain receipt, corrupt file, and renamed duplicate did not leave new
unverified retained copies. A normal renderer `fetch` of an asset is blocked
by `connect-src`; media playback is explicitly allowed by `media-src`. The
integration therefore tests the actual Audio decoder without weakening CSP.

Independent review of the explicit file-association path found no actionable
issue. It covered cancellation before staging, account checks after the
picker and at commit, current native ownership/membership, rollback after
failed persistence, and cleanup of an uncommitted managed copy. The playback
UI also rechecks the selected track and playback intent before restarting.

## Real Windows playback observation

A native 0.4.2 QA instance used an isolated copy of a profile. An original file
was explicitly selected for an existing own-library VK item in that QA copy.
No VK upload, deletion or other cloud mutation was performed for this check.

- First media-clock progress was observed after **299 ms**.
- The source reached a normal `ended` event at **146.866 seconds**.
- There were **0 observed `waiting`, `stalled` or media-error events** during
  that full-track run, with network access for the VK playback context offline.
- The selected MP3 and the retained managed copy had identical SHA-256 bytes.
- The saved library item retained its VK identity and `source: "vk"`.
- After a native process restart, the same stored binding resolved correctly;
  first progress was observed after **280 ms**, followed by another 11 seconds
  without interruption while the VK context was offline.

This demonstrates the retained-source path for the file and conditions tested.
It is not evidence that every imported track, file format, network source or
physical device will play without interruption. Retained-source resolution
currently requires confirmation of the active native VK account; this is not
a claim of unrestricted offline login.

Two separate real VK API/HLS source checks initially encountered a CDN request
that made no progress and reached a **25-second timeout**. The final transport
now also tries the website's separately granted same-track source after an API
delivery fails. In a real retest, one affected uploaded track still failed:
both routes supplied the same unavailable URL, so it was not downloaded twice.
The attempt ended after **4.7 seconds** rather than being reported as playback.
Successful local playback does not resolve that external source availability.

A separate real catalog track started after **572 ms**: its first candidate
failed decoding and a second candidate supplied playable audio. A repeat run
started after **577 ms** and reached `ended` at **207.36 seconds**, with no
`waiting`, `stalled`, recovery, or media-error event after playback began. A
normal background library refresh also ran near the end without stopping it.

## Platform and packaging status

The frontend in `src/` and Rust backend in `src-tauri/` are shared by Windows
10/11 and macOS 14+. The retained-source registry, validation, playback routing
and file-association behavior have no separate per-platform feature copies.
The application identifier and existing profile/data locations are preserved.

Windows native playback evidence above does not validate WKWebView behavior.
The 0.4.2 macOS Apple Silicon/Intel builds and physical-Mac login, playback,
import, persistence and update checks remain pending. Earlier successful macOS
builds do not establish compatibility or runtime behavior for this revision.
macOS remains an unsigned preview. Android support is not implemented and has
not been tested.

The Windows NSIS installer was built successfully. Its embedded executable
reports version **0.4.2**, product **VK Player**; the application identifier is
unchanged. The local installer is **107,366,826 bytes**, SHA-256:

`11ef8278ae8c8b92c676bfcf21ef7b9f623330cbb4bc6d7d7f4305ffa1091105`

macOS build verification for the same production revision was dispatched in
[GitHub Actions run 39651652274](https://github.com/XxNellonxX/Pulse---Player-for-VK/actions/runs/39651652274).
It remains pending until its result is explicitly recorded. Stable Windows and macOS packages
must use the same application version and source revision; experimental
unsigned previews remain separate prereleases.

## Remaining acceptance work

- Complete the macOS builds and clearly record unavailable physical-Mac checks.

No uninterrupted-playback or universal-import guarantee is made by this report.
