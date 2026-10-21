import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Info, TriangleAlert, X } from 'lucide-react'
import './Notifications.css'
type Notice = { id: number; message: string; kind: 'success' | 'info' | 'error' }
export function useNotifications() {
  const [notices, setNotices] = useState<Notice[]>([])
  const next = useRef(0), timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())
  const dismiss = useCallback((id: number) => { clearTimeout(timers.current.get(id)); timers.current.delete(id); setNotices(items => items.filter(item => item.id !== id)) }, [])
  const notify = useCallback((message: string, kind: Notice['kind'] = 'info') => {
    const id = ++next.current
    setNotices(items => [...items.filter(item => item.message !== message), { id, message, kind }].slice(-3))
    timers.current.set(id, setTimeout(() => dismiss(id), 7000))
  }, [dismiss])
  useEffect(() => () => { for (const timer of timers.current.values()) clearTimeout(timer); timers.current.clear() }, [])
  return { notices, notify, dismiss }
}
export function Notifications({ notices, dismiss }: Pick<ReturnType<typeof useNotifications>, 'notices' | 'dismiss'>) {
  return <div className="notification-stack" aria-live="polite" aria-relevant="additions">{notices.map(notice => <div className={`notification-card notification-${notice.kind}`} key={notice.id} role="status">{notice.kind === 'error' ? <TriangleAlert size={18} /> : notice.kind === 'success' ? <Check size={18} /> : <Info size={18} />}<span>{notice.message}</span><button className="icon-button" onClick={() => dismiss(notice.id)} aria-label="Закрыть уведомление"><X size={16} /></button><i className="notification-lifetime" /></div>)}</div>
}
