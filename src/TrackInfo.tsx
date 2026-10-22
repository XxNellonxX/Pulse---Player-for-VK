import { useEffect, useRef } from 'react'
import { Mic2, X } from 'lucide-react'
import type { Track } from './shared/contracts'
import { TrackArtwork } from './TrackArtwork'
import { SoundCloudTrackSource } from './SoundCloudSources'

export function TrackInfo({ track, onClose, onArtist, onSourceChanged, preferExplicit, sourceLabel }: { track: Track; onClose: () => void; onArtist: () => void; onSourceChanged?: () => void; preferExplicit?: boolean; sourceLabel?: string }) {
  const dialog = useRef<HTMLElement>(null)
  useEffect(() => {
    const element = dialog.current
    if (!element) return
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const buttons = [...element.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]')]
      const first = buttons[0], last = buttons.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    element.addEventListener('keydown', trap)
    return () => element.removeEventListener('keydown', trap)
  }, [])
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><section ref={dialog} className="modal-card track-info-card" role="dialog" aria-modal="true" aria-labelledby="track-info-title"><div className="modal-header"><div><p className="eyebrow">ИНФОРМАЦИЯ О ТРЕКЕ</p><h2 id="track-info-title">{track.title}</h2></div><button autoFocus className="icon-button" onClick={onClose} aria-label="Закрыть информацию о треке"><X size={19} /></button></div><div className="track-info-main"><TrackArtwork track={track} className="track-info-art" /><dl><dt>Исполнитель</dt><dd><button className="artist-link" onClick={onArtist}>{track.artist}</button></dd>{track.album && track.album !== 'Без альбома' && <><dt>Альбом</dt><dd>{track.album}</dd></>}<dt>Длительность</dt><dd>{Math.floor(track.duration / 60)}:{Math.floor(track.duration % 60).toString().padStart(2, '0')}</dd><dt>Источник</dt><dd>{sourceLabel || (track.source === 'vk' ? 'VK' : 'Локальный файл')}</dd><dt>Доступность</dt><dd>{track.available ? 'Доступен' : track.source === 'vk' ? 'VK ограничил воспроизведение' : 'Файл недоступен'}</dd></dl></div><p className="page-description">{track.source === 'vk' ? 'Данные получены из VK при последнем обновлении.' : 'Данные прочитаны из файла.'}</p>{track.version && <p className="page-description">Версия: {track.version}</p>}{track.source === 'vk' && <SoundCloudTrackSource track={track} onChanged={onSourceChanged} preferExplicit={preferExplicit} />}<div className="modal-actions"><button className="secondary-button" onClick={onArtist}><Mic2 size={16} /> Найти исполнителя в VK</button><button className="primary-button" onClick={onClose}>Готово</button></div></section></div>
}
