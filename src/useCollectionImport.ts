import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { PersistedState, Track } from './shared/contracts'
import type { ServicePlaylistSource } from './shared/serviceImports'
import { collectionTrackIds, matchImportedEntry, MAX_IMPORTED_COLLECTIONS, MAX_IMPORTED_ENTRIES, normalizeCollections, recordingIndex, type ImportedCollection } from './shared/collectionImports'
import { normalizeRecordingText } from './shared/sourceMatching'
import { mergeTracks } from './state'

export function useCollectionImport(state: PersistedState, setState: Dispatch<SetStateAction<PersistedState>>, accountId?: number) {
  const latest = useRef(state); latest.current = state
  const account = useRef(accountId); account.current = accountId
  const run = useRef(0), pending = useRef(false)
  const checkpoint = useRef<() => void>(() => {})
  const [busy, setBusy] = useState(false), [progress, setProgress] = useState(''), [error, setError] = useState('')
  useEffect(() => { run.current++; pending.current = false; setBusy(false); setProgress(''); return () => { run.current++ } }, [accountId])
  const cancel = () => { checkpoint.current(); run.current++; pending.current = false; setBusy(false); setProgress('Остановлено. Полученные совпадения сохранены; можно продолжить.') }
  async function importCollection(source: ServicePlaylistSource) {
    if (pending.current) throw new Error('Дождитесь текущего импорта или остановите его.')
    pending.current = true; setBusy(true); setError(''); const ticket = ++run.current, expectedAccount = account.current
    const valid = () => ticket === run.current && account.current === expectedAccount
    const prior = latest.current.serviceImports?.find(r => r.id === `${source.service}:${source.sourceId}` && r.accountId === expectedAccount)
    if (prior?.complete && !source.complete) { pending.current = false; setBusy(false); throw new Error('Сервис вернул неполный список. Предыдущая полная коллекция сохранена; повторите чтение позднее.') }
    const previousRows = new Map(prior?.entries.map(e => [`${e.position}:${e.sourceId}`, e]) || [])
    const retained = (latest.current.serviceImports || []).filter(r => r.id !== `${source.service}:${source.sourceId}`)
    if (retained.length >= MAX_IMPORTED_COLLECTIONS || source.entries.length > 20_000 || retained.reduce((count, r) => count + r.entries.length, 0) + source.entries.length > MAX_IMPORTED_ENTRIES) {
      pending.current = false; setBusy(false)
      throw new Error('Предел хранения импорта: 100 коллекций и 50 000 записей суммарно, до 20 000 в одной коллекции. Уже сохранённые списки не изменены.')
    }
    // A saved report may belong to another VK account. Only unchanged rows
    // from the same account may reuse a previously confirmed source.
    const [record] = normalizeCollections([{ ...source, entries: source.entries.map(entry => ({ ...entry, trackId: undefined, resolution: 'pending', message: undefined })), importedAt: Date.now(), accountId: expectedAccount }])
    if (!record) { pending.current = false; setBusy(false); throw new Error('В коллекции нет допустимых метаданных.') }
    record.remotePlaylistId = prior?.remotePlaylistId
    const knownIds = new Set(latest.current.tracks.map(track => track.id))
    record.entries = record.entries.map(entry => { const old = previousRows.get(`${entry.position}:${entry.sourceId}`); const identity = (row: typeof entry) => JSON.stringify([row.title, row.artists, row.duration, row.isrc || '', row.explicit]); return old?.trackId && identity(old) === identity(entry) && knownIds.has(old.trackId) ? { ...entry, trackId: old.trackId, resolution: 'matched' } : entry })
    const persist = (tracks: Track[] = []) => {
      if (!valid()) return
      const saved = { ...record, entries: record.entries.map(e => ({ ...e })) }
      const ids = collectionTrackIds(saved), playlistId = `import-${record.id}`
      setState(previous => account.current !== expectedAccount ? previous : ({ ...previous, tracks: tracks.length ? mergeTracks(previous.tracks, tracks) : previous.tracks,
        serviceImports: [...(previous.serviceImports || []).filter(r => r.id !== saved.id), saved],
        playlists: [...previous.playlists.filter(p => p.id !== playlistId), { id: playlistId, title: `${source.service === 'spotify' ? 'Spotify' : 'Яндекс Музыка'} / ${record.title}`, trackIds: ids, createdAt: prior?.importedAt || saved.importedAt, description: 'Порядок исходной коллекции. Ненайденные записи сохранены в отчёте импорта.' }] }))
    }
    const discovered = new Map<string, Track>()
    checkpoint.current = () => persist([...discovered.values()])
    persist()
    try {
      const own = latest.current.tracks.filter(t => t.source === 'local' || t.remote?.inLibrary !== false), index = recordingIndex(own)
      const memo = new Map<string, ReturnType<typeof matchImportedEntry>>(); let failures = 0
      let bufferedTracks: Track[] = [], lastCheckpoint = performance.now()
      for (let i = 0; i < record.entries.length && valid(); i++) {
        if (i % 25 === 0) { setProgress(`${record.title}: ${i + 1} из ${record.entries.length}`); await new Promise(resolve => setTimeout(resolve, 0)); if (!valid()) break }
        const entry = record.entries[i]
        if (entry.trackId) continue
        const key = JSON.stringify([entry.title, entry.artists, entry.duration, entry.isrc, entry.explicit])
        let result = memo.get(key) || matchImportedEntry(entry, index.get(normalizeRecordingText(entry.title)) || [])
        if (!result.track && !memo.has(key) && expectedAccount && window.desktop?.searchVk) {
          try {
            const candidates = await window.desktop.searchVk(`${entry.artists.join(', ')} ${entry.title}`)
            if (!valid()) break
            result = matchImportedEntry(entry, candidates); failures = 0
            // No speculative parallel requests while audio is playing.
            await new Promise(resolve => setTimeout(resolve, 350))
          } catch { failures++; entry.resolution = 'pending'; entry.message = 'Поиск временно недоступен. Повторите позже.'; persist(bufferedTracks); bufferedTracks = []; if (failures >= 3) throw new Error('Поиск VK временно недоступен. Импорт остановлен; сохранённый список можно продолжить позже.'); continue }
        }
        if (!valid()) break
        memo.set(key, result)
        entry.trackId = result.track?.id; entry.resolution = result.track ? 'matched' : result.review ? 'review' : expectedAccount ? 'missing' : 'pending'
        entry.message = result.track ? undefined : result.review ? 'Несколько версий или не хватает данных для точного выбора.' : expectedAccount ? 'Точного совпадения в доступных результатах VK нет.' : 'Подключите VK для поиска доступного источника.'
        if (result.track && !knownIds.has(result.track.id)) { bufferedTracks.push(result.track); discovered.set(result.track.id, result.track); knownIds.add(result.track.id) }
        if (performance.now() - lastCheckpoint >= 1500) { persist(bufferedTracks); bufferedTracks = []; lastCheckpoint = performance.now() }
      }
      persist(bufferedTracks)
      if (valid()) { const matched = collectionTrackIds(record).length; setProgress(`Сохранено ${record.entries.length} записей, доступный источник найден для ${matched}. Остальные сохранены для проверки.`) }
    } catch (reason) { if (valid()) { persist([...discovered.values()]); setError(reason instanceof Error ? reason.message : 'Импорт прерван. Данные сохранены.') } }
    finally { if (valid()) { checkpoint.current = () => {}; pending.current = false; setBusy(false) } }
  }
  return { busy, progress, error, importCollection, cancel }
}
