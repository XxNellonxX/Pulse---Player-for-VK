# Saved session and incremental music cache

The WebView2 profile remains on disk between normal closes. The app reuses
that profile until VK revokes/expires it or the user explicitly disconnects.
No application can promise that VK will accept a session forever.

The saved native catalog is rendered first. An absent identity while the VK
page loads does not erase it. The app enables authenticated controls only
after the live page confirms an account; a different confirmed account clears
the old account's catalog. Explicit Disconnect still purges the catalog and
rotates the WebView profile. Temporary offline/expired-session state permits
cached browsing without falsely claiming to be authenticated.

After account confirmation, synchronization reads the authoritative personal
library pages and playlist-card index. Own-library pages are necessary to
preserve VK order and detect deletions without a trustworthy delta endpoint.
Playlist contents are reused when their bounded public metadata fingerprint
matches a recently verified cache entry. Changed, missing, inaccessible, or
older-than-ten-minute entries are fetched. A five-minute background check
reconciles changes; the Refresh button requests complete verification. Hidden
WebView timer throttling and network failures can delay background checks.

VK does not always expose a revision for a playlist. A same-count interior
edit whose card metadata does not change can remain cached for up to ten
minutes (then until the next successful background check). This is deliberate
bounded revalidation rather than a claim of a perfect server-side delta feed.
Installing this change over an existing catalog needs one full composition
check to create the public fingerprint index; the existing UI stays usable.

The small `vk-web-cache-index.json` contains account-scoped playlist public
fingerprints/check times only. Raw audio tuples, resource hashes, signed media
URLs, cookies, and tokens are never persisted there. A cached playlist-only
track obtains a current raw tuple from its playlist on demand; an offset move
falls back to reading that collection only. A pinned global-search track
resolves again by query and exact identity, failing explicitly if VK no longer
returns it. Search playback and source acquisition remain subject to VK access.

Native commits compare substantive metadata and ignore playlist check times.
An unchanged catalog does not rewrite or resend the full library. Local data
and the latest bounded result set plus pinned global search results survive a background reconciliation; deleted
personal-library tracks are still removed, including stale references.

Verification: `node --test qa/vk-cache-delta.node.mjs` passes eight isolated
tests: warm reuse, exact deletions/order, changed/stale/full revalidation,
account isolation, lazy playback, account switch during lazy lookup, and global
search tuple retention/recovery. Existing adapter suites pass 54 tests. Rust
tests cover account/cache clearing, public index sanitization, no-op check
times and search retention; the final full Rust suite passed 69 tests. These use
synthetic endpoint fixtures and do not mutate the user's VK library.
