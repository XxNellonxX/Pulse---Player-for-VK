import net from 'node:net';
import { GatewayError } from './errors.mjs';

const invalid = () => new GatewayError(400, 'invalid_request');
const denied = () => new GatewayError(502, 'invalid_provider_target');

export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    if ([0, 10, 127].includes(a) || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)) return false;
    if (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) return false;
    if ((a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113)) return false;
    return true;
  }
  if (family === 6) {
    // Accept ordinary global unicast only. Reject mapped IPv4, local/link-local,
    // multicast, NAT64, documentation, transition and IETF special-use ranges.
    const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase();
    const halves = normalized.split('::');
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const parts = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
    const [first, second] = parts.map(part => parseInt(part, 16));
    if (first < 0x2000 || first > 0x3fff) return false;
    if ((first === 0x2001 && (second <= 0x1ff || second === 0xdb8)) || first === 0x2002 || first === 0x3fff) return false;
    return true;
  }
  return false;
}

export function safeHttps(value) {
  let url;
  try { url = value instanceof URL ? new URL(value) : new URL(value); } catch { throw denied(); }
  if (url.href.length > 16384 || /[\x00-\x20\x7f]/.test(String(value)) || url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') || net.isIP(url.hostname.replace(/^\[|\]$/g, ''))) throw denied();
  if ([...url.searchParams.keys()].some(key => /^(?:access_token|client_secret|oauth_token|authorization)$/i.test(key))) throw denied();
  return url;
}

export function validateTarget(value, kind) {
  const url = safeHttps(value);
  const host = url.hostname;
  const accepted = kind === 'token' ? host === 'secure.soundcloud.com' && url.pathname === '/oauth/token'
    : kind === 'musicbrainz' ? host === 'musicbrainz.org' && url.pathname.startsWith('/ws/2/')
      : kind === 'api' ? host === 'api.soundcloud.com' && (/^\/tracks(?:\/(?:soundcloud%3Atracks%3A|soundcloud:tracks:)?[1-9]\d{0,19}(?:\/streams)?)?$/i.test(url.pathname) || url.pathname === '/resolve')
        : kind === 'media' ? (host.endsWith('.sndcdn.com') || host === 'playback.media-streaming.soundcloud.cloud' || host === 'api.soundcloud.com')
          : false;
  if (!accepted) throw denied();
  if (kind === 'media' && host === 'api.soundcloud.com') {
    if (!/^\/tracks\/(?:soundcloud%3Atracks%3A|soundcloud:tracks:)?[1-9]\d{0,19}\/streams(?:\/[a-z0-9_-]{1,200}(?:\/hls)?)?\/?$/i.test(url.pathname)) throw denied();
  }
  return url;
}

export function trackId(value) {
  const id = value.startsWith('soundcloud:tracks:') ? value.slice(18) : value;
  if (!/^[1-9]\d{0,19}$/.test(id)) throw invalid();
  return id;
}

export function uuid(value) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) throw invalid();
  return value.toLowerCase();
}

export function queryText(value, max = 200) {
  const text = (value || '').trim().normalize('NFC');
  if (!text || text.length > max || /[\x00-\x1f\x7f]/.test(text)) throw invalid();
  return text;
}

export function integerQuery(value, fallback, min, max) {
  if (value === null || value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw invalid();
  return Number(value);
}

export function allowedQuery(params, names) {
  const seen = new Set();
  for (const [name] of params) {
    if (!names.includes(name) || seen.has(name)) throw invalid();
    seen.add(name);
  }
}

export function publicPermalink(value) {
  let url;
  try { url = safeHttps(value); } catch { throw invalid(); }
  if (!['soundcloud.com', 'www.soundcloud.com', 'on.soundcloud.com'].includes(url.hostname) || url.search || !/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)?\/?$/.test(url.pathname)) throw invalid();
  return url.href;
}

export function validateRange(value) {
  if (!value) return undefined;
  const match = /^bytes=(\d{1,16})-(\d{0,16})$/.exec(value);
  if (!match) throw new GatewayError(416, 'invalid_range');
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : undefined;
  if (!Number.isSafeInteger(start) || (end !== undefined && (!Number.isSafeInteger(end) || end < start || end - start >= 8 * 1024 * 1024))) throw new GatewayError(416, 'invalid_range');
  return value;
}

export function clientIp(request, trustLoopbackProxy) {
  let remote = request.socket.remoteAddress || 'unknown';
  if (remote.startsWith('::ffff:')) remote = remote.slice(7);
  if (trustLoopbackProxy && (remote === '127.0.0.1' || remote === '::1')) {
    const forwarded = request.headers['x-forwarded-for'];
    // Caddy replaces untrusted incoming forwarding headers. Trust exactly one
    // address, and only on the private loopback hop.
    if (typeof forwarded === 'string' && net.isIP(forwarded.trim())) return forwarded.trim();
  }
  return remote;
}
