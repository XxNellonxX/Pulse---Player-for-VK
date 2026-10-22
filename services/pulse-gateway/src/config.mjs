import { GatewayError } from './errors.mjs';

function integer(value, fallback, minimum, maximum) {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value) || Number(value) < minimum || Number(value) > maximum) throw new Error('Invalid numeric gateway configuration');
  return Number(value);
}

export function publicOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('PUBLIC_ORIGIN must be an HTTPS origin'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || url.pathname !== '/' || (url.port && url.port !== '443') || !url.hostname.includes('.')) {
    throw new Error('PUBLIC_ORIGIN must be an HTTPS origin without a path');
  }
  return url.origin;
}

function credential(value) {
  if (!value || value.length > 8192 || /[\x00-\x20\x7f]/.test(value) || /PASTE_|YOUR_|REPLACE|<.*>/i.test(value)) throw new Error('Configure real server-side SoundCloud credentials');
  return value;
}

export function loadConfig(env = process.env) {
  const config = {
    origin: publicOrigin(env.PUBLIC_ORIGIN),
    host: env.HOST || '127.0.0.1',
    port: integer(env.PORT, 8080, 1024, 65535),
    clientId: credential(env.SOUNDCLOUD_CLIENT_ID),
    clientSecret: credential(env.SOUNDCLOUD_CLIENT_SECRET),
    userAgent: env.MUSICBRAINZ_USER_AGENT || 'PulseGateway/1.0 (https://github.com/XxNellonxX/Pulse---Player-for-VK)',
    trustLoopbackProxy: env.TRUST_LOOPBACK_PROXY !== 'false',
    maxGlobalConcurrent: integer(env.MAX_GLOBAL_CONCURRENT, 16, 2, 64),
    maxIpConcurrent: integer(env.MAX_IP_CONCURRENT, 6, 1, 16),
    metadataPerMinute: integer(env.METADATA_PER_IP_MINUTE, 60, 1, 600),
    mediaPerMinute: integer(env.MEDIA_PER_IP_MINUTE, 600, 30, 3600),
    globalPerMinute: integer(env.GLOBAL_REQUESTS_MINUTE, 6000, 60, 30000),
  };
  if (config.host !== '127.0.0.1' && config.host !== '::1') throw new Error('Gateway must bind to a loopback address behind HTTPS');
  if (!config.userAgent.includes('(') || config.userAgent.length > 256 || /[\r\n]/.test(config.userAgent)) throw new Error('Set an identifying MusicBrainz User-Agent and contact');
  return config;
}

export function requireGet(method) {
  if (method !== 'GET' && method !== 'HEAD') throw new GatewayError(405, 'method_not_allowed');
}
