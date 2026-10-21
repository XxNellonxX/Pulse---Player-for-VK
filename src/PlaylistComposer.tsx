import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { ArrowDown, ArrowUp, Check, Cloud, Disc3, HardDrive, ListMusic, LoaderCircle, Plus, Search, X } from 'lucide-react'
import type { Playlist, Track } from './shared/contracts'
import { TrackArtwork } from './TrackArtwork'
import './PlaylistComposer.css'

export type PlaylistDraft = { title: string; description: string; trackIds: string[]; destination: 'vk' | 'local' }
type Props = { tracks: Track[]; initialPlaylist?: Playlist; initialDestination?: 'vk' | 'local'; canSyncVk: boolean; accountId?: number; busy: boolean; error?: string; onClose(): void; onSave(draft: PlaylistDraft): Promise<boolean | void> }
const time = (seconds: number) => `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`

export function PlaylistComposer({ tracks, initialPlaylist: existing, initialDestination, canSyncVk: connected, accountId, busy, error, onClose, onSave }: Props) {
  const [title, setTitle] = useState(existing?.title || '')
  const [description, setDescription] = useState(existing?.description || '')
  const [destination, setDestination] = useState<'vk' | 'local'>(existing ? existing.remote ? 'vk' : 'local' : initialDestination || (connected ? 'vk' : 'local'))
  const [selected, setSelected] = useState<string[]>(existing?.trackIds || [])
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(60)
  const [submitted, setSubmitted] = useState(false)
  const [localError, setLocalError] = useState('')
  const dialog = useRef<HTMLDivElement>(null)
  const saving = busy || submitted
  const lookup = useMemo(() => new Map(tracks.map(track => [track.id, track])), [tracks])
  const selectedSet = useMemo(() => new Set(selected), [selected])
  const eligible = (track: Track | undefined) => Boolean(track && track.available && (destination === 'local' || track.source === 'vk' && (existing?.remote && existing.trackIds.includes(track.id) || track.remote?.ownerId === accountId && track.remote?.inLibrary !== false)))
  const invalidCount = selected.filter(id => !eligible(lookup.get(id))).length
  const duration = selected.reduce((total, id) => total + (lookup.get(id)?.duration || 0), 0)
  const matching = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return tracks.filter(track => !selectedSet.has(track.id) && (!needle || `${track.title} ${track.artist}`.toLocaleLowerCase().includes(needle)))
  }, [tracks, selectedSet, query])

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.current?.querySelector<HTMLInputElement>('input[name="playlist-title"]')?.focus()
    return () => previous?.focus()
  }, [])
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); if (!saving) onClose(); return }
      if (event.key !== 'Tab' || !dialog.current) return
      const targets = Array.from(dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]'))
      const first = targets[0], last = targets[targets.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [saving, onClose])

  function move(index: number, direction: number) {
    setSelected(ids => { const next = [...ids], other = index + direction; if (other >= 0 && other < next.length) [next[index], next[other]] = [next[other], next[index]]; return next })
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (saving || !title.trim() || invalidCount || selected.length > 5000 || destination === 'vk' && !connected) return
    setSubmitted(true); setLocalError('')
    try { const saved = await onSave({ title: title.trim(), description: description.trim(), trackIds: selected, destination }); if (saved === false) setLocalError('VK не подтвердил сохранение. Плейлист оставлен в редакторе. Проверьте соединение и повторите.') }
    catch (reason) { setLocalError(reason instanceof Error ? reason.message : 'Не удалось сохранить плейлист. Проверьте подключение и повторите.') }
    finally { setSubmitted(false) }
  }
  const preview = selected.slice(0, 4).map(id => lookup.get(id)).filter((track): track is Track => Boolean(track))
  return <div className="playlist-composer-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !saving) onClose() }}>
    <div className="playlist-composer" role="dialog" aria-modal="true" aria-labelledby="playlist-composer-title" aria-busy={saving} ref={dialog}>
      <form onSubmit={save}>
        <header className="composer-header"><div><span className="eyebrow">ВАША МУЗЫКА, ВАШ ПОРЯДОК</span><h2 id="playlist-composer-title">{existing ? 'Редактировать плейлист' : 'Новый плейлист'}</h2></div><button className="icon-button" type="button" onClick={onClose} disabled={saving} aria-label="Закрыть создание плейлиста"><X size={20} /></button></header>
        <div className="composer-scroll">
          <section className="composer-identity">
            <div className={`composer-cover ${preview.length >= 4 ? 'is-mosaic' : ''}`} aria-hidden="true">{preview.length ? (preview.length >= 4 ? preview : preview.slice(0, 1)).map(track => <TrackArtwork key={track.id} track={track} className="composer-cover-tile" />) : <><Disc3 size={48} strokeWidth={1} /><span>PULSE MIX</span><i /><i /></>}</div>
            <div className="composer-fields"><label>Название<input name="playlist-title" placeholder="Например, после полуночи" maxLength={200} value={title} disabled={saving} onChange={event => setTitle(event.target.value)} required /></label><label>Описание <span>необязательно</span><textarea placeholder="Настроение, история или пара слов для себя" maxLength={2000} rows={2} value={description} disabled={saving} onChange={event => setDescription(event.target.value)} /></label></div>
          </section>
          {!existing && <div className="composer-destination" aria-label="Где сохранить плейлист"><button type="button" aria-pressed={destination === 'vk'} className={destination === 'vk' ? 'active' : ''} onClick={() => setDestination('vk')} disabled={saving || !connected}><Cloud size={17} /><span><strong>В VK и плеере</strong><small>Синхронизация с аккаунтом</small></span>{destination === 'vk' && <Check size={16} />}</button><button type="button" aria-pressed={destination === 'local'} className={destination === 'local' ? 'active' : ''} onClick={() => setDestination('local')} disabled={saving}><HardDrive size={17} /><span><strong>На компьютере</strong><small>Локальные файлы и музыка VK</small></span>{destination === 'local' && <Check size={16} />}</button></div>}
          {destination === 'vk' && <p className="composer-sync-note"><Cloud size={14} />{existing ? 'Название, описание, состав и порядок сохранятся в VK.' : 'Плейлист появится в вашем VK после подтверждения сохранения.'} В плейлист можно выбрать треки из своей музыки VK.</p>}
          <div className="composer-columns">
            <section className="composer-selection" aria-label="Порядок треков"><div className="composer-section-heading"><h3><ListMusic size={17} />В плейлисте <span>{selected.length}</span></h3><small>{duration ? `${Math.floor(duration / 60)} мин` : 'Соберите своё настроение'}</small></div>
              <div className="composer-track-scroll">{selected.length === 0 ? <div className="composer-empty"><ListMusic size={29} strokeWidth={1.3} /><strong>Начните с любимого трека</strong><p>Добавляйте музыку справа.<br />Порядок можно поменять в любой момент.</p></div> : selected.map((id, index) => { const track = lookup.get(id); return <div className={`composer-selected-row ${eligible(track) ? '' : 'is-unavailable'}`} key={id}><span className="composer-track-number">{index + 1}</span>{track && <TrackArtwork track={track} className="composer-track-art" />}<div className="composer-track-copy"><strong>{track?.title || 'Недоступный трек'}</strong><small>{track?.artist || 'Удалите его перед сохранением'}</small></div><div className="composer-order-actions"><button type="button" className="icon-button" disabled={saving || index === 0} onClick={() => move(index, -1)} aria-label={`Поднять ${track?.title || 'трек'}`}><ArrowUp size={14} /></button><button type="button" className="icon-button" disabled={saving || index === selected.length - 1} onClick={() => move(index, 1)} aria-label={`Опустить ${track?.title || 'трек'}`}><ArrowDown size={14} /></button></div><button type="button" className="icon-button composer-remove" disabled={saving} onClick={() => setSelected(ids => ids.filter(value => value !== id))} aria-label={`Убрать ${track?.title || 'трек'} из плейлиста`}><X size={15} /></button></div> })}</div>
              {invalidCount > 0 && <div className="composer-warning" role="status">{invalidCount} треков нельзя сохранить в этот плейлист. Добавьте их в свою музыку VK или уберите из списка.<button type="button" disabled={saving} onClick={() => setSelected(ids => ids.filter(id => eligible(lookup.get(id))))}>Убрать недоступные</button></div>}
            </section>
            <section className="composer-library" aria-label="Добавить треки"><div className="composer-section-heading"><h3>Добавить музыку</h3><small>{matching.length}</small></div><label className="composer-search"><Search size={16} /><input aria-label="Найти трек для плейлиста" placeholder="Название или исполнитель" value={query} disabled={saving} onChange={event => { setQuery(event.target.value); setLimit(60) }} />{query && <button type="button" className="icon-button" onClick={() => { setQuery(''); setLimit(60) }} aria-label="Очистить поиск"><X size={14} /></button>}</label>
              <div className="composer-track-scroll">{matching.slice(0, limit).map(track => <button type="button" className="composer-library-row" key={track.id} disabled={saving || !eligible(track) || selected.length >= 5000} title={!eligible(track) ? destination === 'vk' ? 'Сначала добавьте трек в свою музыку VK' : 'Трек недоступен' : `Добавить ${track.title}`} onClick={() => setSelected(ids => ids.includes(track.id) ? ids : [...ids, track.id])}><TrackArtwork track={track} className="composer-track-art" /><span className="composer-track-copy"><strong>{track.title}</strong><small>{track.artist}</small></span><span className="composer-duration">{time(track.duration)}</span><Plus size={16} /></button>)}{matching.length === 0 && <div className="composer-empty"><Search size={25} strokeWidth={1.3} /><strong>{query ? 'Ничего не найдено' : 'Все треки уже в плейлисте'}</strong><p>{query ? 'Попробуйте другое название или исполнителя.' : 'Можно сохранить плейлист или изменить порядок.'}</p></div>}{matching.length > limit && <button type="button" className="composer-show-more" disabled={saving} onClick={() => setLimit(value => value + 60)}>Показать ещё {Math.min(60, matching.length - limit)}</button>}</div>
            </section>
          </div>
        </div>
        <footer className="composer-footer"><div className={error || localError ? 'composer-error' : 'composer-footer-note'} role={error || localError ? 'alert' : 'status'}>{error || localError || (saving ? 'Сохраняем и проверяем содержимое плейлиста…' : destination === 'vk' ? 'Сохранение подтвердится после ответа VK.' : 'Плейлист сохранится на этом компьютере.')}</div><button type="button" className="secondary-button" disabled={saving} onClick={onClose}>Отмена</button><button className="primary-button" type="submit" disabled={saving || !title.trim() || invalidCount > 0 || selected.length > 5000 || destination === 'vk' && !connected}>{saving ? <LoaderCircle className="spin" size={16} /> : destination === 'vk' ? <Cloud size={16} /> : <Check size={16} />}{saving ? 'Сохраняем…' : existing ? 'Сохранить изменения' : 'Создать плейлист'}</button></footer>
      </form>
    </div>
  </div>
}
