import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, BookOpen, ChevronDown, Disc3, ExternalLink, LoaderCircle, Mic2, Network, Search } from 'lucide-react'
import type { CatalogArtistPage, CatalogArtistSearch, CatalogArtistSummary, CatalogRelease } from './shared/catalog'
import './CatalogView.css'

type SearchRequest = { query: string; offset: number; previous: number[] }
type ArtistRequest = { id: string; name: string; offset: number; previous: number[] }
export type CatalogRoute = { search: SearchRequest | null; artist: ArtistRequest | null }
const kinds: Record<string, string> = { Person: 'Исполнитель', Group: 'Группа', Orchestra: 'Оркестр', Choir: 'Хор', Character: 'Персонаж', Other: 'Другой тип' }
const releaseKinds: Array<[string, string]> = [['Album', 'Альбомы'], ['EP', 'EP'], ['Single', 'Синглы'], ['Other', 'Другие релизы']]
const releaseLabels: Record<string, string> = { Album: 'Альбом', EP: 'EP', Single: 'Сингл', Broadcast: 'Эфир', Other: 'Релиз', Compilation: 'Сборник', Live: 'Концертный', Remix: 'Ремиксы', Soundtrack: 'Саундтрек' }
function releaseGroup(release: CatalogRelease) { return ['Album', 'EP', 'Single'].includes(release.primaryType || '') ? release.primaryType! : 'Other' }
function safeUrl(value: string) { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null } catch { return null } }
function catalogDate(value?: string) {
  if (!value || !/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(value)) return { label: 'Дата не указана', future: false }
  const now = new Date(), today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const future = value > today.slice(0, value.length)
  const [year, month, day] = value.split('-')
  return { label: day ? `${day}.${month}.${year}` : month ? `${month}.${year}` : year, future }
}

function Pagination({ offset, count, hasMore, canPrevious, busy, previous, next, label }: { offset: number; count: number; hasMore: boolean; canPrevious: boolean; busy: boolean; previous: () => void; next: () => void; label: string }) {
  if (!canPrevious && !hasMore) return null
  return <nav className="catalog-pagination" aria-label={label}>
    <button className="secondary-button" disabled={busy || !canPrevious} onClick={previous}><ArrowLeft size={15} /> Назад</button>
    <span>{count ? `${offset + 1}–${offset + count}` : 'Нет результатов'}</span>
    <button className="secondary-button" disabled={busy || !hasMore || count === 0} onClick={next}>Далее <ArrowRight size={15} /></button>
  </nav>
}

export function CatalogView({ onSearchVk, route, onNavigate }: { onSearchVk: (query: string) => void; route?: CatalogRoute; onNavigate?: (route: CatalogRoute) => void }) {
  const [query, setQuery] = useState(() => route?.search?.query || '')
  const [searchRequest, setSearchRequest] = useState<SearchRequest | null>(null)
  const [searchPage, setSearchPage] = useState<CatalogArtistSearch | null>(null)
  const [artistRequest, setArtistRequest] = useState<ArtistRequest | null>(null)
  const [artistPage, setArtistPage] = useState<CatalogArtistPage | null>(null)
  const [busy, setBusy] = useState<'search' | 'artist' | null>(null)
  const [error, setError] = useState('')
  const [routeStatus, setRouteStatus] = useState<{ proxy: boolean; available?: boolean; message: string } | null>(null)
  const [proxy, setProxy] = useState('')
  const [routeBusy, setRouteBusy] = useState(Boolean(window.desktop?.statusCatalogRoute))
  const [routeMessage, setRouteMessage] = useState('')
  const [routeError, setRouteError] = useState('')
  const generation = useRef(0)
  const routeGeneration = useRef(0)
  const available = Boolean(window.desktop?.searchCatalogArtists && window.desktop?.getCatalogArtist)
  const canConfigureRoute = Boolean(window.desktop?.statusCatalogRoute && window.desktop?.configureCatalogRoute)
  useEffect(() => () => { generation.current++ }, [])
  useEffect(() => {
    const status = window.desktop?.statusCatalogRoute
    if (!status) return
    const current = ++routeGeneration.current
    setRouteBusy(true)
    void status().then(result => { if (routeGeneration.current === current) setRouteStatus(result) }).catch(() => {
      if (routeGeneration.current === current) setRouteError('Не удалось прочитать настройку подключения каталога.')
    }).finally(() => { if (routeGeneration.current === current) setRouteBusy(false) })
    return () => { routeGeneration.current++ }
  }, [])
  async function search(request: SearchRequest, navigate = true) {
    const api = window.desktop?.searchCatalogArtists
    if (!api || !request.query.trim() || routeBusy) return
    const current = ++generation.current
    setSearchRequest(request); setArtistRequest(null); setArtistPage(null); setSearchPage(null); setBusy('search'); setError('')
    if (navigate) onNavigate?.({ search: request, artist: null })
    try { const result = await api(request.query, request.offset); if (generation.current === current) setSearchPage(result) }
    catch (reason) { if (generation.current === current) setError(reason instanceof Error ? reason.message : String(reason || 'Каталог недоступен. Попробуйте ещё раз.')) }
    finally { if (generation.current === current) setBusy(null) }
  }
  async function openArtist(request: ArtistRequest, navigate = true) {
    const api = window.desktop?.getCatalogArtist
    if (!api || routeBusy) return
    const current = ++generation.current
    setArtistRequest(request); setArtistPage(null); setBusy('artist'); setError('')
    if (navigate) onNavigate?.({ search: searchRequest, artist: request })
    try { const result = await api(request.id, request.offset); if (generation.current === current) setArtistPage(result) }
    catch (reason) { if (generation.current === current) setError(reason instanceof Error ? reason.message : String(reason || 'Карточка недоступна. Попробуйте ещё раз.')) }
    finally { if (generation.current === current) setBusy(null) }
  }
  function backToSearch() {
    if (searchRequest && !searchPage) { void search(searchRequest); return }
    generation.current++; setArtistRequest(null); setArtistPage(null); setBusy(null); setError('')
    onNavigate?.({ search: searchRequest, artist: null })
  }
  // App history restores the submitted query, exact artist and pagination offset.
  // User actions already started their request before the controlled route arrives.
  useEffect(() => {
    if (routeBusy || !route || JSON.stringify(route) === JSON.stringify({ search: searchRequest, artist: artistRequest })) return
    setQuery(route.search?.query || '')
    if (route.artist) {
      if (JSON.stringify(route.search) !== JSON.stringify(searchRequest)) setSearchPage(null)
      setSearchRequest(route.search); void openArtist(route.artist, false)
    }
    else if (route.search) void search(route.search, false)
    else {
      generation.current++; setSearchRequest(null); setSearchPage(null); setArtistRequest(null); setArtistPage(null); setBusy(null); setError('')
    }
  }, [route, routeBusy])
  async function saveCatalogRoute(value: string) {
    const api = window.desktop?.configureCatalogRoute
    if (!api || routeBusy) return
    const current = ++routeGeneration.current
    generation.current++; setBusy(null); setError(''); setSearchPage(null); setArtistPage(null)
    setRouteBusy(true); setRouteMessage(''); setRouteError(''); setProxy('')
    try {
      await api(value.trim())
      if (routeGeneration.current !== current) return
      generation.current++; setBusy(null); setSearchPage(null); setArtistPage(null)
      setRouteStatus(null)
      setRouteMessage('Подключение сохранено. Повторите поиск, чтобы проверить выбранный маршрут.')
      try {
        const status = await window.desktop?.statusCatalogRoute?.()
        if (routeGeneration.current === current && status) setRouteStatus(status)
      } catch {
        if (routeGeneration.current === current) setRouteError('Настройка сохранена, но её состояние сейчас недоступно.')
      }
    } catch {
      if (routeGeneration.current === current) setRouteError('Не удалось сохранить подключение. Проверьте адрес прокси и повторите попытку.')
    } finally { if (routeGeneration.current === current) setRouteBusy(false) }
  }
  async function openLink(value: string) {
    const url = safeUrl(value)
    if (!url) return
    try { if (window.desktop?.openExternal) await window.desktop.openExternal(url); else window.open(url, '_blank', 'noopener,noreferrer') }
    catch { setError('Не удалось открыть ссылку в браузере.') }
  }
  const data = artistRequest ? artistPage : searchPage
  const artist = artistPage?.artist
  const fetchedAt = data?.fetchedAt ? new Date(data.fetchedAt) : null
  const timestamp = fetchedAt && Number.isFinite(fetchedAt.getTime()) ? fetchedAt.toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }) : null
  const sourceButton = (url: string, label = 'MusicBrainz') => <button className="catalog-source-link" onClick={() => void openLink(url)}>{label}<ExternalLink size={12} /></button>
  const searchNext = () => searchPage && searchRequest && void search({ ...searchRequest, offset: searchPage.offset + searchPage.artists.length, previous: [...searchRequest.previous, searchPage.offset] })
  const searchPrevious = () => searchRequest && void search({ ...searchRequest, offset: searchRequest.previous.at(-1) || 0, previous: searchRequest.previous.slice(0, -1) })
  const artistNext = () => artistPage && artistRequest && void openArtist({ ...artistRequest, offset: artistPage.offset + artistPage.releases.length, previous: [...artistRequest.previous, artistPage.offset] })
  const artistPrevious = () => artistRequest && void openArtist({ ...artistRequest, offset: artistRequest.previous.at(-1) || 0, previous: artistRequest.previous.slice(0, -1) })
  function artistCard(item: CatalogArtistSummary) {
    return <button className="catalog-artist-card" key={item.id} onClick={() => void openArtist({ id: item.id, name: item.name, offset: 0, previous: [] })}>
      <span className="catalog-artist-symbol"><Mic2 size={24} strokeWidth={1.3} /></span>
      <span className="catalog-artist-copy"><strong>{item.name}</strong><span>{[kinds[item.kind || ''] || item.kind, item.country].filter(Boolean).join(', ') || 'Тип и страна не указаны'}</span>{item.disambiguation && <small>{item.disambiguation}</small>}</span>
      <ArrowRight size={17} className="catalog-card-arrow" />
    </button>
  }
  return <section className="catalog-view" aria-label="Каталог артистов" aria-busy={Boolean(busy)}>
    <header className="catalog-heading"><div><p className="eyebrow">ЗА ПРЕДЕЛАМИ БИБЛИОТЕКИ</p><h1>Каталог артистов</h1><p className="page-description">Исполнители и дискографии из открытого каталога MusicBrainz. Вход в VK для просмотра не нужен.</p></div><BookOpen size={30} strokeWidth={1.2} /></header>
    <form className="catalog-search" onSubmit={event => { event.preventDefault(); if (query.trim() && !routeBusy) void search({ query: query.trim(), offset: 0, previous: [] }) }}>
      <label><Search size={18} /><input aria-label="Имя артиста в каталоге" value={query} maxLength={160} onChange={event => setQuery(event.target.value)} placeholder="Имя артиста на русском или английском" autoComplete="off" /></label>
      <button className="primary-button" disabled={!available || !query.trim() || routeBusy} type="submit">Найти артиста</button>
    </form>
    <p className="catalog-explanation">Здесь собраны сведения о релизах, без аудиофайлов. Музыку из карточки можно отдельно найти в VK.</p>
    {canConfigureRoute && <details className="catalog-route-settings"><summary><Network size={14} /><span>Подключение каталога</span><small>{routeStatus ? routeStatus.available === false ? 'Настройка недоступна' : routeStatus.proxy ? 'Прокси' : 'Напрямую' : routeBusy ? 'Проверяем настройку…' : 'Состояние недоступно'}</small><ChevronDown size={14} /></summary><div>
      <p>Отдельный маршрут только для MusicBrainz. Подключение VK остаётся прежним. Ключи SoundCloud не нужны.</p>
      {routeStatus && <p className="catalog-route-status">{routeStatus.message}</p>}
      <form onSubmit={event => { event.preventDefault(); void saveCatalogRoute(proxy) }}>
        <label>Прокси для MusicBrainz<input type="password" aria-label="Прокси для MusicBrainz" value={proxy} onChange={event => setProxy(event.target.value)} autoComplete="new-password" spellCheck={false} maxLength={2048} placeholder="http://логин:пароль@сервер:порт" disabled={routeBusy} /></label>
        <button className="secondary-button" disabled={routeBusy} type="submit">{routeBusy ? <LoaderCircle size={14} className="spin" /> : null} Сохранить</button>
        {routeStatus?.proxy && <button className="catalog-direct-button" disabled={routeBusy} type="button" onClick={() => void saveCatalogRoute('')}>Подключаться напрямую</button>}
      </form>
      <small>Поддерживаются HTTP, HTTPS и SOCKS5h. Пустое поле включает прямое подключение. Сохранённый адрес скрыт; настройка маршрута не подтверждает доступность сервиса.</small>
      {routeMessage && <p className="catalog-route-status" role="status">{routeMessage}</p>}
      {routeError && <p className="catalog-route-error" role="alert">{routeError}</p>}
    </div></details>}
    {!available ? <div className="catalog-empty"><BookOpen size={32} strokeWidth={1.2} /><h2>Каталог в desktop-версии</h2><p>Откройте установленный Pulse, чтобы искать артистов и их релизы.</p></div> : <>
      {artistRequest && <button className="catalog-back" onClick={backToSearch}><ArrowLeft size={15} /> К результатам поиска</button>}
      {busy && <div className="catalog-loading" role="status"><LoaderCircle size={20} className="spin" />{busy === 'artist' ? `Загружаем дискографию ${artistRequest?.name || ''}…` : 'Ищем в MusicBrainz…'}</div>}
      {error && <div className="catalog-error" role="alert"><span>{error}</span><button className="secondary-button" onClick={() => artistRequest ? void openArtist(artistRequest) : searchRequest ? void search(searchRequest) : setError('')}>Повторить</button></div>}
      {data?.stale && <div className="catalog-cache-note" role="status">MusicBrainz сейчас недоступен. Показана сохранённая копия{timestamp ? ` от ${timestamp}` : ''}; сведения могли измениться.</div>}
      {!artistRequest && searchPage && <>
        <div className="catalog-section-title"><h2>Результаты поиска</h2><span>Запрос: {searchRequest?.query}</span></div>
        {searchPage.artists.length ? <div className="catalog-artists">{searchPage.artists.map(artistCard)}</div> : <div className="catalog-empty"><Search size={29} /><h2>Артист не найден</h2><p>Попробуйте другое написание или псевдоним. MusicBrainz может знать не всех исполнителей.</p></div>}
        <Pagination offset={searchPage.offset} count={searchPage.artists.length} hasMore={searchPage.hasMore} canPrevious={Boolean(searchRequest?.previous.length)} busy={Boolean(busy)} previous={searchPrevious} next={searchNext} label="Страницы артистов" />
      </>}
      {artist && artistPage && <>
        <header className="catalog-artist-hero"><div className="catalog-hero-symbol"><Mic2 size={46} strokeWidth={1.1} /></div><div><p className="eyebrow">КАРТОЧКА MUSICBRAINZ</p><h2>{artist.name}</h2><p>{[kinds[artist.kind || ''] || artist.kind, artist.country].filter(Boolean).join(', ')}</p>{artist.disambiguation && <p className="catalog-disambiguation">{artist.disambiguation}</p>}{sourceButton(`https://musicbrainz.org/artist/${encodeURIComponent(artist.id)}`, 'Карточка в MusicBrainz')}</div></header>
        {artist.description && <p className="catalog-description">{artist.description}</p>}
        {artist.tags.length > 0 && <div className="catalog-tags" aria-label="Теги MusicBrainz">{artist.tags.slice(0, 12).map(tag => <span key={tag}>{tag}</span>)}</div>}
        {artist.links.some(link => safeUrl(link.url)) && <div className="catalog-artist-links"><span>Ссылки из MusicBrainz</span>{artist.links.filter(link => safeUrl(link.url)).slice(0, 12).map(link => <button key={`${link.label}:${link.url}`} onClick={() => void openLink(link.url)}>{link.label || new URL(link.url).hostname}<ExternalLink size={12} /></button>)}</div>}
        <p className="catalog-release-note">Даты относятся к первому выпуску по данным каталога. Будущая дата в MusicBrainz не подтверждает анонс артиста.</p>
        {releaseKinds.map(([kind, label]) => { const rows = artistPage.releases.filter(release => releaseGroup(release) === kind); return rows.length ? <section className="catalog-release-section" key={kind}><div className="catalog-section-title"><h3>{label}</h3><span>{rows.length} на этой странице</span></div><div className="catalog-releases">{rows.map(release => { const date = catalogDate(release.firstReleaseDate); return <article className="catalog-release" key={release.id}><div className="catalog-release-art" aria-hidden="true"><Disc3 size={37} strokeWidth={1} /></div><div className="catalog-release-copy"><h4>{release.title}</h4><span>{date.label}{date.future && <em>Будущая дата в каталоге</em>}</span><small>{[release.primaryType, ...release.secondaryTypes].filter(Boolean).map(type => releaseLabels[type!] || type).join(', ') || 'Тип не указан'}</small></div><div className="catalog-release-actions"><button className="secondary-button" onClick={() => onSearchVk(`${artist.name} ${release.title}`)}><Search size={14} /> Найти в VK</button>{sourceButton(`https://musicbrainz.org/release-group/${encodeURIComponent(release.id)}`, 'Источник')}</div></article> })}</div></section> : null })}
        {!artistPage.releases.length && <div className="catalog-empty"><Disc3 size={30} /><h3>Релизы не указаны</h3><p>На этой странице каталога нет альбомов, EP или синглов.</p></div>}
        <Pagination offset={artistPage.offset} count={artistPage.releases.length} hasMore={artistPage.hasMore} canPrevious={Boolean(artistRequest?.previous.length)} busy={Boolean(busy)} previous={artistPrevious} next={artistNext} label="Страницы релизов" />
      </>}
      {!searchRequest && !busy && <div className="catalog-empty catalog-intro"><div className="catalog-intro-orbit"><Disc3 size={56} strokeWidth={.8} /><Mic2 size={24} /></div><h2>Найдите свою следующую дискографию</h2><p>Введите имя артиста. Откройте подходящую карточку, чтобы увидеть альбомы, EP и синглы. Одноимённых исполнителей можно отличить по стране и описанию.</p></div>}
      {data && <footer className="catalog-attribution">{sourceButton('https://musicbrainz.org', 'Данные MusicBrainz')}{timestamp && <span>Получены {timestamp}</span>}<span>Каталог пополняет сообщество; полнота и точность могут различаться.</span></footer>}
    </>}
  </section>
}
