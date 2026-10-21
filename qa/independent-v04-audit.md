# Independent release audit — 0.4.0 working tree

The reviewer edited QA code only and did not change the user's installed player,
VK account, files, library, playlists or follows. Native tests refused to run
unless `assert-isolated-native.mjs` confirmed a debug QA binary named **VK Player
QA**. Temporary profiles and an intercepted synthetic VK page were used. The
full native verification used the debug build from 21 October 2026, 19:35 local
time. A subsequent targeted notification check passed on the 19:40:57 debug
build. No unresolved actionable issue remained in these tested scenarios.

## Independently discovered defects verified as fixed

- An uploaded MP3 with a valid session URL but no reload hashes could wait on an
  indefinitely pending website resolver instead of playing its valid URL.
- A broken preferred progressive source could spend the full load budget,
  preventing a valid fallback from receiving a fair attempt.
- Neutral EQ amplified a test tone by about 7.7% through compression; a preamp-only
  attenuation initially had the same problem. Neutral bypass and -6 dB output
  were subsequently measured as correct with real OfflineAudioContext PCM.
- Local file selection accepted a half-truncated MP3 as an available 30-second
  track, trusting a stale Xing header. The final build rejects it. This defect
  was distinct from the already protected VK/URL upload path.

## Final native upload and import verification

`node qa/tauri-vk-upload.mjs`: **5 / 5 PASS** on the final build.

- Real generated MP3 crosses chunk boundaries and uploads byte-for-byte.
- Title/artist tags survive, renamed duplicate is skipped, corrupt file fails.
- Confirmed upload appears first in the authoritative VK snapshot.
- Lost save confirmation returns uncertain instead of claiming success.
- Artist-only tags use the filename title fallback, while a real tagged title
  equal to the filename stem is preserved without an incorrect split.
- Existing local playable files remain after upload.

`node qa/tauri-vk-upload-formats-independent.mjs`: **6 / 6 PASS** on the final build.

- Real FLAC and variable-rate raw AAC become complete MP3 files for VK; each
  received output is independently inspected with the packaged FFprobe.
- Truncated and corrupt MP3 files fail individually and never reach transfer or
  save, while valid files in the same batch succeed.
- Original source SHA-256 hashes remain unchanged, and FLAC tags are retained.
- Confirmed identities and order are correct. The uploaded MP3 actually plays
  and its clock advances despite a deliberately stuck website `_ensureHasURL`.
- Local FLAC and raw AAC actually advance WebView2 playback, rather than merely
  being marked available in the library.
- The local picker rejects the truncated MP3, and repeat imports retain the same
  two track identities without duplicates. Original hashes and saved identities
  survive a renderer reload.

`node qa/tauri-vk-upload-formats-independent.mjs --notice-only`: **1 / 1 PASS**
after the renderer notice listener was connected. The actual native event shows
an error notification containing `Не удалось добавить файлов: 2` and the full
truncation reason. Only the two valid files are saved, and the close button
removes the notification. The full suite includes this visibility assertion too.

Receipts are written to `qa/tauri-vk-upload-results.json` and
`qa/tauri-vk-upload-formats-independent-results.json`, with the targeted receipt
in `qa/tauri-vk-upload-notice-independent-results.json`. Source fixtures are real
FFmpeg-generated audio, never fabricated MP3 headers.

## Equalizer and transport evidence

- The isolated source/resolver and CORS probe Node suites passed **20 / 20**.
- EQ UI was exercised at 960 and 1440 pixels in all 15 themes, including custom
  curves, presets, keyboard controls, saved values and malformed settings.
- OfflineAudioContext PCM covers neutral, disabled, spectral changes, -6 dB
  attenuation, peak safety, low sample rates and AudioContext lifecycle.
- Four browser CORS scenarios passed. A readable source has nonzero post-EQ
  AudioWorklet PCM; denied readability preserves ordinary media playback; EQ-off
  avoids capture; enabling EQ on an existing non-CORS source preserves playback
  and reports that processing cannot yet be applied.
- Generated HLS baseline and worker paths were measured for 22.25 seconds with
  no large discontinuities and a maximum silent sample run of 0.020833 ms. A
  deliberately injected 80 ms silent gap was detected as a positive control.

Related scripts: `qa/equalizer-source-independent.node.mjs`,
`qa/equalizer-cors-probe.node.mjs`, `qa/equalizer-ui-independent.mjs`,
`qa/equalizer-dsp-independent.mjs`, `qa/equalizer-cors-independent.mjs` and
`qa/hls-pcm-continuity-independent.mjs`.

## Limits of this evidence

Synthetic VK tests prove application behavior against controlled responses, not
a successful write to the live account or compatibility with every future VK
change. The CORS negative test intentionally aborts the readability fetch because
response interception does not consistently enforce missing CORS headers; it
does not establish the policy of a real VK CDN. Playback clock checks prove that
native decoding starts and progresses; detailed continuity comes from the
separate generated PCM measurements.

The HLS outage test exercises recovery, but its timeline may skip an unavailable
segment. It is not evidence of uninterrupted audio during an actual network
outage. No test can guarantee that network media will never stall. Physical Mac
behavior, live protected services, and future session expiry remain outside this
independent Windows audit.
