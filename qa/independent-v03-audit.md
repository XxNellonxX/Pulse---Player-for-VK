# Independent product audit — 0.3.0 working tree

Tested through a headless Chromium browser against the running frontend at `127.0.0.1:5173`, with an isolated synthetic desktop bridge. No user profile, credentials, library, playlists or follows were modified. These checks validate frontend behavior and contracts; they do not claim to confirm a live VK write or uninterrupted real audio.

The independent reviewer did not edit production files. Five reproducible defects were reported to the implementing agent and then verified as fixed:

1. Back navigation lost a library scroll position after entering an empty section, because it recorded the already clamped DOM scroll value.
2. A confirmed add with VK's canonical owned identity removed the row plus but left a second add action in the context menu.
3. Artist tracks kept their local success check after a subsequent authoritative snapshot removed the owned track.
4. Playlist save failure showed a toast underneath the modal backdrop, leaving no visible error inside the editor.
5. Returning to an artist card lost its scroll position when the card data arrived after the initial skeleton had rendered. The follow-up check also confirmed that a user's manual scroll cancels delayed restoration.

The final complete run passed **23 / 23** scenarios. The script is `qa/independent-v03-flows.mjs`, and machine-readable results are in `qa/independent-v03-results.json`. Notification expiry was checked with browser clock control: present at 6999ms and gone after 7001ms.

Coverage includes mouse Back/Forward and branching history; restored scroll; coalesced search edits; busy modal Escape protection; failed and unconfirmed playlist save; exact ordered create payload; edit metadata preservation; foreign playlist protection; duplicate add suppression and canonical identity; failure retry; notification close and seven-second expiry; artist metrics, EP sections and release links; artist pause; no refetch churn on playback updates; late result rejection; account-change remount; membership removal; VK snippet bounds and stop; 900px composer layout; actual buffered ranges, keyboard seek and offline status.

Screenshots inspected visually:

- `qa/artifacts/independent-v03-final-composer-900.png`
- `qa/artifacts/independent-v03-playlist-failure.png`
- `qa/artifacts/independent-v03-final-artist-top.png`
- `qa/artifacts/independent-v03-final-buffered-network.png`

No unresolved actionable frontend defect remained in the scenarios tested. External VK changes and network/audio behavior require separate installed-app and transport verification.
