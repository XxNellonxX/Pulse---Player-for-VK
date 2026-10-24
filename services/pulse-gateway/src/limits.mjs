import { GatewayError } from './errors.mjs';
import { rateLimitKey } from './security.mjs';

export class BoundedCache {
  constructor({ maxEntries = 256, maxBytes = 32 * 1024 * 1024, now = Date.now } = {}) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.now = now;
    this.entries = new Map();
    this.bytes = 0;
  }
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= this.now()) { this.delete(key); return undefined; }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  delete(key) {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= entry.size;
    this.entries.delete(key);
  }
  set(key, value, ttlMs) {
    const size = Buffer.byteLength(JSON.stringify(value));
    if (size > Math.min(this.maxBytes, 2 * 1024 * 1024)) return;
    this.delete(key);
    while (this.entries.size >= this.maxEntries || this.bytes + size > this.maxBytes) this.delete(this.entries.keys().next().value);
    this.entries.set(key, { value, size, expires: this.now() + ttlMs });
    this.bytes += size;
  }
}

export class AbuseLimits {
  constructor(config, now = Date.now) {
    this.config = config;
    this.now = now;
    this.clients = new Map();
    this.global = { requests: 0, bytes: 0, minute: 0, active: 0 };
  }
  acquire(ip, media = false) {
    ip = rateLimitKey(ip);
    const now = this.now();
    const minute = Math.floor(now / 60_000);
    if (this.global.minute !== minute) Object.assign(this.global, { requests: 0, bytes: 0, minute });
    let client = this.clients.get(ip);
    if (!client) {
      if (this.clients.size >= 10000) {
        for (const [key, value] of this.clients) if (value.active === 0 && value.last < now - 10 * 60_000) this.clients.delete(key);
        if (this.clients.size >= 10000) throw new GatewayError(503, 'gateway_busy', 30);
      }
      client = { minute, metadata: 0, media: 0, bytes: 0, active: 0, last: now };
      this.clients.set(ip, client);
    }
    if (client.minute !== minute) Object.assign(client, { minute, metadata: 0, media: 0, bytes: 0 });
    client.last = now;
    if (this.global.active >= this.config.maxGlobalConcurrent || client.active >= this.config.maxIpConcurrent) throw new GatewayError(429, 'gateway_busy', 2);
    if (this.global.requests >= this.config.globalPerMinute || client[media ? 'media' : 'metadata'] >= (media ? this.config.mediaPerMinute : this.config.metadataPerMinute)) throw new GatewayError(429, 'rate_limited', 60 - Math.floor(now / 1000) % 60);
    if (media && (client.bytes >= 120 * 1024 * 1024 || this.global.bytes >= 2048 * 1024 * 1024)) throw new GatewayError(429, 'bandwidth_limited', 60);
    this.global.requests++;
    client[media ? 'media' : 'metadata']++;
    this.global.active++;
    client.active++;
    let released = false;
    return {
      bytes: count => { client.bytes += count; this.global.bytes += count; },
      release: () => { if (!released) { released = true; client.active--; this.global.active--; } },
    };
  }
}

export class IntervalGate {
  constructor(intervalMs = 1000, now = Date.now, delay = ms => new Promise(resolve => setTimeout(resolve, ms))) {
    this.interval = intervalMs;
    this.now = now;
    this.delay = delay;
    this.next = 0;
    this.chain = Promise.resolve();
  }
  async enter() {
    const operation = this.chain.then(async () => {
      await this.delay(Math.max(0, this.next - this.now()));
      this.next = this.now() + this.interval;
    });
    this.chain = operation.catch(() => {});
    await operation;
  }
}
