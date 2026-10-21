import { useState } from 'react'
import { AlertCircle, Check, FileAudio, Link2, LoaderCircle, LogIn, Upload } from 'lucide-react'
import type { ImportProgress, UploadBatchResult } from './shared/contracts'

type Props = {
  connected: boolean
  busy: boolean
  progress: ImportProgress | null
  report: UploadBatchResult | null
  onFiles: () => void
  onUrl: (url: string, destination: 'vk' | 'local', proxy?: string) => void
  onConnect: () => void
}
const statusLabels = { uploaded: 'В VK', local: 'Локально', failed: 'Ошибка', uncertain: 'Нужно проверить', skipped: 'Пропущен' }

export function MusicUploadView({ connected, busy, progress, report, onFiles, onUrl, onConnect }: Props) {
  const [url, setUrl] = useState('')
  const [destination, setDestination] = useState<'vk' | 'local'>('vk')
  const [proxy, setProxy] = useState('')
  return <div className="music-import-view">
    {!connected && <div className="import-account-note"><LogIn size={20} /><div><strong>Подключите VK для загрузки в аккаунт</strong><p>После входа треки будут добавляться в вашу музыку VK и появляться в Pulse.</p></div><button className="secondary-button" onClick={onConnect} disabled={busy}>Войти в VK</button></div>}
    <div className="import-methods">
      <section className="import-method">
        <div className="import-method-icon"><Upload size={25} /></div>
        <p className="eyebrow">С КОМПЬЮТЕРА</p><h2>Ваши файлы — в вашей музыке</h2>
        <p>Выберите файлы. Pulse отправит их в ваш аккаунт VK и проверит добавление в библиотеку.</p>
        <button className="primary-button" onClick={onFiles} disabled={busy || !connected}><FileAudio size={17} />Выбрать аудио и загрузить</button>
        <small>MP3 передаётся без перекодирования. FLAC, WAV, M4A и другие аудиоформаты готовятся в MP3 320 кбит/с для VK. Исходные файлы сохраняются.</small>
      </section>
      <section className="import-method">
        <div className="import-method-icon soundcloud-icon"><Link2 size={25} /></div>
        <p className="eyebrow">ПО ССЫЛКЕ</p><h2>Нашли трек — добавьте сюда</h2>
        <p>Импортируйте доступный звук из SoundCloud, YouTube, Яндекс Музыки, Bandcamp и других поддерживаемых страниц. Можно вставить прямую ссылку на аудиофайл с любого публичного сайта.</p>
        <form onSubmit={event => { event.preventDefault(); if (!busy && url.trim()) onUrl(url.trim(), destination, proxy.trim() || undefined) }}>
          <label className="import-url-label">Ссылка на трек<input aria-label="Ссылка на трек" type="url" placeholder="https://…/artist-track.mp3" value={url} onChange={event => setUrl(event.target.value)} disabled={busy} required /></label>
          <label className="import-destination-label">Добавить<select aria-label="Куда добавить трек" value={destination} onChange={event => setDestination(event.target.value as 'vk' | 'local')} disabled={busy}><option value="vk">В VK и плеер</option><option value="local">Только локально</option></select></label>
          <p className="import-quality-note">{destination === 'vk' ? 'MP3 загружается без перекодирования. Другие форматы преобразуются в MP3 320 кбит/с для VK; качество не может стать выше исходного.' : 'Сохраняется лучшая доступная аудиодорожка без повторного сжатия.'}</p>
          <details className="import-network"><summary>Подключение к сервису</summary><p>Для извлечения аудио со страниц можно указать доверенный прокси. Прямые файлы используют системное подключение.</p><label className="import-url-label">Прокси<input aria-label="Прокси для импорта" type="password" autoComplete="off" placeholder="socks5://host:port" value={proxy} onChange={event => setProxy(event.target.value)} disabled={busy} /></label></details>
          <button className="secondary-button" type="submit" disabled={busy || !url.trim() || (destination === 'vk' && !connected)}><Link2 size={17} />Добавить по ссылке</button>
        </form>
        <small>Название и исполнитель сохраняются. Поиск замены в VK не используется. Spotify и другие сервисы с защищёнными потоками могут не выдавать полный файл по ссылке: превью и недоступное аудио не добавляются.</small>
      </section>
    </div>
    {busy && <div className="import-progress" role="status" aria-live="polite"><LoaderCircle className="spin" size={20} /><div><strong>{progress?.message || 'Подготавливаем загрузку…'}</strong>{progress && progress.total > 1 && <span>Файл {Math.min(progress.current, progress.total)} из {progress.total}</span>}</div></div>}
    {report && <section className="upload-report" role="status" aria-live="polite" aria-label="Результаты загрузки"><h2>Результаты загрузки</h2>{report.cancelled && <p>Выбор файлов отменён.</p>}{report.items.map((item, index) => <div className={`import-result import-result-${item.status}`} key={`${index}-${item.name}`}>
      {item.status === 'uploaded' || item.status === 'local' ? <Check size={19} /> : <AlertCircle size={19} />}<div><strong>{item.name}</strong><p>{item.message}</p></div><span>{statusLabels[item.status]}</span>
    </div>)}</section>}
  </div>
}
