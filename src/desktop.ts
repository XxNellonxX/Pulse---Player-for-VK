import { invoke, isTauri, convertFileSrc } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { DesktopAPI, DesktopCommand, Track, PersistedState, VkSnapshot, VkWebPlayback, ImportProgress } from './shared/contracts'
import { soundCloudMediaUrl, soundCloudSessionId } from './shared/mediaSource'

// Windows and macOS share this Tauri bridge. Browser preview stays local.
if (isTauri()) {
  const track = (value: Track): Track => value.source === 'local' && !/^(asset:|https?:)/.test(value.url) ? { ...value, url: convertFileSrc(value.url) } : value
  const api: DesktopAPI = {
    getAutostart: () => invoke('get_autostart'),
    setAutostart: enabled => invoke('set_autostart', { enabled }),
    readServicePlaylist: url => invoke('read_service_playlist', { url }),
    serviceImportStatus: () => invoke('service_import_status'),
    connectServiceImport: input => invoke('connect_service_import', { clientId: null, ...input }),
    disconnectServiceImport: service => invoke('disconnect_service_import', { service }),
    listServicePlaylists: service => invoke('list_service_playlists', { service }),
    cancelServiceImport: () => invoke('cancel_service_import'),
    catalogWatchStatus: () => invoke('catalog_watch_status'),
    setCatalogFollowed: (id, followed) => invoke('catalog_set_followed', { id, followed }),
    refreshCatalog: () => invoke('catalog_refresh'),
    cancelCatalogRefresh: () => invoke('catalog_cancel_refresh'),
    onCatalogUpdate(callback) {
      let disposed = false;
      const pending = listen<import('./shared/catalog').CatalogWatchState>('catalog:updates', event => { if (!disposed) callback(event.payload) });
      return () => { disposed = true; void pending.then(unlisten => unlisten()).catch(() => {}) };
    },
    searchCatalogArtists: (query, offset = 0) => invoke('search_catalog_artists', { query, offset }),
    getCatalogArtist: (id, offset = 0) => invoke('get_catalog_artist', { id, offset }),
    statusCatalogRoute: () => invoke('status_catalog_route'),
    configureCatalogRoute: proxy => invoke('configure_catalog_route', { proxy }),
    soundCloudStatus: () => invoke('soundcloud_status'),
    configureSoundCloud: input => invoke('configure_soundcloud', { proxy: null, ...input }),
    importSoundCloudCredentials: () => invoke('import_soundcloud_credentials'),
    checkSoundCloudConnection: () => invoke('check_soundcloud_connection'),
    searchSoundCloud: async query => {
      const page = await invoke<{ items: import('./shared/sourceMatching').SoundCloudCandidate[]; nextHref?: string }>('search_soundcloud', { query })
      return { collection: page.items, hasMore: Boolean(page.nextHref) }
    },
    resolveSoundCloudCandidate: url => invoke('resolve_soundcloud_candidate', { url }),
    bindSoundCloud: (trackId, sourceId, selection = 'user') => invoke('bind_soundcloud', { trackId, sourceId, selection }),
    soundCloudBinding: trackId => invoke('soundcloud_binding', { trackId }),
    resolveSoundCloud: async trackId => {
      const source = await invoke<{ path: string; title: string; explicit?: boolean; sourceId: string }>('resolve_soundcloud', { trackId })
      return { ...source, url: soundCloudMediaUrl(source.path, convertFileSrc) }
    },
    releaseSoundCloud: url => invoke('release_soundcloud', { sessionId: url === undefined ? null : soundCloudSessionId(url) }),
    getState: async () => {
      const value = await invoke<PersistedState | null>('get_state')
      return value ? { ...value, tracks: value.tracks.map(track) } : null
    },
    // Native code owns the track registry and remote playlists. Send only the
    // renderer-owned references/preferences instead of the whole VK catalog.
    saveState: state => invoke('save_state', { state: { ...state, tracks: [], playlists: state.playlists.filter(playlist => !playlist.remote) } }),
    importFiles: async () => (await invoke<Track[]>('import_files')).map(track),
    uploadFilesToVk: () => invoke('upload_files_to_vk'),
    attachVkSource: id => invoke('attach_vk_source', { id }),
    uploadLocalTrackToVk: id => invoke('upload_local_track_to_vk', { id }),
    importFromUrl: async (url, destination, proxy) => {
      const result = await invoke<import('./shared/contracts').UploadBatchResult>('import_from_url', { url, destination, proxy: proxy || null })
      return { ...result, items: result.items.map(item => item.track ? { ...item, track: track(item.track) } : item) }
    },
    onImportProgress(callback) {
      let disposed = false
      const pending = listen<ImportProgress>('import:progress', event => { if (!disposed) callback(event.payload) })
      return () => { disposed = true; void pending.then(unlisten => unlisten()) }
    },
    onAppNotice(callback) {
      let disposed = false
      const pending = listen<string>('app:notice', event => { if (!disposed && typeof event.payload === 'string') callback(event.payload.slice(0, 1000)) })
      return () => { disposed = true; void pending.then(unlisten => unlisten()) }
    },
    removeTrack: id => invoke('remove_track', { id }),
    openExternal: url => invoke('open_external', { url }),
    openVkMusic: () => invoke('open_vk_music'),
    getVkStatus: () => invoke('get_vk_status'),
    connectVk: () => invoke('connect_vk'),
    disconnectVk: () => invoke('disconnect_vk'),
    refreshVk: () => invoke('refresh_vk'),
    addVkTrack: track => invoke('add_vk_track', { track }),
    deleteVkTrack: id => invoke('delete_vk_track', { id }),
    vkPlaylistChange: input => invoke('vk_playlist_change', { playlistId: null, title: null, description: null, trackIds: null, track: null, ...input }),
    searchVk: query => invoke('search_vk', { query }),
  artistMusic: input => invoke('vk_artist_music', { input }),
    resolveVkTrack: async id => track(await invoke<Track>('resolve_vk_track', { id })),
    vkWebControl: command => invoke('vk_web_control', { id: null, position: null, volume: null, equalizer: null, ...command }),
    onVkUpdate(callback) {
      let disposed = false
      const pending = listen<VkSnapshot>('vk:web-update', event => { if (!disposed) callback(event.payload) })
      return () => { disposed = true; void pending.then(unlisten => unlisten()) }
    },
    onVkPlayback(callback) {
      let disposed = false
      const pending = listen<VkWebPlayback>('vk:web-playback', event => { if (!disposed) callback(event.payload) })
      return () => { disposed = true; void pending.then(unlisten => unlisten()) }
    },
    getVersion: () => invoke('get_version'),
    checkAppRelease: () => invoke('check_app_release'),
    exportDiagnostics: () => invoke('export_diagnostics'),
    onCommand(callback) {
      let disposed = false
      const pending = listen<DesktopCommand>('player:command', event => { if (!disposed) callback(event.payload) })
      return () => { disposed = true; void pending.then(unlisten => unlisten()) }
    },
    onCloseRequest(callback) {
      let disposed = false
      let closing = false
      const pending = listen('app:close-requested', async () => {
        if (disposed || closing) return
        closing = true
        try {
          await callback()
          if (!disposed) await invoke('finish_close')
        } catch {
          // A failed save keeps the window open with the hook's storage error.
        } finally { closing = false }
      })
      return () => { disposed = true; void pending.then(unlisten => unlisten()) }
    },
  }
  window.desktop = Object.freeze(api)
}
