/** Fixed-window in-memory rate limiter keyed by client IP. */
export class RateLimiter {
  constructor({ limit = 120, windowMs = 60_000, maxKeys = 50_000 } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.buckets = new Map();
  }

  take(key, now = Date.now()) {
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (this.buckets.size > this.maxKeys) this.sweep(now);
    return bucket.count <= this.limit;
  }

  sweep(now = Date.now()) {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
    if (this.buckets.size > this.maxKeys) {
      const excess = this.buckets.size - this.maxKeys;
      let removed = 0;
      for (const key of this.buckets.keys()) {
        this.buckets.delete(key);
        if (++removed >= excess) break;
      }
    }
  }
}
