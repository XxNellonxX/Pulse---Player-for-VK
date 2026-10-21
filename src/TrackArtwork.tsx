import { memo, useId, useState, type ReactNode } from 'react'
import type { Track } from './shared/contracts'
import './TrackArtwork.css'

type Props = { track: Pick<Track, 'id' | 'title' | 'artist' | 'artwork'>; className?: string; children?: ReactNode }
const COLORS = [ ['#152b47', '#84d5de', '#e9b4ef'], ['#3c2037', '#ffb08f', '#e7d2a3'], ['#19382f', '#b5d77e', '#f5d494'], ['#352354', '#b9a6f7', '#85dcd4'], ['#233a51', '#f3a981', '#f6d99e'], ['#3d263e', '#e3a7d8', '#94c8f2'] ]

/** Stable visual identity: reordering or shuffling never changes a track's cover. */
export function artworkSeed(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619)
  return hash >>> 0
}

const AbstractArtwork = memo(function AbstractArtwork({ seed }: { seed: number }) {
  const id = `art-${useId().replace(/:/g, '')}`
  const [background, first, second] = COLORS[(seed >>> 4) % COLORS.length]
  const variant = seed % 5
  return <svg className={`abstract-artwork abstract-artwork-${variant}`} viewBox="0 0 100 100" fill="none" aria-hidden="true" focusable="false">
    <defs><linearGradient id={`${id}-color`} x1="0" y1="0" x2="100" y2="100" gradientUnits="userSpaceOnUse"><stop stopColor={first} /><stop offset="1" stopColor={second} /></linearGradient><radialGradient id={`${id}-glow`} cx="0" cy="0" r="1" gradientTransform="translate(78 15) rotate(120) scale(105)"><stop stopColor={second} stopOpacity=".55" /><stop offset="1" stopColor={background} stopOpacity="0" /></radialGradient></defs>
    <path fill={background} d="M0 0h100v100H0z" /><path fill={`url(#${id}-glow)`} d="M0 0h100v100H0z" />
    {variant === 0 && <g transform={`rotate(${(seed >>> 8) % 40 - 20} 50 50)`}><circle cx="56" cy="44" r="36" stroke={`url(#${id}-color)`} strokeWidth="14" /><circle cx="56" cy="44" r="22" stroke={second} strokeOpacity=".65" strokeWidth="1" /><path d="M-10 87L110 17" stroke={first} strokeWidth="5" /><path d="M-10 98L110 28" stroke={second} strokeWidth="2" /></g>}
    {variant === 1 && <><path d="M-8 94L37 -5H79L34 94H-8Z" fill={`url(#${id}-color)`} /><path d="M30 104L75 5H117L72 104H30Z" fill={second} fillOpacity=".65" /><path d="M34 94L58 42L77 52L53 104Z" fill={background} fillOpacity=".5" /><path d="M37 -5L58 42L79 -5" fill={second} fillOpacity=".8" /></>}
    {variant === 2 && <g stroke={`url(#${id}-color)`} strokeWidth="2.5">{[0, 1, 2, 3, 4, 5, 6, 7].map(index => <path key={index} d={`M-8 ${18 + index * 10}C25 ${-18 + index * 10} 55 ${110 - index * 9} 108 ${16 + index * 9}`} opacity={.45 + index * .065} />)}<circle cx="72" cy="24" r="8" fill={second} stroke="none" /></g>}
    {variant === 3 && <><path d="M-5 100V49A54 54 0 0 1 49 -5H106V100Z" fill={`url(#${id}-color)`} /><path d="M15 100V59A40 40 0 0 1 55 19H105V100Z" fill={background} fillOpacity=".62" /><path d="M35 100V69A26 26 0 0 1 61 43H105V100Z" fill={second} fillOpacity=".8" /><path d="M55 100V79A12 12 0 0 1 67 67H105V100Z" fill={background} fillOpacity=".7" /></>}
    {variant === 4 && <g transform={`rotate(${seed % 2 ? -16 : 16} 50 50)`}><path d="M8 80L50 7L93 80H8Z" stroke={`url(#${id}-color)`} strokeWidth="9" /><path d="M22 74L50 26L79 74H22Z" stroke={second} strokeOpacity=".6" strokeWidth="1" /><path d="M-10 91H110" stroke={first} strokeWidth="4" /><path d="M-10 99H110" stroke={second} strokeWidth="2" /><circle cx="50" cy="57" r="6" fill={first} /></g>}
  </svg>
})

export const TrackArtwork = memo(function TrackArtwork({ track, className = 'track-cover', children }: Props) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const showImage = Boolean(track.artwork && track.artwork !== failedUrl)
  return <span className={`artwork-container ${className}`}>
    {showImage ? <img src={track.artwork} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailedUrl(track.artwork || null)} /> : <AbstractArtwork seed={artworkSeed(track.id || `${track.artist}\n${track.title}`)} />}
    {children}
  </span>
})
