import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppSettings, PersistedState, Track, VkSnapshot } from './shared/contracts'
import { normalizeEqualizer } from './shared/equalizer'
import { normalizeCollections } from './shared/collectionImports'

export const defaultSettings: AppSettings = {
  theme: 'dark', style: 'minimal', accent: '#bdff62', density: 'comfortable', textScale: 1,
  reducedMotion: false, volume: 0.7, repeat: 'off', shuffle: false, closeToTray: false,
  autoplay: false, autoSkip: true, equalizer: normalizeEqualizer(undefined), preferSoundCloud: true, preferExplicit: true,
}
export const initialState: PersistedState = {
  version: 1, tracks: [], playlists: [], history: [], queue: [], currentTrackId: null,
  position: 0, settings: defaultSettings,
}
export function normalizeSettings(value: unknown): AppSettings {
  const input = value && typeof value === 'object' ? value as Partial<AppSettings> : {}
  const number = (value: unknown, fallback: number, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
  return {
    ...defaultSettings,
    theme: ['dark', 'light', 'system', 'high-contrast'].includes(input.theme || '') ? input.theme! : defaultSettings.theme,
    style: ['minimal', 'compact', 'soft'].includes(input.style || '') ? input.style! : defaultSettings.style,
    ...(typeof input.palette === 'string' && /^[a-z0-9-]{1,40}$/.test(input.palette) ? { palette: input.palette } : {}),
    accent: typeof input.accent === 'string' && /^#[\da-f]{6}$/i.test(input.accent) ? input.accent : defaultSettings.accent,
    density: input.density === 'compact' ? 'compact' : 'comfortable',
    textScale: number(input.textScale, 1, .85, 1.3), volume: number(input.volume, .7, 0, 1),
    repeat: input.repeat === 'all' || input.repeat === 'one' ? input.repeat : 'off',
    reducedMotion: input.reducedMotion === true, shuffle: input.shuffle === true,
    closeToTray: input.closeToTray === true, autoplay: input.autoplay === true,
    autoSkip: typeof input.autoSkip === 'boolean' ? input.autoSkip : defaultSettings.autoSkip,
    equalizer: normalizeEqualizer(input.equalizer),
    preferSoundCloud: input.preferSoundCloud !== false, preferExplicit: input.preferExplicit !== false,
  }
}
function normalizeTrack(value: unknown): Track | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<Track>
  if (typeof item.id !== 'string' || !item.id) return null
  return {
    id: item.id, title: typeof item.title === 'string' && item.title.trim() ? item.title : 'Без названия',
    artist: typeof item.artist === 'string' && item.artist.trim() ? item.artist : 'Неизвестный исполнитель',
    album: typeof item.album === 'string' ? item.album : '', duration: Number.isFinite(Number(item.duration)) ? Number(item.duration) : 0,
    artwork: typeof item.artwork === 'string' ? item.artwork : undefined, url: typeof item.url === 'string' ? item.url : '',
    source: item.source === 'vk' ? 'vk' : 'local', addedAt: Number.isFinite(Number(item.addedAt)) ? Number(item.addedAt) : Date.now(),
    available: item.available !== false, remote: item.remote,
    version: typeof item.version === 'string' ? item.version.slice(0, 200) : undefined,
    isrc: typeof item.isrc === 'string' ? item.isrc : undefined,
    explicit: typeof item.explicit === 'boolean' ? item.explicit : undefined,
    artistCard: item.artistCard === 'present' || item.artistCard === 'absent' ? item.artistCard : 'unknown',
    artistRefs: Array.isArray(item.artistRefs) ? item.artistRefs.filter(ref => ref && typeof ref.id === 'string' && /^[\w-]{1,100}$/.test(ref.id) && typeof ref.name === 'string').slice(0, 20) : undefined,
  }
}
export function hydrateState(value: unknown): PersistedState {
  if (!value || typeof value !== 'object') return initialState
  const candidate = value as Partial<PersistedState>
  const tracks = Array.isArray(candidate.tracks) ? candidate.tracks.map(normalizeTrack).filter((track): track is Track => Boolean(track)) : []
  const ids = new Set(tracks.map(track => track.id))
  const playlists = Array.isArray(candidate.playlists) ? candidate.playlists.filter(item => item && typeof item.id === 'string' && typeof item.title === 'string').map(item => ({ ...item, id: item.id, title: item.title.trim() || 'Без названия', trackIds: Array.isArray(item.trackIds) ? item.trackIds.filter(id => typeof id === 'string' && ids.has(id)) : [], createdAt: Number(item.createdAt) || Date.now() })) : []
  return { ...initialState, ...candidate, tracks, playlists, serviceImports: normalizeCollections(candidate.serviceImports, ids), history: Array.isArray(candidate.history) ? candidate.history.filter(id => typeof id === 'string' && ids.has(id)) : [], queue: Array.isArray(candidate.queue) ? [...new Set(candidate.queue.filter(id => typeof id === 'string' && ids.has(id)))] : [], currentTrackId: typeof candidate.currentTrackId === 'string' && ids.has(candidate.currentTrackId) ? candidate.currentTrackId : null, position: Number.isFinite(Number(candidate.position)) ? Math.max(0, Number(candidate.position)) : 0, settings: normalizeSettings(candidate.settings) }
}
export function mergeTracks(existing: Track[], incoming: Track[]): Track[] {
  const known = new Map(existing.map(track => [track.id, track]))
  for (const track of incoming) known.set(track.id, track)
  return [...known.values()]
}
export function applyVkSnapshot(previous: PersistedState, snapshot: VkSnapshot): PersistedState {
  if (snapshot.complete !== true || !Array.isArray(snapshot.playlists) || !Array.isArray(snapshot.tracks)) return previous
  const known = new Map(previous.tracks.map(track => [track.id, track]))
  const incoming = new Set(snapshot.tracks.map(track => track.id))
  const pinned = new Set([...previous.queue, ...previous.history, ...(previous.currentTrackId ? [previous.currentTrackId] : []), ...previous.playlists.filter(playlist => !playlist.remote).flatMap(playlist => playlist.trackIds)])
  const transient = previous.tracks.filter(track => track.source === 'vk' && track.remote?.inLibrary === false && (snapshot.mode !== 'web' || track.remote?.searchResult === true) && pinned.has(track.id) && !incoming.has(track.id))
  const tracks = [...previous.tracks.filter(track => track.source !== 'vk'), ...snapshot.tracks.map(track => {
    const old = known.get(track.id)
    const next = { ...track, artistCard: track.artistCard || 'unknown' as const, addedAt: old?.addedAt ?? track.addedAt }
    return old && old.title === next.title && old.artist === next.artist && old.album === next.album && old.duration === next.duration && old.artwork === next.artwork && old.url === next.url && old.available === next.available && old.source === next.source && old.version === next.version && old.isrc === next.isrc && old.explicit === next.explicit && old.artistCard === next.artistCard && old.remote?.ownerId === next.remote?.ownerId && old.remote?.audioId === next.remote?.audioId && old.remote?.accessKey === next.remote?.accessKey && old.remote?.inLibrary === next.remote?.inLibrary && old.remote?.searchResult === next.remote?.searchResult && JSON.stringify(old.artistRefs || []) === JSON.stringify(next.artistRefs || []) ? old : next
  }), ...transient]
  const previousPlaylists = new Map(previous.playlists.map(playlist => [playlist.id, playlist]))
  const playlists = [...previous.playlists.filter(playlist => !playlist.remote), ...snapshot.playlists.map(playlist => {
    const old = previousPlaylists.get(playlist.id)
    return old && old.title === playlist.title && old.artwork === playlist.artwork && old.description === playlist.description && old.contentUnavailable === playlist.contentUnavailable && old.remoteTrackCount === playlist.remoteTrackCount && old.remote?.ownerId === playlist.remote?.ownerId && old.remote?.playlistId === playlist.remote?.playlistId && old.remote?.accessKey === playlist.remote?.accessKey && old.trackIds.length === playlist.trackIds.length && old.trackIds.every((id, index) => id === playlist.trackIds[index]) ? old : playlist
  })]
  if (tracks.length === previous.tracks.length && tracks.every((track, index) => track === previous.tracks[index]) && playlists.length === previous.playlists.length && playlists.every((playlist, index) => playlist === previous.playlists[index])) return previous
  return hydrateState({ ...previous, tracks, playlists })
}
export function stripVkState(previous: PersistedState): PersistedState {
  return hydrateState({ ...previous, tracks: previous.tracks.filter(track => track.source !== 'vk'), playlists: previous.playlists.filter(playlist => !playlist.remote) })
}
export function useLibraryState() {
  const [state, setState] = useState<PersistedState>(initialState)
  const [ready, setReady] = useState(false)
  const [storageError, setStorageError] = useState('')
  const saved = useRef<PersistedState | null>(null)
  const observed = useRef<PersistedState | null>(null)
  const pending = useRef<PersistedState | null>(null)
  const saving = useRef<Promise<void> | null>(null)
  const latest = useRef(state)
  const canSave = useRef(ready)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastPersistAt = useRef(0)
  latest.current = state
  canSave.current = ready
  const persist = useCallback((): Promise<void> => {
    if (!canSave.current) return Promise.resolve()
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = null
    lastPersistAt.current = Date.now()
    pending.current = latest.current
    if (saving.current) return saving.current
    saving.current = Promise.resolve().then(async () => {
      // The bridge is asynchronous: an older write must finish before the next
      // snapshot starts. Keep only the latest waiting snapshot during slow I/O.
      while (pending.current) {
        const snapshot = pending.current
        pending.current = null
        if (snapshot === saved.current) continue
        try {
          if (window.desktop) await window.desktop.saveState(snapshot)
          else localStorage.setItem('pulse-preview', JSON.stringify(snapshot))
          saved.current = snapshot
          setStorageError('')
        } catch { setStorageError('Изменения пока не сохранены. Проверьте свободное место на диске.') }
      }
    }).finally(() => { saving.current = null })
    return saving.current
  }, [])
  useEffect(() => {
    let active = true
    const restore = async () => {
      try {
        const value = window.desktop ? await window.desktop.getState() : JSON.parse(localStorage.getItem('pulse-preview') || 'null')
        if (active && value?.version === 1) {
          const restored = hydrateState(value)
          saved.current = observed.current = latest.current = restored
          setState(restored)
        }
      } catch { if (active) setStorageError('Не удалось восстановить библиотеку. Исходные данные сохранены на диске.') }
      finally { if (active) setReady(true) }
    }
    void restore()
    return () => { active = false }
  }, [])
  useEffect(() => {
    if (!ready) return
    const previous = observed.current
    observed.current = state
    if (state === saved.current) return
    const sameCatalog = previous && previous.version === state.version && previous.tracks === state.tracks && previous.playlists === state.playlists && previous.history === state.history && previous.queue === state.queue && previous.currentTrackId === state.currentTrackId
    const equalizerOnly = sameCatalog && previous.settings.equalizer !== state.settings.equalizer && Object.keys(previous.settings).every(key => key === 'equalizer' || previous.settings[key as keyof AppSettings] === state.settings[key as keyof AppSettings])
    if (equalizerOnly) {
      // A slider updates audio immediately. Coalesce disk writes while it is
      // dragged so large libraries are not serialized for every pointer event.
      saveTimer.current = setTimeout(() => { void persist() }, 250)
      return () => { if (saveTimer.current) clearTimeout(saveTimer.current) }
    }
    const positionOnly = sameCatalog && previous.settings === state.settings
    if (!positionOnly) { void persist(); return }
    // Checkpoint progress without repeatedly serializing and writing the whole
    // catalog. Pause, hide and close still drain the latest snapshot immediately.
    saveTimer.current = setTimeout(() => { void persist() }, Math.max(0, 15_000 - (Date.now() - lastPersistAt.current)))
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current) }
  }, [state, ready, persist])
  useEffect(() => {
    const flush = () => { void persist() }
    const hide = () => { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
    document.addEventListener('visibilitychange', hide)
    return () => {
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('beforeunload', flush)
      document.removeEventListener('visibilitychange', hide)
    }
  }, [persist])
  useEffect(() => window.desktop?.onCloseRequest?.(async () => {
    await persist()
    if (!canSave.current || saved.current !== latest.current) throw new Error('State has not been saved')
  }), [persist])
  return { state, setState, ready, storageError, flushState: persist }
}
