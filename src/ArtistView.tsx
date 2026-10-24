import { useEffect, useMemo, useRef, useState } from 'react'
import { Bell, BellOff, Check, ChevronRight, CircleAlert, Disc3, LoaderCircle, Mic2, Pause, Play, Plus, Radio, RefreshCw, Sparkles } from 'lucide-react'
import type { Track } from './shared/contracts'
import type { ArtistMusicRequest, ArtistMusicResult, ArtistRelease, ArtistViewProps, VkArtistRef } from './shared/artists'
import { TrackArtwork } from './TrackArtwork'
import { useCurrentTrackReveal } from './useCurrentTrackReveal'
import './ArtistView.css'

const labels = { album: 'Альбомы', ep: 'EP', single: 'Синглы', compilation: 'Сборники', release: 'Другие релизы' }
const number = new Intl.NumberFormat('ru-RU')
const time = (seconds: number) => `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`
const errorText = (error: unknown) => typeof error === 'string' ? error : error instanceof Error ? error.message : 'Не удалось связаться с VK. Повторите запрос.'

export function ArtistView({ request, connected, library, currentId, playing, addedTrackIds, onNavigate, onPlay, onAdd, onSnippet, onConnect }: ArtistViewProps) {
  const [result, setResult] = useState<ArtistMusicResult | null>(null)
  const [loading, setLoading] = useState(false), [refreshing, setRefreshing] = useState(false), [error, setError] = useState('')
  const [pending, setPending] = useState<string | null>(null), [snippetPending, setSnippetPending] = useState<string | null>(null), [followPending, setFollowPending] = useState(false)
  const [visible, setVisible] = useState(30)
  const [catalogTracks, setCatalogTracks] = useState<Track[] | null>(null), [catalogCursor, setCatalogCursor] = useState<string | undefined>(), [catalogTotal, setCatalogTotal] = useState<number | undefined>()
  const [catalogLoading, setCatalogLoading] = useState(false), [catalogError, setCatalogError] = useState(''), [catalogMessage, setCatalogMessage] = useState('')
  const [catalogNeedsRestart, setCatalogNeedsRestart] = useState(false)
  const requestKey = JSON.stringify({ action: request.action, artistId: request.artistId, query: request.query, releaseId: request.releaseId, trackId: request.trackId })
  const generation = useRef(0), inFlight = useRef(false)
  const catalogGeneration = useRef(0), catalogInFlight = useRef(false)
  const fetchLatest = useRef<(quiet?: boolean) => Promise<void>>(async () => {})
  const currentRequest = useRef(request); currentRequest.current = request
  const members = useMemo(() => new Set(library.filter(t => t.source === 'vk' && t.remote?.inLibrary === true).map(t => t.id)), [library])

  useEffect(() => {
    const ticket = ++generation.current
    setResult(null); setError(''); setVisible(30); setPending(null); setSnippetPending(null); setFollowPending(false); inFlight.current = false
    catalogGeneration.current++; catalogInFlight.current = false
    setCatalogTracks(null); setCatalogCursor(undefined); setCatalogTotal(undefined); setCatalogLoading(false); setCatalogError(''); setCatalogMessage(''); setCatalogNeedsRestart(false)
    const load = async (quiet = false) => {
      if (!connected || inFlight.current) return
      if (!window.desktop?.artistMusic) { setError('Каталог артистов доступен в версии приложения на Tauri.'); return }
      inFlight.current = true
      if (!quiet) setLoading(true); else setRefreshing(true)
      try {
        const next = await window.desktop.artistMusic({ ...currentRequest.current, force: quiet })
        if (generation.current === ticket) { setResult(next); setError('') }
      } catch (reason) { if (generation.current === ticket) setError(errorText(reason)) }
      finally { if (generation.current === ticket) { setLoading(false); setRefreshing(false); inFlight.current = false } }
    }
    fetchLatest.current = load
    if (connected) void load()
    else setLoading(false)
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible' && currentRequest.current.action !== 'resolve') void load(true) }, 300_000)
    return () => { window.clearInterval(timer); if (generation.current === ticket) { generation.current++; catalogGeneration.current++; catalogInFlight.current = false; inFlight.current = false } }
  }, [requestKey, connected])

  async function loadCatalog(reset = false) {
    const artistId = result?.artist?.id, api = window.desktop?.artistMusic
    if (!artistId || !api || !connected || catalogInFlight.current || (!reset && catalogTracks !== null && !catalogCursor)) return
    const ticket = generation.current, pageTicket = ++catalogGeneration.current
    catalogInFlight.current = true; setCatalogLoading(true); setCatalogError(''); setCatalogNeedsRestart(false)
    if (reset) { setCatalogTracks([]); setCatalogCursor(undefined); setCatalogTotal(undefined); setCatalogMessage(''); setVisible(30) }
    const cursor = reset ? undefined : catalogCursor
    try {
      const next = await api({ action: 'artist-tracks', artistId, ...(cursor ? { cursor } : {}) })
      if (generation.current !== ticket || catalogGeneration.current !== pageTicket) return
      if (next.artistId !== artistId || !Array.isArray(next.tracks) || Boolean(next.hasMore) !== Boolean(next.nextCursor) || next.nextCursor === cursor && next.hasMore) throw new Error('VK не подтвердил следующую страницу треков. Повторите запрос.')
      setCatalogTracks(previous => [...new Map([...(reset ? [] : previous || []), ...next.tracks!].map(track => [track.id, track])).values()])
      setCatalogCursor(next.nextCursor); setCatalogTotal(next.totalTracks); setCatalogMessage(next.message || '')
      if (!reset) setVisible(value => value + 100)
    } catch (reason) { if (generation.current === ticket && catalogGeneration.current === pageTicket) { const message = errorText(reason); setCatalogError(message); setCatalogNeedsRestart(/больше не хранит|не подтвердил следующую страницу/.test(message)) } }
    finally { if (generation.current === ticket && catalogGeneration.current === pageTicket) { catalogInFlight.current = false; setCatalogLoading(false) } }
  }
  function closeCatalog() {
    catalogGeneration.current++; catalogInFlight.current = false
    setCatalogTracks(null); setCatalogLoading(false); setCatalogCursor(undefined); setCatalogTotal(undefined); setCatalogError(''); setCatalogMessage(''); setVisible(30)
  }

  async function follow() {
    const artist = result?.artist, api = window.desktop?.artistMusic
    if (!artist || !api || followPending || inFlight.current || typeof artist.followed !== 'boolean') return
    const ticket = generation.current; inFlight.current = true; setFollowPending(true); setError('')
    try { const next = await api({ action: 'follow', artistId: artist.id, follow: !artist.followed }); if (generation.current === ticket) setResult(next) }
    catch (reason) { if (generation.current === ticket) setError(errorText(reason)) }
    finally { if (generation.current === ticket) { setFollowPending(false); inFlight.current = false } }
  }
  async function add(track: Track) {
    if (pending) return
    const ticket = generation.current; setPending(track.id); setError('')
    try { await onAdd(track) }
    catch (reason) { if (generation.current === ticket) setError(errorText(reason)) }
    finally { if (generation.current === ticket) setPending(null) }
  }
  async function snippet(track: Track) {
    if (snippetPending || !window.desktop?.artistMusic) return
    const ticket = generation.current; setSnippetPending(track.id); setError('')
    try { const next = await window.desktop.artistMusic({ action: 'snippet', trackId: track.id }); if (generation.current === ticket && next.clip?.trackId === track.id) onSnippet(track, next.clip.from, next.clip.to) }
    catch (reason) { if (generation.current === ticket) setError(errorText(reason)) }
    finally { if (generation.current === ticket) setSnippetPending(null) }
  }
  const openArtist = (artist: VkArtistRef) => onNavigate({ action: 'artist', artistId: artist.id })
  const saved = (track: Track) => members.has(track.id) || addedTrackIds?.has(track.id)
  function artistLinks(track: Track) { return track.artistRefs?.length ? track.artistRefs.map((a, index) => <span key={a.id}>{index > 0 && ', '}<button onClick={() => openArtist(a)}>{a.name}</button></span>) : <button onClick={() => onNavigate({ action: 'resolve', query: track.artist })}>{track.artist}</button> }
  function trackRow(track: Track, index: number, context: Track[]) { return <div className={`artist-track ${currentId === track.id ? 'is-active' : ''}`} key={track.id} role="listitem" data-track-id={track.id} aria-current={currentId === track.id ? 'true' : undefined}>
    <button className="artist-track-play" onClick={() => onPlay(track, context)} aria-label={`${currentId === track.id && playing ? 'Пауза' : 'Слушать'} ${track.title}`}><TrackArtwork track={track} className="artist-track-cover" /><span>{currentId === track.id && playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}</span></button>
    <span className="artist-track-number">{index + 1}</span><div className="artist-track-copy"><button className="artist-track-title" onClick={() => onPlay(track, context)}>{track.title}</button><div className="artist-track-artists">{artistLinks(track)}</div></div>
    <span className="artist-track-time">{time(track.duration)}</span><button className="icon-button artist-snippet-action" aria-label={`Сниппет ${track.title}`} title="Сниппет VK" disabled={Boolean(snippetPending) || !connected} onClick={() => void snippet(track)}>{snippetPending === track.id ? <LoaderCircle size={17} className="spin" /> : <Radio size={17} />}</button>
    {saved(track) ? <span className="artist-track-saved" aria-label="В вашей музыке VK" title="В вашей музыке VK"><Check size={17} /></span> : <button className="icon-button" disabled={Boolean(pending) || !connected} title="Добавить в мою музыку VK" aria-label={`Добавить ${track.title} в VK`} onClick={() => void add(track)}>{pending === track.id ? <LoaderCircle size={17} className="spin" /> : <Plus size={18} />}</button>}
  </div> }
  function releaseCard(release: ArtistRelease) { return <button className="artist-release-card" key={release.id} onClick={() => onNavigate({ action: 'release', releaseId: release.id })}>
    <span className="artist-release-art-wrap"><TrackArtwork track={{ id: release.id, title: release.title, artist: release.artist, artwork: release.artwork }} className="artist-release-art" /><span className="artist-release-play"><ChevronRight size={23} /></span>{release.kind !== 'album' && release.kind !== 'release' && <span className="artist-release-badge">{release.kind === 'compilation' ? 'Сборник' : release.kind === 'single' ? 'Сингл' : 'EP'}</span>}</span>
    <strong>{release.title}</strong><span>{release.artist || `${release.trackCount} треков`}{release.year ? `, ${release.year}` : ''}</span>{release.plays != null && <small>{number.format(release.plays)} прослушиваний</small>}
  </button> }
  const artist = result?.artist, tracks = catalogTracks ?? artist?.tracks ?? result?.tracks ?? [], releases = artist?.releases || result?.releases || []
  const currentTrackList = useCurrentTrackReveal({ currentId, tracks, contextKey: `${requestKey}:${catalogTracks === null ? 'popular' : 'catalog'}`, renderedCount: visible, ensureRendered: count => setVisible(previous => Math.max(previous, count)), enabled: connected && !loading && request.action !== 'snippets' })
  const title = artist?.name || result?.release?.title || (request.action === 'updates' ? 'Новые релизы' : request.action === 'snippets' ? 'Сниппеты' : request.action === 'resolve' ? `Исполнители: ${request.query || ''}` : 'Исполнитель')
  if (!connected) return <section className="artist-view artist-empty"><Mic2 size={42} strokeWidth={1.2} /><h1>Музыка ближе</h1><p>Подключите VK, чтобы открыть артистов, их релизы и обновления.</p><button className="primary-button" onClick={onConnect}>Подключить VK</button></section>
  return <section className="artist-view" aria-busy={loading}>
    <div className="artist-view-toolbar"><span className="eyebrow">{request.action === 'updates' ? 'ОТ ТЕХ, КОГО ВЫ СЛУШАЕТЕ' : request.action === 'snippets' ? 'ОТКРОЙТЕ НОВЫЙ ЗВУК' : 'МУЗЫКА VK'}</span><button className="icon-button" disabled={loading || refreshing || followPending || catalogLoading} onClick={() => catalogTracks !== null ? void loadCatalog(true) : void fetchLatest.current(true)} title="Обновить из VK" aria-label="Обновить из VK"><RefreshCw size={17} className={refreshing || catalogLoading ? 'spin' : ''} /></button></div>
    {loading && !result ? <div className="artist-skeleton"><div /><section><span /><span /><span /></section></div> : <>
      <header className={`artist-hero ${artist?.photo || result?.release?.artwork ? 'has-art' : ''}`}>
        {artist ? <TrackArtwork track={{ id: artist.id, title: artist.name, artist: artist.name, artwork: artist.photo }} className="artist-portrait" /> : result?.release ? <TrackArtwork track={{ id: result.release.id, title, artist: result.release.artist, artwork: result.release.artwork }} className="artist-release-hero-art" /> : <div className="artist-hero-symbol">{request.action === 'updates' ? <Bell size={40} strokeWidth={1.1} /> : request.action === 'snippets' ? <Radio size={42} strokeWidth={1.1} /> : <Mic2 size={42} strokeWidth={1.1} />}</div>}
        <div className="artist-hero-copy"><span className="artist-hero-label">{artist ? 'Исполнитель' : result?.release ? ({ album: 'Альбом', single: 'Сингл', ep: 'EP', compilation: 'Сборник', release: 'Релиз' }[result.release.kind]) : 'Ваша следующая любимая музыка'}</span><h1>{title}</h1>
          {artist && <div className="artist-stats">{artist.listeners != null && <span>{number.format(artist.listeners)} слушателей</span>}{artist.followers != null && <span>{number.format(artist.followers)} подписчиков</span>}</div>}
          {result?.release && <div className="artist-stats">{result.release.artistRefs?.map(a => <button className="artist-text-link" key={a.id} onClick={() => openArtist(a)}>{a.name}</button>)}{!result.release.artistRefs?.length && result.release.artist && <span>{result.release.artist}</span>}{result.release.year && <span>{result.release.year}</span>}<span>{result.release.trackCount} треков</span>{result.release.plays != null && <span>{number.format(result.release.plays)} прослушиваний</span>}</div>}
          {request.action === 'updates' && <p>Свежие альбомы и синглы из вашей ленты VK.<br />Подписывайтесь на артистов, чтобы видеть новые выходы.</p>}
          {request.action === 'snippets' && <p>Короткие фрагменты, которые подобрал VK.<br />Услышали своё — сохраните полную версию.</p>}
          <div className="artist-hero-actions">{tracks.length > 0 && <button className="primary-button" onClick={() => request.action === 'snippets' ? void snippet(tracks[0]) : onPlay(tracks[0], tracks, true)}><Play size={17} fill="currentColor" />{request.action === 'snippets' ? 'Слушать сниппет' : 'Слушать'}</button>}{artist && artist.canFollow !== false && typeof artist.followed === 'boolean' && <button className={`secondary-button artist-follow ${artist.followed ? 'is-followed' : ''}`} disabled={followPending || refreshing} onClick={() => void follow()}>{followPending ? <LoaderCircle size={17} className="spin" /> : artist.followed ? <BellOff size={17} /> : <Bell size={17} />}{followPending ? 'Проверяем в VK…' : artist.followed ? 'Вы подписаны' : 'Подписаться на новинки'}</button>}</div>
        </div>
      </header>
      {artist?.bio && <details className="artist-bio"><summary>Об исполнителе</summary><p>{artist.bio}</p></details>}
      {result?.artists && result.artists.length > 0 && <section className="artist-follows"><div className="artist-section-heading"><h2>{request.action === 'resolve' ? 'В каталоге VK' : 'Вы подписаны'}</h2><span>{result.artists.length}</span></div><div className="artist-follows-strip">{result.artists.map(a => <button key={a.id} onClick={() => openArtist(a)}><TrackArtwork track={{ id: a.id, title: a.name, artist: a.name, artwork: a.photo }} className="artist-follow-avatar" /><strong>{a.name}</strong>{a.followed && <Check size={13} />}</button>)}</div></section>}
      {(tracks.length > 0 || artist) && <section className="artist-track-section"><div className="artist-section-heading"><h2>{artist ? catalogTracks !== null ? 'Все треки' : 'Популярное' : request.action === 'snippets' ? 'Подборка VK' : 'Треки'}</h2><span>{catalogTracks !== null && catalogTotal != null ? `${tracks.length} из ${number.format(catalogTotal)}` : tracks.length}</span>{artist && <button className="artist-catalog-toggle" disabled={catalogLoading} onClick={() => catalogTracks !== null ? closeCatalog() : void loadCatalog(true)}>{catalogLoading ? <LoaderCircle size={15} className="spin" /> : null}{catalogTracks !== null ? 'Популярное' : 'Все треки'}<ChevronRight size={15} /></button>}</div>{request.action === 'snippets' ? <div className="artist-snippet-grid">{tracks.map(track => <article className={`artist-snippet-card ${currentId === track.id ? 'is-active' : ''}`} key={track.id}><button className="artist-snippet-cover-button" disabled={Boolean(snippetPending)} onClick={() => void snippet(track)} aria-label={`Сниппет ${track.title}`}><TrackArtwork track={track} className="artist-snippet-cover" /><span>{snippetPending === track.id ? <LoaderCircle className="spin" size={29} /> : <Play size={29} fill="currentColor" />}</span></button><strong>{track.title}</strong><div className="artist-track-artists">{artistLinks(track)}</div><div className="artist-snippet-footer"><button onClick={() => onPlay(track, tracks, true)}>Полная версия<ChevronRight size={14} /></button>{saved(track) ? <Check size={18} aria-label="В вашей музыке VK" /> : <button className="icon-button" disabled={Boolean(pending)} aria-label={`Добавить ${track.title} в VK`} onClick={() => void add(track)}>{pending === track.id ? <LoaderCircle size={17} className="spin" /> : <Plus size={19} />}</button>}</div></article>)}</div> : <div className="artist-track-list" role="list" ref={currentTrackList}>{tracks.slice(0, visible).map((t, i) => trackRow(t, i, tracks))}{catalogLoading && <div className="artist-catalog-status" role="status"><LoaderCircle size={17} className="spin" />Загружаем треки из VK…</div>}{tracks.length > visible ? <button className="artist-show-more" onClick={() => setVisible(v => v + 100)}>Показать ещё {Math.min(100, tracks.length - visible)}</button> : catalogCursor && <button className="artist-show-more" disabled={catalogLoading} onClick={() => void loadCatalog()}>{catalogLoading ? 'Загружаем…' : 'Загрузить ещё треки'}</button>}{catalogTracks !== null && !tracks.length && !catalogLoading && !catalogError && <p className="artist-catalog-status">VK пока не предоставил треки артиста.</p>}</div>}{catalogError && <div className="artist-inline-error" role="alert"><CircleAlert size={18} /><span>{catalogError}</span><button disabled={catalogLoading} onClick={() => void loadCatalog(catalogNeedsRestart || !catalogTracks?.length)}>{catalogNeedsRestart ? 'Открыть заново' : 'Повторить'}</button></div>}{catalogMessage && <p className="artist-cache-note" role="status">{catalogMessage}</p>}</section>}
      {(['album', 'ep', 'single', 'compilation', 'release'] as const).map(kind => { const rows = releases.filter(r => r.kind === kind); return rows.length > 0 && <section className="artist-releases-section" key={kind}><div className="artist-section-heading"><h2>{labels[kind]}</h2><span>{rows.length}</span><Disc3 size={17} /></div><div className="artist-release-grid">{rows.map(releaseCard)}</div></section> })}
      {!error && !loading && result && !artist && !result.release && !tracks.length && !releases.length && !result.artists?.length && <div className="artist-empty"><Sparkles size={33} strokeWidth={1.2} /><h2>{request.action === 'resolve' ? 'Такого артиста пока нет' : request.action === 'updates' ? 'Пока без новых релизов' : 'Музыка ещё не появилась'}</h2><p>{request.action === 'resolve' ? 'Попробуйте другое имя или откройте исполнителя из трека.' : 'Когда VK предоставит новые подборки, они появятся здесь.'}</p></div>}
    </>}
    {error && <div className="artist-inline-error" role="alert"><CircleAlert size={18} /><span>{error}</span><button onClick={() => void fetchLatest.current(true)} disabled={refreshing}>Повторить</button></div>}
    {result?.message && <p className="artist-cache-note" role="status">{result.message}</p>}{result?.hasMore && <p className="artist-cache-note">Показана доступная часть каталога VK. Новые релизы появятся после обновления.</p>}
    {result?.checkedAt && <p className="artist-updated">{result.cached ? 'Сохранено' : 'Обновлено из VK'} {new Date(result.checkedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</p>}
  </section>
}
