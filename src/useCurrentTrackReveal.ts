import { useEffect, useMemo, useRef } from 'react'

type Options = {
  currentId?: string | null
  tracks: readonly { id: string }[]
  contextKey: string
  renderedCount: number
  ensureRendered: (count: number) => void
  enabled?: boolean
  reducedMotion?: boolean
}

/** Follow playback in the open list without changing routes or fetching music. */
export function useCurrentTrackReveal(options: Options) {
  const listRef = useRef<HTMLDivElement>(null)
  const currentIndex = useMemo(() => options.currentId ? options.tracks.findIndex(track => track.id === options.currentId) : -1, [options.currentId, options.tracks])
  const latest = useRef({ ...options, currentIndex })
  latest.current = { ...options, currentIndex }
  const previous = useRef({ id: options.currentId, key: options.contextKey })
  const pending = useRef<{ id: string; key: string; reason: 'return' | 'track'; previousId?: string | null } | null>(null)
  const frame = useRef(0)
  const lastReturn = useRef(0)
  const manualAt = useRef(0)
  const scrolling = useRef<HTMLElement | null>(null)
  const request = useRef<(reason: 'return' | 'track', previousId?: string | null) => void>(() => {})
  const cancelReveal = useRef<() => void>(() => {})

  useEffect(() => {
    const scroller = () => listRef.current?.closest<HTMLElement>('.content-scroll') || null
    const overlayOpen = () => [...document.querySelectorAll<HTMLElement>('.modal-backdrop, .queue-panel.open, [aria-modal="true"]')].some(element => element.getBoundingClientRect().height > 0)
    const viewport = (element: HTMLElement) => {
      const bounds = element.getBoundingClientRect()
      // The desktop HUD is fixed over the content, including its error strip.
      const player = document.querySelector<HTMLElement>('.player-wrap')?.getBoundingClientRect()
      return { top: Math.max(0, bounds.top) + 14, bottom: Math.min(innerHeight, bounds.bottom, player && player.width > 0 && player.height > 0 ? player.top : innerHeight) - 14 }
    }
    const rows = (id: string) => [...(listRef.current?.querySelectorAll<HTMLElement>('[data-track-id]') || [])].filter(row => row.dataset.trackId === id)
    const visible = (id: string) => {
      const container = scroller()
      if (!container) return false
      const bounds = viewport(container)
      return rows(id).some(row => { const rect = row.getBoundingClientRect(); return rect.height > 0 && rect.top >= bounds.top && rect.bottom <= bounds.bottom })
    }
    const cancel = () => {
      cancelAnimationFrame(frame.current); pending.current = null
      if (scrolling.current) {
        scrolling.current.scrollTo({ top: scrolling.current.scrollTop, behavior: 'auto' })
        scrolling.current = null
      }
    }
    cancelReveal.current = cancel
    const attempt = () => {
      frame.current = 0
      const ticket = pending.current, state = latest.current
      if (!ticket || state.enabled === false || ticket.id !== state.currentId || ticket.key !== state.contextKey || document.visibilityState === 'hidden' || overlayOpen()) { pending.current = null; return }
      if (state.currentIndex < 0) { pending.current = null; return }
      if (state.currentIndex >= state.renderedCount) { state.ensureRendered(state.currentIndex + 1); return }
      const container = scroller()
      if (!container) { pending.current = null; return }
      const bounds = viewport(container)
      const candidates = rows(ticket.id).filter(row => row.getBoundingClientRect().height > 0)
      if (!candidates.length) { pending.current = null; return }
      // Imported lists can deliberately contain repeated tracks. Keep a visible
      // occurrence in place, otherwise choose the nearest occurrence.
      if (visible(ticket.id)) { pending.current = null; return }
      const middle = (bounds.top + bounds.bottom) / 2
      const row = candidates.reduce((nearest, candidate) => Math.abs(candidate.getBoundingClientRect().top - middle) < Math.abs(nearest.getBoundingClientRect().top - middle) ? candidate : nearest)
      const rect = row.getBoundingClientRect()
      pending.current = null
      if (bounds.bottom <= bounds.top || rect.width <= 0) return
      const target = Math.max(0, container.scrollTop + rect.top - bounds.top - Math.max(0, (bounds.bottom - bounds.top - rect.height) / 2))
      const reduced = state.reducedMotion || document.documentElement.classList.contains('reduced-motion') || window.matchMedia('(prefers-reduced-motion: reduce)').matches
      scrolling.current = container
      container.scrollTo({ top: target, behavior: reduced ? 'auto' : 'smooth' })
    }
    request.current = (reason, previousId) => {
      const state = latest.current
      if (state.enabled === false || !state.currentId || state.currentIndex < 0 || document.visibilityState === 'hidden' || overlayOpen()) { cancel(); return }
      // Returning to the window is explicit. During ordinary playback, leave
      // the user's browsing position alone after scrolling away from the song.
      if (reason === 'track' && manualAt.current && (performance.now() - manualAt.current < 1500 || !previousId || !visible(previousId))) { cancel(); return }
      if (reason === 'return') manualAt.current = 0
      cancelAnimationFrame(frame.current)
      pending.current = { id: state.currentId, key: state.contextKey, reason, previousId }
      if (state.currentIndex >= state.renderedCount) state.ensureRendered(state.currentIndex + 1)
      frame.current = requestAnimationFrame(attempt)
    }
    const onReturn = () => {
      if (document.visibilityState === 'hidden') return
      const now = performance.now()
      // Restoring a window can emit both visibilitychange and focus.
      if (now - lastReturn.current < 120) return
      lastReturn.current = now; request.current('return')
    }
    const interact = (event: Event) => {
      const container = scroller(), target = event.target
      if (!container || !(target instanceof Node) || !container.contains(target)) return
      manualAt.current = performance.now(); cancel()
    }
    const key = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) interact(event)
    }
    window.addEventListener('focus', onReturn)
    document.addEventListener('visibilitychange', onReturn)
    window.addEventListener('wheel', interact, { passive: true })
    window.addEventListener('touchstart', interact, { passive: true })
    window.addEventListener('pointerdown', interact)
    window.addEventListener('keydown', key)
    return () => {
      cancel(); request.current = () => {}; cancelReveal.current = () => {}
      window.removeEventListener('focus', onReturn)
      document.removeEventListener('visibilitychange', onReturn)
      window.removeEventListener('wheel', interact)
      window.removeEventListener('touchstart', interact)
      window.removeEventListener('pointerdown', interact)
      window.removeEventListener('keydown', key)
    }
  }, [])

  useEffect(() => {
    const before = previous.current
    previous.current = { id: options.currentId, key: options.contextKey }
    if (before.key !== options.contextKey || options.enabled === false) {
      cancelReveal.current(); manualAt.current = 0
      return
    }
    if (before.id !== options.currentId) request.current('track', before.id)
  }, [options.currentId, options.contextKey, options.enabled])

  useEffect(() => {
    const ticket = pending.current
    if (ticket && currentIndex < options.renderedCount) request.current(ticket.reason, ticket.previousId)
  }, [currentIndex, options.renderedCount])

  return listRef
}
