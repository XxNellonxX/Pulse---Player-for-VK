type ConvertNativePath = (path: string, protocol?: string) => string

const preparedPath = /^([a-f0-9]{48})\/0$/u
const sessionPath = /^\/([a-f0-9]{48})\/0$/u
const invalidSource = () => new Error('Неверный адрес подготовленного аудиоисточника.')

/** A private media capability is a URL path, not an operating-system file path. */
export function soundCloudMediaUrl(path: string, convertNativePath: ConvertNativePath): string {
  const token = typeof path === 'string' ? preparedPath.exec(path)?.[1] : undefined
  if (!token) throw invalidSource()
  // Tauri percent-encodes every slash passed to convertFileSrc. Convert only
  // the capability, retaining Tauri's platform-specific scheme and hostname;
  // the protocol handler requires a literal separator before the media index.
  const url = `${convertNativePath(token, 'pulse-media')}/0`
  if (soundCloudSessionId(url) !== token) throw invalidSource()
  return url
}

/** Never interpret an invalid supplied URL as a request to release all sessions. */
export function soundCloudSessionId(value: string): string {
  if (typeof value !== 'string' || value.length > 200) throw invalidSource()
  let url: URL
  try { url = new URL(value) } catch { throw invalidSource() }
  const windows = ['http:', 'https:'].includes(url.protocol) && url.hostname === 'pulse-media.localhost'
  const mac = url.protocol === 'pulse-media:' && url.hostname === 'localhost'
  const token = sessionPath.exec(url.pathname)?.[1]
  if (!(windows || mac) || url.port || url.username || url.password || url.search || url.hash || !token) throw invalidSource()
  return token
}
