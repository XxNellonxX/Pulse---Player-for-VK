# Independent web-session QA

These probes treat the official site's state as mutable and untrusted to the
adapter. They are intended to catch failures a successful small-library demo
does not expose. They use an isolated synthetic runtime, never the user's web
profile, cookies, access tokens, or logged-in process.

- A library page repeats the preceding page while claiming more results. The
  adapter must terminate without declaring the duplicated subset complete.
- Totals shrink, grow, or switch type halfway through pagination. Ambiguous
  results must not replace the last complete native library.
- A playlist card page repeats an ID with changed metadata. It must not inflate
  the playlist count or silently omit another playlist.
- A playlist references tracks absent from the main library, including a
  restricted track without a playable URL. Preserve its identity and declared
  availability; avoid inventing playable audio.
- The account changes while one callback is pending. Reject every mixed-account
  snapshot, including callbacks from the prior run that arrive after a restart.
- Navigation replaces the document between request and response. Native code
  must reject an evaluation result tied to the obsolete document/session.
- A timeout is followed by a valid late callback. It must not complete the
  expired run or overwrite a newer result.
- The official player plays a different track from the requested ID, declines
  playback, or pauses while a command is pending. Pulse must reflect the actual
  state, and must not report command dispatch as confirmed playback.
- A stream pauses/ends/errors during a queue edit or local/remote source switch.
  Only the current source may advance the queue or update saved position.
- The user disconnects while sync or playback polling is in flight. No later
  callback may restore the account or continue official playback.

Native checks must include a complete successful sync followed by a partial
failure. The old remote cache must remain intact until the new snapshot is
validated as complete and tied to one account.
