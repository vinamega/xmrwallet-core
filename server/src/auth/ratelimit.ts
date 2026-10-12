// In-memory token bucket (per key, per hour). Day-one abuse caps; the
// single-process app server makes in-memory state adequate for MVP.

const WINDOW_MS = 3600 * 1000;

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private limitPerHour: number,
    private sweepIntervalMs = 10 * 60 * 1000,
  ) {
    const t = setInterval(() => this.sweep(), this.sweepIntervalMs);
    t.unref();
  }

  allow(key: string): boolean {
    if (this.limitPerHour <= 0) return true;
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: this.limitPerHour, lastRefill: now };
    const elapsed = now - b.lastRefill;
    const refill = (elapsed / WINDOW_MS) * this.limitPerHour;
    b.tokens = Math.min(this.limitPerHour, b.tokens + refill);
    b.lastRefill = now;
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    return true;
  }

  private sweep(): void {
    const cutoff = Date.now() - WINDOW_MS;
    for (const [k, b] of this.buckets) {
      if (b.lastRefill < cutoff) this.buckets.delete(k);
    }
  }
}
