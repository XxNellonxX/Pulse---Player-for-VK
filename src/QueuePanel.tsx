import { useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ListMusic, Trash2, X } from 'lucide-react'
import type { Track } from './shared/contracts'
import './QueuePanel.css'

const ROW_HEIGHT = 52
const OVERSCAN = 5

type Props = {
  open: boolean; tracks: Track[]; currentIndex: number; currentId: string | null; playing: boolean
  onClose: () => void; onPlay: (track: Track) => void; onRemove: (id: string) => void
  onMove: (index: number, direction: -1 | 1) => void; onClear: () => void
}

export function QueuePanel({ open, tracks, currentIndex, currentId, playing, onClose, onPlay, onRemove, onMove, onClear }: Props) {
  const list = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ top: 0, height: 500 })
  const hasTracks = tracks.length > 0

  useLayoutEffect(() => {
    const element = list.current
    if (!open || !element) return
    // Reopening starts beside the current track, even in a large collection.
    // While open, queue edits preserve the user's own scroll position.
    element.scrollTop = currentIndex >= 0 ? Math.max(0, (currentIndex + .5) * ROW_HEIGHT - element.clientHeight / 2) : 0
    const measure = () => setViewport({ top: element.scrollTop, height: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [open, hasTracks])

  useLayoutEffect(() => {
    const element = list.current
    if (open && element) setViewport({ top: element.scrollTop, height: element.clientHeight })
  }, [open, tracks.length])

  if (!open) return <aside className="queue-panel" aria-hidden="true" />
  const start = Math.max(0, Math.min(tracks.length - 1, Math.floor(viewport.top / ROW_HEIGHT) - OVERSCAN))
  const end = Math.min(tracks.length, Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT) + OVERSCAN)

  return <aside className="queue-panel open queue-panel-virtual" aria-hidden="false">
    <div className="queue-header"><div><p className="eyebrow">СЕЙЧАС ИГРАЕТ</p><h2>Очередь <span>{tracks.length}</span></h2></div><button className="icon-button" onClick={onClose} aria-label="Закрыть очередь"><X size={19} /></button></div>
    {tracks.length ? <>
      <div ref={list} className="queue-list queue-list-virtual" role="list" aria-label="Треки в очереди" tabIndex={0} onScroll={event => setViewport({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}>
        <div className="queue-virtual-space" style={{ height: tracks.length * ROW_HEIGHT }}>
          {tracks.slice(start, end).map((track, offset) => {
            const index = start + offset
            return <div className={`queue-row ${track.id === currentId ? 'active' : ''}`} key={track.id} role="listitem" aria-posinset={index + 1} aria-setsize={tracks.length} style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}>
              <span className="queue-number">{index === currentIndex && playing ? <span className="equalizer"><i /><i /><i /></span> : String(index + 1).padStart(2, '0')}</span>
              <button className="queue-track" onClick={() => onPlay(track)}><strong>{track.title}</strong><span>{track.artist}</span></button>
              <div className="queue-row-actions"><button className="icon-button tiny-action" disabled={index === 0} onClick={() => onMove(index, -1)} aria-label="Выше"><ArrowUp size={14} /></button><button className="icon-button tiny-action" disabled={index === tracks.length - 1} onClick={() => onMove(index, 1)} aria-label="Ниже"><ArrowDown size={14} /></button><button className="icon-button tiny-action" onClick={() => onRemove(track.id)} aria-label="Удалить"><X size={14} /></button></div>
            </div>
          })}
        </div>
      </div>
      <button className="clear-queue" onClick={onClear}><Trash2 size={15} /> Очистить очередь</button>
    </> : <div className="queue-empty"><ListMusic size={28} /><strong>Очередь пуста</strong><span>Добавьте треки из библиотеки, чтобы начать.</span></div>}
  </aside>
}
