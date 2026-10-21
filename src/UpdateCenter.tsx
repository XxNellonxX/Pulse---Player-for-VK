import { useEffect, useRef, useState } from 'react'
import { Bell, Check, Download, ExternalLink, LoaderCircle, RefreshCw, X } from 'lucide-react'
import type { AppRelease } from './shared/contracts'
import './UpdateCenter.css'

type Props = { onBeforeInstall?: () => Promise<void> }

export function UpdateCenter({ onBeforeInstall }: Props) {
  const [release, setRelease] = useState<AppRelease | null>(null)
  const [open, setOpen] = useState(false)
  const [checking, setChecking] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const requested = useRef(false)
  const inFlight = useRef(false)

  const check = async () => {
    if (!window.desktop?.checkAppRelease || inFlight.current) return
    requested.current = true; inFlight.current = true
    setChecking(true); setError('')
    try { setRelease(await window.desktop.checkAppRelease()) }
    catch (value) { setError(value instanceof Error ? value.message : 'Не удалось проверить обновления.') }
    finally { inFlight.current = false; setChecking(false) }
  }
  useEffect(() => {
    const timer = window.setTimeout(() => { if (!requested.current) void check() }, 4_000)
    return () => window.clearTimeout(timer)
  // The startup timer only schedules a single check for this mount.
  }, [])
  useEffect(() => {
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); root.current?.querySelector('button')?.focus() } }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape) }
  }, [])

  const openLink = async (url: string | null) => {
    if (!url || installing) return
    setInstalling(true); setError('')
    try {
      const target = new URL(url)
      if (target.protocol !== 'https:' || target.hostname !== 'github.com' || target.username || target.password || target.search || target.hash || !target.pathname.startsWith('/XxNellonxX/Pulse---Player-for-VK/releases/')) throw new Error('Не удалось подтвердить адрес релиза Pulse.')
      await onBeforeInstall?.()
      if (window.desktop?.openExternal) await window.desktop.openExternal(url)
      else window.open(url, '_blank', 'noopener,noreferrer')
    } catch (value) { setError(value instanceof Error ? value.message : 'Не удалось открыть страницу релиза.') }
    finally { setInstalling(false) }
  }
  const available = release?.available === true
  return <div className="update-center" ref={root}>
    <button type="button" className={`update-trigger ${available ? 'has-update' : ''}`} aria-label={available ? 'Доступно обновление Pulse' : 'Проверить обновления Pulse'} aria-expanded={open} onClick={() => { setOpen(value => !value); if (!requested.current) void check() }}>
      <Bell size={16} />{available && <i aria-hidden="true" />}
    </button>
    {open && <section className="update-popover" role="dialog" aria-label="Обновления Pulse">
      <div className="update-popover-heading"><div><span className="update-kicker">PULSE</span><h2>{available ? 'Доступно обновление' : 'Обновления'}</h2></div><button type="button" className="update-close" aria-label="Закрыть обновления" onClick={() => setOpen(false)}><X size={15} /></button></div>
      {checking && <p className="update-state"><LoaderCircle className="spin" size={15} /> Проверяем последнюю версию…</p>}
      {!checking && error && <div className="update-error" role="alert">{error}</div>}
      {!checking && !error && !release && <p className="update-state">Проверка доступна в приложении Pulse.</p>}
      {!checking && !error && release && !available && <p className="update-state"><Check size={15} />{release.latestVersion ? `Установлена последняя версия · ${release.currentVersion}` : `Версия ${release.currentVersion} · новых релизов пока нет`}</p>}
      {!checking && !error && available && <>
        <p className="update-version">v{release.currentVersion} <span>→</span> <strong>v{release.latestVersion}</strong></p>
        {release.notes && <div className="update-notes">{release.notes}</div>}
        <div className="update-actions">{release.downloadUrl && <button type="button" className="primary-button" onClick={() => void openLink(release.downloadUrl)} disabled={installing}><Download size={15} />{installing ? 'Сохраняем…' : 'Скачать обновление'}</button>}{release.releaseUrl && <button type="button" className="secondary-button" onClick={() => void openLink(release.releaseUrl)} disabled={installing}><ExternalLink size={15} /> Открыть релиз</button>}</div>
        <small className="update-footnote">Скачайте установщик и установите поверх старой версии. Библиотека и настройки сохранятся.</small>
      </>}
      <button type="button" className="update-refresh" onClick={() => void check()} disabled={checking}><RefreshCw size={13} className={checking ? 'spin' : ''} /> Проверить снова</button>
    </section>}
  </div>
}
