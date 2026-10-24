import { useEffect, useRef, useState } from 'react'
import type { AutostartStatus } from './shared/contracts'

/** Reflect the OS registration directly; never reconcile a saved preference. */
export function AutostartSetting() {
  const [status, setStatus] = useState<AutostartStatus | null>(null)
  const [pending, setPending] = useState(true)
  const [error, setError] = useState('')
  const sequence = useRef(0)
  const mounted = useRef(false)
  const changing = useRef(false)
  const read = useRef<() => void>(() => {})
  useEffect(() => {
    mounted.current = true
    const refresh = () => {
      if (changing.current || document.visibilityState === 'hidden') return
      const api = window.desktop
      const ticket = ++sequence.current
      if (!api?.getAutostart || !api.setAutostart) { setStatus({ supported: false, enabled: false, requiresApproval: false, message: 'Автозапуск доступен в установленной настольной версии Pulse.' }); setPending(false); return }
      setPending(true)
      void api.getAutostart().then(value => {
        if (!mounted.current || sequence.current !== ticket) return
        setStatus(value); setError('')
      }).catch(reason => {
        if (mounted.current && sequence.current === ticket) setError(typeof reason === 'string' ? reason : 'Не удалось проверить системный автозапуск. Повторите проверку.')
      }).finally(() => { if (mounted.current && sequence.current === ticket) setPending(false) })
    }
    read.current = refresh
    refresh()
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => { mounted.current = false; ++sequence.current; read.current = () => {}; window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [])
  const change = async () => {
    const api = window.desktop
    if (!status?.supported || pending || changing.current || !api?.setAutostart) return
    changing.current = true; setPending(true); setError('')
    const ticket = ++sequence.current
    try {
      const value = await api.setAutostart(!status.enabled)
      if (mounted.current && sequence.current === ticket) setStatus(value)
    } catch (reason) {
      if (mounted.current && sequence.current === ticket) setError(typeof reason === 'string' ? reason : 'Не удалось изменить автозапуск. Проверьте разрешения системы и повторите действие.')
    } finally {
      changing.current = false
      if (mounted.current && sequence.current === ticket) setPending(false)
    }
  }
  return <div className="autostart-setting">
    <div className="setting-toggle"><div><strong>Запускать Pulse при входе в систему</strong><p>{pending ? 'Проверяем системный автозапуск…' : status?.message || 'Pulse будет открываться вместе с вашей системой.'}</p></div><button className={`toggle ${status?.enabled ? 'on' : ''}`} type="button" role="switch" aria-label="Запускать Pulse при входе в систему" aria-checked={Boolean(status?.enabled)} aria-busy={pending} disabled={pending || !status?.supported} onClick={() => void change()}><span /></button></div>
    {error && <div className="notice" role="alert"><span>{error}</span><button className="text-button" type="button" disabled={pending} onClick={() => read.current()}>Повторить проверку</button></div>}
  </div>
}
