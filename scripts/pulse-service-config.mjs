import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Only a public service origin belongs in desktop builds. OAuth secrets stay on
// the service and are never read by this build helper.
export function gatewayOrigin(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid public Pulse service origin.');
  if (!value.trim()) return '';
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('Invalid public Pulse service origin.'); }
  const host = url.hostname;
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || !host.includes('.') || host.length > 253 || !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
    || /^\d+(?:\.\d+){3}$/.test(host) || /(?:^|\.)(?:localhost|local|internal|lan)$/.test(host)) {
    throw new Error('Pulse service must be a public HTTPS domain without a path, credentials or query.');
  }
  return url.origin;
}

export async function loadGatewayOrigin(root, env = process.env) {
  if (Object.hasOwn(env, 'PULSE_GATEWAY_URL')) return gatewayOrigin(env.PULSE_GATEWAY_URL);
  let raw;
  try { raw = await readFile(path.join(root, 'config', 'pulse-service.json')); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw new Error('Cannot read config/pulse-service.json.'); }
  if (raw.length > 4096) throw new Error('Pulse service config is too large.');
  let config;
  try { config = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error('Invalid config/pulse-service.json.'); }
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).length !== 1 || !Object.hasOwn(config, 'gatewayUrl')) {
    throw new Error('Pulse service config accepts only gatewayUrl; never put API keys in it.');
  }
  return gatewayOrigin(config.gatewayUrl);
}
