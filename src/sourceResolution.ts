import type { AppSettings, Track } from './shared/contracts'
import { rankSoundCloudCandidates } from './shared/sourceMatching'

const check = (signal: AbortSignal) => { if (signal.aborted) throw new DOMException('Cancelled', 'AbortError') }
/** Cleanup is best effort; an unavailable native bridge must not reject on the UI thread. */
export function releaseSoundCloudSource(url: string) {
  try { void window.desktop?.releaseSoundCloud?.(url)?.catch(() => {}) }
  catch { /* The media session has an independent native expiry. */ }
}
export function shouldSearchSoundCloud(track: Track, settings: Pick<AppSettings, 'preferSoundCloud' | 'preferExplicit'>, failed = false) {
  return track.source === 'vk' && track.available && settings.preferSoundCloud && (
    failed || track.artistCard === 'absent' || settings.preferExplicit && /\b(?:clean|censored)\b|цензурн/iu.test(`${track.title} ${track.version || ''}`)
  )
}
/** Returns only a saved source or one unique strict metadata match. */
export async function soundCloudSource(track: Track, settings: AppSettings, signal: AbortSignal, failed = false) {
  const controller = new AbortController()
  const cancel = () => controller.abort()
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) controller.abort()
  let timer: ReturnType<typeof setTimeout> | undefined
  let aborted: (() => void) | undefined
  const budget = new Promise<never>((_, reject) => {
    aborted = () => reject(new DOMException('Cancelled', 'AbortError'))
    controller.signal.addEventListener('abort', aborted, { once: true })
    timer = setTimeout(() => controller.abort(), failed ? 15000 : 6000)
  })
  try { return await Promise.race([resolveSource(track, settings, controller.signal, failed), budget]) }
  catch (cause) {
    if (!signal.aborted && controller.signal.aborted) {
      if (!failed) return null
      throw new Error('SoundCloud не ответил за 15 секунд. Проверьте подключение и повторите попытку.')
    }
    throw cause
  } finally {
    if (timer) clearTimeout(timer)
    if (aborted) controller.signal.removeEventListener('abort', aborted)
    signal.removeEventListener('abort', cancel)
  }
}
async function resolveSource(track: Track, settings: AppSettings, signal: AbortSignal, failed = false) {
  const api = window.desktop
  if (!settings.preferSoundCloud || !api?.soundCloudBinding || !api.resolveSoundCloud) return null
  check(signal)
  let binding = await api.soundCloudBinding(track.id)
  check(signal)
  // Automatic links are only metadata proposals. Recheck them against fresh VK
  // evidence; a user-confirmed different edition remains an intentional choice.
  if (binding?.selection === 'metadata' && rankSoundCloudCandidates(track, [binding], { preferExplicit: settings.preferExplicit }).candidates[0]?.quality !== 'exact') binding = null
  if (!binding && !shouldSearchSoundCloud(track, settings, failed)) return null
  const status = await api.soundCloudStatus?.()
  check(signal)
  if (!status?.configured) return null
  if (!binding && api.searchSoundCloud && api.bindSoundCloud) {
    const query = `${track.artist} ${track.title} ${track.version || ''}`.trim().slice(0, 300)
    const page = await api.searchSoundCloud(query)
    check(signal)
    const matches = rankSoundCloudCandidates(track, page.collection, { preferExplicit: settings.preferExplicit })
    const match = matches.status === 'unique' && !page.hasMore ? matches.candidates.find(item => item.candidate.id === matches.suggestedId && item.quality === 'exact') : undefined
    if (!match) {
      if (failed) throw new Error('Не найдено однозначное соответствие в SoundCloud. Откройте информацию о треке и выберите нужную запись.')
      return null
    }
    // A source chosen in the track dialog while search was in flight wins.
    // The native write repeats this check under its storage lock.
    const latest = await api.soundCloudBinding(track.id)
    check(signal)
    if (latest && latest.selection !== 'metadata') binding = latest
    else {
      await api.bindSoundCloud(track.id, match.candidate.id, 'metadata')
      check(signal)
      binding = match.candidate
    }
  }
  if (!binding) return null
  const source = await api.resolveSoundCloud(track.id)
  if (signal.aborted) {
    releaseSoundCloudSource(source.url)
    check(signal)
  }
  return source
}
