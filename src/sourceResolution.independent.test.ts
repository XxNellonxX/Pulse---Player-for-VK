import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, DesktopAPI, Track } from './shared/contracts'
import type { SoundCloudCandidate } from './shared/sourceMatching'
import { shouldSearchSoundCloud, soundCloudSource } from './sourceResolution'

const track: Track = { id: 'vk-101-7', title: 'Song', artist: 'Artist', album: '', duration: 180, source: 'vk', url: 'vk-web://101/7', available: true, artistCard: 'absent', addedAt: 1, remote: { ownerId: 101, audioId: 7, inLibrary: true } }
const settings = { preferSoundCloud: true, preferExplicit: true } as AppSettings
const candidate = (changes: Partial<SoundCloudCandidate> = {}): SoundCloudCandidate => ({ id: '123', title: 'Song', artist: 'Artist', duration: 180, streamable: true, ...changes })
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (value: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const flush = async () => { for (let n = 0; n < 20; n++) await Promise.resolve() }
function fixture(overrides: Partial<DesktopAPI> = {}) {
  const source = { url: 'http://pulse-media.localhost/session-a/0', title: 'Song', sourceId: '123' }
  const api = { soundCloudBinding: vi.fn(async () => null), soundCloudStatus: vi.fn(async () => ({ configured: true, proxy: false, message: '' })), searchSoundCloud: vi.fn(async () => ({ collection: [candidate()], hasMore: false })), bindSoundCloud: vi.fn(async () => {}), resolveSoundCloud: vi.fn(async () => source), releaseSoundCloud: vi.fn(async () => {}), ...overrides }
  vi.stubGlobal('window', { desktop: api })
  return { api, source }
}
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('independent SoundCloud source coordinator boundaries', () => {
  it('does no provider work when the preference is disabled', async () => {
    const { api } = fixture()
    expect(await soundCloudSource(track, { ...settings, preferSoundCloud: false }, new AbortController().signal, true)).toBeNull()
    expect(api.soundCloudBinding).not.toHaveBeenCalled()
  })
  it('never initiates discovery for local, unavailable, unknown-card, or linked records without a playback failure', () => {
    for (const changed of [{ source: 'local' as const }, { available: false }, { artistCard: 'unknown' as const }, { artistCard: 'present' as const }]) expect(shouldSearchSoundCloud({ ...track, ...changed }, settings)).toBe(false)
    expect(shouldSearchSoundCloud({ ...track, artistCard: 'present' }, settings, true)).toBe(true)
  })
  it('missing credentials leave playback on VK without querying or binding SoundCloud', async () => {
    const { api } = fixture({ soundCloudStatus: vi.fn(async () => ({ configured: false, proxy: false, message: 'not configured' })) })
    expect(await soundCloudSource(track, settings, new AbortController().signal)).toBeNull()
    expect(api.searchSoundCloud).not.toHaveBeenCalled(); expect(api.bindSoundCloud).not.toHaveBeenCalled(); expect(api.resolveSoundCloud).not.toHaveBeenCalled()
  })
  it('restores the saved track-scoped selection without repeating global search', async () => {
    const { api, source } = fixture({ soundCloudBinding: vi.fn(async () => candidate()) })
    expect(await soundCloudSource({ ...track, artistCard: 'present' }, settings, new AbortController().signal)).toEqual(source)
    expect(api.soundCloudBinding).toHaveBeenCalledExactlyOnceWith(track.id)
    expect(api.resolveSoundCloud).toHaveBeenCalledExactlyOnceWith(track.id)
    expect(api.searchSoundCloud).not.toHaveBeenCalled(); expect(api.bindSoundCloud).not.toHaveBeenCalled()
  })
  it('autobinds only a complete-page unique strict metadata match', async () => {
    const { api, source } = fixture()
    expect(await soundCloudSource(track, settings, new AbortController().signal)).toEqual(source)
    expect(api.bindSoundCloud).toHaveBeenCalledExactlyOnceWith(track.id, '123', 'metadata')
  })
  it('legacy bindings without provenance retain the user-selected recording even after a VK version correction', async () => {
    const { api, source } = fixture({ soundCloudBinding: vi.fn(async () => candidate({ title: 'Song (Acoustic)' })) })
    expect(await soundCloudSource({ ...track, version: 'Live' }, settings, new AbortController().signal)).toEqual(source)
    expect(api.searchSoundCloud).not.toHaveBeenCalled(); expect(api.bindSoundCloud).not.toHaveBeenCalled()
  })
  it('an explicit user binding is not replaced by automatic metadata matching', async () => {
    const chosen = { ...candidate({ title: 'Song (Acoustic)' }), selection: 'user' as const }
    const { api, source } = fixture({ soundCloudBinding: vi.fn(async () => chosen) })
    expect(await soundCloudSource({ ...track, version: 'Live' }, settings, new AbortController().signal)).toEqual(source)
    expect(api.resolveSoundCloud).toHaveBeenCalledExactlyOnceWith(track.id)
    expect(api.searchSoundCloud).not.toHaveBeenCalled(); expect(api.bindSoundCloud).not.toHaveBeenCalled()
  })
  it('a still-exact automatic binding restores without a redundant provider search', async () => {
    const chosen = { ...candidate(), selection: 'metadata' as const }
    const { api, source } = fixture({ soundCloudBinding: vi.fn(async () => chosen) })
    expect(await soundCloudSource(track, settings, new AbortController().signal)).toEqual(source)
    expect(api.resolveSoundCloud).toHaveBeenCalledExactlyOnceWith(track.id)
    expect(api.searchSoundCloud).not.toHaveBeenCalled(); expect(api.bindSoundCloud).not.toHaveBeenCalled()
  })
  it.each([
    ['version', { version: 'Live' }],
    ['duration', { duration: 240 }],
    ['artist', { artist: 'Different Artist' }],
    ['title', { title: 'Different Song' }],
    ['known explicit edition', { explicit: true }],
    ['ISRC', { isrc: 'USABC2612346' }],
  ])('does not reuse a stale automatic binding after the VK %s changes', async (_, changes) => {
    const chosen = { ...candidate({ isrc: 'USABC2612345' }), selection: 'metadata' as const }
    const { api } = fixture({ soundCloudBinding: vi.fn(async () => chosen), searchSoundCloud: vi.fn(async () => ({ collection: [chosen], hasMore: false })) })
    expect(await soundCloudSource({ ...track, ...changes }, settings, new AbortController().signal)).toBeNull()
    expect(api.resolveSoundCloud).not.toHaveBeenCalled(); expect(api.bindSoundCloud).not.toHaveBeenCalled()
  })
  it('a stale automatic binding can be replaced only by a fresh unique strict matching recording', async () => {
    const chosen = { ...candidate(), selection: 'metadata' as const }, fresh = candidate({ id: '124', version: 'Live' })
    const { api, source } = fixture({ soundCloudBinding: vi.fn(async () => chosen), searchSoundCloud: vi.fn(async () => ({ collection: [chosen, fresh], hasMore: false })) })
    expect(await soundCloudSource({ ...track, version: 'Live' }, settings, new AbortController().signal)).toEqual(source)
    expect(api.bindSoundCloud).toHaveBeenCalledExactlyOnceWith(track.id, '124', 'metadata')
    expect(api.resolveSoundCloud).toHaveBeenCalledExactlyOnceWith(track.id)
  })
  it('pagination cannot silently replace a stale automatic binding', async () => {
    const chosen = { ...candidate(), selection: 'metadata' as const }
    const { api } = fixture({ soundCloudBinding: vi.fn(async () => chosen), searchSoundCloud: vi.fn(async () => ({ collection: [candidate({ id: '124', version: 'Live' })], hasMore: true })) })
    expect(await soundCloudSource({ ...track, version: 'Live' }, settings, new AbortController().signal)).toBeNull()
    expect(api.resolveSoundCloud).not.toHaveBeenCalled(); expect(api.bindSoundCloud).not.toHaveBeenCalled()
  })
  it('an ambiguous refreshed search never falls back to the stale automatically selected edition', async () => {
    const chosen = { ...candidate(), selection: 'metadata' as const }
    const { api } = fixture({ soundCloudBinding: vi.fn(async () => chosen), searchSoundCloud: vi.fn(async () => ({ collection: [candidate({ id: '124', version: 'Live' }), candidate({ id: '125', version: 'Live' })] })) })
    expect(await soundCloudSource({ ...track, version: 'Live' }, settings, new AbortController().signal)).toBeNull()
    expect(api.resolveSoundCloud).not.toHaveBeenCalled(); expect(api.bindSoundCloud).not.toHaveBeenCalled()
  })
  it.each(['user', undefined] as const)('a manual choice made during search wins over an automatic suggestion (%s provenance)', async selection => {
    const pending = deferred<{ collection: SoundCloudCandidate[] }>()
    let selected: (SoundCloudCandidate & { selection?: 'user' | 'metadata' }) | null = null
    const { api } = fixture({
      soundCloudBinding: vi.fn(async () => selected), searchSoundCloud: vi.fn(() => pending.promise),
      resolveSoundCloud: vi.fn(async () => ({ url: 'http://pulse-media.localhost/user-choice/0', title: 'Song (Acoustic)', sourceId: selected?.id || 'not-selected' })),
    })
    const run = soundCloudSource(track, settings, new AbortController().signal)
    await flush(); selected = { ...candidate({ id: '124', title: 'Song (Acoustic)' }), selection }
    pending.resolve({ collection: [candidate()] })
    expect((await run)?.sourceId).toBe('124')
    expect(api.bindSoundCloud).not.toHaveBeenCalled(); expect(api.resolveSoundCloud).toHaveBeenCalledExactlyOnceWith(track.id)
  })
  it('a native conflict rejecting a late automatic write never starts its stale media', async () => {
    const { api } = fixture({ bindSoundCloud: vi.fn(async () => { throw Error('Источник уже выбран вами. Автоматический подбор отменён.') }) })
    await expect(soundCloudSource(track, settings, new AbortController().signal)).rejects.toThrow('Источник уже выбран вами')
    expect(api.resolveSoundCloud).not.toHaveBeenCalled()
  })
  it('cancellation during the final binding check cannot mutate or resolve after a late reply', async () => {
    const pending = deferred<SoundCloudCandidate | null>(), controller = new AbortController(); let reads = 0
    const { api } = fixture({ soundCloudBinding: vi.fn(() => ++reads === 1 ? Promise.resolve(null) : pending.promise) })
    const run = soundCloudSource(track, settings, controller.signal), rejected = expect(run).rejects.toMatchObject({ name: 'AbortError' })
    await flush(); expect(reads).toBe(2); controller.abort(); await rejected; pending.resolve(null); await flush()
    expect(api.bindSoundCloud).not.toHaveBeenCalled(); expect(api.resolveSoundCloud).not.toHaveBeenCalled()
  })
  it.each([
    ['paginated result', { collection: [candidate()], hasMore: true }],
    ['two uploads', { collection: [candidate(), candidate({ id: '124' })] }],
    ['wrong live version', { collection: [candidate({ title: 'Song (Live)' })] }],
    ['wrong remixer', { collection: [candidate({ version: 'DJ Two Remix' })] }],
    ['only preview', { collection: [candidate({ streamable: false })] }],
    ['unknown duration', { collection: [candidate({ duration: 0 })] }],
    ['contradictory ISRC', { collection: [candidate({ isrc: 'USABC2612346' })] }],
  ])('does not save or resolve %s', async (_, page) => {
    const wanted = { ...track, isrc: 'USABC2612345' }
    const { api } = fixture({ searchSoundCloud: vi.fn(async () => page) })
    expect(await soundCloudSource(wanted, settings, new AbortController().signal)).toBeNull()
    expect(api.bindSoundCloud).not.toHaveBeenCalled(); expect(api.resolveSoundCloud).not.toHaveBeenCalled()
  })
  it('a failed VK track with ambiguous matches asks for explicit source selection', async () => {
    const { api } = fixture({ searchSoundCloud: vi.fn(async () => ({ collection: [candidate(), candidate({ id: '124' })] })) })
    await expect(soundCloudSource(track, settings, new AbortController().signal, true)).rejects.toThrow(/выберите/)
    expect(api.bindSoundCloud).not.toHaveBeenCalled(); expect(api.resolveSoundCloud).not.toHaveBeenCalled()
  })
  it('does not substitute a known clean edition for a requested explicit edition', async () => {
    const { api } = fixture({ searchSoundCloud: vi.fn(async () => ({ collection: [candidate({ title: 'Song (Clean)' })] })) })
    expect(await soundCloudSource({ ...track, explicit: true }, settings, new AbortController().signal)).toBeNull()
    expect(api.bindSoundCloud).not.toHaveBeenCalled()
  })
  it('cancellation before invocation does not touch provider state', async () => {
    const { api } = fixture(); const c = new AbortController(); c.abort()
    await expect(soundCloudSource(track, settings, c.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(api.soundCloudBinding).not.toHaveBeenCalled()
  })
  it('a late search response after cancellation cannot bind or resolve', async () => {
    const pending = deferred<{ collection: SoundCloudCandidate[] }>()
    const { api } = fixture({ searchSoundCloud: vi.fn(() => pending.promise) }); const c = new AbortController()
    const run = soundCloudSource(track, settings, c.signal); const rejected = expect(run).rejects.toMatchObject({ name: 'AbortError' })
    await flush(); c.abort(); pending.resolve({ collection: [candidate()] }); await rejected
    expect(api.bindSoundCloud).not.toHaveBeenCalled(); expect(api.resolveSoundCloud).not.toHaveBeenCalled()
  })
  it('an allocated source arriving after cancellation releases only its exact session', async () => {
    const pending = deferred<{ url: string; title: string; sourceId: string }>()
    const { api } = fixture({ soundCloudBinding: vi.fn(async () => candidate()), resolveSoundCloud: vi.fn(() => pending.promise) }); const c = new AbortController()
    const run = soundCloudSource(track, settings, c.signal); const rejected = expect(run).rejects.toMatchObject({ name: 'AbortError' })
    await flush(); c.abort(); pending.resolve({ url: 'http://pulse-media.localhost/late-session-only/0', title: 'Song', sourceId: '123' }); await rejected
    expect(api.releaseSoundCloud).toHaveBeenCalledExactlyOnceWith('http://pulse-media.localhost/late-session-only/0')
  })
  it('an account-change failure while confirming the selected provider never resolves media', async () => {
    const { api } = fixture({ bindSoundCloud: vi.fn(async () => { throw Error('Сеанс изменился') }) })
    await expect(soundCloudSource(track, settings, new AbortController().signal)).rejects.toThrow('Сеанс изменился')
    expect(api.resolveSoundCloud).not.toHaveBeenCalled()
  })
  it('cancelling a hung metadata lookup rejects promptly rather than waiting for the upstream timeout', async () => {
    fixture({ soundCloudBinding: vi.fn(() => new Promise<SoundCloudCandidate | null>(() => {})) })
    const c = new AbortController(); let settled = false
    const run = soundCloudSource(track, settings, c.signal).then(() => { settled = true }, () => { settled = true })
    await flush(); c.abort(); await vi.advanceTimersByTimeAsync(100)
    expect(settled).toBe(true)
    if (settled) await run
  })
  it('an optional source cannot delay a working VK route beyond six seconds', async () => {
    fixture({ soundCloudStatus: vi.fn(() => new Promise<never>(() => {})) })
    const run = soundCloudSource(track, settings, new AbortController().signal)
    const result = expect(run).resolves.toBeNull()
    await vi.advanceTimersByTimeAsync(6001); await result
  })
  it('a forced provider lookup ends after fifteen seconds with an actionable error', async () => {
    fixture({ soundCloudStatus: vi.fn(() => new Promise<never>(() => {})) })
    const run = soundCloudSource(track, settings, new AbortController().signal, true)
    const result = expect(run).rejects.toThrow(/15 секунд/)
    await vi.advanceTimersByTimeAsync(15001); await result
  })
  it('a search response arriving after the optional deadline cannot create a saved binding', async () => {
    const pending = deferred<{ collection: SoundCloudCandidate[] }>()
    const { api } = fixture({ searchSoundCloud: vi.fn(() => pending.promise) })
    const run = soundCloudSource(track, settings, new AbortController().signal)
    await flush(); await vi.advanceTimersByTimeAsync(6001); expect(await run).toBeNull()
    pending.resolve({ collection: [candidate()] }); await flush()
    expect(api.bindSoundCloud).not.toHaveBeenCalled(); expect(api.resolveSoundCloud).not.toHaveBeenCalled()
  })
  it('a stream allocated after the deadline is released without affecting the new playback session', async () => {
    const pending = deferred<{ url: string; title: string; sourceId: string }>()
    const { api } = fixture({ soundCloudBinding: vi.fn(async () => candidate()), resolveSoundCloud: vi.fn(() => pending.promise) })
    const run = soundCloudSource(track, settings, new AbortController().signal)
    await flush(); await vi.advanceTimersByTimeAsync(6001); expect(await run).toBeNull()
    pending.resolve({ url: 'http://pulse-media.localhost/expired-attempt-only/0', title: 'Song', sourceId: '123' }); await flush()
    expect(api.releaseSoundCloud).toHaveBeenCalledExactlyOnceWith('http://pulse-media.localhost/expired-attempt-only/0')
  })
  it('cancelling while binding is in flight cannot start a provider stream afterwards', async () => {
    const pending = deferred<void>(); const c = new AbortController()
    const { api } = fixture({ bindSoundCloud: vi.fn(() => pending.promise) })
    const run = soundCloudSource(track, settings, c.signal); const rejection = expect(run).rejects.toMatchObject({ name: 'AbortError' })
    await flush(); expect(api.bindSoundCloud).toHaveBeenCalledOnce(); c.abort(); await rejection
    pending.resolve(); await flush(); expect(api.resolveSoundCloud).not.toHaveBeenCalled()
  })
})
