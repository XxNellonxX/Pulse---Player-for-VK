import { GatewayError, upstreamStatus } from './errors.mjs';

export class SoundCloudTokens {
  constructor(config, transport, now = Date.now) {
    this.config = config;
    this.transport = transport;
    this.now = now;
    this.token = null;
    this.pending = null;
    this.retryAt = 0;
    this.failures = 0;
  }
  async get(rejected) {
    if (this.token && this.token.expires > this.now() && this.token.access !== rejected) return this.token.access;
    if (this.pending) return this.pending;
    if (this.retryAt > this.now()) throw new GatewayError(503, 'provider_retry_later', Math.ceil((this.retryAt - this.now()) / 1000));
    this.pending = this.exchange(this.token?.refresh).catch(async error => {
      if (this.token?.refresh && error instanceof GatewayError && error.code === 'token_rejected') return this.exchange(null);
      throw error;
    }).then(token => {
      this.token = token;
      this.failures = 0;
      this.retryAt = 0;
      return token.access;
    }).catch(error => {
      this.failures++;
      const seconds = error.retryAfter || Math.min(300, 5 * 2 ** Math.min(this.failures, 6));
      this.retryAt = this.now() + seconds * 1000;
      throw new GatewayError(503, 'provider_auth_unavailable', seconds);
    }).finally(() => { this.pending = null; });
    return this.pending;
  }
  async exchange(refresh) {
    const form = new URLSearchParams(refresh ? {
      grant_type: 'refresh_token', refresh_token: refresh,
      client_id: this.config.clientId, client_secret: this.config.clientSecret,
    } : { grant_type: 'client_credentials' });
    const headers = { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' };
    if (!refresh) headers.authorization = `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64')}`;
    const response = await this.transport.request('https://secure.soundcloud.com/oauth/token', { kind: 'token', method: 'POST', headers, body: form.toString(), maxBytes: 65536, timeoutMs: 15000 });
    if ([400, 401, 403].includes(response.status)) throw new GatewayError(503, 'token_rejected');
    if (response.status !== 200) throw upstreamStatus(response.status, response.headers);
    let data;
    try { data = JSON.parse(response.bytes); } catch { throw new GatewayError(502, 'invalid_provider_response'); }
    const valid = token => typeof token === 'string' && token.length > 0 && token.length <= 8192 && !/[\x00-\x20\x7f]/.test(token);
    if (!valid(data.access_token) || !Number.isInteger(data.expires_in) || data.expires_in < 1 || data.expires_in > 604800 || (data.refresh_token !== undefined && !valid(data.refresh_token))) throw new GatewayError(502, 'invalid_provider_response');
    return { access: data.access_token, refresh: data.refresh_token, expires: this.now() + (data.expires_in - Math.min(30, Math.ceil(data.expires_in / 10))) * 1000 };
  }
}
