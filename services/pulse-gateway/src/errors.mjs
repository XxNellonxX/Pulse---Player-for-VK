export class GatewayError extends Error {
  constructor(status, code, retryAfter) {
    super(code);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function upstreamStatus(status, headers = {}) {
  if (status === 429) {
    const seconds = Number(headers['retry-after']);
    return new GatewayError(429, 'provider_rate_limited', Number.isFinite(seconds) ? Math.max(1, Math.min(3600, Math.ceil(seconds))) : 60);
  }
  if (status === 401 || status === 403) return new GatewayError(503, 'provider_access_unavailable');
  if (status === 404 || status === 410) return new GatewayError(404, 'not_available');
  return new GatewayError(502, 'provider_unavailable');
}
