import { useState } from 'react'
import { ListMusic, Music2, Pause, Play, RefreshCw, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume2, X } from 'lucide-react'
import type { AppSettings, Track } from './shared/contracts'
import { TrackArtwork } from './TrackArtwork'
import { BufferedSeekbar } from './BufferedSeekbar'
import type { BufferedRange, PlaybackNetwork } from './buffering'

type Props = { current?: Track | null; playing: boolean; buffering: boolean; advertising: boolean; position: number; duration: number; buffered?: BufferedRange[]; bufferedAhead?: number; network?: PlaybackNetwork; volume: number; queueCount: number; canShuffle: boolean; shuffle: boolean; repeat: AppSettings['repeat']; onToggle: () => void; onPrevious: () => void; onNext: () => void; onSeek: (position: number) => void; onVolume: (volume: number) => void; onQueue: () => void; onShuffle: () => void; onRepeat: () => void; onArtist: () => void; onInfo: () => void; error: string; onRetry: () => void; onDismissError?: () => void }
export function PlayerBar({ current, playing, buffering, advertising, position, duration, buffered, bufferedAhead, network, volume, queueCount, canShuffle, shuffle, repeat, onToggle, onPrevious, onNext, onSeek, onVolume, onQueue, onShuffle, onRepeat, onArtist, onInfo, error, onRetry, onDismissError }: Props) {
  const [volumeOpen, setVolumeOpen] = useState(false)
  const repeatLabel = repeat === 'off' ? 'Повтор выключен' : repeat === 'all' ? 'Повтор всей очереди' : 'Повтор одного трека'
  return <div className="player-wrap">
    {advertising && <div className="player-info" role="status">VK воспроизводит рекламную вставку в официальном плеере.</div>}{error && <div className="player-error" role="alert"><span>{error}</span><button onClick={onRetry}>Повторить</button>{current?.source === 'vk' && <button onClick={onInfo}>Выбрать источник</button>}{onDismissError && <button className="player-error-dismiss" onClick={onDismissError} aria-label="Закрыть ошибку воспроизведения"><X size={14} /></button>}</div>}
    <div className="player-bar"><div className="now-playing">{current ? <><TrackArtwork track={current} className="now-cover" /><div className="now-meta"><button className="track-title-button" onClick={onInfo} title="Информация о треке"><strong>{current.title}</strong></button><button className="artist-link" onClick={onArtist} title={`Найти в VK: ${current.artist}`}>{current.artist}</button></div></> : <div className="no-track"><div className="now-cover"><Music2 size={17} /></div><span>Выберите трек</span></div>}</div>
      <div className="player-controls"><div className="transport">
        <button className={`player-button ${shuffle ? 'active' : ''}`} onClick={onShuffle} disabled={!canShuffle} aria-label="Перемешать всю мою музыку" aria-pressed={shuffle} title="Перемешать всю мою музыку"><Shuffle size={16} /></button>
        <button className="player-button" onClick={onPrevious} disabled={!current} aria-label="Предыдущий трек"><SkipBack size={18} fill="currentColor" /></button>
        <button className="play-button" onClick={onToggle} disabled={!current && !queueCount} aria-label={playing ? 'Пауза' : 'Воспроизвести'}>{buffering ? <RefreshCw size={19} className="spin" /> : playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}</button>
        <button className="player-button" onClick={onNext} disabled={!current} aria-label="Следующий трек"><SkipForward size={18} fill="currentColor" /></button>
        <button className={`player-button ${repeat !== 'off' ? 'active' : ''}`} onClick={onRepeat} aria-label={repeatLabel} aria-pressed={repeat !== 'off'} title={`${repeatLabel}. Нажмите, чтобы изменить`}>{repeat === 'one' ? <Repeat1 size={16} /> : <Repeat size={16} />}</button>
      </div><BufferedSeekbar trackId={current?.id} position={position} duration={duration} buffered={buffered} bufferedAhead={bufferedAhead} network={network} buffering={buffering} onSeek={onSeek} /></div>
      <div className="player-options"><div className={`volume-control ${volumeOpen ? 'expanded' : ''}`}><button className="player-button volume-button" aria-label="Открыть громкость" aria-expanded={volumeOpen} onClick={() => setVolumeOpen(value => !value)} title={`Громкость ${Math.round(volume * 100)}%`}><Volume2 size={17} /></button><input aria-label="Громкость" type="range" min={0} max={1} step="0.01" value={volume} onChange={event => onVolume(Number(event.target.value))} /></div><button className="queue-button" onClick={onQueue} aria-label={`Открыть очередь, ${queueCount} треков`}><ListMusic size={18} /><span>Очередь</span>{queueCount > 0 && <b>{queueCount}</b>}</button></div>
    </div>
  </div>
}
