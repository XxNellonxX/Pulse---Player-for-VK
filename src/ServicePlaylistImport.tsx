import { useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowDownToLine, Check, FileText, Library, Link2, LoaderCircle, LogIn, X } from 'lucide-react'
import { parseServiceExport, type ImportService, type ServiceImportStatus, type ServicePlaylistDescriptor, type ServicePlaylistSource } from './shared/serviceImports'
import './serviceImports.css'

type Props = { busy?: boolean; onImport: (source: ServicePlaylistSource) => Promise<void>; onCancel?: () => void }
const labels = { spotify: 'Spotify', yandex: 'Яндекс Музыка' }
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

/** Collection acquisition stays separate from matching and existing file/audio imports. */
export function ServicePlaylistImport({ busy = false, onImport, onCancel }: Props) {
  const [service, setService] = useState<ImportService>('spotify')
  const [url, setUrl] = useState('')
  const [status, setStatus] = useState<ServiceImportStatus | null>(null)
  const [collections, setCollections] = useState<ServicePlaylistDescriptor[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [preview, setPreview] = useState<ServicePlaylistSource | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [working, setWorking] = useState(false)
  const [phase, setPhase] = useState('')
  const operation = useRef(0)
  const fileInput = useRef<HTMLInputElement>(null)
  const disabled = working || busy
  const refresh = async () => { if (window.desktop?.serviceImportStatus) setStatus(await window.desktop.serviceImportStatus()) }
  useEffect(() => { void refresh().catch(() => {}); return () => { operation.current++ } }, [])

  const run = async (label: string, task: (epoch: number) => Promise<void>) => {
    if (disabled) return
    const epoch = ++operation.current
    setWorking(true); setError(''); setNotice(''); setPhase(label)
    try { await task(epoch) } catch (error) { if (operation.current === epoch) setError(message(error)) }
    finally { if (operation.current === epoch) { setWorking(false); setPhase('') } }
  }
  const cancel = () => {
    operation.current++; setWorking(false); setPhase(''); setNotice('Операция остановлена. Уже импортированные коллекции сохранены.')
    onCancel?.()
    void window.desktop?.cancelServiceImport?.().catch(() => {})
  }
  const readUrl = () => run('Читаем список треков…', async epoch => {
    if (!window.desktop?.readServicePlaylist) throw new Error('Чтение сервисов доступно в настольной версии Pulse.')
    const source = await window.desktop.readServicePlaylist(url.trim())
    if (operation.current === epoch) { setPreview(source); setService(source.service) }
  })
  const listCollections = async (epoch: number) => {
    if (!window.desktop?.listServicePlaylists) throw new Error('Обновите настольную версию Pulse для входа в сервис.')
    const list = await window.desktop.listServicePlaylists(service)
    if (operation.current === epoch) { setCollections(list); setSelected(new Set(list.map(item => item.sourceId))); setPreview(null) }
  }
  const connect = () => run(`Вход в ${labels[service]}…`, async epoch => {
    if (!window.desktop?.connectServiceImport) throw new Error('Вход в сервис доступен в настольной версии Pulse.')
    const status = await window.desktop.connectServiceImport({ service })
    if (operation.current !== epoch) return
    setStatus(status)
    if (status[service].connected) await listCollections(epoch)
  })
  const importPreview = () => run('Передаём коллекцию в библиотеку…', async epoch => {
    if (!preview) return
    await onImport(preview)
    if (operation.current === epoch) setNotice('Коллекция передана в библиотеку. Результаты поиска и недостающие треки показаны отдельно.')
  })
  const importSelected = () => run('Получаем выбранные коллекции…', async epoch => {
    if (!window.desktop?.readServicePlaylist) throw new Error('Чтение коллекций доступно в настольной версии Pulse.')
    const requested = collections.filter(item => selected.has(item.sourceId))
    const failures: string[] = []; let completed = 0
    for (const descriptor of requested) {
      if (operation.current !== epoch) return
      setPhase(`Коллекция ${completed + failures.length + 1} из ${requested.length}: ${descriptor.title}`)
      try {
        const source = await window.desktop.readServicePlaylist(descriptor.sourceUrl)
        if (operation.current !== epoch) return
        await onImport(source); completed++
      } catch (error) { failures.push(`${descriptor.title}: ${message(error)}`) }
    }
    if (operation.current === epoch) {
      setNotice(`Получено коллекций: ${completed} из ${requested.length}. Порядок треков каждого источника сохранён.`)
      if (failures.length) setError(failures.slice(0, 5).join('\n'))
    }
  })

  return <section className="service-collection-import" aria-label="Импорт музыкальной коллекции">
    <div className="service-import-heading"><div className="import-method-icon"><Library size={25} /></div><div><p className="eyebrow">ВАША КОЛЛЕКЦИЯ</p><h2>Из другого сервиса — в Pulse</h2><p>Любимые треки и плейлисты сохраняют порядок источника. Полные версии ищутся отдельно; неоднозначные совпадения требуют проверки.</p></div></div>
    <div className="service-import-tabs" role="group" aria-label="Сервис для импорта">{(['spotify', 'yandex'] as const).map(item => <button key={item} className={service === item ? 'active' : ''} disabled={disabled} onClick={() => { setService(item); setCollections([]); setSelected(new Set()); setPreview(null); setError(''); setNotice('') }}>{labels[item]}</button>)}</div>
    <div className="service-import-columns">
      <div className="service-import-account">
        <h3>Вся личная музыка</h3>
        <p>{status?.[service].message || (service === 'spotify' ? 'Подключите аккаунт, чтобы прочитать любимые треки и все ваши плейлисты.' : 'Подключите аккаунт Яндекса, чтобы прочитать личную коллекцию, если сервис предоставляет доступ. Публичные списки и экспорт доступны отдельно.')}</p>
        <div className="service-import-actions">
          {status?.[service].connected ? <><button className="secondary-button" disabled={disabled} onClick={() => void run('Получаем ваши плейлисты…', listCollections)}><Library size={16} />Мои коллекции</button><button className="text-button" disabled={disabled} onClick={() => void run('Отключаем аккаунт…', async () => { const status = await window.desktop?.disconnectServiceImport?.(service); if (status) setStatus(status); setCollections([]) })}>Отключить</button></>
            : <button className="secondary-button" disabled={disabled || status?.[service].configured === false} onClick={() => void connect()}><LogIn size={16} />Подключить {labels[service]}</button>}
        </div>
        {collections.length > 0 && <div className="service-collection-selection"><div><strong>Выберите коллекции</strong><button className="text-button" disabled={disabled} onClick={() => setSelected(selected.size === collections.length ? new Set() : new Set(collections.map(item => item.sourceId)))}>{selected.size === collections.length ? 'Снять все' : 'Выбрать все'}</button></div><ul>{collections.map(item => <li key={item.sourceId}><label><input type="checkbox" checked={selected.has(item.sourceId)} disabled={disabled} onChange={event => { const next = new Set(selected); if (event.target.checked) next.add(item.sourceId); else next.delete(item.sourceId); setSelected(next) }} /><span>{item.title}<small>{item.total === null ? 'Количество прочитается при импорте' : `${item.total} треков`}</small></span></label></li>)}</ul><button className="primary-button" disabled={disabled || !selected.size} onClick={() => void importSelected()}><ArrowDownToLine size={16} />Импортировать выбранные ({selected.size})</button></div>}
      </div>
      <div className="service-import-links"><h3>Плейлист по ссылке или экспорт</h3><form onSubmit={event => { event.preventDefault(); void readUrl() }}><label className="import-url-label">Ссылка на публичный плейлист<input type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder={service === 'spotify' ? 'https://open.spotify.com/playlist/…' : 'https://music.yandex.ru/users/…/playlists/…'} disabled={disabled} required /></label><button className="secondary-button" type="submit" disabled={disabled || !url.trim()}><Link2 size={16} />Прочитать плейлист</button></form><div className="service-export-file"><button className="secondary-button" disabled={disabled} onClick={() => fileInput.current?.click()}><FileText size={16} />Открыть экспорт CSV / JSON</button><input ref={fileInput} type="file" accept=".csv,.tsv,.json,text/csv,application/json" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; void run('Читаем экспорт коллекции…', async epoch => { if (file.size > 8 * 1024 * 1024) throw new Error('Экспорт больше 8 МБ. Разделите его на части.'); const source = parseServiceExport(await file.text(), service, file.name); if (operation.current === epoch) setPreview(source) }) }} /><small>Нужны колонки названия и исполнителя. Повторы и исходная последовательность сохраняются. Это список музыки, а не загрузка защищённого аудио.</small></div></div>
    </div>
    {working && <div className="service-import-status" role="status"><LoaderCircle className="spin" size={18} /><span>{phase}</span><button className="icon-button" aria-label="Остановить получение коллекции" onClick={cancel}><X size={17} /></button></div>}
    {error && <div className="service-import-error" role="alert"><AlertCircle size={18} /><span>{error}</span><button className="icon-button" aria-label="Закрыть ошибку импорта" onClick={() => setError('')}><X size={16} /></button></div>}
    {notice && <div className="service-import-status" role="status"><Check size={18} /><span>{notice}</span><button className="icon-button" aria-label="Закрыть результат импорта" onClick={() => setNotice('')}><X size={16} /></button></div>}
    {preview && <div className="service-import-preview"><div><strong>{preview.title || 'Плейлист'}</strong><span>{labels[preview.service]} · Получено {preview.entries.length}{preview.total === null ? '' : ` из ${preview.total}`} · {preview.complete ? 'Список получен полностью' : 'Получена часть списка'}</span></div>{preview.warnings.length > 0 && <ul>{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}<ol>{preview.entries.slice(0, 6).map(entry => <li key={`${entry.position}-${entry.sourceId}`}><span>{entry.position + 1}</span><div><strong>{entry.title}</strong><small>{entry.artists.join(', ')}</small></div></li>)}</ol>{preview.entries.length > 6 && <p>И ещё {preview.entries.length - 6} треков в исходном порядке.</p>}<button className="primary-button" disabled={disabled || !preview.entries.length} onClick={() => void importPreview()}><ArrowDownToLine size={16} />{preview.complete ? 'Импортировать коллекцию' : `Импортировать доступные (${preview.entries.length})`}</button></div>}
  </section>
}
