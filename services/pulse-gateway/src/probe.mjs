import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { publicOrigin } from './config.mjs';

// This explicit deployment probe never reads local listener credentials, dumps
// response bodies, saves media or prints capability/provider URLs.
const MAX_BYTES = 8 * 1024 * 1024;
class ProbeError extends Error {}

function identity(track) {
  const id = track?.id;
  if (typeof id === 'number' && (!Number.isSafeInteger(id) || id < 1)) throw new ProbeError('invalid_track_identity');
  const urn = track?.urn;
  const value = typeof urn === 'string' ? urn : typeof id === 'number' || typeof id === 'string' ? String(id) : '';
  const normalized = value.replace(/^soundcloud:tracks:/, '');
  if (!/^[1-9]\d{0,19}$/.test(normalized) || (urn !== undefined && urn !== `soundcloud:tracks:${normalized}`)) throw new ProbeError('invalid_track_identity');
  if (id !== undefined && String(id) !== normalized) throw new ProbeError('invalid_track_identity');
  return typeof urn === 'string' ? urn : normalized;
}

function json(bytes) {
  try { return JSON.parse(bytes); } catch { throw new ProbeError('invalid_json'); }
}

function failure(error) {
  // Provider errors may contain tokens, request URLs or response snippets.
  // Only locally assigned fixed codes are safe to display.
  return error instanceof ProbeError ? error.message : 'network_or_response_error';
}

export async function runProbe({ origin: suppliedOrigin, queries = ['Кишлак', 'Капля испуга'], fetchFn = fetch, logger = console } = {}) {
  const origin = publicOrigin(suppliedOrigin);
  let failures = 0;
  async function request(path, base = origin) {
    if (typeof path !== 'string' || !path.trim()) throw new ProbeError('missing_resource_url');
    let url;
    try { url = new URL(path, base); } catch { throw new ProbeError('invalid_resource_url'); }
    if (url.origin !== origin || url.username || url.password || url.hash) throw new ProbeError('unexpected_resource_origin');
    const response = await fetchFn(url, { signal: AbortSignal.timeout(45000), redirect: 'error' });
    if (!response.ok) throw new ProbeError(`http_${response.status}`);
    if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new ProbeError('response_too_large');
    if (!response.body) return { address: url.href, bytes: Buffer.alloc(0) };
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_BYTES) {
          await reader.cancel().catch(() => {});
          throw new ProbeError('response_too_large');
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    return { address: url.href, bytes: Buffer.concat(chunks, length) };
  }
  for (let index = 0; index < queries.length; index++) {
    let stage = 'search';
    try {
      const started = Date.now();
      const search = json((await request(`/v1/soundcloud/tracks?${new URLSearchParams({ q: queries[index], limit: '1', linked_partitioning: 'true' })}`)).bytes);
      const id = identity(search.collection?.[0]);
      stage = 'streams';
      const streams = json((await request(`/v1/soundcloud/tracks/${encodeURIComponent(id)}/streams`)).bytes);
      const address = [streams?.hls_aac_160_url, streams?.hls_mp3_128_url].find(value => typeof value === 'string' && value.trim());
      if (!address) throw new ProbeError('no_supported_stream');
      stage = 'manifest';
      const manifest = await request(address);
      const text = manifest.bytes.toString().replace(/^\uFEFF/, '');
      if (!text.trimStart().startsWith('#EXTM3U')) throw new ProbeError('invalid_manifest');
      const reference = text.split(/\r?\n/).map(line => line.trim()).find(line => line && !line.startsWith('#')) || /URI="([^"]+)"/.exec(text)?.[1];
      if (!reference) throw new ProbeError('no_media_reference');
      stage = 'first_resource';
      const firstResource = await request(reference, manifest.address);
      if (!firstResource.bytes.length) throw new ProbeError('empty_media_resource');
      logger.info(`SoundCloud case ${index + 1}: search + manifest + first referenced resource OK (${Date.now() - started} ms). Exact recording identity and uninterrupted full playback remain unverified.`);
    } catch (error) {
      failures++;
      logger.error(`SoundCloud case ${index + 1}: failed at ${stage} (${failure(error)}).`);
    }
  }
  try {
    const result = json((await request(`/v1/musicbrainz/search?${new URLSearchParams({ query: 'artist:"Кишлак"', offset: '0' })}`)).bytes);
    if (!Array.isArray(result?.artists)) throw new ProbeError('invalid_artist_response');
    logger.info('MusicBrainz metadata request OK; artist coverage is not guaranteed.');
  } catch (error) {
    failures++;
    logger.error(`MusicBrainz metadata request failed (${failure(error)}).`);
  }
  return { failures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const queries = process.argv.slice(2);
    const result = await runProbe({ origin: process.env.PUBLIC_ORIGIN, ...(queries.length ? { queries } : {}) });
    process.exitCode = result.failures ? 1 : 0;
  } catch {
    console.error('Set PUBLIC_ORIGIN to the deployed HTTPS origin.');
    process.exitCode = 1;
  }
}
