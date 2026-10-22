import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Bell, BellOff, BookOpen, Disc3, ExternalLink, LoaderCircle, Mic2, RefreshCw, Search } from 'lucide-react'
import type { CatalogArtistPage, CatalogArtistSearch, CatalogArtistSummary, CatalogRelease, CatalogWatchState } from './shared/catalog'
import './CatalogView.css'

type SearchRequest = { query: string; offset: number; previous: number[] }
type ArtistRequest = { id: string; name: string; offset: number; previous: number[] }
export type CatalogRoute = { search: SearchRequest | null; artist: ArtistRequest | null; tab?: 'search' | 'updates' }
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
  const [searchRequest, setSearchRequest] = useState<SearchRequest | null>(route?.search || null)
  const [searchPage, setSearchPage] = useState<CatalogArtistSearch | null>(null)
  const [artistRequest, setArtistRequest] = useState<ArtistRequest | null>(route?.artist || null)
  const [artistPage, setArtistPage] = useState<CatalogArtistPage | null>(null)
  const [busy, setBusy] = useState<'search' | 'artist' | null>(null)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const available = Boolean(window.desktop?.searchCatalogArtists && window.desktop?.getCatalogArtist)
  const [catalogTab, setCatalogTab] = useState<'search' | 'updates'>(route?.tab || 'search')
  const [watch, setWatch] = useState<CatalogWatchState | null>(null)
  const [watchError, setWatchError] = useState('')
  const [followBusy, setFollowBusy] = useState(false)
  const [refreshBusy, setRefreshBusy] = useState(false)
  const refreshPending = useRef(false)
  const [updatesFilter, setUpdatesFilter] = useState('')
  const [updatesVisible, setUpdatesVisible] = useState(30)
  const watchGeneration = useRef(0)
  const followPending = useRef(false)
  const watchRevision = useRef(-1)
  const acceptWatch = (state: CatalogWatchState) => {
    if (state.revision !== undefined && state.revision < watchRevision.current) return
    watchRevision.current = state.revision ?? watchRevision.current
    setWatch(state); setWatchError('')
  }
  useEffect(() => () => { generation.current++ }, [])
  useEffect(() => {
    const current = ++watchGeneration.current
    let observed = false
    const accept = (state: CatalogWatchState) => { if (watchGeneration.current === current) acceptWatch(state) }
    const off = window.desktop?.onCatalogUpdate?.(state => { observed = true; accept(state) })
    void window.desktop?.catalogWatchStatus?.().then(state => { if (!observed) accept(state) }).catch(() => { if (watchGeneration.current === current && !observed) setWatchError('Не удалось прочитать подписки каталога.') })
    return () => { watchGeneration.current++; off?.() }
  }, [])
  async function changeFollow(id: string, followed: boolean) {
    if (!window.desktop?.setCatalogFollowed || followPending.current) return
    const current = watchGeneration.current
    followPending.current = true; setFollowBusy(true); setWatchError('')
    try {
      const state = await window.desktop.setCatalogFollowed(id, followed)
      if (watchGeneration.current === current) acceptWatch(state)
    } catch (reason) { if (watchGeneration.current === current) setWatchError(typeof reason === 'string' ? reason : 'Не удалось изменить подписку.') }
    finally { if (watchGeneration.current === current) { followPending.current = false; setFollowBusy(false) } }
  }
  async function refreshUpdates() {
    if (!window.desktop?.refreshCatalog || refreshPending.current || watch?.refreshing) return
    const current = watchGeneration.current
    refreshPending.current = true; setRefreshBusy(true); setWatchError('')
    try { const state = await window.desktop.refreshCatalog(); if (watchGeneration.current === current) acceptWatch(state) }
    catch { if (watchGeneration.current === current) setWatchError('Не удалось проверить обновления. Сохранённые данные доступны.') }
    finally { if (watchGeneration.current === current) { refreshPending.current = false; setRefreshBusy(false) } }
  }
  async function search(request: SearchRequest, navigate = true) {
    const api = window.desktop?.searchCatalogArtists
    if (!api || !request.query.trim()) return
    const current = ++generation.current
    if (navigate) setCatalogTab('search')
    setSearchRequest(request); setArtistRequest(null); setArtistPage(null); setSearchPage(null); setBusy('search'); setError('')
    if (navigate) onNavigate?.({ search: request, artist: null, tab: 'search' })
    try { const result = await api(request.query, request.offset); if (generation.current === current) setSearchPage(result) }
    catch (reason) { if (generation.current === current) setError(reason instanceof Error ? reason.message : String(reason || 'Каталог недоступен. Попробуйте ещё раз.')) }
    finally { if (generation.current === current) setBusy(null) }
  }
  async function openArtist(request: ArtistRequest, navigate = true) {
    const api = window.desktop?.getCatalogArtist
    if (!api) return
    const current = ++generation.current
    if (navigate) setCatalogTab('search')
    setArtistRequest(request); setArtistPage(null); setBusy('artist'); setError('')
    if (navigate) onNavigate?.({ search: searchRequest, artist: request, tab: 'search' })
    try { const result = await api(request.id, request.offset); if (generation.current === current) setArtistPage(result) }
    catch (reason) { if (generation.current === current) setError(reason instanceof Error ? reason.message : String(reason || 'Карточка недоступна. Попробуйте ещё раз.')) }
    finally { if (generation.current === current) setBusy(null) }
  }
  function backToSearch() {
    if (searchRequest && !searchPage) { void search(searchRequest); return }
    generation.current++; setArtistRequest(null); setArtistPage(null); setBusy(null); setError('')
    onNavigate?.({ search: searchRequest, artist: null, tab: 'search' })
  }
  // App history restores the submitted query, exact artist and pagination offset.
  // User actions already started their request before the controlled route arrives.
  useEffect(() => {
    if (!route) return
    setCatalogTab(route.tab || 'search')
    const sameRequest = JSON.stringify({ search: route.search, artist: route.artist }) === JSON.stringify({ search: searchRequest, artist: artistRequest })
    const alreadyRequested = Boolean(busy) || (artistRequest ? Boolean(artistPage) : !searchRequest || Boolean(searchPage))
    if (sameRequest && alreadyRequested) return
    setQuery(route.search?.query || '')
    if (route.artist) {
      if (JSON.stringify(route.search) !== JSON.stringify(searchRequest)) setSearchPage(null)
      setSearchRequest(route.search); void openArtist(route.artist, false)
    }
    else if (route.search) void search(route.search, false)
    else {
      generation.current++; setSearchRequest(null); setSearchPage(null); setArtistRequest(null); setArtistPage(null); setBusy(null); setError('')
    }
  }, [route])
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
  const followed = watch?.artists.filter(item => item.followed) || []
  const artistFollowed = Boolean(artist && followed.some(item => item.artist.id === artist.id))
  const effectiveUpdatesFilter = followed.some(item => item.artist.id === updatesFilter) ? updatesFilter : ''
  const followedIds = new Set(followed.map(item => item.artist.id))
  const updates = (watch?.updates || []).filter(item => followedIds.has(item.artist.id) && (!effectiveUpdatesFilter || item.artist.id === effectiveUpdatesFilter))
  function switchTab(tab: 'search' | 'updates') { setCatalogTab(tab); onNavigate?.({ search: searchRequest, artist: artistRequest, tab }) }
  function artistCard(item: CatalogArtistSummary) {
    return <button className="catalog-artist-card" key={item.id} onClick={() => void openArtist({ id: item.id, name: item.name, offset: 0, previous: [] })}>
      <span className="catalog-artist-symbol"><Mic2 size={24} strokeWidth={1.3} /></span>
      <span className="catalog-artist-copy"><strong>{item.name}</strong><span>{[kinds[item.kind || ''] || item.kind, item.country].filter(Boolean).join(', ') || 'Тип и страна не указаны'}</span>{item.disambiguation && <small>{item.disambiguation}</small>}</span>
      <ArrowRight size={17} className="catalog-card-arrow" />
    </button>
  }
  return <section className="catalog-view" aria-label="Каталог артистов" aria-busy={Boolean(busy)}>
    <header className="catalog-heading"><div><p className="eyebrow">ЗА ПРЕДЕЛАМИ БИБЛИОТЕКИ</p><h1>Каталог артистов</h1><p className="page-description">Исполнители и дискографии из открытого каталога MusicBrainz. Вход в VK для просмотра не нужен.</p></div><BookOpen size={30} strokeWidth={1.2} /></header>
    <form className="catalog-search" onSubmit={event => { event.preventDefault(); if (query.trim()) void search({ query: query.trim(), offset: 0, previous: [] }) }}>
      <label><Search size={18} /><input aria-label="Имя артиста в каталоге" value={query} maxLength={160} onChange={event => setQuery(event.target.value)} placeholder="Имя артиста на русском или английском" autoComplete="off" /></label>
      <button className="primary-button" disabled={!available || !query.trim()} type="submit">Найти артиста</button>
    </form>
    <p className="catalog-explanation">Здесь собраны сведения о релизах, без аудиофайлов. Музыку из карточки можно отдельно найти в VK.</p>
    {!available ? <div className="catalog-empty"><BookOpen size={32} strokeWidth={1.2} /><h2>Каталог в desktop-версии</h2><p>Откройте установленный Pulse, чтобы искать артистов и их релизы.</p></div> : <>
      <div className="catalog-tabs" role="group" aria-label="Раздел каталога"><button aria-pressed={catalogTab === 'search'} className={catalogTab === 'search' ? 'active' : ''} onClick={() => switchTab('search')}><Search size={14} />Поиск артистов</button><button aria-pressed={catalogTab === 'updates'} className={catalogTab === 'updates' ? 'active' : ''} onClick={() => switchTab('updates')}><Bell size={14} />Обновления{Boolean(watch?.updates.length) && <span>{watch!.updates.length}</span>}</button></div>
      {watchError && <p className="catalog-cache-note" role="alert">{watchError}</p>}
      {catalogTab === 'updates' ? <section className="catalog-updates" aria-label="Обновления каталога">
        <div className="catalog-section-title"><h2>Ваши артисты</h2><button className="catalog-source-link" onClick={() => void refreshUpdates()} disabled={refreshBusy || watch?.refreshing || !window.desktop?.refreshCatalog}><RefreshCw size={13} className={watch?.refreshing || refreshBusy ? 'spin' : ''} />{watch?.refreshing || refreshBusy ? 'Проверяем в фоне' : 'Проверить обновления'}</button></div>
        <p className="catalog-release-note">Pulse хранит подписки и сведения о релизах на этом компьютере и периодически обновляет их в фоне. Первая проверка запоминает текущие данные. Следующие показывают обнаруженные записи; дата и появление в каталоге не подтверждают анонс артиста.</p>
        {watch?.error && <p className="catalog-cache-note" role="status">{watch.error}</p>}
        {followed.length > 0 && <div className="catalog-followed-list" aria-label="Артисты, за которыми вы следите">{followed.map(item => <button key={item.artist.id} onClick={() => void openArtist({ id: item.artist.id, name: item.artist.name, offset: 0, previous: [] })}><Mic2 size={14} /><span>{item.artist.name}</span></button>)}</div>}
        {!followed.length ? <div className="catalog-empty"><Bell size={30} strokeWidth={1.2} /><h3>Выберите своих артистов</h3><p>Откройте карточку и нажмите «Следить за релизами». Подписка сохраняется в Pulse и не меняет подписки VK.</p><button className="secondary-button" onClick={() => switchTab('search')}>Найти артиста</button></div> : <>
          <div className="catalog-update-heading"><h3>Обнаружено в каталоге</h3><label><span>Артист</span><select aria-label="Фильтр обновлений по артисту" value={effectiveUpdatesFilter} onChange={event => { setUpdatesFilter(event.target.value); setUpdatesVisible(30) }}><option value="">Все подписки</option>{followed.map(item => <option value={item.artist.id} key={item.artist.id}>{item.artist.name}</option>)}</select></label></div>
          <div className="catalog-releases">{updates.slice(0, updatesVisible).map(item => { const date = catalogDate(item.release.firstReleaseDate); return <article className="catalog-release" key={`${item.artist.id}:${item.release.id}`}><div className="catalog-release-art" aria-hidden="true"><Disc3 size={37} strokeWidth={1} /></div><div className="catalog-release-copy"><button className="catalog-update-artist" onClick={() => void openArtist({ id: item.artist.id, name: item.artist.name, offset: 0, previous: [] })}>{item.artist.name}</button><h4>{item.release.title}</h4><span>{date.label}{date.future && <em>Будущая дата в каталоге</em>}</span><small>Обнаружено {new Date(item.discoveredAt).toLocaleDateString('ru-RU')}</small></div><div className="catalog-release-actions"><button className="secondary-button" onClick={() => onSearchVk(`${item.artist.name} ${item.release.title}`)}><Search size={14} />Найти в VK</button>{sourceButton(`https://musicbrainz.org/release-group/${encodeURIComponent(item.release.id)}`, 'Источник')}</div></article> })}</div>
          {!updates.length && <div className="catalog-empty"><Disc3 size={29} /><h3>Пока без обнаруженных записей</h3><p>Сохранённые релизы доступны в карточках артистов. Новые записи появятся здесь после следующих успешных проверок.</p></div>}
          {updates.length > updatesVisible && <button className="secondary-button" onClick={() => setUpdatesVisible(count => count + 30)}>Показать ещё</button>}
        </>}
      </section> : <>
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
        <header className="catalog-artist-hero"><div className="catalog-hero-symbol"><Mic2 size={46} strokeWidth={1.1} /></div><div><p className="eyebrow">КАРТОЧКА MUSICBRAINZ</p><h2>{artist.name}</h2><p>{[kinds[artist.kind || ''] || artist.kind, artist.country].filter(Boolean).join(', ')}</p>{artist.disambiguation && <p className="catalog-disambiguation">{artist.disambiguation}</p>}{sourceButton(`https://musicbrainz.org/artist/${encodeURIComponent(artist.id)}`, 'Карточка в MusicBrainz')}{window.desktop?.setCatalogFollowed && <button className="secondary-button catalog-follow-button" disabled={followBusy || !watch} onClick={() => void changeFollow(artist.id, !artistFollowed)}>{followBusy ? <LoaderCircle size={15} className="spin" /> : artistFollowed ? <BellOff size={15} /> : <Bell size={15} />}{artistFollowed ? 'Вы следите' : 'Следить за релизами'}</button>}</div></header>
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
    </>}
  </section>
}
