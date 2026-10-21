# Independent upload probes

These probes exercise user-visible outcomes and side effects. A request being
accepted by the bridge is not evidence that a track exists in VK.

| Probe | Required observation |
| --- | --- |
| Pick one valid MP3 from My Music | One official upload; confirmed remote identity appears in the authoritative library. Local import alone never reports VK success. |
| Cancel picker | No request, no new track, no success toast. Busy state clears. |
| Pick corrupt MP3 / renamed executable / empty file | Explicit per-file rejection; no remote mutation. |
| Batch valid, corrupt, valid | Confirmed files survive; failures are named; retry excludes successful files. |
| Double click, tray import while picker is open | One active native job. No second picker or duplicate remote write. |
| Upload succeeds but save fails | Explicit failure or uncertain result. No fabricated remote track. |
| Save succeeds, read-back is temporarily stale | Track stays pending; no completed-success claim until the remote identity is visible. Retrying does not upload it again. |
| Connection drops after save response is lost | Uncertain outcome is shown. No automatic repeat of the mutation. |
| Disconnect while picker / upload / save / read-back is pending | The cancelled generation cannot update the renderer or native account cache. |
| Switch account between async phases | No upload/save is started for the replacement account. Old-account results cannot enter the new library. |
| Reload after confirmed upload | Track still exists remotely and appears once after authoritative sync. |
| Import same file under another filename | Content identity prevents accidental duplicate remote writes, or the UI explicitly offers a duplicate action. |
| Upload existing local library track | Local media remains playable if upload fails. A successful remote track has a real remote identity, not a changed `source` flag. |
| Close main window during upload | Either graceful completion or explicit recoverable interrupted state. No report of remote failure as success. |

## SoundCloud original downloads

- A track URL with an author-enabled original download sends the original bytes
  to the upload pipeline; compare byte length and SHA-256 in the isolated test.
- A track with downloads disabled, private access, an expired URL, or an unsupported
  original format reports that limitation without falling back to a lower bitrate
  stream or claiming lossless import.
- SoundCloud playlists, profiles, embeds, and malformed paths cannot silently
  resolve to an arbitrary first track.
- URL credentials, local/IP hosts, and a permitted URL redirecting to a local/IP
  host must fail before a network request reaches that destination.
- Bound streamed bytes as well as declared Content-Length. Large or infinite
  chunked responses stop cleanly and remove temporary files.
- Never expose signed download URLs or raw site authorization material in UI,
  diagnostics, persisted state, or test output.
- The application can promise no additional transcoding by Pulse. VK's own
  processing is outside that promise.
