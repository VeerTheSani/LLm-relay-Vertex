class SlidingWindowLimiter {
  constructor(limitPerWindow, windowMs = 60000) {
    this.limit = limitPerWindow;
    this.windowMs = windowMs;
    this.hits = new Map();
    if (this.limit > 0) {
      const sweeper = setInterval(() => this.prune(), this.windowMs * 5);
      sweeper.unref();
    }
  }

  check(key) {
    if (!this.limit || this.limit <= 0) return { allowed: true };
    const now = Date.now();
    const recent = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      const retryAfterSeconds = Math.max(1, Math.ceil((recent[0] + this.windowMs - now) / 1000));
      return { allowed: false, retryAfterSeconds };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true, remaining: this.limit - recent.length };
  }

  prune() {
    const now = Date.now();
    for (const [key, timestamps] of this.hits) {
      const recent = timestamps.filter((t) => now - t < this.windowMs);
      if (recent.length === 0) this.hits.delete(key);
      else this.hits.set(key, recent);
    }
  }
}

module.exports = { SlidingWindowLimiter };
