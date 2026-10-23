// Short-lived replay of already authorized HLS segments within one capability.
// This is deliberately neither a track archive nor a cache of stream grants.
export class MediaByteCache {
  constructor({ maxEntries = 128, maxBytes = 64 * 1024 * 1024, ttlMs = 15 * 60_000, now = Date.now } = {}) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.ttlMs = ttlMs;
    this.now = now;
    this.entries = new Map();
    this.bytes = 0;
  }
  key(token, index, url, range) {
    // Preserve the complete signed URL and the complete validated Range. A new
    // capability, signature or range must never inherit another response.
    return JSON.stringify([token, index, url, range || '']);
  }
  delete(key) {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= entry.size;
    this.entries.delete(key);
  }
  deleteSession(token) {
    for (const [key, entry] of this.entries) if (entry.token === token) this.delete(key);
  }
  prune() {
    const now = this.now();
    for (const [key, entry] of this.entries) if (entry.expires <= now) this.delete(key);
  }
  get(key) {
    this.prune();
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key, token, value, sessionExpires) {
    this.prune();
    const expires = Math.min(this.now() + this.ttlMs, sessionExpires);
    const size = value.bytes.length + Buffer.byteLength(key) + 512;
    if (expires <= this.now() || size > this.maxBytes || this.maxEntries < 1) return;
    this.delete(key);
    while (this.entries.size >= this.maxEntries || this.bytes + size > this.maxBytes) this.delete(this.entries.keys().next().value);
    this.entries.set(key, { token, expires, size, value: { status: value.status, headers: { ...value.headers }, bytes: Buffer.from(value.bytes) } });
    this.bytes += size;
  }
  clear() {
    this.entries.clear();
    this.bytes = 0;
  }
}
