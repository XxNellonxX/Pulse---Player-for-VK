export type BufferedRange = [number, number]
export type PlaybackNetwork = 'idle' | 'loading' | 'ready' | 'stalled' | 'offline' | 'recovering' | 'error'

/** Keep real buffered islands: a gap must never look like downloaded audio. */
export function normalizeBufferedRanges(value: unknown, duration: number): BufferedRange[] {
  if (!Array.isArray(value) || !Number.isFinite(duration) || duration <= 0) return []
  const ranges = value.slice(0, 64).flatMap(item => {
    if (!Array.isArray(item) || typeof item[0] !== 'number' || typeof item[1] !== 'number' || !Number.isFinite(item[0]) || !Number.isFinite(item[1])) return []
    const start = Math.max(0, Math.min(duration, item[0])), end = Math.max(0, Math.min(duration, item[1]))
    return end > start ? [[start, end] as BufferedRange] : []
  }).sort((a, b) => a[0] - b[0])
  const result: BufferedRange[] = []
  for (const range of ranges) {
    const last = result[result.length - 1]
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else result.push(range)
  }
  return result
}

export function secondsBufferedAhead(ranges: BufferedRange[], position: number): number {
  if (!Number.isFinite(position)) return 0
  const current = ranges.find(([start, end]) => start <= position + .05 && end > position)
  return current ? Math.max(0, current[1] - position) : 0
}

export function readMediaBuffered(media: HTMLMediaElement): BufferedRange[] {
  const ranges: BufferedRange[] = []
  try {
    for (let index = 0; index < Math.min(media.buffered?.length || 0, 64); index++) ranges.push([media.buffered.start(index), media.buffered.end(index)])
  } catch { /* A source replacement can invalidate a TimeRanges snapshot. */ }
  return normalizeBufferedRanges(ranges, media.duration)
}

export function sameBufferedRanges(left: BufferedRange[], right: BufferedRange[]): boolean {
  return left.length === right.length && left.every((range, index) => range[0] === right[index][0] && range[1] === right[index][1])
}
