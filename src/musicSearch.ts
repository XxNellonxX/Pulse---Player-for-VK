import type { Track } from './shared/contracts'

export type SearchScope = 'all' | 'mine'
export function musicSearchResults(tracks: readonly Track[], remote: readonly Track[], query: string, scope: SearchScope): Track[] {
  const normalized = query.trim().toLocaleLowerCase()
  const own = tracks.filter(track => (track.source === 'local' || track.remote?.inLibrary !== false) && `${track.title} ${track.artist} ${track.album}`.toLocaleLowerCase().includes(normalized))
  if (scope === 'mine') return own
  const known = new Map(tracks.map(track => [track.id, track]))
  const result = new Map<string, Track>()
  // VK can return spelling corrections and related matches. Preserve its
  // ordering and do not discard those results using a local substring test.
  for (const track of remote) {
    const cached = known.get(track.id)
    result.set(track.id, cached?.remote && track.remote ? { ...track, remote: { ...track.remote, inLibrary: cached.remote.inLibrary } } : track)
  }
  for (const track of own) if (!result.has(track.id)) result.set(track.id, track)
  return [...result.values()]
}
