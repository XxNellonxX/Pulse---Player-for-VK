import { useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle, Play, Radio, RefreshCw, Sparkles } from 'lucide-react'
import type { PersistedState, Track } from './shared/contracts'
import { pulseMix } from './recommendations'
import { TrackRow } from './TrackRow'
import './MixView.css'

export function MixView({ addedTrackIds, addingTrackIds, state, accountId, connected, playing, currentId, onPlay, onArtist, onAdd, onQueue, onInfo, onConnect }: { addedTrackIds?: Set<string>; addingTrackIds?: Set<string>; state: PersistedState; accountId?: number; connected: boolean; playing: boolean; currentId: string | null; onPlay: (track: Track, context: Track[]) => void; onArtist: (track: Track) => void; onAdd: (track: Track) => Promise<unknown>; onQueue: (track: Track) => void; onInfo: (track: Track) => void; onConnect: () => void }) {
  const [mode, setMode] = useState<'vk' | 'pulse'>('pulse'), [discovery, setDiscovery] = useState<Track[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState(''), [seed, setSeed] = useState(() => Math.floor(Date.now() / 86400000))
  const generation = useRef(0), pending = useRef(false)
  const [mixHistory, setMixHistory] = useState(state.history)
  useEffect(() => { generation.current++; pending.current = false; setDiscovery([]); setMixHistory(state.history); setError(''); setBusy(false); return () => { generation.current++ } }, [accountId, connected])
  const load = async () => {
    if (!connected || !window.desktop?.artistMusic || pending.current) return
    pending.current = true; setBusy(true); setError(''); const ticket = generation.current
    try { const result = await window.desktop.artistMusic({ action: 'recommendations', force: true }); if (ticket === generation.current) { setDiscovery(result.tracks || []); setError(result.message || '') } }
    catch (reason) { if (ticket === generation.current) setError(typeof reason === 'string' ? reason : 'VK не вернул рекомендации. В Pulse Mix доступна ваша коллекция.') }
    finally { if (ticket === generation.current) { pending.current = false; setBusy(false) } }
  }
  const items = useMemo(() => pulseMix(state.tracks, discovery, mixHistory, state.settings, seed), [state.tracks, discovery, mixHistory, state.settings.preferSoundCloud, seed])
  const tracks = mode === 'vk' ? discovery : items.map(row => row.track)
  const ownedIds = useMemo(() => new Set(state.tracks.filter(track => track.remote?.inLibrary === true).map(track => track.id)), [state.tracks])
  return <section className="mix-view"><div className="page-heading"><div><p className="eyebrow">ПОД ВАШ ВКУС</p><h1>Миксы</h1><p className="page-description">Знакомая музыка и новые находки без повторов подряд.</p></div><button className="secondary-button" disabled={busy || !connected} onClick={() => void load()}>{busy ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />} Получить рекомендации VK</button></div>
    <div className="mix-modes"><button className={mode === 'pulse' ? 'active' : ''} aria-pressed={mode === 'pulse'} onClick={() => setMode('pulse')}><Sparkles size={21} /><strong>Pulse Mix</strong><span>Ваша история, разнообразие артистов и открытия</span></button><button className={mode === 'vk' ? 'active' : ''} aria-pressed={mode === 'vk'} onClick={() => { setMode('vk'); if (!discovery.length) void load() }}><Radio size={21} /><strong>Для вас от VK</strong><span>Персональная подборка вашего аккаунта VK</span></button></div>
    {!connected && <div className="notice"><span>Подключите VK для новых рекомендаций. Pulse Mix уже использует сохранённую коллекцию.</span><button className="text-button" onClick={onConnect}>Подключить VK</button></div>}
    {error && <p className="mix-message" role="status">{error}</p>}
    <div className="panel-toolbar"><span>{tracks.length} треков {mode === 'pulse' && '/ баланс знакомого и нового'}</span><div className="toolbar-actions">{mode === 'pulse' && <button className="secondary-button" onClick={() => { setMixHistory(state.history); setSeed(value => value + 1) }}><RefreshCw size={15} /> Другой микс</button>}<button className="primary-button" disabled={!tracks.length} onClick={() => onPlay(tracks[0], tracks)}><Play size={16} /> Слушать</button></div></div>
    {tracks.length ? <div className="track-list" role="list">{tracks.map((track, index) => <div key={track.id}><TrackRow added={addedTrackIds?.has(track.id) || ownedIds.has(track.id)} adding={addingTrackIds?.has(track.id)} track={track} index={index} active={currentId === track.id} playing={currentId === track.id && playing} onPlay={() => onPlay(track, tracks)} onArtist={() => onArtist(track)} onQueue={() => onQueue(track)} onInfo={() => onInfo(track)} onAddVk={track.source === 'vk' && track.remote?.inLibrary === false ? () => { void onAdd(track) } : undefined} />{mode === 'pulse' && <small className="mix-reason">{items[index]?.reason}</small>}</div>)}</div> : <div className="empty-filter"><Radio size={26} /><strong>{busy ? 'VK подбирает музыку…' : 'Микс пока пуст'}</strong><span>{mode === 'vk' ? 'Нажмите «Получить рекомендации VK».' : 'Добавьте музыку или получите рекомендации VK.'}</span></div>}
    <p className="mix-footnote">Pulse Mix учитывает последние выбранные треки, избегает недавних повторов и распределяет исполнителей. Это локальный алгоритм; он не анализирует звук и не передаёт историю на сторонний сервер.</p>
  </section>
}
