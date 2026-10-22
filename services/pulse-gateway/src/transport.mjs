import https from 'node:https';
import dns from 'node:dns/promises';
import { GatewayError } from './errors.mjs';
import { isPublicAddress, validateTarget } from './security.mjs';

export function createTransport({ lookup = dns.lookup, request = https.request } = {}) {
  const agent = new https.Agent({ keepAlive: true, maxSockets: 20, maxFreeSockets: 8, timeout: 30_000 });
  return {
    close() { agent.destroy(); },
    async request(value, { kind, method = 'GET', headers = {}, body, maxBytes = 2 * 1024 * 1024, timeoutMs = 20_000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      const url = validateTarget(value, kind);
      let addresses;
      let dnsTimer;
      try {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new GatewayError(504, 'provider_timeout');
        addresses = await Promise.race([
          lookup(url.hostname, { all: true, verbatim: true }),
          new Promise((_, reject) => { dnsTimer = setTimeout(() => reject(new GatewayError(504, 'provider_timeout')), Math.min(5000, remaining)); dnsTimer.unref(); }),
        ]);
      } catch (error) {
        if (error instanceof GatewayError && error.code === 'provider_timeout') throw error;
        throw new GatewayError(502, 'provider_dns_unavailable');
      } finally { clearTimeout(dnsTimer); }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new GatewayError(504, 'provider_timeout');
      if (!Array.isArray(addresses) || addresses.length === 0 || addresses.length > 64 || addresses.some(item => !isPublicAddress(item.address))) throw new GatewayError(502, 'invalid_provider_target');
      // This lookup returns only the already validated addresses. The OS cannot
      // resolve a different address between validation and connection.
      const pinnedLookup = (_host, options, callback) => {
        const candidates = addresses.filter(item => !options.family || item.family === options.family);
        if (!candidates.length) return callback(new Error('No matching public address'));
        if (options.all) return callback(null, candidates);
        callback(null, candidates[0].address, candidates[0].family);
      };
      return new Promise((resolve, reject) => {
        let done = false;
        let req;
        const finish = (error, result) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          error ? reject(error) : resolve(result);
        };
        const timer = setTimeout(() => {
          req?.destroy();
          finish(new GatewayError(504, 'provider_timeout'));
        }, remaining);
        timer.unref();
        req = request(url, { method, agent, lookup: pinnedLookup, headers: { 'accept-encoding': 'identity', ...headers } }, response => {
          const chunks = [];
          let size = 0;
          const contentLength = Number(response.headers['content-length']);
          if (contentLength > maxBytes || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
            response.destroy();
            finish(new GatewayError(502, 'provider_response_too_large'));
            return;
          }
          response.on('data', chunk => {
            if (done) return;
            size += chunk.length;
            if (size > maxBytes) {
              response.destroy();
              finish(new GatewayError(502, 'provider_response_too_large'));
            } else chunks.push(chunk);
          });
          response.once('error', () => finish(new GatewayError(502, 'provider_unavailable')));
          response.once('end', () => { if (!done) finish(null, { status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks, size), finalUrl: url.href }); });
        });
        req.once('error', () => finish(new GatewayError(502, 'provider_unavailable')));
        if (body) req.write(body);
        req.end();
      });
    },
  };
}
