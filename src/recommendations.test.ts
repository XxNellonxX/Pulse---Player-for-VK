import { describe, expect, it } from 'vitest'
import { pulseMix } from './recommendations'
import type { Track } from './shared/contracts'
const track = (n: number, artist = `Artist ${n % 15}`): Track => ({ id: `vk-1-${n}`, source: 'vk', title: `Song ${n}`, artist, album: '', duration: 100, addedAt: n, available: true, url: '', remote: { ownerId: 1, audioId: n, inLibrary: true } })
describe('Pulse Mix', () => {
  it('does not repeat recording or the most recent five selections', () => { const tracks = Array.from({ length: 80 }, (_, i) => track(i)); const mix = pulseMix(tracks, tracks, tracks.slice(0, 5).map(t => t.id), { preferSoundCloud: true }, 19); expect(mix).toHaveLength(50); expect(new Set(mix.map(t => t.track.id)).size).toBe(50); expect(mix.some(t => tracks.slice(0, 5).some(recent => recent.id === t.track.id))).toBe(false) })
  it('distributes artists and changes selection only when the seed changes', () => { const tracks = Array.from({ length: 100 }, (_, i) => track(i)); const a = pulseMix(tracks, [], [], { preferSoundCloud: true }, 12); const b = pulseMix(tracks, [], [], { preferSoundCloud: true }, 12); expect(a).toEqual(b); expect(a.map(t => t.track.id)).not.toEqual(pulseMix(tracks, [], [], { preferSoundCloud: true }, 21).map(t => t.track.id)); expect(a.slice(1).every((t, i) => t.track.artist !== a[i].track.artist)).toBe(true) })
  it('excludes missing local files while allowing independent source resolution for VK', () => { const local = { ...track(1), source: 'local' as const, available: false }; expect(pulseMix([local, { ...track(2), available: false }], [], [], { preferSoundCloud: true }, 1).map(t => t.track.id)).toEqual(['vk-1-2']) })
  it('is bounded when the entire library belongs to one artist', () => { const tracks = Array.from({ length: 1000 }, (_, i) => track(i, 'Only one')); expect(pulseMix(tracks, [], [], { preferSoundCloud: true }, 1, 500)).toHaveLength(100) })
})
