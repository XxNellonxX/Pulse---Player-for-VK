import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { PersistedState, VkWebCommand } from './shared/contracts'
import { nextShuffledCycle, ownMusicIds, shuffledQueue } from './shuffle'
import { normalizeBufferedRanges, readMediaBuffered, sameBufferedRanges, secondsBufferedAhead, type BufferedRange, type PlaybackNetwork } from './buffering'
import './shared/audioEqualizer.js'
import type { EqualizerGraph } from './shared/audioEqualizer'
import type Hls from 'hls.js'
import { releaseSoundCloudSource, soundCloudSource } from './sourceResolution'

// Native transport allows 20s resolve + 25s load + 25s play, plus IPC margin.
const WEB_START_TIMEOUT = 80000

export function usePlayback(state: PersistedState, setState: Dispatch<SetStateAction<PersistedState>>) {
  const audio = useRef<HTMLAudioElement | null>(null)
  const externalHls = useRef<Hls | null>(null)
  const externalUrl = useRef<string | null>(null)
  const forcedExternalId = useRef<string | null>(null)
  const externalAttempted = useRef(new Set<string>())
  const externalRecovery = useRef<{ id: string | null; renewals: number; bypass: boolean }>({ id: null, renewals: 0, bypass: false })
  const externalFallback = useRef<(id: string) => boolean>(() => false)
  const [sourceLabel, setSourceLabel] = useState('')
  const equalizerGraph = useRef<EqualizerGraph | null>(null)
  const localEqualizerSafe = useRef(false)
  const stateRef = useRef(state)
  stateRef.current = state
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(state.position)
  const [duration, setDuration] = useState(0)
  const [error, setError] = useState('')
  const [equalizerError, setEqualizerError] = useState('')
  const [buffering, setBuffering] = useState(false)
  const [advertising, setAdvertising] = useState(false)
  const [buffered, setBuffered] = useState<BufferedRange[]>([])
  const [bufferedAhead, setBufferedAhead] = useState(0)
  const [network, setNetwork] = useState<PlaybackNetwork>('idle')
  const [snippet, setSnippet] = useState<{ id: string; from: number; to: number } | null>(null)
  const snippetRef = useRef<{ id: string; from: number; to: number } | null>(null)
  const snippetReady = useRef(false)
  const [reloadNonce, setReloadNonce] = useState(0)
  const playIntent = useRef(false)
  const failureTimes = useRef<number[]>([])
  const loadedId = useRef<string | null>(null)
  // A VK library item can use a verified copy retained by our own upload.
  // Keep its library identity intact and route controls by the loaded source.
  const transport = useRef<{ id: string | null; kind: 'pending' | 'web' | 'local' }>({ id: null, kind: 'pending' })
  const ownedSourceId = useRef<string | null>(null)
  const ownedFailedId = useRef<string | null>(null)
  const sourceVersion = useRef(0)
  const pendingStart = useRef(false)
  const sourceAbort = useRef<AbortController | null>(null)
  const stallTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const webPlaying = useRef(false)
  const webLoaded = useRef<string | null>(null)
  const webPending = useRef<string | null>(null)
  const webEnded = useRef('')
  const webPosition = useRef(0)
  const webLatestPosition = useRef(0)
  const webPaused = useRef(false)
  const webAtEnd = useRef(false)
  const webStallTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const webStallAd = useRef(false)
  const webRecovering = useRef(false)
  const webStallRecovery = useRef(false)
  const webStartDeadline = useRef(0)
  const webProgress = useRef(0)
  const webSeeking = useRef(false)
  const current = useMemo(() => state.tracks.find(track => track.id === state.currentTrackId), [state.tracks, state.currentTrackId])
  const isWebTrack = () => transport.current.id === stateRef.current.currentTrackId && transport.current.kind === 'web'
  const isLocalTrack = () => transport.current.id === stateRef.current.currentTrackId && transport.current.kind === 'local'
  const controlWeb = useCallback(async (command: VkWebCommand) => {
    if (!window.desktop?.vkWebControl) throw new Error('Подключение плеера VK недоступно в этой версии.')
    const result = await window.desktop.vkWebControl(command)
    if (!result.accepted) throw new Error(result.error || 'VK не подтвердил команду плеера.')
    if (command.operation === 'equalizer') setEqualizerError(result.equalizerError || '')
  }, [])
  const configureWebEqualizer = useCallback(async () => {
    try { await controlWeb({ operation: 'equalizer', equalizer: stateRef.current.settings.equalizer }) }
    catch { setEqualizerError('Эквалайзер VK пока недоступен. Трек продолжит играть без обработки.') }
  }, [controlWeb])
  const prepareLocalEqualizer = useCallback(async (element: HTMLAudioElement) => {
    if (audio.current !== element || !element.getAttribute('src')) return
    if (stateRef.current.settings.equalizer.enabled && !localEqualizerSafe.current && !equalizerGraph.current) { setEqualizerError('Этот источник не разрешает эквалайзер. Трек играет без обработки.'); return }
    try {
      if (stateRef.current.settings.equalizer.enabled && !equalizerGraph.current) equalizerGraph.current = globalThis.__PULSE_CREATE_EQUALIZER__(element)
      const graph = equalizerGraph.current
      if (graph && stateRef.current.settings.equalizer.enabled) {
        let timeout: ReturnType<typeof setTimeout> | undefined
        try { await Promise.race([graph.prepare(), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('audio-context-timeout')), 1500) })]) }
        finally { if (timeout) clearTimeout(timeout) }
      }
      if (audio.current !== element || graph !== equalizerGraph.current) return
      graph?.apply(stateRef.current.settings.equalizer)
      await graph?.resume()
      if (audio.current === element) setEqualizerError('')
    } catch {
      if (audio.current !== element) return
      if (equalizerGraph.current && !equalizerGraph.current.connected) { equalizerGraph.current.destroy(); equalizerGraph.current = null }
      setEqualizerError('Эквалайзер недоступен для этого источника звука.')
    }
  }, [])
  const playLocal = useCallback(async (element: HTMLAudioElement) => {
    externalHls.current?.startLoad(-1)
    await prepareLocalEqualizer(element)
    if (audio.current === element && playIntent.current) await element.play()
  }, [prepareLocalEqualizer])
  const clearWebStall = useCallback(() => {
    if (webStallTimer.current) clearTimeout(webStallTimer.current)
    webStallTimer.current = null
    webStallAd.current = false
    webStallRecovery.current = false
  }, [])
  const recoverExternal = useCallback(() => {
    const id = stateRef.current.currentTrackId
    if (!id || !externalUrl.current || !playIntent.current || externalRecovery.current.id !== id || externalRecovery.current.bypass) return false
    const element = audio.current
    const position = element && element.readyState >= HTMLMediaElement.HAVE_METADATA && Number.isFinite(element.currentTime) ? element.currentTime : stateRef.current.position
    // Allow one renewal per failure streak for this exact recording. Healthy
    // media-clock progress replenishes the budget for a later grant expiry.
    if (externalRecovery.current.renewals === 0) externalRecovery.current.renewals = 1
    else {
      externalRecovery.current.bypass = true
      forcedExternalId.current = null
      externalAttempted.current.add(id)
    }
    sourceVersion.current++
    transport.current = { id, kind: 'pending' }
    sourceAbort.current?.abort(); externalHls.current?.stopLoad(); element?.pause()
    loadedId.current = null; pendingStart.current = true
    if (stallTimer.current) clearTimeout(stallTimer.current)
    stallTimer.current = null
    setState(previous => previous.currentTrackId === id ? { ...previous, position } : previous)
    setPosition(position); setError(''); setPlaying(false); setBuffering(true); setNetwork('recovering')
    setReloadNonce(value => value + 1)
    return true
  }, [setState])
  const watchWebStall = useCallback((id: string, advertisement = false, reset = false, recovery = false) => {
    if (reset && webStallTimer.current) { clearTimeout(webStallTimer.current); webStallTimer.current = null }
    if (webStallTimer.current) return
    webStallAd.current = advertisement
    webStallRecovery.current = recovery
    const starting = webStartDeadline.current > 0
    webStallTimer.current = setTimeout(() => {
      webStallTimer.current = null
      if (!playIntent.current || stateRef.current.currentTrackId !== id || !isWebTrack()) return
      if (externalFallback.current(id)) return
      playIntent.current = false; pendingStart.current = false; webPlaying.current = false; webPaused.current = true
      setPlaying(false); setBuffering(false); setAdvertising(false); setNetwork('error')
      setError(advertisement
        ? 'VK долго загружает аудио. Проверьте соединение и повторите попытку.'
        : starting
          ? 'VK не подтвердил запуск источника. Проверьте соединение и повторите попытку.'
          : 'Загрузка трека прервалась. Проверьте соединение и нажмите «Повторить», чтобы продолжить с места остановки.')
      void controlWeb({ operation: 'pause' }).catch(() => {})
    }, recovery ? 150000 : advertisement ? 90000 : Math.max(15000, webStartDeadline.current - Date.now()))
  }, [controlWeb])
  const clearSnippet = useCallback(() => { snippetRef.current = null; snippetReady.current = false; setSnippet(null) }, [])
  const acceptSnippetStart = useCallback((id: string, start: number) => {
    if (snippetRef.current?.id === id && snippetRef.current.from === start) snippetReady.current = true
  }, [])
  const finishSnippet = useCallback(() => {
    if (!snippetRef.current) return
    const finished = snippetRef.current
    snippetRef.current = null; snippetReady.current = false; setSnippet(null)
    playIntent.current = false; pendingStart.current = false; webPlaying.current = false; webPaused.current = true
    clearWebStall(); setPlaying(false); setBuffering(false); setPosition(finished.to)
    webLatestPosition.current = finished.to; webPosition.current = finished.to
    if (isWebTrack()) void controlWeb({ operation: 'pause' }).catch(() => {})
    else audio.current?.pause()
    setState(previous => previous.currentTrackId === finished.id ? { ...previous, position: finished.to } : previous)
  }, [clearWebStall, controlWeb, setState])
  const restartWeb = useCallback((startPosition = 0) => {
    const id = stateRef.current.currentTrackId
    if (!id) return
    playIntent.current = true; pendingStart.current = true; webPaused.current = false; webAtEnd.current = false; setBuffering(true)
    const version = sourceVersion.current
    webStartDeadline.current = Date.now() + WEB_START_TIMEOUT
    webProgress.current = startPosition; webLatestPosition.current = startPosition; webSeeking.current = false
    clearWebStall(); watchWebStall(id, false, true)
    webPending.current = id
    void controlWeb({ operation: 'volume', volume: stateRef.current.settings.volume }).then(async () => {
      await configureWebEqualizer()
      if (sourceVersion.current !== version || !playIntent.current) return
      await controlWeb({ operation: 'play', id, position: startPosition })
      if (sourceVersion.current !== version) return
      acceptSnippetStart(id, startPosition)
      webLoaded.current = id; webPending.current = null
    }).catch(error => {
      if (stateRef.current.currentTrackId !== id || sourceVersion.current !== version) return
      clearWebStall(); playIntent.current = false; pendingStart.current = false
      setBuffering(false); setPlaying(false); setNetwork('error'); setError(error.message)
    })
  }, [controlWeb, clearWebStall, watchWebStall, acceptSnippetStart, configureWebEqualizer])

  const next = useCallback((direction = 1, auto = false, failedSource = false) => {
    clearSnippet()
    const s = stateRef.current
    const availableIds = new Set(s.tracks.filter(track => track.available).map(track => track.id))
    const available = s.queue.filter(id => availableIds.has(id))
    if (!available.length) { playIntent.current = false; setPlaying(false); return }
    const index = available.indexOf(s.currentTrackId || '')
    let nextIndex = index + direction
    if (auto && s.settings.repeat === 'one' && !failedSource) {
      if (isWebTrack()) restartWeb()
      else if (audio.current) { audio.current.currentTime = 0; void playLocal(audio.current).catch(() => {}) }
      return
    }
    let nextQueue: string[] | undefined
    if (s.settings.shuffle && direction > 0 && nextIndex >= available.length && s.settings.repeat === 'all') {
      // Each complete permutation is stored, so the queue, Previous and restart
      // follow the same order without random re-picks during a cycle.
      const completeLibrary = ownMusicIds(s.tracks)
      nextQueue = nextShuffledCycle(completeLibrary.length ? completeLibrary : available, s.currentTrackId)
      nextIndex = 0
    }
    if (nextIndex >= available.length || nextIndex < 0) {
      if (s.settings.repeat === 'all') nextIndex = (nextIndex + available.length) % available.length
      else { playIntent.current = false; webPaused.current = true; audio.current?.pause(); if (isWebTrack()) void controlWeb({ operation: 'pause' }).catch(() => {}); setPlaying(false); return }
    }
    playIntent.current = true
    const selectedId = (nextQueue || available)[nextIndex]
    if (selectedId === s.currentTrackId) {
      if (isWebTrack()) restartWeb()
      else if (audio.current) { audio.current.currentTime = 0; void playLocal(audio.current).catch(() => setError('Не удалось перезапустить трек. Попробуйте снова.')) }
      setState(prev => ({ ...prev, position: 0 }))
      return
    }
    setState(prev => ({ ...prev, ...(nextQueue ? { queue: nextQueue } : {}), currentTrackId: selectedId, position: 0, history: [selectedId, ...prev.history.filter(item => item !== selectedId)].slice(0, 300) }))
  }, [setState, restartWeb, controlWeb, clearSnippet, playLocal])

  useEffect(() => window.desktop?.onVkPlayback?.(status => {
    const s = stateRef.current
    const track = s.tracks.find(item => item.id === s.currentTrackId)
    if (!track || !isWebTrack()) return
    setEqualizerError(status.equalizerError || '')
    if (status.error && (status.requestedId === track.id || status.id === track.id)) {
      if (Number.isFinite(status.position) && (status.position > 0 || webLatestPosition.current === 0)) {
        webLatestPosition.current = status.position; webPosition.current = status.position
        setPosition(status.position)
        setState(previous => previous.currentTrackId === track.id ? { ...previous, position: status.position } : previous)
      }
      if (externalFallback.current(track.id)) return
      clearWebStall(); setError(status.error); setPlaying(false); setBuffering(false); setAdvertising(false); setNetwork('error')
      playIntent.current = false; pendingStart.current = false; webPlaying.current = false; webPaused.current = true
      webLoaded.current = null; webPending.current = null; webRecovering.current = false
      sourceVersion.current++
      return
    }
    if (status.id !== track.id) return
    // Polling can still contain the previous playback of the same track
    // while a new fragment's source/seek command is awaiting its receipt.
    if (snippetRef.current?.id === track.id && !snippetReady.current) return
    if (snippetReady.current && snippetRef.current?.id === track.id && (status.position >= snippetRef.current.to - .05 || status.ended)) { finishSnippet(); return }
    const nextBuffered = normalizeBufferedRanges(status.buffered, status.duration || track.duration)
    setBuffered(previous => sameBufferedRanges(previous, nextBuffered) ? previous : nextBuffered)
    setBufferedAhead(secondsBufferedAhead(nextBuffered, status.position))
    setNetwork(status.network || (status.recovering ? 'recovering' : status.buffering ? 'loading' : status.playing ? 'ready' : 'idle'))
    if (webPaused.current && status.playing) { webPlaying.current = false; setPlaying(false); setBuffering(false); void controlWeb({ operation: 'pause' }).catch(() => {}); return }
    if (status.ended && pendingStart.current) return
    const adActive = status.advertising === true
    webRecovering.current = status.recovering === true
    const progressed = status.playing && !adActive && !status.seeking && !webSeeking.current && status.position > webProgress.current + 0.01
    webProgress.current = status.position
    if (progressed) { webStartDeadline.current = 0; clearWebStall() }
    setAdvertising(adActive && playIntent.current)
    webAtEnd.current = status.ended
    webPlaying.current = status.playing || adActive && playIntent.current
    setPlaying(status.playing && !adActive); setBuffering(playIntent.current && (adActive || status.buffering && !progressed || pendingStart.current && !status.playing))
    setDuration(status.duration || track.duration); setPosition(status.position)
    webLatestPosition.current = status.position
    if (status.error) { setError(status.error); playIntent.current = false }
    else if (status.playing && !adActive) { setError(''); pendingStart.current = false; webLoaded.current = track.id; if (!status.ended) webEnded.current = '' }
    if (webStallTimer.current && (webStallAd.current !== adActive || webStallRecovery.current !== webRecovering.current)) clearWebStall()
    // A false `playing`/`buffering` flag must neither stop an advancing track
    // nor keep a frozen one alive. Only media-clock progress renews the timer.
    if (playIntent.current && !status.ended) watchWebStall(track.id, adActive, false, webRecovering.current)
    else clearWebStall()
    const settledPause = !status.playing && !status.buffering && webLoaded.current === track.id
    if (Math.abs(status.position - webPosition.current) >= 2 || settledPause) { webPosition.current = status.position; setState(previous => previous.currentTrackId === track.id && previous.position !== status.position ? { ...previous, position: status.position } : previous) }
    const endKey = `${status.runId || ''}:${track.id}`
    if (status.ended && playIntent.current && webEnded.current !== endKey) { webEnded.current = endKey; next(1, true) }
  }), [next, setState, clearWebStall, watchWebStall, controlWeb, finishSnippet])


  useEffect(() => {
    const element = new Audio()
    localEqualizerSafe.current = false
    element.preload = 'metadata'
    element.volume = Math.min(1, Math.max(0, stateRef.current.settings.volume))
    audio.current = element
    let active = true
    const handlers: Array<[string, EventListener]> = []
    const on = (type: string, handler: () => void) => {
      const listener = () => { if (active && isLocalTrack()) handler() }
      handlers.push([type, listener])
      element.addEventListener(type, listener)
    }
    let lastSaved = 0
    let lastProgress = 0
    let lastClockAt = performance.now()
    let healthyExternalSeconds = 0
    const resetExternalClock = () => { healthyExternalSeconds = 0; lastClockAt = performance.now(); lastProgress = element.currentTime }
    const updateBuffer = () => {
      if (isWebTrack()) return
      const ranges = readMediaBuffered(element)
      setBuffered(previous => sameBufferedRanges(previous, ranges) ? previous : ranges)
      setBufferedAhead(secondsBufferedAhead(ranges, element.currentTime))
      const remote = ownedSourceId.current !== stateRef.current.currentTrackId && stateRef.current.tracks.find(track => track.id === stateRef.current.currentTrackId)?.source === 'vk'
      setNetwork(element.error ? 'error' : remote && navigator.onLine === false ? 'offline' : element.readyState >= 3 ? 'ready' : element.networkState === 2 ? 'loading' : 'idle')
    }
    const update = () => {
      if (isWebTrack()) return
      if (snippetReady.current && snippetRef.current?.id === stateRef.current.currentTrackId && element.currentTime >= snippetRef.current.to - .05) { finishSnippet(); return }
      const elapsed = Math.max(0, (performance.now() - lastClockAt) / 1000)
      const advanced = element.currentTime - lastProgress
      if (externalUrl.current && playIntent.current && !element.paused && !element.seeking && advanced > .01 && advanced <= elapsed * 1.5 + .5) {
        // A seek or a long paused clock must not manufacture successful audio.
        healthyExternalSeconds += Math.min(advanced, elapsed)
        if (healthyExternalSeconds >= 30 && externalRecovery.current.id === stateRef.current.currentTrackId) externalRecovery.current.renewals = 0
      } else healthyExternalSeconds = 0
      lastClockAt = performance.now()
      if (!element.paused && !element.seeking && element.currentTime > lastProgress + .01) {
        if (stallTimer.current) clearTimeout(stallTimer.current)
        stallTimer.current = null; setBuffering(false)
      }
      lastProgress = element.currentTime
      updateBuffer()
      setPosition(Number.isFinite(element.currentTime) ? element.currentTime : 0)
      if (Math.abs(element.currentTime - lastSaved) >= 2) {
        lastSaved = element.currentTime
        setState(prev => ({ ...prev, position: element.currentTime }))
      }
    }
    const failed = () => {
      if (stallTimer.current) clearTimeout(stallTimer.current)
      stallTimer.current = null
      if (!playIntent.current) return
      if (recoverExternal()) return
      // A removed or unreadable retained copy must still allow the exact VK
      // item to play. Retry through VK once, without skipping the library item.
      if (ownedSourceId.current && ownedSourceId.current === stateRef.current.currentTrackId) {
        ownedFailedId.current = ownedSourceId.current; ownedSourceId.current = null
        transport.current = { id: stateRef.current.currentTrackId, kind: 'pending' }
        sourceAbort.current?.abort(); loadedId.current = null
        setReloadNonce(value => value + 1)
        return
      }
      pendingStart.current = false
      sourceAbort.current?.abort()
      setPlaying(false); setBuffering(false)
      if (!isWebTrack()) setNetwork('error')
      const now = Date.now()
      failureTimes.current = [...failureTimes.current.filter(time => now - time < 10000), now]
      if (stateRef.current.settings.autoSkip && failureTimes.current.length < 3) {
        setError('Трек недоступен. Переходим к следующему.')
        next(1, true, true)
      } else {
        playIntent.current = false
        setError(failureTimes.current.length >= 3 ? 'Несколько треков недоступны. Автопереход остановлен — попробуйте снова.' : 'Не удалось воспроизвести трек. Файл перемещён или соединение прервано.')
      }
    }
    on('timeupdate', update)
    on('progress', updateBuffer)
    on('durationchange', updateBuffer)
    on('seeking', () => { resetExternalClock(); updateBuffer() })
    on('seeked', () => { resetExternalClock(); updateBuffer() })
    on('loadedmetadata', () => {
      setDuration(Number.isFinite(element.duration) ? element.duration : 0)
      const savedPosition = stateRef.current.position
      if (savedPosition > 0 && savedPosition < element.duration) element.currentTime = savedPosition
      lastProgress = element.currentTime
      resetExternalClock()
      updateBuffer()
    })
    const recovered = () => { if (stallTimer.current) clearTimeout(stallTimer.current); stallTimer.current = null; pendingStart.current = false; setBuffering(false); updateBuffer() }
    const waiting = () => {
      if (!playIntent.current) return
      resetExternalClock()
      setBuffering(true)
      if (!isWebTrack()) setNetwork(ownedSourceId.current !== stateRef.current.currentTrackId && navigator.onLine === false ? 'offline' : 'stalled')
      if (!stallTimer.current) stallTimer.current = setTimeout(() => { stallTimer.current = null; if (playIntent.current && !element.ended) failed() }, 15000)
    }
    on('playing', () => { if (!playIntent.current) { element.pause(); return }; resetExternalClock(); recovered(); setPlaying(true); setError('') })
    on('pause', () => {
      resetExternalClock()
      setPlaying(false)
      if (loadedId.current === stateRef.current.currentTrackId && !isWebTrack() && Number.isFinite(element.currentTime)) {
        setState(previous => previous.position === element.currentTime ? previous : { ...previous, position: element.currentTime })
      }
    })
    on('waiting', waiting)
    // `stalled` reports a download pause even while already-buffered audio
    // keeps playing. Do not arm a failure timer for healthy buffered playback.
    on('stalled', () => { updateBuffer(); if (element.readyState < 3) waiting() })
    on('canplay', recovered)
    on('error', failed)
    on('ended', () => { if (!playIntent.current) return; if (snippetRef.current) { if (snippetReady.current) finishSnippet() } else next(1, true) })
    return () => {
      active = false
      for (const [type, handler] of handlers) element.removeEventListener(type, handler)
      sourceAbort.current?.abort()
      if (stallTimer.current) clearTimeout(stallTimer.current)
      equalizerGraph.current?.destroy(); equalizerGraph.current = null
      externalHls.current?.destroy(); externalHls.current = null
      if (externalUrl.current) { releaseSoundCloudSource(externalUrl.current); externalUrl.current = null }
      element.pause(); element.removeAttribute('src'); element.load(); audio.current = null; loadedId.current = null
    }
  }, [setState, next, state.currentTrackId, reloadNonce, finishSnippet, recoverExternal])

  useEffect(() => {
    const element = audio.current
    if (!element) return
    const version = ++sourceVersion.current
    if (externalRecovery.current.id !== current?.id) externalRecovery.current = { id: current?.id || null, renewals: 0, bypass: false }
    if (forcedExternalId.current !== current?.id) forcedExternalId.current = null
    if (current?.id) externalAttempted.current = new Set([...externalAttempted.current].filter(id => id === current.id))
    setSourceLabel('')
    transport.current = { id: current?.id || null, kind: 'pending' }
    ownedSourceId.current = null
    if (ownedFailedId.current !== current?.id) ownedFailedId.current = null
    if (snippetRef.current && snippetRef.current.id !== current?.id) clearSnippet()
    setAdvertising(false)
    setBuffered([]); setBufferedAhead(0); setNetwork('idle')
    clearWebStall()
    sourceAbort.current?.abort()
    if (stallTimer.current) clearTimeout(stallTimer.current)
    stallTimer.current = null
    pendingStart.current = false
    if (!current) { playIntent.current = false; element.pause(); element.removeAttribute('src'); element.load(); loadedId.current = null; if (webLoaded.current) void controlWeb({ operation: 'stop' }).catch(() => {}); webLoaded.current = null; webPlaying.current = false; setPlaying(false); setPosition(0); setDuration(0); setBuffering(false); return }
    const controller = new AbortController()
    sourceAbort.current = controller
    // Initial pause belongs to source replacement, so it must not overwrite
    // a saved resume/snippet start with the new element's zero clock.
    loadedId.current = null
    element.pause(); loadedId.current = current.id
    setPosition(stateRef.current.position || 0); setDuration(current.duration); setError('')
    pendingStart.current = playIntent.current || stateRef.current.settings.autoplay
    if (pendingStart.current) { playIntent.current = true; setBuffering(true); setNetwork('loading') }
    const load = async () => {
      try {
        let resolved = current
        if (current.source === 'vk' && window.desktop?.resolveVkTrack && ownedFailedId.current !== current.id) {
          try { resolved = await window.desktop.resolveVkTrack(current.id) }
          catch (error) { if (!current.url.startsWith('vk-web://')) throw error }
        }
        if (sourceVersion.current !== version || controller.signal.aborted) return
        if (resolved.source === 'vk' && playIntent.current && window.desktop?.resolveSoundCloud && !externalRecovery.current.bypass) {
          const forced = forcedExternalId.current === current.id
          try {
            const source = await soundCloudSource(current, stateRef.current.settings, controller.signal, forced)
            if (sourceVersion.current !== version || controller.signal.aborted) { if (source) releaseSoundCloudSource(source.url); return }
            if (source) {
              externalUrl.current = source.url
              resolved = { ...current, url: source.url }
              setSourceLabel(source.explicit === true ? 'SoundCloud · explicit' : 'SoundCloud')
            } else if (forced) throw new Error('VK не запустил трек. SoundCloud ещё не подключён или соответствие не найдено — откройте информацию о треке.')
          } catch (cause) {
            if (controller.signal.aborted) throw cause
            if (forced && externalRecovery.current.renewals === 0) throw cause
            externalRecovery.current.bypass = true
            externalAttempted.current.add(current.id)
            forcedExternalId.current = null
            // An optional provider failure leaves the existing VK path usable.
          }
        }
        if (sourceVersion.current !== version || controller.signal.aborted) return
        if (resolved.url.startsWith('vk-web://')) {
          setSourceLabel('VK')
          transport.current = { id: current.id, kind: 'web' }
          const startPosition = stateRef.current.position || 0
          webEnded.current = ''; webPosition.current = startPosition; webLatestPosition.current = startPosition; webProgress.current = startPosition; webSeeking.current = false; webPaused.current = !playIntent.current; webAtEnd.current = false
          if (playIntent.current) {
            webStartDeadline.current = Date.now() + WEB_START_TIMEOUT
            watchWebStall(current.id, false, true)
            webPending.current = current.id
            await controlWeb({ operation: 'volume', volume: stateRef.current.settings.volume })
            await configureWebEqualizer()
            if (sourceVersion.current !== version || controller.signal.aborted || !playIntent.current) return
            await controlWeb({ operation: 'play', id: current.id, position: startPosition })
            if (sourceVersion.current !== version || controller.signal.aborted) { if (isLocalTrack()) void controlWeb({ operation: 'stop' }).catch(() => {}); return }
            acceptSnippetStart(current.id, startPosition)
            webLoaded.current = current.id
            webPending.current = null
            if (!playIntent.current) await controlWeb({ operation: 'pause' })
          }
          return
        }
        if (webLoaded.current || webPending.current) { void controlWeb({ operation: 'stop' }).catch(() => {}); webLoaded.current = null; webPending.current = null; webPlaying.current = false }
        if (!resolved.available || !resolved.url) throw new Error('unavailable')
        transport.current = { id: current.id, kind: 'local' }
        ownedSourceId.current = current.source === 'vk' && resolved.source === 'local' ? current.id : null
        if (!externalUrl.current) setSourceLabel(ownedSourceId.current ? 'Сохранённый оригинал' : 'Локальный файл')
        const resolvedUrl = new URL(resolved.url, location.href)
        // Local Tauri asset responses explicitly permit CORS; browser-local
        // imports are blobs or same-origin URLs. Legacy remote API sources
        // remain native Audio unless a readable CORS request is confirmed.
        let readable = resolvedUrl.origin === location.origin || ['blob:', 'data:', 'asset:'].includes(resolvedUrl.protocol) || ['asset.localhost', 'tauri.localhost'].includes(resolvedUrl.hostname)
        if (!readable && stateRef.current.settings.equalizer.enabled) {
          const probe = new AbortController(), timer = setTimeout(() => probe.abort(), 1500)
          try { const response = await fetch(resolved.url, { mode: 'cors', credentials: 'omit', headers: { Range: 'bytes=0-0' }, signal: probe.signal }); readable = response.ok && response.type !== 'opaque'; void response.body?.cancel() }
          catch { /* leave the ordinary Audio path available */ }
          finally { clearTimeout(timer) }
        }
        if (sourceVersion.current !== version || controller.signal.aborted) return
        localEqualizerSafe.current = readable
        if (readable) element.crossOrigin = 'anonymous'
        const HlsEngine = externalUrl.current ? (await import('hls.js')).default : null
        if (sourceVersion.current !== version || controller.signal.aborted) return
        if (HlsEngine?.isSupported()) {
          const engine = new HlsEngine({ enableWorker: false, autoStartLoad: playIntent.current, maxBufferLength: 90, maxMaxBufferLength: 120, backBufferLength: 20, maxBufferSize: 8 * 1024 * 1024 })
          externalHls.current = engine
          engine.on(HlsEngine.Events.ERROR, (_, detail) => {
            // An expired service capability cannot succeed by retrying its old
            // URL. Obtain a fresh grant immediately and keep the saved offset.
            if ((detail.fatal || detail.response?.code === 410) && externalHls.current === engine && audio.current === element && sourceVersion.current === version && playIntent.current) element.dispatchEvent(new Event('error'))
          })
          engine.attachMedia(element); engine.loadSource(resolved.url)
        } else { element.src = resolved.url; element.load() }
        const shouldStart = playIntent.current
        if (shouldStart) {
          playIntent.current = true
          if (element.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) await new Promise<void>((resolve, reject) => {
            const cleanup = () => { clearTimeout(timer); element.removeEventListener('canplay', done); element.removeEventListener('error', fail); controller.signal.removeEventListener('abort', fail) }
            const done = () => { cleanup(); resolve() }
            const fail = () => { cleanup(); reject(new Error('unavailable')) }
            const timer = setTimeout(fail, 15000)
            element.addEventListener('canplay', done, { once: true })
            element.addEventListener('error', fail, { once: true })
            controller.signal.addEventListener('abort', fail, { once: true })
            if (element.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) done()
          })
          if (sourceVersion.current === version && playIntent.current && !controller.signal.aborted) { acceptSnippetStart(current.id, stateRef.current.position || 0); await playLocal(element) }
        }
      } catch (cause) {
        if (sourceVersion.current === version && !controller.signal.aborted && !recoverExternal()) { clearWebStall(); pendingStart.current = false; playIntent.current = false; setPlaying(false); setBuffering(false); setNetwork('error'); setError(cause instanceof Error && forcedExternalId.current === current.id ? cause.message : 'Этот трек сейчас недоступен. Можно попробовать ещё раз.') }
      }
    }
    void load()
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: current.title, artist: current.artist, album: current.album })
    return () => { controller.abort(); clearWebStall(); if (current.url.startsWith('vk-web://') && (webLoaded.current === current.id || webPending.current === current.id)) { void controlWeb({ operation: 'stop' }).catch(() => {}); webLoaded.current = null; webPending.current = null; webPlaying.current = false } if (sourceVersion.current === version) sourceVersion.current++; if (stallTimer.current) clearTimeout(stallTimer.current) }
  }, [current?.id, current?.url, reloadNonce, controlWeb, clearWebStall, watchWebStall, clearSnippet, acceptSnippetStart, playLocal, configureWebEqualizer, recoverExternal])

  externalFallback.current = id => {
    if (!playIntent.current || !stateRef.current.settings.preferSoundCloud || !window.desktop?.resolveSoundCloud || externalRecovery.current.bypass || externalAttempted.current.has(id)) return false
    externalAttempted.current.add(id); forcedExternalId.current = id
    clearWebStall(); webPlaying.current = false; webPending.current = null
    void controlWeb({ operation: 'pause' }).catch(() => {})
    playIntent.current = true; loadedId.current = null
    setError(''); setBuffering(true); setReloadNonce(value => value + 1)
    return true
  }

  useEffect(() => {
    setEqualizerError('')
    if (isWebTrack()) void controlWeb({ operation: 'equalizer', equalizer: state.settings.equalizer }).catch(() => setEqualizerError('Эквалайзер VK пока недоступен. Трек продолжит играть без обработки.'))
    else if (audio.current) void prepareLocalEqualizer(audio.current)
  }, [state.settings.equalizer, current?.id, controlWeb, prepareLocalEqualizer])

  useEffect(() => { if (audio.current) audio.current.volume = Math.min(1, Math.max(0, state.settings.volume)); if (isWebTrack() && webLoaded.current) void controlWeb({ operation: 'volume', volume: state.settings.volume }).catch(error => setError(error.message)) }, [state.settings.volume, controlWeb])
  const playTrack = useCallback((id: string, queue?: string[], startPosition = 0) => {
    clearSnippet()
    const start = Number.isFinite(startPosition) ? Math.max(0, startPosition) : 0
    playIntent.current = true
    setError('')
    setState(prev => {
      const requested = queue ? [...new Set([...queue, id])] : [...new Set([...prev.queue, id])]
      const nextQueue = prev.settings.shuffle && queue ? shuffledQueue(ownMusicIds(prev.tracks), id) : requested
      return { ...prev, currentTrackId: id, position: start, queue: nextQueue, history: [id, ...prev.history.filter(item => item !== id)].slice(0, 300) }
    })
    if (loadedId.current === id && audio.current) {
      if (isWebTrack()) { restartWeb(start); return }
      if (audio.current.error || !audio.current.getAttribute('src')) { loadedId.current = null; setReloadNonce(value => value + 1) }
      else { audio.current.currentTime = start; acceptSnippetStart(id, start); void playLocal(audio.current).catch(() => setError('Не удалось запустить воспроизведение. Попробуйте снова.')) }
    }
  }, [setState, restartWeb, clearSnippet, acceptSnippetStart, playLocal])
  const playSnippet = useCallback((id: string, from: number, to: number) => {
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from || to > 864000) { setError('VK не предоставил корректные границы сниппета.'); return }
    playTrack(id, undefined, from)
    const clip = { id, from, to }
    snippetRef.current = clip; snippetReady.current = loadedId.current === id && !isWebTrack() && audio.current?.currentTime === from; setSnippet(clip)
  }, [playTrack])
  const toggleShuffle = useCallback(() => {
    setState(previous => {
      const shuffle = !previous.settings.shuffle
      const pool = ownMusicIds(previous.tracks)
      const queue = shuffle ? shuffledQueue(pool, previous.currentTrackId) : [...new Set([...pool, ...(previous.currentTrackId && !pool.includes(previous.currentTrackId) ? [previous.currentTrackId] : [])])]
      return { ...previous, queue, settings: { ...previous.settings, shuffle } }
    })
  }, [setState])
  const toggle = useCallback(() => {
    if (isWebTrack()) {
      if (!webLoaded.current && !playIntent.current && stateRef.current.settings.preferSoundCloud && window.desktop?.resolveSoundCloud) {
        playIntent.current = true; setReloadNonce(value => value + 1); return
      }
      if (webPlaying.current || playIntent.current && (pendingStart.current || webRecovering.current)) {
        // Cancelling a source renewal disposes its partially loaded media.
        // The following Play must obtain a fresh source at the saved position.
        if (webRecovering.current) { webLoaded.current = null; webPending.current = null }
        clearWebStall()
        setAdvertising(false)
        playIntent.current = false; pendingStart.current = false; webPaused.current = true; webPlaying.current = false; setPlaying(false)
        setState(previous => previous.position === webLatestPosition.current ? previous : { ...previous, position: webLatestPosition.current })
        void controlWeb({ operation: 'pause' }).catch(error => setError(error.message))
        setBuffering(false)
      } else {
        playIntent.current = true; pendingStart.current = true; webPaused.current = false; setError(''); setBuffering(true)
        const id = stateRef.current.currentTrackId!
        const version = sourceVersion.current
        const command: VkWebCommand = webLoaded.current === id && !webAtEnd.current ? { operation: 'resume' } : { operation: 'play', id, position: webAtEnd.current ? 0 : webLatestPosition.current }
        webProgress.current = webAtEnd.current ? 0 : webLatestPosition.current
        webAtEnd.current = false; webPending.current = id
        webStartDeadline.current = Date.now() + WEB_START_TIMEOUT
        clearWebStall(); watchWebStall(id, false, true)
        webEnded.current = ''
        void controlWeb({ operation: 'volume', volume: stateRef.current.settings.volume }).then(async () => {
          await configureWebEqualizer()
          if (sourceVersion.current !== version || !playIntent.current) return
          await controlWeb(command)
          if (sourceVersion.current === version) { if (snippetRef.current?.id === id) acceptSnippetStart(id, snippetRef.current.from); webLoaded.current = id; webPending.current = null }
        }).catch(error => { if (stateRef.current.currentTrackId !== id || sourceVersion.current !== version) return; clearWebStall(); playIntent.current = false; pendingStart.current = false; setPlaying(false); setBuffering(false); setNetwork('error'); setError(error.message) })
      }
      return
    }
    const element = audio.current
    if (!element) return
    if (playIntent.current && pendingStart.current) { playIntent.current = false; pendingStart.current = false; sourceAbort.current?.abort(); externalHls.current?.stopLoad(); element.pause(); setPlaying(false); setBuffering(false); if (stallTimer.current) clearTimeout(stallTimer.current); stallTimer.current = null; return }
    if (element.paused) {
      if (!stateRef.current.currentTrackId) { const first = stateRef.current.queue[0] || stateRef.current.tracks[0]?.id; if (first) playTrack(first); return }
      playIntent.current = true
      if (element.error || !element.getAttribute('src')) { loadedId.current = null; setReloadNonce(value => value + 1); return }
      void playLocal(element).catch(() => { setPlaying(false); setError('Воспроизведение не началось. Проверьте доступность файла и повторите.') })
    } else { playIntent.current = false; externalHls.current?.stopLoad(); element.pause(); setBuffering(false); if (stallTimer.current) clearTimeout(stallTimer.current); stallTimer.current = null }
  }, [playTrack, controlWeb, clearWebStall, watchWebStall, acceptSnippetStart, playLocal, configureWebEqualizer])
  const retry = useCallback(() => {
    if (!stateRef.current.currentTrackId) return
    if (isWebTrack()) {
      const id = stateRef.current.currentTrackId
      const savedPosition = webLatestPosition.current
      setState(previous => previous.currentTrackId === id ? { ...previous, position: savedPosition } : previous)
    }
    loadedId.current = null
    ownedFailedId.current = null
    externalRecovery.current = { id: stateRef.current.currentTrackId, renewals: 0, bypass: false }
    externalAttempted.current.clear(); forcedExternalId.current = null
    playIntent.current = true
    setError('')
    setReloadNonce(value => value + 1)
  }, [setState])
  const reloadSource = useCallback(() => {
    externalRecovery.current = { id: stateRef.current.currentTrackId, renewals: 0, bypass: false }
    externalAttempted.current.clear(); forcedExternalId.current = null
    loadedId.current = null; setReloadNonce(value => value + 1)
  }, [])
  const seek = useCallback((value: number) => {
    clearSnippet()
    if (isWebTrack() && Number.isFinite(value)) {
      const id = stateRef.current.currentTrackId, version = sourceVersion.current
      webSeeking.current = true
      void controlWeb({ operation: 'seek', position: value }).then(() => {
        if (stateRef.current.currentTrackId !== id || sourceVersion.current !== version) return
        webProgress.current = value; webLatestPosition.current = value; webPosition.current = value
        setPosition(value); setState(previous => previous.currentTrackId === id ? { ...previous, position: value } : previous)
      }).catch(error => { if (sourceVersion.current === version) setError(error.message) }).finally(() => { if (sourceVersion.current === version) webSeeking.current = false }); return
    }
    if (audio.current && Number.isFinite(value)) { audio.current.currentTime = value; setPosition(value); setState(prev => ({ ...prev, position: value })) }
  }, [setState, controlWeb, clearSnippet])
  const previous = useCallback(() => { if ((isWebTrack() ? webPosition.current : audio.current?.currentTime || 0) > 3) seek(0); else next(-1) }, [seek, next])
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    navigator.mediaSession.setActionHandler('play', () => { if (!playIntent.current && (isWebTrack() ? !webPlaying.current : audio.current?.paused)) toggle() })
    navigator.mediaSession.setActionHandler('pause', () => { if (playIntent.current || (isWebTrack() ? webPlaying.current : !audio.current?.paused)) toggle() })
    navigator.mediaSession.setActionHandler('nexttrack', () => next())
    navigator.mediaSession.setActionHandler('previoustrack', previous)
    navigator.mediaSession.setActionHandler('seekto', detail => { if (detail.seekTime !== undefined) seek(detail.seekTime) })
  }, [toggle, next, previous, seek])
  const nextTrack = useCallback(() => next(), [next])
  return { current, playing, position, duration, error, equalizerError, buffering, buffered, bufferedAhead, network, advertising, sourceLabel, reloadSource, snippet, playSnippet, playTrack, retry, toggle, toggleShuffle, seek, next: nextTrack, previous, clearError: () => setError('') }
}
