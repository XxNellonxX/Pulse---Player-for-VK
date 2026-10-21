import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight } from 'lucide-react'

type Route = Record<string, unknown>
type Entry<T> = { key: string; route: T; scroll: number }
const equal = (first: Route, second: Route) => JSON.stringify(first) === JSON.stringify(second)

/** Browser history also receives native WebView2 Back/Forward mouse commands. */
export function useNavigationHistory<T extends Route>(route: T, restore: (route: T) => void) {
  const current = useRef(route), restoreRoute = useRef(restore)
  current.current = route; restoreRoute.current = restore
  const entries = useRef<Entry<T>[]>([]), cursor = useRef(0), restoring = useRef<string | null>(null)
  const cancelRestore = useRef<() => void>(() => {})
  const [available, setAvailable] = useState({ back: false, forward: false })
  const token = useRef(`pulse-${crypto.randomUUID()}`)
  const updateAvailable = () => setAvailable({ back: cursor.current > 0, forward: cursor.current < entries.current.length - 1 })
  useEffect(() => {
    const entry = { key: crypto.randomUUID(), route: current.current, scroll: 0 }
    entries.current = [entry]; cursor.current = 0
    history.replaceState({ pulse: token.current, key: entry.key }, '')
    const pop = (event: PopStateEvent) => {
      if (event.state?.pulse !== token.current) return
      const index = entries.current.findIndex(item => item.key === event.state.key)
      if (index < 0) return
      cancelRestore.current()
      cursor.current = index; restoring.current = entries.current[index].key
      restoreRoute.current(entries.current[index].route)
      updateAvailable()
    }
    const mouse = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return
      event.preventDefault(); event.stopPropagation()
      if (event.type !== 'mousedown') return
      if (event.button === 3 && cursor.current > 0) history.back()
      if (event.button === 4 && cursor.current < entries.current.length - 1) history.forward()
    }
    const keyboard = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return
      event.preventDefault()
      if (event.key === 'ArrowLeft' && cursor.current > 0) history.back()
      if (event.key === 'ArrowRight' && cursor.current < entries.current.length - 1) history.forward()
    }
    const rememberScroll = (event: Event) => {
      const element = event.target
      const entry = entries.current[cursor.current]
      // Capture while the old page still exists; a shorter next page can
      // clamp scrollTop before React's route effect runs.
      if (element instanceof HTMLElement && element.matches('.content-scroll') && entry && equal(current.current, entry.route) && !restoring.current) entry.scroll = element.scrollTop
    }
    window.addEventListener('popstate', pop)
    window.addEventListener('mousedown', mouse, true)
    window.addEventListener('mouseup', mouse, true)
    window.addEventListener('auxclick', mouse, true)
    window.addEventListener('keydown', keyboard)
    document.addEventListener('scroll', rememberScroll, true)
    return () => {
      window.removeEventListener('popstate', pop)
      window.removeEventListener('mousedown', mouse, true)
      window.removeEventListener('mouseup', mouse, true)
      window.removeEventListener('auxclick', mouse, true)
      window.removeEventListener('keydown', keyboard)
      document.removeEventListener('scroll', rememberScroll, true)
    }
  }, [])
  useEffect(() => {
    const entry = entries.current[cursor.current]
    if (!entry) return
    if (restoring.current && equal(route, entry.route)) {
      const key = entry.key, scroll = entry.scroll
      const element = document.querySelector<HTMLElement>('.content-scroll')
      const content = element?.querySelector<HTMLElement>('.page-content')
      let observer: ResizeObserver | undefined, frame = 0, timer: ReturnType<typeof setTimeout> | undefined, done = false
      const finish = () => {
        if (done) return
        done = true; observer?.disconnect(); cancelAnimationFrame(frame); clearTimeout(timer)
        window.removeEventListener('wheel', interrupt); window.removeEventListener('touchstart', interrupt); window.removeEventListener('pointerdown', interrupt); window.removeEventListener('keydown', interruptKey)
        if (restoring.current === key) restoring.current = null
      }
      const interrupt = () => finish()
      const interruptKey = (event: KeyboardEvent) => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) finish() }
      const attempt = () => {
        if (done || entries.current[cursor.current]?.key !== key) { finish(); return }
        if (!element) { finish(); return }
        // Artist/release pages can first render a short loading skeleton.
        // Retain the desired position until their actual content arrives.
        if (element.scrollHeight - element.clientHeight + 1 >= scroll) { element.scrollTop = scroll; finish() }
      }
      window.addEventListener('wheel', interrupt, { passive: true }); window.addEventListener('touchstart', interrupt, { passive: true }); window.addEventListener('pointerdown', interrupt); window.addEventListener('keydown', interruptKey)
      if (content) { observer = new ResizeObserver(attempt); observer.observe(content) }
      frame = requestAnimationFrame(attempt)
      timer = setTimeout(() => { if (!done && element) element.scrollTop = scroll; finish() }, 45_000)
      cancelRestore.current = finish
      return finish
    }
    if (equal(route, entry.route)) return
    restoring.current = null
    // Editing the same search query is one place in history, not one place per letter.
    const previousWithoutQuery = { ...entry.route, query: undefined }, nextWithoutQuery = { ...route, query: undefined }
    if (route.page === 'search' && entry.route.page === 'search' && equal(previousWithoutQuery, nextWithoutQuery)) {
      entry.route = route
      return
    }
    const next = { key: crypto.randomUUID(), route, scroll: 0 }
    entries.current = [...entries.current.slice(0, cursor.current + 1), next]
    cursor.current++
    history.pushState({ pulse: token.current, key: next.key }, '')
    const element = document.querySelector('.content-scroll'); if (element) element.scrollTop = 0
    updateAvailable()
  }, [route])
  return { ...available, goBack: () => { if (cursor.current > 0) history.back() }, goForward: () => { if (cursor.current < entries.current.length - 1) history.forward() } }
}

export function NavigationButtons({ back, forward, goBack, goForward }: ReturnType<typeof useNavigationHistory>) {
  return <div className="history-buttons"><button className="icon-button" onClick={goBack} disabled={!back} aria-label="Назад" title="Назад (Alt + ←, боковая кнопка мыши)"><ArrowLeft size={17} /></button><button className="icon-button" onClick={goForward} disabled={!forward} aria-label="Вперёд" title="Вперёд (Alt + →, боковая кнопка мыши)"><ArrowRight size={17} /></button></div>
}
