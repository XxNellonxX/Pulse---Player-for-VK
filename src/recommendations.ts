import type { AppSettings, Track } from './shared/contracts'
import { canAttemptPlayback } from './shuffle'
import { normalizeRecordingText } from './shared/sourceMatching'

export type MixItem = { track: Track; reason: string; discovery: boolean }
function artistKeys(track: Track): string[] { return track.artistRefs?.length ? track.artistRefs.map(a => a.id) : [normalizeRecordingText(track.artist)] }
function jitter(id: string, seed: number): number { let hash = seed | 0; for (const c of id) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619); return (hash >>> 0) / 4294967296 }
/** Bounded local ranking: no timer, network calls, embeddings or audio analysis. */
export function pulseMix(library: readonly Track[], discovery: readonly Track[], history: readonly string[], settings: Pick<AppSettings, 'preferSoundCloud'>, seed: number, limit = 50): MixItem[] {
  const own = new Set(library.filter(t => t.source === 'local' || t.remote?.inLibrary !== false).map(t => t.id)), known = new Map(library.map(t => [t.id, t]))
  const affinity = new Map<string, number>(), recent = new Map(history.map((id, index) => [id, index]))
  history.slice(0, 120).forEach((id, index) => { const track = known.get(id); if (track) artistKeys(track).forEach(key => affinity.set(key, (affinity.get(key) || 0) + Math.exp(-index / 35))) })
  const seen = new Set<string>(), recordings = new Set<string>()
  const pool = [...discovery, ...library.filter(t => own.has(t.id))].filter(t => {
    const key = [normalizeRecordingText(t.title) || t.title.normalize('NFKC').trim(), normalizeRecordingText(t.artist) || t.artist.normalize('NFKC').trim(), t.version || '', t.explicit].join('|')
    if (!canAttemptPlayback(t, settings) || seen.has(t.id) || recordings.has(key) || recent.get(t.id)! < 5) return false
    seen.add(t.id); recordings.add(key); return true
  }).map(track => {
    const keys = artistKeys(track), related = Math.max(0, ...keys.map(key => affinity.get(key) || 0)), isNew = !own.has(track.id)
    return { track, keys, discovery: isNew, reason: isNew ? related ? 'Новое от знакомого артиста' : 'Из рекомендаций VK' : related ? 'Артист из вашей истории' : 'Из вашей коллекции', score: Math.log1p(related) * .8 + (isNew ? .65 : .2) + jitter(track.id, seed) * 1.3 - (recent.has(track.id) ? Math.exp(-recent.get(track.id)! / 25) * 1.2 : 0) }
  }).sort((a, b) => b.score - a.score).slice(0, 2000)
  const result: MixItem[] = [], lastArtists: string[][] = []
  const count = Math.min(Math.max(0, limit), 100, pool.length)
  const ownCount = pool.filter(row => !row.discovery).length
  const discoveryBudget = Math.max(Math.round(count * .35), count - ownCount)
  while (result.length < count && pool.length) {
    let best = -Infinity, selected = 0
    const targetDiscovery = Math.floor((result.length + 1) * .35), discoveries = result.filter(t => t.discovery).length
    for (let i = 0; i < pool.length; i++) {
      const row = pool[i], repeats = lastArtists.slice(-8).filter(keys => keys.some(key => row.keys.includes(key))).length
      if (row.discovery && discoveries >= discoveryBudget) continue
      const immediate = lastArtists.at(-1)?.some(key => row.keys.includes(key)) ? 4 : 0
      const score = row.score - repeats * 1.2 - immediate + (row.discovery && discoveries < targetDiscovery ? 1 : 0)
      if (score > best) { best = score; selected = i }
    }
    const [row] = pool.splice(selected, 1); lastArtists.push(row.keys); result.push({ track: row.track, reason: row.reason, discovery: row.discovery })
  }
  return result
}
