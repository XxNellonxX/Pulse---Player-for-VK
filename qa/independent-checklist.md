# Independent adversarial QA checklist

This checklist is intentionally independent from the product specification. It targets failures that can look fine in a happy-path demo but damage user state, playback continuity, or VK synchronization.

## Queue and playback races

- Spam Next/Previous/Play-Pause (20+ events) while a stream is buffering; verify only the final intent wins and stale callbacks cannot replace the selected track.
- Reorder, remove, clear, and add items while the current track changes; verify no orphaned current ID and no duplicate queue entries.
- Toggle shuffle/repeat while queue is exhausted and while a track ends; verify no duplicate replay and no skipped user-selected item.
- Seek before metadata/duration exists, then seek again after metadata; verify progress never becomes NaN or jumps to a stale track.
- Start a track, close/minimize, wake from sleep, and change output device; verify playback state and media controls remain coherent.
- Trigger a stream failure repeatedly; verify bounded retry/backoff and a visible actionable error, never an infinite skip loop.

## Persistence and corruption

- Kill the process during queue/settings write; restart and verify the last atomic snapshot is readable and consistent.
- Replace local persisted data with truncated JSON, invalid UTF-8, unknown fields, duplicate IDs, or an older schema; verify migration/recovery preserves valid state and reports repair.
- Restart repeatedly with a queue containing 0, 1, 10,000 items; verify order, current ID, position, volume, repeat, and shuffle state.
- Change theme/layout during playback and restart; verify theme failure cannot prevent the app or queue from opening.

## Offline and auth expiry

- Cut network during search, metadata load, cover load, and playback; restore it after short and long outages. Verify requests settle and retry is bounded.
- Expire/revoke the token during an in-flight read/write; verify one re-auth prompt, no duplicate mutations, and no token/cookie leakage in logs.
- Return 401/403/429/5xx in succession; verify each maps to a distinct user action and no retry storm.
- Log out while upload/sync/playback is active; verify cancellation/rollback is explicit and stale callbacks cannot mutate the next account.

## Import and VK sync edge cases

- Import the same local file twice, including renamed copies with identical content; verify duplicate policy is deterministic and remote IDs are not fabricated.
- Upload interruption at each phase (before upload, mid-upload, after remote creation, before read-back); retry and verify idempotency.
- Apply remote deletion/reorder while a local list is open; refresh/paginate and verify no duplicates, stale rows, or destructive overwrite.
- Paginate through an empty page, repeated cursor, and malformed item; verify the UI terminates and keeps prior valid results.

## UX and accessibility stress

- Rapidly navigate sections while loading; verify stale requests cannot paint the wrong screen.
- Resize 1280x720 at 100%, 1920x1080 at 150%, 2560x1440 at 200%; verify controls remain reachable and no horizontal clipping hides actions.
- Navigate all primary controls by keyboard alone; verify visible focus, stable tab order, and no focus trapped in a closed panel.
- Exercise empty, loading, offline, unauthorized, unsupported, and error states; verify they are visually distinct and provide a next action.
- Use long/RTL/unicode titles, very long artist names, missing art, and malformed metadata; verify truncation is safe and rows remain actionable.

## Severity

- **P0:** data loss, token leakage, unbounded loop, or app cannot start.
- **P1:** playback/sync corruption or a common workflow is blocked with no safe recovery.
- **P2:** recoverable workflow defect, stale visual state, or accessibility break.
- **P3:** cosmetic or rare edge behavior with a clear workaround.
