import { useState } from 'react'
import { Check, Info, ListMusic, LoaderCircle, Mic2, MoreHorizontal, Pause, Play, Plus, Trash2, Upload } from 'lucide-react'
import type { Track } from './shared/contracts'
import { TrackArtwork } from './TrackArtwork'

type Props = { track: Track; index: number; active: boolean; playing: boolean; onPlay: () => void; onArtist: () => void; onInfo: () => void; onQueue: () => void; onRemove?: () => void; removeDisabled?: boolean; removeLabel?: string; onAddPlaylist?: () => void; onAddVk?: () => void; adding?: boolean; added?: boolean }
export function TrackRow({ track, active, playing, onPlay, onArtist, onInfo, onQueue, onRemove, removeDisabled, removeLabel, onAddPlaylist, onAddVk, adding, added }: Props) {
  const [open, setOpen] = useState(false)
  const duration = Math.floor(track.duration / 60) + ':' + Math.floor(track.duration % 60).toString().padStart(2, '0')
  const saved = added || track.source === 'vk' && track.remote?.inLibrary !== false
  return <div className={`track-row ${active ? 'active' : ''}`} role="listitem">
    <button className="track-index" onClick={onPlay} aria-label={`${playing ? 'Пауза' : 'Воспроизвести'} ${track.title}`}>
      <TrackArtwork track={track}><span className={`track-cover-overlay ${active ? 'is-active' : ''}`}>{playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</span></TrackArtwork>
    </button>
    <div className="track-meta"><button className="track-title-button" onClick={onPlay} title={track.title}><strong>{track.title}</strong></button><span className="track-details"><button className="artist-link" onClick={onArtist} title={`Найти в VK: ${track.artist}`}>{track.artist}</button>{track.album && track.album !== 'Без альбома' && <span className="track-album">{track.album}</span>}</span></div>
    <span className="track-source">{track.source === 'vk' ? 'VK' : 'Локально'}</span><span className="track-duration">{duration}</span>
    <div className="track-actions">{adding ? <button className="icon-button track-add" disabled aria-label="Сохраняем в VK"><LoaderCircle size={17} className="spin" /></button> : saved ? <span className="track-saved" title="В вашей музыке VK" aria-label="В вашей музыке VK"><Check size={15} /></span> : onAddVk ? <button className="icon-button track-add" onClick={onAddVk} aria-label={track.source === 'local' ? 'Загрузить в VK' : 'Добавить в мою музыку VK'} title={track.source === 'local' ? 'Загрузить в VK' : 'Добавить в мою музыку VK'}><Plus size={17} /></button> : null}
      {onRemove && <button className="icon-button track-delete" onClick={onRemove} disabled={removeDisabled} aria-label={removeLabel || 'Удалить трек'} title={removeDisabled ? 'Подключите VK и дождитесь окончания операции' : removeLabel || 'Удалить трек'}><Trash2 size={16} /></button>}
      <div className="more-wrap"><button className="icon-button row-action" onClick={() => setOpen(value => !value)} aria-label="Дополнительные действия" aria-expanded={open}><MoreHorizontal size={18} /></button>{open && <div className="context-menu"><button onClick={() => { onPlay(); setOpen(false) }}><Play size={14} /> Воспроизвести</button><button onClick={() => { onInfo(); setOpen(false) }}><Info size={14} /> Информация о треке</button><button onClick={() => { onArtist(); setOpen(false) }}><Mic2 size={14} /> Открыть исполнителя</button><button onClick={() => { onQueue(); setOpen(false) }}><ListMusic size={14} /> В очередь</button>{onAddPlaylist && <button onClick={() => { onAddPlaylist(); setOpen(false) }}><Plus size={14} /> В плейлист</button>}{onAddVk && !saved && <button disabled={adding} onClick={() => { onAddVk(); setOpen(false) }}><Upload size={14} /> {track.source === 'local' ? 'Загрузить в VK' : 'В мою музыку VK'}</button>}{onRemove && <button className="danger" disabled={removeDisabled} onClick={() => { onRemove(); setOpen(false) }}><Trash2 size={14} /> {removeLabel || 'Удалить'}</button>}</div>}</div>
    </div>
  </div>
}
