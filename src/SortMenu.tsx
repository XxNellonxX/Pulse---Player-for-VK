import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDownUp, Check, ChevronDown } from 'lucide-react'
import './SortMenu.css'

export type SortOption<T extends string> = { value: T; label: string; group: string }
type Props<T extends string> = { value: T; options: readonly SortOption<T>[]; onChange: (value: T) => void }

/** Select-only combobox: focus stays on the trigger while its active option
 * moves with the keyboard. The portal avoids clipping by the library panel. */
export function SortMenu<T extends string>({ value, options, onChange }: Props<T>) {
  const id = useId(), trigger = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null)
  const typed = useRef({ text: '', at: 0 })
  const [open, setOpen] = useState(false), [active, setActive] = useState<T>(value)
  const [placement, setPlacement] = useState<CSSProperties>({ visibility: 'hidden' })
  const selected = options.find(option => option.value === value) || options[0]
  const optionId = (option: T) => `${id}-option-${option}`
  const close = () => { typed.current = { text: '', at: 0 }; setOpen(false) }
  const show = (initial = selected?.value) => { if (initial) { setActive(initial); setPlacement({ visibility: 'hidden' }); setOpen(true) } }
  const select = (option: T) => { onChange(option); close(); trigger.current?.focus({ preventScroll: true }) }
  useEffect(() => { if (!open) typed.current = { text: '', at: 0 } }, [open])

  useLayoutEffect(() => {
    if (!open) return
    let frame = 0
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect(), menu = popup.current
      if (!anchor || !menu) return
      if (anchor.bottom <= 0 || anchor.top >= innerHeight || anchor.right <= 0 || anchor.left >= innerWidth) { setOpen(false); return }
      const margin = 10, gap = 7, width = Math.min(292, innerWidth - margin * 2)
      const below = Math.max(0, innerHeight - margin - anchor.bottom - gap), above = Math.max(0, anchor.top - gap - margin)
      const desired = Math.min(menu.scrollHeight + 2, 360), down = below >= desired || below >= above
      const height = Math.max(40, Math.min(desired, down ? below : above))
      setPlacement({ width, maxHeight: height, top: down ? anchor.bottom + gap : Math.max(margin, anchor.top - gap - height), left: Math.max(margin, Math.min(anchor.right - width, innerWidth - width - margin)), visibility: 'visible', transformOrigin: down ? 'top right' : 'bottom right' })
    }
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(place) }
    place(); window.addEventListener('resize', schedule); window.addEventListener('scroll', schedule, true)
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true) }
  }, [open])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!trigger.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) setOpen(false) }
    const focus = (event: FocusEvent) => { if (!trigger.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside); document.addEventListener('focusin', focus)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', focus) }
  }, [open])
  useEffect(() => { if (open) document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' }) }, [active, open])
  useEffect(() => { if (!open) return; if (!selected) setOpen(false); else if (!options.some(option => option.value === active)) setActive(selected.value) }, [open, options, active, selected])
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.ctrlKey || event.altKey || event.metaKey) return
    if (event.key === 'Tab') { close(); return }
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); return }
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (open) select(active); else show(); return }
    if (/^[\p{L}\p{N}]$/u.test(event.key) && !event.nativeEvent.isComposing) {
      event.preventDefault()
      const now = performance.now(), letter = event.key.toLocaleLowerCase(), previous = now - typed.current.at <= 700 ? typed.current.text : ''
      const repeat = previous.length > 0 && [...previous].every(value => value === letter)
      const prefix = (repeat ? letter : previous + letter).trim().slice(0, 80)
      typed.current = { text: prefix, at: now }
      const start = repeat ? options.findIndex(option => option.value === (open ? active : selected.value)) + 1 : 0
      const match = options.slice(start).concat(options.slice(0, start)).find(option => option.label.trim().toLocaleLowerCase().startsWith(prefix))
      if (match) { if (open) setActive(match.value); else show(match.value) }
      else if (!open) show()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    typed.current = { text: '', at: 0 }
    const index = options.findIndex(option => option.value === active)
    if (event.key === 'Home') { if (open) setActive(options[0].value); else show(options[0].value) }
    else if (event.key === 'End') { if (open) setActive(options[options.length - 1].value); else show(options[options.length - 1].value) }
    else if (!open) show()
    else setActive(options[Math.max(0, Math.min(options.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))].value)
  }
  if (!selected) return null
  const groups = [...new Set(options.map(option => option.group))]
  return <div className="sort-menu">
    <button ref={trigger} type="button" role="combobox" aria-label={`Сортировка: ${selected.label}`} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? `${id}-list` : undefined} aria-activedescendant={open ? optionId(active) : undefined} className={`sort-menu-trigger ${open ? 'is-open' : ''}`} onClick={() => open ? close() : show()} onKeyDown={keyDown}>
      <ArrowDownUp size={14} className="sort-menu-icon" aria-hidden="true" /><span>{selected.label}</span><ChevronDown size={13} className="sort-menu-chevron" aria-hidden="true" />
    </button>
    {open && createPortal(<div ref={popup} className="sort-menu-popup" role="listbox" id={`${id}-list`} aria-label="Сортировка музыки" style={placement} onPointerDown={event => event.preventDefault()}>
      {groups.map(group => <div key={group} role="group" aria-label={group} className="sort-menu-group"><div className="sort-menu-group-label" aria-hidden="true">{group}</div>{options.filter(option => option.group === group).map(option => <div key={option.value} id={optionId(option.value)} role="option" aria-selected={option.value === value} className={`sort-menu-option ${option.value === active ? 'is-active' : ''}`} onPointerMove={() => setActive(option.value)} onClick={() => select(option.value)}><span>{option.label}</span>{option.value === value && <Check size={14} aria-hidden="true" />}</div>)}</div>)}
    </div>, document.body)}
  </div>
}
