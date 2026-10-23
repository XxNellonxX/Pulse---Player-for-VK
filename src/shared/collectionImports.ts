import type { Track } from './contracts'
import { normalizeRecordingText, rankSoundCloudCandidates } from './sourceMatching'

export type ImportService = 'spotify' | 'yandex'
export type ImportedEntry = {
  sourceId: string; title: string; artists: string[]; album: string; duration: number;
  position: number; isrc?: string; explicit?: boolean; artwork?: string;
  trackId?: string; resolution?: 'pending' | 'matched' | 'review' | 'missing'; message?: string;
}
export type ImportedCollection = {
  id: string; service: ImportService; sourceId: string; sourceUrl: string; title: string;
  total: number | null; complete: boolean; warnings: string[]; entries: ImportedEntry[];
  importedAt: number; accountId?: number; remotePlaylistId?: string;
}
export const MAX_IMPORTED_ENTRIES = 50_000
export const MAX_IMPORTED_COLLECTIONS = 100
const clean = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : ''
export function normalizeCollections(value: unknown, knownIds?: Set<string>): ImportedCollection[] {
  if (!Array.isArray(value)) return []
  const records: ImportedCollection[] = [], ids = new Set<string>(); let budget = MAX_IMPORTED_ENTRIES
  for (const raw of value.slice(0, MAX_IMPORTED_COLLECTIONS)) {
    if (!raw || !['spotify', 'yandex'].includes(raw.service) || !Array.isArray(raw.entries) || !budget) continue
    const sourceId = clean(raw.sourceId, 300), id = `${raw.service}:${sourceId}`
    if (!sourceId || ids.has(id)) continue
    ids.add(id)
    const entries: ImportedEntry[] = []
    for (const item of raw.entries.slice(0, Math.min(20_000, budget))) {
      if (!item || !clean(item.title, 500) || !Array.isArray(item.artists)) continue
      const trackId = clean(item.trackId, 120)
      entries.push({ sourceId: clean(item.sourceId, 300), title: clean(item.title, 500), artists: item.artists.slice(0, 20).map((s: unknown) => clean(s, 200)).filter(Boolean), album: clean(item.album, 500), duration: Number.isFinite(item.duration) ? Math.max(0, Math.min(864000, item.duration)) : 0,
        position: Number.isSafeInteger(item.position) && item.position >= 0 && item.position <= 100_000 ? item.position : entries.length, isrc: clean(item.isrc, 30) || undefined, explicit: typeof item.explicit === 'boolean' ? item.explicit : undefined,
        artwork: /^https:\/\//.test(item.artwork || '') ? clean(item.artwork, 4096) : undefined,
        ...(trackId && (!knownIds || knownIds.has(trackId)) ? { trackId, resolution: 'matched' as const } : { resolution: item.resolution === 'review' || item.resolution === 'missing' ? item.resolution : 'pending' }), message: clean(item.message, 300) || undefined })
    }
    budget -= entries.length
    const total = Number.isSafeInteger(raw.total) && raw.total >= 0 ? raw.total : null
    const warnings: string[] = Array.isArray(raw.warnings) ? raw.warnings.slice(0, 29).map((s: unknown) => clean(s, 500)).filter(Boolean) : []
    if (entries.length !== raw.entries.length) warnings.push('Сохранена часть метаданных: достигнут предел хранения или обнаружены повреждённые записи. Повторите чтение источника.')
    records.push({ id, service: raw.service, sourceId, sourceUrl: clean(raw.sourceUrl, 2048), title: clean(raw.title, 500) || 'Импортированная коллекция', total, complete: raw.complete === true && total === entries.length && entries.length === raw.entries.length, warnings, entries, importedAt: Number.isFinite(raw.importedAt) ? raw.importedAt : Date.now(), accountId: Number.isSafeInteger(raw.accountId) && raw.accountId > 0 ? raw.accountId : undefined, remotePlaylistId: clean(raw.remotePlaylistId, 100) || undefined })
  }
  return records
}
export function recordingIndex(tracks: readonly Track[]): Map<string, Track[]> {
  const index = new Map<string, Track[]>()
  for (const track of tracks) {
    const key = normalizeRecordingText(track.title)
    const group = index.get(key) || []; group.push(track); index.set(key, group)
  }
  return index
}
/** No approximate candidate is silently substituted during a collection transfer. */
export function matchImportedEntry(entry: ImportedEntry, candidates: readonly Track[]): { track?: Track; review: boolean } {
  const byRecording = new Map<string, Track>()
  for (const track of candidates) {
    const key = track.id
    const previous = byRecording.get(key)
    if (!previous || track.remote?.inLibrary && !previous.remote?.inLibrary) byRecording.set(key, track)
  }
  const pool = [...byRecording.values()]
  const ranked = rankSoundCloudCandidates({ id: entry.sourceId || `import-${entry.position}`, title: entry.title, artist: entry.artists.join(', '), duration: entry.duration, isrc: entry.isrc, explicit: entry.explicit }, pool.map(track => ({ ...track, streamable: track.available })), { preferExplicit: false })
  return { track: ranked.status === 'unique' ? pool.find(t => t.id === ranked.suggestedId) : undefined, review: ranked.status === 'ambiguous' || ranked.candidates.some(c => c.quality === 'review') }
}
export function collectionTrackIds(record: ImportedCollection): string[] { return record.entries.flatMap(entry => entry.trackId ? [entry.trackId] : []) }
export function sortByImportedOrder(tracks: readonly Track[], imports: readonly ImportedCollection[], service: ImportService): Track[] {
  const positions = new Map<string, number>()
  for (const record of imports.filter(r => r.service === service).sort((a, b) => b.importedAt - a.importedAt)) for (const id of collectionTrackIds(record)) if (!positions.has(id)) positions.set(id, positions.size)
  return tracks.map((track, index) => ({ track, index })).sort((a, b) => (positions.get(a.track.id) ?? Infinity) - (positions.get(b.track.id) ?? Infinity) || a.index - b.index).map(row => row.track)
}
