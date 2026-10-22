import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Album, Check, ChevronDown, ChevronRight, Cloud, CloudOff, Download,
  FileAudio, FolderOpen, History, Keyboard, Library, ListMusic, LogIn, Menu, Mic2,
  Music2, Plus, RefreshCw, Search, Settings, ShieldCheck,
  SlidersHorizontal, Sparkles, Trash2, Upload, X,
} from 'lucide-react'
import type { AppSettings, PersistedState, Playlist, Track, VkStatus, VkSnapshot, UploadBatchResult, ImportProgress } from './shared/contracts'
import { applyVkSnapshot, mergeTracks, stripVkState, useLibraryState } from './state'
import { usePlayback } from './usePlayback'
import appIcon from '../src-tauri/icons/app-icon.svg'
import { MusicUploadView } from './MusicUploadView'
import { QueuePanel } from './QueuePanel'
import { TrackRow } from './TrackRow'
import { PlayerBar } from './PlayerBar'
import { TrackInfo } from './TrackInfo'
import { ThemeSettings } from './ThemeSettings'
import { EqualizerSettings } from './EqualizerSettings'
import { UpdateCenter } from './UpdateCenter'
import { applyTheme } from './themes'
import { musicSearchResults } from './musicSearch'
import type { SearchScope } from './musicSearch'
import { NavigationButtons, useNavigationHistory } from './NavigationHistory'
import { Notifications, useNotifications } from './Notifications'
import { ArtistView } from './ArtistView'
import type { ArtistMusicRequest, VkArtistRef } from './shared/artists'
import { PlaylistComposer } from './PlaylistComposer'
import { SoundCloudSettings } from './SoundCloudSources'
import { CatalogView } from './CatalogView'
import type { CatalogRoute } from './CatalogView'
import { version as appVersion } from '../package.json'

type Page = 'library' | 'playlists' | 'search' | 'history' | 'local' | 'upload' | 'settings' | 'artist' | 'updates' | 'snippets' | 'catalog'
type SettingsTab = 'themes' | 'appearance' | 'playback' | 'sources' | 'equalizer' | 'library' | 'account' | 'system'

const navItems: Array<{ id: Page; label: string; icon: typeof Library }> = [
  { id: 'library', label: 'Моя музыка', icon: Library }, { id: 'playlists', label: 'Плейлисты', icon: ListMusic },
  { id: 'search', label: 'Поиск', icon: Search }, { id: 'history', label: 'История', icon: History },
  { id: 'updates', label: 'Новинки артистов', icon: Sparkles }, { id: 'snippets', label: 'Сниппеты', icon: Music2 },
  { id: 'catalog', label: 'Каталог артистов', icon: Mic2 },
  { id: 'local', label: 'Локальные файлы', icon: FolderOpen }, { id: 'upload', label: 'Загрузить в VK', icon: Upload },
]
const settingsItems: Array<{ id: SettingsTab; label: string; icon: typeof Settings }> = [
  { id: 'themes', label: 'Темы', icon: Sparkles }, { id: 'appearance', label: 'Оформление', icon: Sparkles }, { id: 'playback', label: 'Воспроизведение', icon: SlidersHorizontal }, { id: 'sources', label: 'Источники музыки', icon: Cloud },
  { id: 'equalizer', label: 'Эквалайзер', icon: SlidersHorizontal },
  { id: 'library', label: 'Библиотека и загрузки', icon: FolderOpen }, { id: 'account', label: 'Аккаунт VK', icon: ShieldCheck },
  { id: 'system', label: 'Система', icon: Settings },
]
function formatDuration(seconds: number) { if (!Number.isFinite(seconds) || seconds < 0) return '—:—'; const m = Math.floor(seconds / 60); return `${m}:${Math.floor(seconds % 60).toString().padStart(2, '0')}` }
function safeTrack(value: Track): Track { return { ...value, title: value.title || 'Без названия', artist: value.artist || 'Неизвестный исполнитель', album: value.album || 'Без альбома', duration: Number(value.duration) || 0, available: value.available !== false } }
function stripTrack(state: PersistedState, id: string): PersistedState { return { ...state, tracks: state.tracks.filter(track => track.id !== id), playlists: state.playlists.map(playlist => ({ ...playlist, trackIds: playlist.trackIds.filter(item => item !== id) })), queue: state.queue.filter(item => item !== id), history: state.history.filter(item => item !== id), currentTrackId: state.currentTrackId === id ? null : state.currentTrackId, position: state.currentTrackId === id ? 0 : state.position } }

function App() {
  const { state, setState, ready, storageError, flushState } = useLibraryState()
  const [page, setPage] = useState<Page>('library')
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('themes')
  const [query, setQuery] = useState('')
  const [queueOpen, setQueueOpen] = useState(false)
  const [mobileNav, setMobileNav] = useState(false)
  const [vkStatus, setVkStatus] = useState<VkStatus | null>(null)
  const [vkSearchTracks, setVkSearchTracks] = useState<Track[]>([])
  const [searchScope, setSearchScope] = useState<SearchScope>('all')
  const [vkSearching, setVkSearching] = useState(false)
  const [vkSearchError, setVkSearchError] = useState('')
  const [searchRetry, setSearchRetry] = useState(0)
  const [infoTrack, setInfoTrack] = useState<Track | null>(null)
  const { notices, notify: showToast, dismiss: dismissNotice } = useNotifications()
  const [addingTrackIds, setAddingTrackIds] = useState<Set<string>>(() => new Set())
  const [addedAliases, setAddedAliases] = useState<Record<string, string>>({})
  const addingTracks = useRef(new Set<string>())
  const [isImporting, setImporting] = useState(false)
  const [isUploading, setUploading] = useState(false)
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null)
  const [uploadReport, setUploadReport] = useState<UploadBatchResult | null>(null)
  const musicImportBusy = useRef(false)
  const [isSyncing, setSyncing] = useState(false)
  const [isConnecting, setConnecting] = useState(false)
  const [playlistDestination, setPlaylistDestination] = useState<'local' | 'vk'>('local')
  const [newPlaylistOpen, setNewPlaylistOpen] = useState(false)
  const [editingPlaylist, setEditingPlaylist] = useState<string | null>(null)
  const [playlistPickerTrack, setPlaylistPickerTrack] = useState<Track | null>(null)
  const [selectedPlaylist, setSelectedPlaylist] = useState<string | null>(null)
  const [sort, setSort] = useState<'recent' | 'title' | 'artist'>('recent')
  const [artistRequest, setArtistRequest] = useState<ArtistMusicRequest>({ action: 'resolve', query: '' })
  const [catalogRoute, setCatalogRoute] = useState<CatalogRoute>({ search: null, artist: null })
  const [visibleCount, setVisibleCount] = useState(120)
  const vkBusy = useRef(false)
  const vkGeneration = useRef(0)
  const lastBackgroundSync = useRef(0)
  const playback = usePlayback(state, setState)
  const sourcePickerBusy = useRef(false)
  const latestPlayback = useRef({ playback, account: vkStatus?.user?.id })
  latestPlayback.current = { playback, account: vkStatus?.user?.id }
  const route = useMemo(() => ({ page, selectedPlaylist, query, settingsTab, searchScope, sort, artistRequest, catalogRoute }), [page, selectedPlaylist, query, settingsTab, searchScope, sort, artistRequest, catalogRoute])
  const navigation = useNavigationHistory(route, next => {
    setPage(next.page); setSelectedPlaylist(next.selectedPlaylist); setQuery(next.query); setSettingsTab(next.settingsTab); setSearchScope(next.searchScope); setSort(next.sort); setArtistRequest(next.artistRequest); setCatalogRoute(next.catalogRoute)
    setInfoTrack(null); setMobileNav(false)
  })
  const restrictedNotices = useRef(new Set<string>())
  useEffect(() => {
    if (!ready || !window.desktop?.refreshCatalog) return;
    let disposed = false;
    const refresh = () => { if (!disposed && navigator.onLine !== false) void window.desktop?.refreshCatalog?.().catch(() => {}); };
    const offline = () => { void window.desktop?.cancelCatalogRefresh?.().catch(() => {}); };
    const start = setTimeout(refresh, 5000);
    // The native scheduler decides when a provider request is due, including
    // its backoff. This cheap wakeup also resumes a batch larger than 20 artists.
    const timer = setInterval(refresh, 60 * 1000);
    window.addEventListener('online', refresh); window.addEventListener('offline', offline);
    return () => { disposed = true; clearTimeout(start); clearInterval(timer); window.removeEventListener('online', refresh); window.removeEventListener('offline', offline); offline(); };
  }, [ready])
  useEffect(() => {
    if (!ready || !vkStatus?.user?.id) return
    const restricted = state.playlists.filter(playlist => playlist.contentUnavailable)
    const key = `${vkStatus.user.id}:${restricted.map(item => item.id).sort().join(',')}`
    if (!restricted.length || restrictedNotices.current.has(key)) return
    restrictedNotices.current.add(key)
    showToast(`VK ограничил содержимое ${restricted.length} плейлиста. Их названия и обложки сохранены; остальная музыка доступна.`, 'info')
  }, [ready, state.playlists, vkStatus?.user?.id, showToast])
  useEffect(() => { if (storageError) showToast(storageError, 'error') }, [storageError, showToast])
  useEffect(() => { if (vkStatus?.state === 'error') showToast(vkStatus.message, 'error') }, [vkStatus?.state, vkStatus?.message, showToast])
  useEffect(() => window.desktop?.onAppNotice?.(message => showToast(message, 'error')), [showToast])
  useEffect(() => { setAddedAliases({}); addingTracks.current.clear(); setAddingTrackIds(new Set()) }, [vkStatus?.user?.id])
  useEffect(() => { if (!playback.playing && !playback.buffering) void flushState() }, [playback.playing, playback.buffering, state.position, flushState])

  const updateSettings = (patch: Partial<AppSettings>) => setState(prev => ({ ...prev, settings: { ...prev.settings, ...patch } }))
  const importFiles = async () => {
    if (!window.desktop || musicImportBusy.current) { if (!window.desktop) showToast('Импорт доступен после запуска desktop-версии.'); return }
    musicImportBusy.current = true
    setImporting(true)
    try { const tracks = (await window.desktop.importFiles()).map(safeTrack); if (!tracks.length) return; setState(prev => ({ ...prev, tracks: mergeTracks(prev.tracks, tracks), queue: prev.queue.length ? prev.queue : tracks.map(t => t.id) })); showToast(`Добавлено файлов: ${tracks.length}`) }
    catch { showToast('Не удалось импортировать файлы. Попробуйте ещё раз.') }
    finally { musicImportBusy.current = false; setImporting(false) }
  }
  const runMusicImport = async (action: () => Promise<UploadBatchResult>, destination: 'vk' | 'local') => {
    if (musicImportBusy.current) return
    musicImportBusy.current = true
    const generation = vkGeneration.current
    const account = vkStatus?.user?.id
    setPage('upload'); setSelectedPlaylist(null); setQuery(''); setUploadReport(null); setImportProgress(null); setUploading(true)
    try {
      const result = await action()
      if (destination === 'vk' && (generation !== vkGeneration.current || (result.accountId !== undefined && account !== result.accountId))) {
        setUploadReport({ cancelled: false, items: [{ name: 'Загрузка', status: 'uncertain', message: 'Аккаунт VK изменился. Проверьте музыку в исходном аккаунте перед повторной загрузкой.' }] })
        return
      }
      setUploadReport(result)
      if (destination === 'local') {
        const tracks = result.items.filter(item => item.status === 'local' && item.track?.source === 'local').map(item => safeTrack(item.track!))
        if (tracks.length) setState(previous => ({ ...previous, tracks: mergeTracks(previous.tracks, tracks) }))
      }
      if (destination === 'vk' && result.items.some(item => item.status === 'uploaded')) void syncVk(true)
    } catch (error) {
      const changed = destination === 'vk' && generation !== vkGeneration.current
      setUploadReport({ cancelled: false, items: [{ name: 'Загрузка', status: changed ? 'uncertain' : 'failed', message: changed ? 'Сеанс VK изменился. Проверьте исходный аккаунт перед повтором.' : typeof error === 'string' ? error : error instanceof Error ? error.message : 'Не удалось добавить трек. Попробуйте ещё раз.' }] })
    } finally { musicImportBusy.current = false; setUploading(false); setImportProgress(null) }
  }
  const uploadFilesToVk = async () => {
    if (vkStatus?.state !== 'connected') { setPage('upload'); setSelectedPlaylist(null); showToast('Подключите VK перед загрузкой в аккаунт.'); return }
    if (!window.desktop?.uploadFilesToVk) { showToast('Загрузка в VK доступна в обновлённой desktop-версии.'); return }
    await runMusicImport(() => window.desktop!.uploadFilesToVk!(), 'vk')
  }
  const importFromUrl = async (url: string, destination: 'vk' | 'local', proxy?: string) => {
    if (!window.desktop?.importFromUrl) { showToast('Импорт по ссылке доступен в desktop-версии.'); return }
    await runMusicImport(() => window.desktop!.importFromUrl!(url, destination, proxy), destination)
  }
  const attachTrackSource = async (track: Track) => {
    if (!window.desktop?.attachVkSource || sourcePickerBusy.current) return
    const generation = vkGeneration.current
    const account = vkStatus?.user?.id
    if (vkStatus?.state !== 'connected' || !account || track.remote?.ownerId !== account || track.remote.inLibrary !== true) return
    sourcePickerBusy.current = true
    try {
      const result = await window.desktop.attachVkSource(track.id)
      if (generation !== vkGeneration.current || latestPlayback.current.account !== account || !result.attached) return
      const active = latestPlayback.current.playback
      if (active.current?.id === track.id && (active.playing || active.buffering || active.error)) active.retry()
      showToast('Исходник сохранён для этого трека. Он будет играть с компьютера.', 'success')
    } catch (error) {
      if (generation === vkGeneration.current && latestPlayback.current.account === account) showToast(typeof error === 'string' ? error : 'Не удалось сохранить исходник. Выберите исходный аудиофайл этого трека.', 'error')
    } finally { sourcePickerBusy.current = false }
  }
  const openVkMusic = async () => { if (!ready) return; if (!window.desktop?.openVkMusic) { showToast('Официальное окно VK доступно только в desktop-версии.'); return } try { await window.desktop.openVkMusic() } catch { showToast('Не удалось открыть VK Музыку.') } }
  const applySnapshot = (result: VkSnapshot) => {
    setVkStatus(previous => ({ ...result.status, lastSyncAt: result.complete || result.unchanged ? result.syncedAt || Date.now() : previous?.lastSyncAt }))
    if (result.complete !== true) return false
    setState(previous => applyVkSnapshot(previous, result))
    return true
  }
  const runVkOperation = async (action: () => Promise<VkSnapshot>, success?: string, quiet = false) => {
    if (vkBusy.current) return false
    vkBusy.current = true; setSyncing(true)
    const generation = vkGeneration.current
    try {
      const result = await action()
      if (generation !== vkGeneration.current) return false
      const complete = applySnapshot(result)
      if (success && result.mutationConfirmed !== true) { showToast('VK пока не подтвердил изменение. Синхронизируйте библиотеку перед повтором.'); return false }
      if (!quiet || !complete) showToast(complete ? success || `Синхронизировано: ${result.tracks.length} треков / ${result.playlists.length} плейлистов` : result.error || result.status.message)
      return complete
    } catch (error) { if (generation === vkGeneration.current) showToast(typeof error === 'string' ? error : 'VK не подтвердил операцию. Проверьте соединение и повторите синхронизацию.'); return false }
    finally { vkBusy.current = false; setSyncing(false) }
  }
  const syncVk = (quiet = false) => window.desktop ? runVkOperation(() => window.desktop!.refreshVk(), undefined, quiet) : Promise.resolve(false)
  const connectVk = async () => {
    if (!ready) return
    if (!window.desktop || isConnecting || vkBusy.current) { if (!window.desktop) showToast('VK подключается только в desktop-версии.'); return }
    setConnecting(true)
    const generation = ++vkGeneration.current
    try {
      const next = await window.desktop.connectVk()
      if (generation !== vkGeneration.current) return
      setVkStatus(next)
      if (next.state === 'not-configured') { setPage('settings'); setSettingsTab('account'); await openVkMusic(); return }
      if (next.state !== 'connected') { showToast(next.message); return }
      if (vkStatus?.user?.id && next.user?.id && vkStatus.user.id !== next.user.id) { setVkSearchTracks([]); setSelectedPlaylist(null) }
      await syncVk()
    } catch { showToast('Не удалось завершить вход VK. Повторите попытку.') }
    finally { setConnecting(false) }
  }
  const disconnectVk = async () => {
    if (!window.desktop) return
    ++vkGeneration.current
    try { const status = await window.desktop.disconnectVk(); setVkStatus(status); setVkSearchTracks([]); setSelectedPlaylist(null); setState(stripVkState); showToast('Аккаунт отключён. Данные VK удалены с компьютера.') }
    catch { showToast('Не удалось завершить выход из VK. Повторите попытку.') }
  }
  useEffect(() => {
    if (!ready) return
    let active = true
    const generation = vkGeneration.current
    if (window.desktop) void window.desktop.getVkStatus().then(status => { if (active && generation === vkGeneration.current) setVkStatus(status) }).catch(() => {})
    return () => { active = false }
  }, [ready])
  useEffect(() => {
    const unsubscribe = window.desktop?.onCommand(command => { if (command === 'play-pause') playback.toggle(); if (command === 'next') playback.next(); if (command === 'previous') playback.previous(); if (command === 'import') void (page === 'local' ? importFiles() : uploadFilesToVk()) })
    return () => { unsubscribe?.() }
  }, [playback.toggle, playback.next, playback.previous, page, vkStatus?.user?.id])
  useEffect(() => window.desktop?.onImportProgress?.(progress => { if (musicImportBusy.current) setImportProgress(progress) }), [])
  useEffect(() => {
    if (!window.desktop?.onVkUpdate) return
    const offUpdate = window.desktop.onVkUpdate(result => {
      setVkStatus(previous => ({ ...result.status, lastSyncAt: result.complete || result.unchanged ? result.syncedAt || Date.now() : result.clearRemote ? undefined : previous?.lastSyncAt }))
      if (result.clearRemote) { ++vkGeneration.current; setVkSearchTracks([]); setSelectedPlaylist(null); setState(stripVkState) }
      if (result.complete) setState(previous => applyVkSnapshot(previous, result))
      if (result.progress) setVkStatus(previous => ({ ...(previous || result.status), syncProgress: result.progress }))
    })
    return offUpdate
  }, [setState])
  useEffect(() => {
    if (!ready || vkStatus?.state !== 'connected' || vkStatus.mode === 'web') return
    void syncVk(true)
    const refresh = () => { if (document.visibilityState === 'visible' && Date.now() - lastBackgroundSync.current >= 60_000) { lastBackgroundSync.current = Date.now(); void syncVk(true) } }
    const timer = setInterval(refresh, 300_000)
    window.addEventListener('focus', refresh)
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [ready, vkStatus?.state, vkStatus?.mode])
  useEffect(() => {
    let active = true
    setVkSearchTracks([]); setVkSearchError(''); setVkSearching(false)
    if (page !== 'search' || searchScope !== 'all' || !query.trim() || vkStatus?.state !== 'connected' || !window.desktop) return () => { active = false }
    setVkSearching(true)
    const timer = setTimeout(() => {
      void window.desktop!.searchVk(query.trim()).then(result => {
        if (active) setVkSearchTracks(result.map(safeTrack))
      }).catch(error => {
        if (active) setVkSearchError(typeof error === 'string' ? error : error instanceof Error ? error.message : 'Поиск VK временно недоступен. Попробуйте ещё раз.')
      }).finally(() => { if (active) setVkSearching(false) })
    }, 280)
    return () => { active = false; clearTimeout(timer) }
  }, [page, query, searchScope, searchRetry, vkStatus?.state, vkStatus?.user?.id])
  useEffect(() => { setVisibleCount(120) }, [page, query, selectedPlaylist, sort])
  useEffect(() => applyTheme(state.settings), [state.settings.theme, state.settings.palette, state.settings.accent, state.settings.style, state.settings.reducedMotion, state.settings.density, state.settings.textScale])
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setSelectedPlaylist(null); setPage('search'); setTimeout(() => document.getElementById('global-search')?.focus(), 0) } if (event.key === 'Escape' && !event.defaultPrevented) { setQueueOpen(false); setMobileNav(false); setNewPlaylistOpen(false); setPlaylistPickerTrack(null); setInfoTrack(null) } }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey) }, [])

  const trackById = useMemo(() => new Map(state.tracks.map(track => [track.id, track])), [state.tracks])
  const queueTracks = useMemo(() => state.queue.map(id => trackById.get(id)).filter((track): track is Track => Boolean(track)), [state.queue, trackById])
  const pageTracks = useMemo(() => {
    let tracks = state.tracks
    if (page === 'search') { const results = musicSearchResults(state.tracks, vkSearchTracks, query, searchScope); return sort === 'recent' ? results : results.sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title) : a.artist.localeCompare(b.artist)) }
    if (page === 'library') tracks = tracks.filter(track => track.source === 'local' || track.remote?.inLibrary !== false)
    if (page === 'history') tracks = state.history.map(id => trackById.get(id)).filter((track): track is Track => Boolean(track))
    if (page === 'local') tracks = tracks.filter(track => track.source === 'local')
    if (page === 'playlists' && selectedPlaylist) { const playlist = state.playlists.find(item => item.id === selectedPlaylist); tracks = playlist ? playlist.trackIds.map(id => trackById.get(id)).filter((track): track is Track => Boolean(track)) : [] }
    const q = query.trim().toLocaleLowerCase()
    if (q) tracks = tracks.filter(track => `${track.title} ${track.artist} ${track.album}`.toLocaleLowerCase().includes(q))
    if (page === 'library' && sort === 'recent') {
      // Native snapshots persist the sequence supplied by VK. addedAt records
      // local import time, which cannot reconstruct the account's order.
      return [...tracks.filter(track => track.source === 'vk'), ...tracks.filter(track => track.source === 'local').sort((a, b) => b.addedAt - a.addedAt)]
    }
    if ((page === 'playlists' || page === 'history') && sort === 'recent') return tracks
    return [...tracks].sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title) : sort === 'artist' ? a.artist.localeCompare(b.artist) : b.addedAt - a.addedAt)
  }, [state.tracks, state.history, state.playlists, trackById, page, query, sort, selectedPlaylist, vkSearchTracks, searchScope])
  const activePlaylist = page === 'playlists' ? state.playlists.find(p => p.id === selectedPlaylist) : undefined
  const musicVerified = vkStatus?.state === 'connected' && vkStatus.capabilities.some(cap => cap.id === 'library' && cap.status === 'verified')
  const vkCanEdit = musicVerified && (vkStatus?.mode !== 'web' || vkStatus.capabilities.some(cap => cap.id === 'mutations' && cap.status === 'verified'))
  const vkCanEditTracks = musicVerified && (vkStatus?.mode !== 'web' || vkStatus.capabilities.some(cap => cap.id === 'track-mutations' && cap.status === 'verified'))
  const canEditActivePlaylist = !activePlaylist?.remote || vkCanEdit && activePlaylist.remote.ownerId === vkStatus?.user?.id
  const activePageTitle = activePlaylist ? activePlaylist.title : navItems.find(item => item.id === page)?.label || (page === 'upload' ? 'Загрузка в VK' : 'Настройки')
  const activePageDescription = page === 'library' ? 'Ваша музыка, собранная в одном месте.' : page === 'local' ? 'Файлы на этом компьютере, без отправки в VK.' : page === 'history' ? 'Недавно прослушанные треки.' : page === 'playlists' ? 'Собирайте музыку под настроение.' : page === 'search' ? 'Ищите по локальной библиотеке и VK.' : page === 'upload' ? 'Добавляйте MP3 и треки по ссылке в аккаунт VK.' : 'Настройте Pulse под себя.'
  const currentInQueue = state.currentTrackId ? queueTracks.findIndex(track => track.id === state.currentTrackId) : -1

  const addToQueue = (track: Track) => setState(prev => ({ ...prev, tracks: mergeTracks(prev.tracks, [track]), queue: prev.queue.includes(track.id) ? prev.queue : [...prev.queue, track.id] }))
  const removeFromQueue = (id: string) => setState(prev => ({ ...prev, queue: prev.queue.filter(item => item !== id), currentTrackId: prev.currentTrackId === id ? null : prev.currentTrackId }))
  const moveQueue = (index: number, direction: -1 | 1) => setState(prev => { const queue = [...prev.queue]; const target = index + direction; if (target < 0 || target >= queue.length) return prev; [queue[index], queue[target]] = [queue[target], queue[index]]; return { ...prev, queue } })
  const savePlaylist = async (input: { title: string; description: string; trackIds: string[]; destination: 'local' | 'vk' }) => {
    const existing = state.playlists.find(item => item.id === editingPlaylist)
    if (input.destination === 'vk') {
      if (!window.desktop?.vkPlaylistChange || !vkCanEdit || vkBusy.current) return false
      let snapshot: VkSnapshot | undefined
      const confirmed = await runVkOperation(async () => { snapshot = await window.desktop!.vkPlaylistChange({ operation: existing ? 'edit' : 'create', playlistId: existing?.id, title: input.title, description: input.description, trackIds: input.trackIds }); return snapshot }, existing ? 'Изменения плейлиста сохранены в VK' : 'Плейлист и выбранные треки сохранены в VK')
      if (!confirmed) return false
      setSelectedPlaylist(snapshot?.createdPlaylistId || existing?.id || null)
    } else {
      const playlist: Playlist = { id: existing?.id || `playlist-${crypto.randomUUID()}`, title: input.title, description: input.description, trackIds: input.trackIds, createdAt: existing?.createdAt || Date.now() }
      setState(previous => ({ ...previous, playlists: existing ? previous.playlists.map(item => item.id === existing.id ? playlist : item) : [...previous.playlists, playlist] }))
      setSelectedPlaylist(playlist.id); showToast(existing ? 'Плейлист сохранён' : 'Плейлист создан', 'success')
    }
    setPage('playlists'); setEditingPlaylist(null); setNewPlaylistOpen(false)
    return true
  }
  const newPlaylist = () => { setEditingPlaylist(null); setPlaylistDestination(vkCanEdit ? 'vk' : 'local'); setNewPlaylistOpen(true) }
  const renameSelectedPlaylist = () => { const playlist = state.playlists.find(item => item.id === selectedPlaylist); if (!playlist) return; setEditingPlaylist(playlist.id); setPlaylistDestination(playlist.remote ? 'vk' : 'local'); setNewPlaylistOpen(true) }
  const addTrackToPlaylist = async (track: Track, playlistId: string) => {
    const playlist = state.playlists.find(item => item.id === playlistId)
    if (!playlist || playlist.trackIds.includes(track.id)) return
    if (playlist.remote) {
      if (!vkCanEdit || playlist.remote.ownerId !== vkStatus?.user?.id) { showToast('Этот плейлист можно изменить в окне VK, затем обновить синхронизацию.'); return }
      if (!track.remote || !window.desktop?.vkPlaylistChange) { showToast('Сначала загрузите локальный файл в VK через официальный сайт.'); return }
      if (!await runVkOperation(() => window.desktop!.vkPlaylistChange({ operation: 'add-track', playlistId, track }), 'VK подтвердил добавление в плейлист')) return
    } else { setState(prev => ({ ...prev, tracks: mergeTracks(prev.tracks, [track]), playlists: prev.playlists.map(item => item.id === playlistId && !item.trackIds.includes(track.id) ? { ...item, trackIds: [...item.trackIds, track.id] } : item) })); showToast('Добавлено в локальный плейлист') }
    setPlaylistPickerTrack(null)
  }
  const removeTrackFromContext = async (track: Track) => {
    if (activePlaylist) {
      if (activePlaylist.remote) { if (window.desktop?.vkPlaylistChange) await runVkOperation(() => window.desktop!.vkPlaylistChange({ operation: 'remove-track', playlistId: activePlaylist.id, track }), 'VK подтвердил удаление из плейлиста'); else showToast('Изменение плейлистов VK доступно в Tauri-версии.'); return }
      setState(prev => ({ ...prev, playlists: prev.playlists.map(item => item.id === activePlaylist.id ? { ...item, trackIds: item.trackIds.filter(id => id !== track.id) } : item) })); showToast('Трек убран из плейлиста'); return
    }
    if (track.source === 'vk') {
      if (track.remote?.inLibrary === false || !window.desktop?.deleteVkTrack) return
      if (window.confirm(`Удалить «${track.title}» из вашей музыки VK?`)) await runVkOperation(() => window.desktop!.deleteVkTrack(track.id), 'VK подтвердил удаление трека')
      return
    }
    try { if (window.desktop) await window.desktop.removeTrack(track.id); setState(prev => stripTrack(prev, track.id)); showToast('Файл убран из библиотеки') } catch { showToast('Не удалось убрать файл из библиотеки.') }
  }
  const deleteSelectedPlaylist = async () => {
    const playlist = activePlaylist; if (!playlist || !window.confirm(`Удалить плейлист «${playlist.title}»${playlist.remote ? ' из VK' : ''}?`)) return
    if (playlist.remote) { if (!window.desktop?.vkPlaylistChange || !await runVkOperation(() => window.desktop!.vkPlaylistChange({ operation: 'delete', playlistId: playlist.id }), 'VK подтвердил удаление плейлиста')) return }
    else { setState(prev => ({ ...prev, playlists: prev.playlists.filter(item => item.id !== playlist.id) })); showToast('Плейлист удалён') }
    setSelectedPlaylist(null); setPage('playlists')
  }
  const addVkTrack = async (track: Track) => {
    if (!window.desktop?.addVkTrack || addingTracks.current.has(track.id)) return false
    if (vkBusy.current) { showToast('Дождитесь завершения текущего сохранения в VK.'); return false }
    addingTracks.current.add(track.id); setAddingTrackIds(new Set(addingTracks.current))
    try {
      let result: VkSnapshot | undefined
      const complete = await runVkOperation(async () => { result = await window.desktop!.addVkTrack(track); return result }, 'Трек сохранён в вашей музыке VK')
      if (complete && result?.addedTrack) setAddedAliases(previous => ({ ...previous, [result!.addedTrack!.sourceId]: result!.addedTrack!.ownedId }))
      return complete
    } finally { addingTracks.current.delete(track.id); setAddingTrackIds(new Set(addingTracks.current)) }
  }
  const navigateArtist = (request: ArtistMusicRequest) => { setArtistRequest(request); setPage(request.action === 'updates' ? 'updates' : request.action === 'snippets' ? 'snippets' : 'artist'); setSelectedPlaylist(null); setQuery(''); setInfoTrack(null) }
  const openArtist = (artist: string, reference?: VkArtistRef) => navigateArtist(reference ? { action: 'artist', artistId: reference.id } : { action: 'resolve', query: artist })
  const playArtistTrack = (track: Track, context: Track[], fullVersion = false) => {
    if (state.currentTrackId === track.id && !fullVersion) { playback.toggle(); return }
    setState(previous => ({ ...previous, tracks: mergeTracks(previous.tracks, context) }))
    playback.playTrack(track.id, context.filter(item => item.available).map(item => item.id))
  }
  const togglePlay = (track: Track) => { if (state.currentTrackId === track.id) playback.toggle(); else { setState(prev => ({ ...prev, tracks: mergeTracks(prev.tracks, [track]) })); playback.playTrack(track.id, pageTracks.filter(item => item.available).map(item => item.id)) } }

  if (!ready) return <div className="boot-screen"><img className="app-logo" src={appIcon} alt="Pulse" /><span>Загружаем библиотеку…</span></div>
  return <div className="app-shell">
    <aside className={`sidebar ${mobileNav ? 'sidebar-open' : ''}`}>
      <div className="brand"><img className="app-logo" src={appIcon} alt="Pulse" /><div><strong>PULSE</strong><span>VK music player</span></div><UpdateCenter onBeforeInstall={flushState} /><button className="icon-button mobile-close" onClick={() => setMobileNav(false)} aria-label="Закрыть меню"><X size={18} /></button></div>
      <div className="sidebar-scroll">
        <p className="eyebrow nav-label">БИБЛИОТЕКА</p>
        <nav className="main-nav">{navItems.map(item => { const Icon = item.icon; return <button key={item.id} className={`nav-item ${page === item.id && !selectedPlaylist ? 'active' : ''}`} onClick={() => { setPage(item.id); setSelectedPlaylist(null); setMobileNav(false); if (item.id !== 'search') setQuery('') }}><Icon size={18} /><span>{item.label}</span>{item.id === 'local' && state.tracks.filter(track => track.source === 'local').length > 0 && <small>{state.tracks.filter(track => track.source === 'local').length}</small>}</button> })}</nav>
        <div className="sidebar-section"><div className="section-heading"><p className="eyebrow nav-label">ПЛЕЙЛИСТЫ</p><button className="tiny-button" onClick={newPlaylist} aria-label="Новый плейлист"><Plus size={16} /></button></div>{state.playlists.length === 0 ? <button className="create-playlist-link" onClick={newPlaylist}><Plus size={15} /> Создать плейлист</button> : state.playlists.slice(0, 40).map(playlist => <button key={playlist.id} className={`nav-item playlist-nav ${selectedPlaylist === playlist.id ? 'active' : ''}`} onClick={() => { setSelectedPlaylist(playlist.id); setPage('playlists'); setMobileNav(false); setQuery('') }}><ListMusic size={16} /><span>{playlist.title}</span><small>{playlist.contentUnavailable ? 'недоступен' : playlist.trackIds.length}</small></button>)}{state.playlists.length > 40 && <button className="create-playlist-link" onClick={() => { setPage('playlists'); setSelectedPlaylist(null) }}>Все плейлисты ({state.playlists.length})</button>}</div>
      </div>
      <div className="sidebar-footer"><button className={`nav-item ${page === 'settings' ? 'active' : ''}`} onClick={() => { setPage('settings'); setMobileNav(false) }}><Settings size={18} /><span>Настройки</span></button><div className={`connection-mini ${vkStatus?.state === 'connected' ? 'connected' : ''}`}><span className="status-dot" /><div><strong>{vkStatus?.state === 'connected' ? vkStatus.user?.name || 'VK подключён' : 'VK не подключён'}</strong><small>{vkStatus?.state === 'connected' ? 'Аккаунт авторизован' : 'Войти для синхронизации'}</small></div>{vkStatus?.state !== 'connected' && <button onClick={connectVk} aria-label="Подключить VK"><ChevronRight size={16} /></button>}</div></div>
    </aside>
    {mobileNav && <button className="scrim" onClick={() => setMobileNav(false)} aria-label="Закрыть меню" />}
    <main className="main-content">
      <header className="topbar"><NavigationButtons {...navigation} /><button className="icon-button menu-button" onClick={() => setMobileNav(true)} aria-label="Открыть меню"><Menu size={20} /></button><div className="topbar-search"><Search size={17} /><input id="global-search" value={query} onChange={event => { setQuery(event.target.value); if (event.target.value) { setPage('search'); setSelectedPlaylist(null) } }} placeholder="Поиск музыки" /><kbd>Ctrl K</kbd></div><div className="topbar-actions"><button className="icon-button" onClick={() => void syncVk()} disabled={isSyncing || isConnecting || !(vkStatus?.state === 'connected' || vkStatus?.mode === 'web' && vkStatus.user)} aria-label="Синхронизировать VK" title={vkStatus?.state === 'connected' ? 'Проверить библиотеку VK' : 'Сначала подключите VK'}><RefreshCw size={17} className={isSyncing ? 'spin' : ''} />{vkStatus?.syncProgress && vkStatus.syncProgress.phase !== 'complete' && <span className="sync-indicator" aria-label="Обновление VK в фоне" />}</button><button className="user-chip" onClick={() => { setPage('settings'); setSettingsTab('account') }}><span className="avatar">{vkStatus?.user?.avatar ? <img src={vkStatus.user.avatar} alt="" /> : vkStatus?.state === 'connected' ? (vkStatus.user?.name || 'V').slice(0, 1) : <CloudOff size={15} />}</span><span className="user-chip-name">{vkStatus?.state === 'connected' ? vkStatus.user?.name || 'VK' : 'Гостевой режим'}</span><ChevronDown size={15} /></button></div></header>
      <div className="content-scroll"><div className="page-content">
        {!['settings', 'artist', 'updates', 'snippets', 'catalog'].includes(page) && <><div className="page-heading"><div><p className="eyebrow">{page === 'library' ? 'БИБЛИОТЕКА' : page === 'upload' ? 'VK MUSIC' : 'РАЗДЕЛ'}</p><h1>{activePageTitle}{activePlaylist?.remote && <span className="remote-badge">VK</span>}</h1><p className="page-description">{activePageDescription}</p></div><div className="heading-actions">{activePlaylist?.remote && !canEditActivePlaylist && <button className="secondary-button" onClick={openVkMusic}>Открыть в VK</button>}{page === 'playlists' && <><button className="secondary-button" onClick={newPlaylist}><Plus size={17} /> Новый плейлист</button>{selectedPlaylist && canEditActivePlaylist && <><button className="secondary-button" onClick={renameSelectedPlaylist}>Редактировать</button><button className="secondary-button danger-button" onClick={deleteSelectedPlaylist}><Trash2 size={16} /> Удалить</button></>}</>}{(page === 'library' || page === 'local') && <button className="primary-button" onClick={() => void (page === 'local' ? importFiles() : uploadFilesToVk())} disabled={isImporting || isUploading}><Upload size={17} /> {isImporting || isUploading ? 'Добавление…' : page === 'local' ? 'Добавить файлы' : 'Добавить в VK'}</button>}</div></div>

          {page === 'search' && <div className="search-tools"><div className="segmented search-scope" aria-label="Область поиска"><button className={searchScope === 'all' ? 'active' : ''} aria-pressed={searchScope === 'all'} onClick={() => setSearchScope('all')}>Вся музыка VK</button><button className={searchScope === 'mine' ? 'active' : ''} aria-pressed={searchScope === 'mine'} onClick={() => setSearchScope('mine')}>Моя музыка</button></div>{query.trim() && searchScope === 'all' && <div className="search-status" role="status">{vkSearching ? <><RefreshCw size={14} className="spin" /> Ищем в VK…</> : vkSearchError ? <><CloudOff size={14} /><span>{vkSearchError}</span><button className="text-button" onClick={() => setSearchRetry(value => value + 1)}>Повторить поиск</button></> : vkStatus?.state !== 'connected' ? <span>Пока доступны совпадения из сохранённой музыки. Для глобального поиска подключите VK.</span> : <span>Результаты VK и совпадения из вашей библиотеки</span>}</div>}</div>}
          {page === 'playlists' && !selectedPlaylist ? <PlaylistOverview playlists={state.playlists} onOpen={id => setSelectedPlaylist(id)} onCreate={newPlaylist} /> : page === 'upload' ? <MusicUploadView onConnect={connectVk} onFiles={() => void uploadFilesToVk()} onUrl={(url, destination, proxy) => void importFromUrl(url, destination, proxy)} connected={vkStatus?.state === 'connected'} busy={isUploading || isImporting} progress={importProgress} report={uploadReport} /> : page === 'search' && !query.trim() ? <SearchLanding onFocus={() => document.getElementById('global-search')?.focus()} /> : <>
            {page === 'library' && state.tracks.length === 0 ? <EmptyLibrary onImport={() => void uploadFilesToVk()} onConnect={connectVk} onOpenVk={openVkMusic} connected={vkStatus?.state === 'connected'} /> : <div className="library-panel"><div className="panel-toolbar"><span className="result-count">{pageTracks.length} {pageTracks.length === 1 ? 'трек' : 'треков'}</span><div className="toolbar-actions"><label className="select-wrap"><span>Сортировка</span><select value={sort} onChange={event => setSort(event.target.value as typeof sort)}><option value="recent">{page === 'search' ? 'Релевантность' : page === 'library' ? 'Как в VK' : page === 'playlists' ? 'Порядок плейлиста' : page === 'history' ? 'Порядок истории' : 'Недавно добавленные'}</option><option value="title">По названию</option><option value="artist">По исполнителю</option></select><ChevronDown size={14} /></label></div></div>{pageTracks.length ? <div className="track-list" role="list">{pageTracks.slice(0, visibleCount).map((track, index) => <TrackRow key={`${track.id}-${index}`} track={track} index={index} active={track.id === state.currentTrackId} playing={track.id === state.currentTrackId && playback.playing} onPlay={() => togglePlay(track)} onArtist={() => openArtist(track.artist, track.artistRefs?.[0])} onInfo={() => setInfoTrack(track)} onQueue={() => addToQueue(track)} onAttachSource={window.desktop?.attachVkSource && vkStatus?.state === 'connected' && track.source === 'vk' && track.remote?.inLibrary === true && track.remote.ownerId === vkStatus.user?.id ? () => void attachTrackSource(track) : undefined} onRemove={activePlaylist || track.source === 'local' || track.remote?.inLibrary !== false ? () => void removeTrackFromContext(track) : undefined} removeDisabled={isSyncing || Boolean((activePlaylist ? activePlaylist.remote && !canEditActivePlaylist : track.source === 'vk' && !vkCanEditTracks))} removeLabel={activePlaylist ? 'Убрать из плейлиста' : track.source === 'vk' ? 'Удалить из VK' : 'Убрать из библиотеки'} onAddVk={track.source === 'local' && vkStatus?.state === 'connected' && window.desktop?.uploadLocalTrackToVk ? () => void runMusicImport(() => window.desktop!.uploadLocalTrackToVk!(track.id), 'vk') : track.source === 'vk' && !track.remote?.inLibrary && vkCanEditTracks ? () => addVkTrack(track) : undefined} adding={addingTrackIds.has(track.id)} added={Boolean(addedAliases[track.id] && trackById.get(addedAliases[track.id])?.remote?.inLibrary)} onAddPlaylist={state.playlists.length ? () => setPlaylistPickerTrack(track) : undefined} />)}{pageTracks.length > visibleCount && <button className="secondary-button load-more" onClick={() => setVisibleCount(count => count + 120)}>Показать ещё / {pageTracks.length - visibleCount} треков</button>}</div> : <div className="empty-filter"><Search size={24} /><strong>{activePlaylist?.contentUnavailable ? 'VK ограничил доступ к плейлисту' : selectedPlaylist ? 'Плейлист пуст' : 'Ничего не найдено'}</strong><span>{activePlaylist?.contentUnavailable ? 'Название и обложка сохранены. Содержимое сейчас недоступно для вашего аккаунта в VK.' : selectedPlaylist ? 'Добавьте треки из библиотеки через меню «…».' : 'Попробуйте изменить запрос или импортировать аудиофайлы.'}</span>{selectedPlaylist && !activePlaylist?.contentUnavailable && <button className="secondary-button" onClick={() => setPage('library')}>Добавить треки из библиотеки</button>}</div>}</div>}
          </>}
        </>}
        {['artist', 'updates', 'snippets'].includes(page) && <ArtistView key={vkStatus?.user?.id || 'disconnected'} request={page === 'updates' ? { action: 'updates' } : page === 'snippets' ? { action: 'snippets' } : artistRequest} connected={vkStatus?.state === 'connected'} library={state.tracks} currentId={state.currentTrackId} playing={playback.playing} onNavigate={navigateArtist} onPlay={playArtistTrack} onAdd={addVkTrack} addedTrackIds={new Set(Object.keys(addedAliases).filter(id => trackById.get(addedAliases[id])?.remote?.inLibrary))} onSnippet={(track, from, to) => { setState(previous => ({ ...previous, tracks: mergeTracks(previous.tracks, [track]) })); playback.playSnippet(track.id, from, to) }} onConnect={() => void connectVk()} />}
        {page === 'catalog' && <CatalogView route={catalogRoute} onNavigate={setCatalogRoute} onSearchVk={value => { setPage('search'); setSelectedPlaylist(null); setSearchScope('all'); setQuery(value); setInfoTrack(null) }} />}
        {page === 'settings' && <SettingsView settings={state.settings} tab={settingsTab} onTab={setSettingsTab} equalizerError={playback.equalizerError} update={updateSettings} vkStatus={vkStatus} onConnect={connectVk} onOpenVk={openVkMusic} onDisconnect={disconnectVk} busy={isConnecting || isSyncing} onSync={() => void syncVk()} />}
      </div></div>
      <PlayerBar current={playback.current} playing={playback.playing} buffering={playback.buffering} advertising={playback.advertising} position={playback.position} duration={playback.duration} buffered={playback.buffered} bufferedAhead={playback.bufferedAhead} network={playback.network} volume={state.settings.volume} queueCount={queueTracks.length} onToggle={playback.toggle} onPrevious={playback.previous} onNext={playback.next} onSeek={playback.seek} onVolume={volume => updateSettings({ volume })} onQueue={() => setQueueOpen(true)} canShuffle={state.tracks.some(track => track.available && (track.source === 'local' || track.remote?.inLibrary !== false))} shuffle={state.settings.shuffle} repeat={state.settings.repeat} onShuffle={playback.toggleShuffle} onRepeat={() => updateSettings({ repeat: state.settings.repeat === 'off' ? 'all' : state.settings.repeat === 'all' ? 'one' : 'off' })} onArtist={() => playback.current && openArtist(playback.current.artist, playback.current.artistRefs?.[0])} onInfo={() => playback.current && setInfoTrack(playback.current)} error={playback.error} onRetry={playback.retry} onDismissError={playback.clearError} />
    </main>
    <QueuePanel open={queueOpen} tracks={queueTracks} currentIndex={currentInQueue} playing={playback.playing} currentId={state.currentTrackId} onClose={() => setQueueOpen(false)} onPlay={track => playback.playTrack(track.id)} onRemove={removeFromQueue} onMove={moveQueue} onClear={() => setState(prev => ({ ...prev, queue: [], currentTrackId: null }))} />
    {infoTrack && <TrackInfo track={infoTrack} preferExplicit={state.settings.preferExplicit} sourceLabel={playback.current?.id === infoTrack.id ? playback.sourceLabel : undefined} onSourceChanged={() => { if (playback.current?.id === infoTrack.id) playback.reloadSource() }} onClose={() => setInfoTrack(null)} onArtist={() => openArtist(infoTrack.artist, infoTrack.artistRefs?.[0])} />}
    {newPlaylistOpen && <PlaylistComposer key={`${vkStatus?.user?.id || 'local'}:${editingPlaylist || 'new'}`} tracks={state.tracks} initialPlaylist={state.playlists.find(item => item.id === editingPlaylist)} initialDestination={playlistDestination} canSyncVk={vkCanEdit} accountId={vkStatus?.user?.id} busy={isSyncing} onClose={() => { if (!isSyncing) setNewPlaylistOpen(false) }} onSave={savePlaylist} />}
    {playlistPickerTrack && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setPlaylistPickerTrack(null) }}><div className="modal-card"><div className="modal-header"><div><p className="eyebrow">ДОБАВИТЬ ТРЕК</p><h2>Выберите плейлист</h2></div><button className="icon-button" onClick={() => setPlaylistPickerTrack(null)} aria-label="Закрыть"><X size={19} /></button></div><div className="playlist-picker">{state.playlists.map(playlist => <button key={playlist.id} disabled={isSyncing || playlist.trackIds.includes(playlistPickerTrack.id) || Boolean(playlist.remote && (!playlistPickerTrack.remote || !vkCanEdit || playlist.remote.ownerId !== vkStatus?.user?.id))} onClick={() => void addTrackToPlaylist(playlistPickerTrack, playlist.id)}><ListMusic size={17} /><span><strong>{playlist.title}</strong><small>{playlist.trackIds.includes(playlistPickerTrack.id) ? 'Уже в плейлисте' : playlist.remote ? 'VK' : 'На компьютере'} / {playlist.trackIds.length} треков</small></span><ChevronRight size={15} /></button>)}</div></div></div>}
    <Notifications notices={notices} dismiss={dismissNotice} />
  </div>
}

function EmptyLibrary({ onImport, onConnect, onOpenVk, connected }: { onImport: () => void; onConnect: () => void; onOpenVk: () => void; connected: boolean }) { return <div className="empty-library"><div className="empty-art"><div className="empty-disc"><Music2 size={34} /></div><span className="sparkle sparkle-a">✦</span><span className="sparkle sparkle-b">✦</span></div><p className="eyebrow">НАЧНЁМ С ЧИСТОГО ЛИСТА</p><h2>Ваша музыка —<br /><em>ваши правила.</em></h2><p className="empty-copy">Импортируйте любимые файлы или подключите VK, чтобы собрать личную библиотеку без лишнего шума.</p><div className="empty-actions"><button className="primary-button" onClick={onImport}><Upload size={17} /> Добавить в VK</button>{!connected && <button className="secondary-button" onClick={onConnect}><LogIn size={17} /> Подключить VK</button>}{connected && <button className="secondary-button" onClick={onOpenVk}><Music2 size={17} /> Открыть VK Музыку</button>}</div><div className="format-hint"><FileAudio size={15} /> MP3 <span>→</span> в аккаунт VK и в плеер</div></div> }
function PlaylistOverview({ playlists, onOpen, onCreate }: { playlists: Playlist[]; onOpen: (id: string) => void; onCreate: () => void }) { const [count, setCount] = useState(120); return <div className="playlist-overview">{playlists.length ? <div className="playlist-cards">{playlists.slice(0, count).map(playlist => <button className="playlist-card" key={playlist.id} onClick={() => onOpen(playlist.id)}><span className="playlist-card-art">{playlist.artwork ? <img src={playlist.artwork} alt="" loading="lazy" decoding="async" /> : <ListMusic size={23} />}</span><span className="playlist-card-copy"><strong>{playlist.title}</strong><small>{playlist.remote ? 'VK' : 'На компьютере'} / {playlist.contentUnavailable ? 'недоступен в VK' : `${playlist.trackIds.length} треков`}</small></span><ChevronRight size={17} /></button>)}{playlists.length > count && <button className="secondary-button" onClick={() => setCount(value => value + 120)}>Ещё плейлисты / {playlists.length - count}</button>}</div> : <div className="empty-filter"><ListMusic size={25} /><strong>Плейлистов пока нет</strong><span>Соберите отдельную коллекцию для любого настроения.</span><button className="primary-button" onClick={onCreate}><Plus size={16} /> Создать плейлист</button></div>}</div> }
function SearchLanding({ onFocus }: { onFocus: () => void }) { return <div className="search-landing"><div className="search-icon-large"><Search size={30} /></div><h2>Найдите свой следующий трек</h2><p>Поиск по локальной библиотеке и подключённому VK. Нажмите <kbd>Ctrl K</kbd>, чтобы начать.</p><button className="secondary-button" onClick={onFocus}><Search size={16} /> Открыть поиск</button></div> }

function SettingsView({ settings, tab, onTab, update, equalizerError, vkStatus, onConnect, onOpenVk, onDisconnect, busy, onSync }: { settings: AppSettings; equalizerError?: string; tab: SettingsTab; onTab: (tab: SettingsTab) => void; update: (patch: Partial<AppSettings>) => void; vkStatus: VkStatus | null; onConnect: () => void; onOpenVk: () => void; onDisconnect: () => void; busy: boolean; onSync: () => void }) {
  return <div className="settings-layout"><div className="settings-intro"><p className="eyebrow">ПЕРСОНАЛИЗАЦИЯ</p><h1>Настройки</h1><p className="page-description">Всё нужное — под рукой. Остальное не мешает слушать.</p></div><div className="settings-body"><nav className="settings-nav">{settingsItems.map(item => { const Icon = item.icon; return <button className={tab === item.id ? 'active' : ''} key={item.id} onClick={() => onTab(item.id)}><Icon size={17} /><span>{item.label}</span><ChevronRight size={15} /></button> })}</nav><div className="settings-content">{tab === 'themes' && <ThemeSettings settings={settings} onChange={update} />}{tab === 'appearance' && <AppearanceSettings settings={settings} update={update} />}{tab === 'playback' && <PlaybackSettings settings={settings} update={update} />}{tab === 'sources' && <SoundCloudSettings settings={settings} onChange={update} />}{tab === 'equalizer' && <EqualizerSettings error={equalizerError} value={settings.equalizer} onChange={equalizer => update({ equalizer })} />}{tab === 'library' && <LibrarySettings settings={settings} update={update} />}{tab === 'account' && <AccountSettings status={vkStatus} onConnect={onConnect} onOpenVk={onOpenVk} onDisconnect={onDisconnect} busy={busy} onSync={onSync} />}{tab === 'system' && <SystemSettings settings={settings} update={update} />}</div></div></div>
}
function AppearanceSettings({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => void }) { const styles: Array<{ id: AppSettings['style']; label: string; detail: string }> = [{ id: 'minimal', label: 'Лаконичный', detail: 'Чистый и спокойный' }, { id: 'compact', label: 'Компактный', detail: 'Больше музыки на экране' }, { id: 'album', label: 'Альбомный', detail: 'Обложки в центре внимания' }, { id: 'soft', label: 'Мягкий', detail: 'Плавные формы и фон' }]; return <SettingsSection title="Оформление" description="Создайте пространство, в котором приятно слушать музыку."><SettingCard title="Стиль интерфейса" description="Стиль меняет компоновку и плотность, сохраняя знакомые действия."><div className="style-grid">{styles.map(item => <button key={item.id} className={`style-option style-${item.id} ${settings.style === item.id ? 'selected' : ''}`} onClick={() => update({ style: item.id })}><span className="style-preview"><i /><i /><i /></span><strong>{item.label}</strong><small>{item.detail}</small>{settings.style === item.id && <Check size={14} />}</button>)}</div></SettingCard></SettingsSection> }
function PlaybackSettings({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => void }) { return <SettingsSection title="Воспроизведение" description="Настройте поведение очереди и фонового проигрывания."><SettingToggle title="Автопереход после ошибки" description="После трёх ошибок за 10 секунд переходы останавливаются." checked={settings.autoSkip} onChange={autoSkip => update({ autoSkip })} /><SettingToggle title="Возобновлять воспроизведение" description="Продолжать последний трек после запуска приложения." checked={settings.autoplay} onChange={autoplay => update({ autoplay })} /></SettingsSection> }
function LibrarySettings({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => void }) { return <SettingsSection title="Библиотека и загрузки" description="Управляйте отображением локальных файлов и импортом."><SettingToggle title="Компактные строки" description="Показывать больше треков в списке." checked={settings.density === 'compact'} onChange={compact => update({ density: compact ? 'compact' : 'comfortable' })} /><SettingCard title="Размер текста" description={`${Math.round(settings.textScale * 100)}% — применяется ко всему интерфейсу.`}><input className="range-wide" type="range" min="0.9" max="1.15" step="0.05" value={settings.textScale} onChange={event => update({ textScale: Number(event.target.value) })} /></SettingCard></SettingsSection> }
function AccountSettings({ status, onConnect, onOpenVk, onDisconnect, busy, onSync }: { status: VkStatus | null; onConnect: () => void; onOpenVk: () => void; onDisconnect: () => void; busy: boolean; onSync: () => void }) {
  const connected = status?.state === 'connected'
  const inProgress = status?.state === 'connecting' || status?.state === 'waiting-login'
  return <SettingsSection title="Аккаунт VK" description="Войдите в окне VK — музыка и плейлисты автоматически появятся в Pulse.">
    <div className={`account-card ${connected ? 'connected' : ''}`}><div className="account-icon">{connected ? <Check size={21} /> : <ShieldCheck size={21} />}</div><div><strong>{status?.user?.name || (connected ? 'VK подключён' : inProgress ? 'Подключаем VK…' : 'VK не подключён')}</strong><p>{connected ? `Последняя синхронизация: ${status?.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString('ru-RU') : 'ещё не выполнялась'}` : 'Музыка и плейлисты появятся здесь после подключения.'}</p></div><button className={connected ? 'secondary-button' : 'primary-button'} disabled={!connected && !inProgress && busy} onClick={connected || inProgress ? onDisconnect : onConnect}>{connected || inProgress ? 'Отключить' : <><LogIn size={16} /> {busy ? 'Вход…' : 'Подключить'}</>}</button></div>
    {status?.state === 'not-configured' && <div className="notice"><ShieldCheck size={17} /><span>Синхронизация в Pulse пока не настроена разработчиком: VK должен выдать приложению доступ к музыке. Уже сейчас можно войти и слушать свою библиотеку в официальном окне VK.</span></div>}
    {status?.message && status.state !== 'not-configured' && <p className="account-message" role="status">{status.message}</p>}
    <div className="account-actions"><button className="secondary-button" onClick={onOpenVk}><Music2 size={17} /> Войти в VK Музыку</button>{(connected || status?.mode === 'web' && status.user) && <button className="secondary-button" disabled={busy} onClick={onSync}><RefreshCw size={16} className={busy ? 'spin' : ''} /> Синхронизировать</button>}</div>
    {status?.capabilities?.length ? <div className="capability-list"><div className="capability-title">Возможности VK</div>{status.capabilities.map(capability => <div className="capability-row" key={capability.id} title={capability.detail}><span>{capability.label}</span><span className={`capability-status ${capability.status}`}>{capability.status === 'verified' ? 'Проверено' : capability.status === 'unsupported' ? 'Недоступно' : 'Не проверено'}</span></div>)}</div> : null}
  </SettingsSection>
}
function SystemSettings({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => void }) { return <SettingsSection title="Система" description="Pulse остаётся рядом, когда вы переключаетесь на другие задачи."><SettingToggle title="Сворачивать в трей" description="Закрытие окна оставляет плеер запущенным в области уведомлений." checked={settings.closeToTray} onChange={closeToTray => update({ closeToTray })} /><SettingToggle title="Уменьшить анимацию" description="Оставить только необходимые переходы интерфейса." checked={settings.reducedMotion} onChange={reducedMotion => update({ reducedMotion })} /><div className="about-card"><img className="app-logo" src={appIcon} alt="Pulse" /><div><strong>Pulse for VK</strong><p>Tauri / локальная библиотека и вход через VK</p></div><span>v{appVersion}</span></div></SettingsSection> }
function SettingsSection({ title, description, children }: { title: string; description: string; children: React.ReactNode }) { return <div className="settings-section"><div className="settings-section-heading"><h2>{title}</h2><p>{description}</p></div>{children}</div> }
function SettingCard({ title, description, children }: { title: string; description: string; children: React.ReactNode }) { return <div className="setting-card"><div className="setting-card-copy"><strong>{title}</strong><p>{description}</p></div>{children}</div> }
function SettingToggle({ title, description, checked, onChange }: { title: string; description: string; checked: boolean; onChange: (value: boolean) => void }) { return <div className="setting-toggle"><div><strong>{title}</strong><p>{description}</p></div><button className={`toggle ${checked ? 'on' : ''}`} role="switch" aria-label={title} aria-checked={checked} onClick={() => onChange(!checked)}><span /></button></div> }

export default App
