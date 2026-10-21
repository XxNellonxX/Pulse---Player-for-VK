import type { Track } from './shared/contracts'

/** One permutation of the complete input, independent of pagination or dates. */
export function shuffleIds(ids: readonly string[], random: () => number = Math.random): string[] {
  const result = [...new Set(ids)]
  for (let index = result.length - 1; index > 0; index--) {
    const value = random()
    const target = Math.min(index, Math.max(0, Math.floor((Number.isFinite(value) ? value : 0) * (index + 1))))
    ;[result[index], result[target]] = [result[target], result[index]]
  }
  return result
}

export function ownMusicIds(tracks: readonly Track[]): string[] {
  return [...new Set(tracks.filter(track => track.available && (track.source === 'local' || track.remote?.inLibrary !== false)).map(track => track.id))]
}

/** Keep the playing source untouched; the stored order is the remaining deck. */
export function shuffledQueue(ids: readonly string[], currentId: string | null, random: () => number = Math.random): string[] {
  const rest = shuffleIds(ids.filter(id => id !== currentId), random)
  return currentId ? [currentId, ...rest] : rest
}

export function nextShuffledCycle(ids: readonly string[], previousId: string | null, random: () => number = Math.random): string[] {
  const next = shuffleIds(ids, random)
  if (next.length > 1 && next[0] === previousId) {
    const target = 1 + Math.min(next.length - 2, Math.max(0, Math.floor(random() * (next.length - 1))))
    ;[next[0], next[target]] = [next[target], next[0]]
  }
  return next
}
