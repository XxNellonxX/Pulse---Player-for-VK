import { useEffect, useId, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { CloudOff, LoaderCircle, Radio, Wifi, WifiOff } from 'lucide-react'
import { normalizeBufferedRanges, type BufferedRange, type PlaybackNetwork } from './buffering'
import './BufferedSeekbar.css'

const clock = (seconds: number) => `${Math.floor(Math.max(0, seconds) / 60)}:${Math.floor(Math.max(0, seconds) % 60).toString().padStart(2, '0')}`
type Props = { trackId?: string; position: number; duration: number; buffered?: BufferedRange[]; bufferedAhead?: number; network?: PlaybackNetwork; buffering: boolean; onSeek: (position: number) => void }

export function BufferedSeekbar({ trackId, position, duration, buffered = [], bufferedAhead = 0, network = 'idle', buffering, onSeek }: Props) {
  const [preview, setPreview] = useState<number | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [focused, setFocused] = useState(false)
  const dragging = useRef(false)
  const previewRef = useRef<number | null>(null)
  const hintId = useId()
  const total = Number.isFinite(duration) && duration > 0 ? duration : 0
  const safePosition = Number.isFinite(position) ? Math.max(0, Math.min(position, total)) : 0
  const shown = preview ?? safePosition
  const ranges = normalizeBufferedRanges(buffered, total)
  const percent = total > 0 ? Math.min(100, shown / total * 100) : 0
  const stalled = buffering || network === 'stalled' || network === 'recovering' || network === 'offline'
  const label = network === 'offline' ? 'Нет подключения' : network === 'recovering' ? 'Восстанавливаем поток' : buffering || network === 'stalled' ? 'Ожидаем аудио' : network === 'error' ? 'Ошибка загрузки' : bufferedAhead >= 1 ? `В буфере ${clock(bufferedAhead)}` : network === 'loading' ? 'Загружаем аудио' : ranges.length ? 'Аудио загружено' : 'Буфер пока пуст'
  const Icon = network === 'offline' ? WifiOff : network === 'error' ? CloudOff : network === 'recovering' || buffering ? LoaderCircle : bufferedAhead >= 1 || ranges.length ? Wifi : Radio
  const stagePreview = (value: number) => { previewRef.current = value; setPreview(value) }
  const commit = (value: number) => { const safe = Math.max(0, Math.min(total, value)); stagePreview(safe); onSeek(safe) }
  const point = (event: PointerEvent<HTMLInputElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return Math.max(0, Math.min(total, (event.clientX - rect.left) / Math.max(1, rect.width) * total))
  }
  useEffect(() => { dragging.current = false; previewRef.current = null; setPreview(null); setHover(null) }, [trackId])
  useEffect(() => {
    if (preview === null || dragging.current) return
    if (Math.abs(position - preview) < .5) { previewRef.current = null; setPreview(null); return }
    const timer = setTimeout(() => { previewRef.current = null; setPreview(null) }, 2000)
    return () => clearTimeout(timer)
  }, [preview, position])
  return <div className={`buffered-progress ${stalled ? 'is-waiting' : ''} network-${network}`}>
    <div className="progress-wrap buffered-progress-row"><span className="seek-clock">{clock(shown)}</span>
      <div className={`buffered-seekbar ${focused || hover !== null || preview !== null ? 'is-engaged' : ''}`} style={{ '--seek-position': `${percent}%` } as CSSProperties}>
        <div className="seek-rail" aria-hidden="true"><div className="seek-buffer-ranges">{ranges.map(([start, end], index) => <i key={index} className="seek-buffer-segment" style={{ left: `${start / total * 100}%`, width: `${(end - start) / total * 100}%` }} />)}</div><div className="seek-played" /><div className="seek-playhead" /></div>
        {(hover !== null || focused || preview !== null) && total > 0 && <span className="seek-preview" aria-hidden="true" style={{ left: `${Math.max(0, Math.min(100, (preview ?? hover ?? shown) / total * 100))}%` }}>{clock(preview ?? hover ?? shown)}</span>}
        <input className="seek-input" aria-label="Позиция воспроизведения" aria-describedby={hintId} aria-valuetext={`${clock(shown)} из ${clock(total)}`} type="range" min={0} max={total || .1} step="0.1" value={Math.min(shown, total || .1)} disabled={!total}
          onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
          onPointerMove={event => setHover(point(event))} onPointerLeave={() => setHover(null)}
          onPointerDown={event => { dragging.current = true; previewRef.current = Number(event.currentTarget.value); event.currentTarget.setPointerCapture?.(event.pointerId) }}
          onPointerUp={event => { if (!dragging.current) return; dragging.current = false; commit(Number(event.currentTarget.value)) }}
          onPointerCancel={() => { dragging.current = false; previewRef.current = null; setPreview(null); setHover(null) }}
          onChange={event => { const value = Number(event.target.value); stagePreview(value); if (!dragging.current) onSeek(value) }}
          onKeyDown={event => {
            const delta = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 5 : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -5 : event.key === 'PageUp' ? 30 : event.key === 'PageDown' ? -30 : 0
            if (delta || event.key === 'Home' || event.key === 'End') { event.preventDefault(); commit(event.key === 'Home' ? 0 : event.key === 'End' ? total : shown + delta) }
          }} />
      </div><span className="seek-clock">{total > 0 ? clock(total) : '—:—'}</span>
    </div>
    <div className="buffer-status" id={hintId} title={`${label}. Светлая полоса — уже загруженные участки. Стрелки изменяют позицию на пять секунд.`}><Icon size={10} className={network === 'recovering' || buffering ? 'spin' : ''} /><span>{label}</span></div>
  </div>
}
