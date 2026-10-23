import { describe, expect, it } from 'vitest'
import { matchImportedEntry, normalizeCollections, sortByImportedOrder, type ImportedCollection, type ImportedEntry } from './collectionImports'
import type { Track } from './contracts'
const entry: ImportedEntry = { title: 'Song', artists: ['Artist'], duration: 180, sourceId: 'source', position: 0, album: '' }
const track = (id: string): Track => ({ id, title: 'Song', artist: 'Artist', duration: 180, album: '', source: 'vk', addedAt: 0, available: true, url: '' })
describe('ordered service collections', () => {
  it('requires unique recording metadata and never silently resolves multiple identities', () => { expect(matchImportedEntry(entry, [track('one')]).track?.id).toBe('one'); expect(matchImportedEntry(entry, [track('one'), track('two')]).track).toBeUndefined(); expect(matchImportedEntry(entry, [{ ...track('one'), title: 'Song (Live)' }]).track).toBeUndefined() })
  it('preserves source positions including hidden provider entries and repeated tracks', () => { const result = normalizeCollections([{ service: 'spotify', sourceId: 'list', entries: [{ ...entry, position: 1, trackId: 'one' }, { ...entry, position: 5, trackId: 'one' }] }], new Set(['one'])); expect(result[0].entries.map(e => e.position)).toEqual([1, 5]); expect(result[0].entries.map(e => e.trackId)).toEqual(['one', 'one']) })
  it('retains unresolved metadata when a linked track disappears', () => { const [result] = normalizeCollections([{ service: 'yandex', sourceId: 'list', entries: [{ ...entry, trackId: 'deleted' }] }], new Set()); expect(result.entries[0].trackId).toBeUndefined(); expect(result.entries[0].title).toBe('Song'); expect(result.entries[0].resolution).toBe('pending') })
  it('service sorting leaves VK base order untouched and keeps non-imported tracks stable', () => { const tracks = ['a', 'b', 'c', 'd'].map(track); const records = [{ service: 'spotify', importedAt: 2, entries: [{ trackId: 'c' }, { trackId: 'a' }] }] as ImportedCollection[]; expect(sortByImportedOrder(tracks, records, 'spotify').map(t => t.id)).toEqual(['c', 'a', 'b', 'd']); expect(tracks.map(t => t.id)).toEqual(['a', 'b', 'c', 'd']) })
})
