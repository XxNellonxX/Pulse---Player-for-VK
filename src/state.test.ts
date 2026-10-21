import { describe, it, expect } from 'vitest'
import { applyVkSnapshot, hydrateState, normalizeSettings } from './state'
import type { Track, VkSnapshot } from './shared/contracts'
const track: Track = { id: 'vk-1-2', source: 'vk', url: 'vk-web://1/2', title: 'Song', artist: 'Artist', album: '', duration: 99, addedAt: 1, available: true, remote: { ownerId: 1, audioId: 2, inLibrary: true } }
const snapshot = (tracks: Track[]): VkSnapshot => ({ status: { state: 'connected', capabilities: [], message: '' }, complete: true, mode: 'web', tracks, playlists: [] })
describe('persistent catalog updates', () => {
  it('reuses unchanged metadata without repainting or persisting the catalog', () => {
    const state = hydrateState({ tracks: [track] })
    expect(applyVkSnapshot(state, snapshot([{ ...track, addedAt: 500 }]))).toBe(state)
  })
  it('keeps authoritative VK order and removes deleted library entries', () => {
    const other = { ...track, id: 'vk-1-3', remote: { ...track.remote!, audioId: 3 } }
    const state = hydrateState({ tracks: [track, other], queue: [track.id], currentTrackId: track.id })
    const next = applyVkSnapshot(state, snapshot([other]))
    expect(next.tracks.map(t => t.id)).toEqual([other.id]); expect(next.currentTrackId).toBe(null); expect(next.queue).toEqual([])
  })
  it('keeps a playing global search result while background library sync completes', () => {
    const result = { ...track, remote: { ...track.remote!, inLibrary: false, searchResult: true } }
    const state = hydrateState({ tracks: [result], currentTrackId: result.id, queue: [result.id] })
    expect(applyVkSnapshot(state, snapshot([])).currentTrackId).toBe(result.id)
  })
})
it('repairs legacy or malformed appearance settings without losing valid user preferences', () => {
  const settings = normalizeSettings({ theme: 'broken', style: 'bad', palette: 'url(evil)', accent: 'red; color: transparent', textScale: Infinity, volume: 5, repeat: 'broken', reducedMotion: true })
  expect(settings.theme).toBe('dark'); expect(settings.palette).toBeUndefined(); expect(settings.volume).toBe(1); expect(settings.textScale).toBe(1); expect(settings.reducedMotion).toBe(true)
})

it('restores a saved equalizer without losing library metadata or settings', () => {
  const equalizer = { enabled: true, preset: 'custom', bands: [3, 2, 1, 0, -1, -2, -3, 0, 1, 2], preamp: -4.5 }
  const restored = hydrateState(JSON.parse(JSON.stringify({ tracks: [track], settings: { equalizer, volume: .45 } })))
  expect(restored.settings.equalizer).toEqual(equalizer)
  expect(restored.settings.volume).toBe(.45)
  expect(restored.tracks[0].id).toBe(track.id)
  expect(normalizeSettings({}).equalizer).toEqual({ enabled: false, preset: 'flat', bands: Array(10).fill(0), preamp: 0 })
})
