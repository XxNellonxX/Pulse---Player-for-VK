# VK session bridge and API access evidence

Checked 20 October 2026 against VK's public documentation and publicly served
website JavaScript. No account credentials, user tokens or third-party application
credentials were used for this source audit. Public source compatibility and
controlled tests do not establish a successful real-account round trip.

## Default connection: the official website session

The current default has no VK OAuth client ID. Instead, the user signs into the
official VK Music page in the application's persistent WebView2 profile. Native
code evaluates a fixed, session-bound adapter only on the top-level
`https://vk.com` and `https://vk.ru` origins. The remote window receives no Tauri
IPC permissions. The adapter uses the site's own `ajax.post` client; it does not
read or export cookies, account passwords or OAuth tokens.

The website's public bundles supplied concrete schemas and entry points:

- [VK Music](https://vk.com/audio) includes
  [audio.cb3b45b1.js](https://st7-6.vk.ru/dist/web/audio.cb3b45b1.js).
  `AudioPage.loadPlaylists` requests `al_audio.php?act=owner_playlists` with
  `owner_id`, `offset` and `is_attach`, receiving playlist records and a total.
  Its normal page size is 50. Playlist cards also use snake-case fields and an `original_identity` for followed sources. The adapter reads the original source identity and, when needed, its resource key from a matching official playlist link. Resource keys remain in the site runtime. String `thumb` covers are supported.
- [audioplayer-lib.37272c14.js](https://st7-6.vk.ru/dist/web/chunks/audioplayer-lib.37272c14.js)
  defines the site's playlist loader: `al_audio.php` with `act=load_section`,
  `type=playlist`, `owner_id`, `playlist_id`, `access_hash`, `offset` and
  `is_loading_all=1`. The response contains `list` and `totalCount`.
  `AudioPlaylist.DEFAULT_PLAYLIST_ID` is `-1` for the owner's library. The
  adapter advances numeric offsets by raw occurrence counts and checks a stable
  total, valid identities and repeated whole-page fingerprints. VK can return
  duplicate track occurrences within a playlist or across distinct pages. Their
  order is preserved in playlist membership while the shared track registry uses
  unique identities. The site's full loader itself concatenates raw page arrays.
  Every playlist's membership is read separately; visible DOM rows are not
  treated as a complete library.
- [common.fcedce56.js](https://st7-6.vk.ru/dist/web/chunks/common.fcedce56.js)
  defines `AUDIO_PLAYER_ENUMS` / `EAudioTupleIndex`: audio ID 0, owner 1, title 3,
  performer 4, duration 5, cover 14, album 19, restriction 21, access key 24.
- [common_web.3a4e23b9.js](https://st7-6.vk.ru/dist/web/common_web.3a4e23b9.js)
  exports `window.getAudioPlayer`. The audio-player bundle defines `play`,
  `pause`, `resume`, `seekToTime`, `setVolume`, current-source/progress getters,
  and `ended` / `failed` events. Playback now uses separate HTMLAudio/HLS inside the official document;
  React receives stable `vk-web://owner/audio` identities, not stream URLs.

These are undocumented website interfaces and their hashed filenames can change.
The adapter keeps raw tuples, playback URLs and site request hashes inside the
website runtime. Native code accepts bounded metadata, validates identities and
playlist references, scopes results to the active run/account and commits only a
complete snapshot. Missing/contradictory counts, duplicate pages, request failures
and timeouts produce an error instead of replacing the cache with a partial set.

Implemented in this route: automatic library/playlist import after login,
playlist membership, saved metadata/artwork, and playback control from Pulse.
Global catalog search, uploads and remote library/playlist mutations are not
implemented for this route. Site restrictions, subscription requirements,
CAPTCHA and advertisements remain under the site's control. No DRM, CAPTCHA or
subscription bypass is part of this adapter.

The public [Music-M repository](https://github.com/Kitsunex-glitch/Music-M) was
also inspected. `MusicX.Core/Services/VkService.cs` and
`VkNet.AudioBypassService/Flows/VkAndroidAuthorizationBase.cs` use a separate
mobile authorization flow, not this website bridge. Its bundled client
credentials and mobile-device emulation were not copied.

## Updating an already signed-in installation

Quit the old Pulse process, including its tray instance, then install and launch
the updated build. The existing WebView2 profile is reused; cookies do not need to
be exported or copied. In Settings → VK Account, open the VK Music window. If the
website retained its login, opening its Music section and starting a fresh sync
should be sufficient. A disconnected/error state can start a new run through
Connect; a connected account exposes Synchronize. Closing the VK window hides
it while independent audio playback and synchronization remain available.

The previous build intentionally opened an isolated official window with no
import bridge. Signing into that window alone therefore could not populate the
custom UI. The new collector is injected by the updated native application; a
still-running old executable cannot acquire it without restarting.

## Separate OAuth route: registration requirements

The remaining sections apply to the optional direct-API OAuth implementation,
not the default session bridge above.

[Create and configure an application](https://id.vk.com/about/business/go/docs/ru/vkid/latest/vk-id/connection/create-application)
states that the developer creates an application in the VK ID dashboard, which
generates the application's `client_id`. Registration assumes a VK Business ID
business profile. The page currently says that a new unverified profile has 60 days
after creation of the first application before applications are blocked. Profile
verification is also required for full access to settings and keys.

This is separate from an end user signing into an already registered app. An app
cannot derive its own registered client ID from the user's VK account. A released
app can bundle its public client ID so its users need only sign in; this repository
currently has no registered client ID in `src-tauri/vk-config.json`.

## Redirect compatibility must be established before claiming login works

The same page requires a registered trusted redirect URL matching the base domain.
Its local testing instructions explicitly say:

> «http://localhost:80»
>
> «Доверенный redirect URL пропишите с http и без порта — http://localhost»
>
> «Другие порты временно не поддерживаются»

The repository's original `http://127.0.0.1:49281/callback` default was not proven
compatible with this current registration flow. The Tauri default now uses
`http://localhost`; the callback accepts its exact root path and verifies Host and
state. The implementation's PKCE/state tests establish local correctness; they do
not establish registration or a successful VK round trip. A registered application
and an actual callback round trip are required.

## VK ID login does not prove music permissions

[User access scopes](https://id.vk.com/about/business/go/docs/ru/vkid/latest/vk-id/connection/work-with-user-info/scopes)
currently documents `vkid.personal_info`, `email` and `phone`. The table does not
document an audio grant. `vkid.personal_info` covers surname, first name, sex,
profile image and date of birth.

[VK authorization overview](https://id.vk.com/about/business/go/docs/ru/vkid/latest/oauth-vk)
states that new user access tokens are obtained through VK ID OAuth, and that
previously created legacy VK OAuth applications remain supported. This does not
establish that a newly registered client can use every VK API method.

[Access token documentation](https://id.vk.com/about/business/go/docs/ru/vkid/latest/vk-id/connection/tokens/access-token)
documents Authorization Code + PKCE, a one-hour access-token lifetime and refresh
tokens. It does not document a general token exchange that grants music rights.

The official `https://dev.vk.com/ru/method/audio.get` URL redirected to
`https://dev.vk.ru/ru/method/audio.get` and returned a VK documentation 404 page in
this check. A missing page is not proof that the method fails for every client.
It means this source does not establish current public access requirements.

## Product acceptance boundary

The adapter and native bridge have controlled tests for pagination, metadata,
  partial failures, legitimate repeated occurrences, logout/account changes,
  stale callbacks and playback commands.
These tests demonstrate local behavior with those supplied schemas; they do not
prove live VK compatibility or the completeness of a particular user's account.

Before claiming real-account validation, use the updated build with the user's
normal login, compare the imported library and all playlist memberships against
the account, exercise a multi-page library and play real tracks through the site
transport. A refreshed session and application restart also need a real-account
check. A live saved-session import on 20 October 2026 read 4,685 library entries, 78 playlist cards and 20,059 unique tracks including playlist-only items. One saved source returned explicit `false` with `permissions.play=false`; its metadata is retained as an unavailable-content placeholder, with its declared 159 tracks not falsely claimed as imported. The source/followed alias distinction, legitimate duplicate occurrences and string cover URL were corrected from this live result. No passwords, session cookies or OAuth tokens were read or exported. This confirms this account’s import at that time; it is not a guarantee about future website compatibility. The earlier delegated-playback release played a real VK track after the official ad, advanced beyond29 seconds and accepted Pause. This historical release has since been replaced by the independent transport below. An explicit autoplay policy on the dedicated VK WebView carries Pulse’s user playback intent across the separate documents; that older release waited for advertisements. The current transport does not invoke that advertising player. App restart retained the signed-in account and cached catalog. These live checks are separate from the synthetic native WAV transport checks.

For the separate direct-API route, validate a token issued to this application
against the real music methods. A successful VK ID callback does not establish
audio access. Remote write features additionally require a successful operation
and subsequent read-back; playlist edits are not implemented by the session bridge; original-file uploads use the separately validated form flow below.

The 20 October order/window update was installed and checked against the saved
live account: all 4,685 library identities matched the official source sequence,
and all 120 initially rendered rows matched it too. Native window inspection
confirmed one hidden VK window and one visible player window both before and
after restarting the installed release. The temporary diagnostic port was then
closed. Independent controlled checks cover nine renderer order scenarios and
eleven native scenarios, including hiding before a held import completes and
real WAV playback while hidden. Overlapping main-library pages are rejected
without replacing the prior complete cache; repeated playlist occurrences remain
supported. The order is the sequence returned by VK, not a reconstructed date of
addition. Offset pagination cannot prove an atomic snapshot if the collection is
being changed concurrently without a source revision identifier.


## Original-file upload and independent playback update

The official upload form was inspected read-only in the saved live session. The fixed adapter parses initUpload arguments as data and never executes response scripts. Original file bytes are transferred in bounded chunks into the official WebView and submitted as FormData. Upload destinations, signatures and edit hashes stay in that page. Native code binds the batch to account, window and navigation, serializes imports before the file picker, validates MPEG and checks content duplicates. A confirmed mutation forces a new sync generation; old in-flight imports cannot overwrite the new result.

Controlled native tests upload a real generated MP3 in multiple chunks and verify SHA-256 equality, ID3 metadata preservation, fresh source order, malformed-file rejection and uncertain-save handling. These synthetic writes do not publish files to the user's real account. Independent UI tests cover partial errors, duplicate clicks, logout and account changes.

The direct transport resolves sources with the site's own URL resolver and pure source factory, then uses its own Audio element and bundled hls.js. It does not invoke the site's play or ad scheduler and has no fallback to them. Raw sources stay in the official page. A saved real-account track was played and advanced with this transport; controlled tests verify zero official play calls. Restricted/unsupported/DRM sources fail explicitly.

URL import accepts original direct audio, author-enabled SoundCloud downloads and a single YouTube video. The pinned yt-dlp/FFmpeg/Deno runner supports a user-supplied proxy, bounded processes and isolated temporary files. A real19-second YouTube video was downloaded as an original Opus track, played through the native asset protocol and restored after restart. A separate MP3 320k conversion was verified. SoundCloud original parsing is controlled-tested; a live SoundCloud request was unavailable on the current route, so live original download is not claimed.

The two MP3 files previously selected by the user were then uploaded to the real
account through the installed release. Both saves were confirmed and read back
at the top of the source sequence; the filename-derived metadata of the untagged
file was corrected through the official edit form without re-uploading it. Three
real tracks advanced and paused through the independent transport, with zero
calls to the official play entry point and no advertising reported. The artifact
`qa/installed-upload-playback-result.json` records counts and booleans only. Its
historical mutating script now requires explicit opt-in to prevent accidental
repeat uploads.

A repeatable read-only acceptance, `qa/installed-final-readonly.mjs`, compares the
complete native track registry, main-library sequence, normalized titles/artists,
playlist metadata and every available membership against the official page's
snapshot. On20 October it checked4,696 library entries,20,070 unique tracks,
78 playlist cards and120 rendered rows. The two previously uploaded MP3s were
present with their expected metadata. One playlist remains explicitly restricted
by VK; this is not reported as a successfully imported empty playlist.

After the final metadata fixes, all58 Rust checks and five isolated native upload
scenarios passed. The latter include an artist-only ID3 tag and a genuine ID3
title equal to the filename stem, and verify original-byte SHA-256 equality.
The final installer was applied and the complete read-only live acceptance
passed again after restart. Package hashes are in `qa/installed-package-proof.json`;
the installed executable differs from Cargo's output only in Tauri's three-byte
NSIS bundle-type marker. It is then restarted without diagnostic browser flags.
