// A token bucket on the injected clock: `capacity` tokens, refilled at
// `perMinute` tokens per minute.

import type { Clock } from "../ports";

export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private capacity: number,
    private perMinute: number,
    private readonly clock: Clock,
  ) {
    this.tokens = capacity;
    this.last = clock.now();
  }

  /** Changes the limits; the current tokens are kept (capped at the new capacity). */
  configure(capacity: number, perMinute: number): void {
    this.refill();
    this.capacity = capacity;
    this.perMinute = perMinute;
    this.tokens = Math.min(this.tokens, capacity);
  }

  private refill(): void {
    const now = this.clock.now();
    const elapsed = Math.max(0, now - this.last);
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed * this.perMinute) / 60_000);
  }

  /** Milliseconds until `n` tokens are available (0 when they are), without taking them. */
  wait(n: number): number {
    this.refill();
    const need = Math.min(n, this.capacity);
    if (this.tokens + 1e-9 >= need) return 0;
    if (this.perMinute <= 0) return Number.POSITIVE_INFINITY;
    return Math.ceil(((need - this.tokens) * 60_000) / this.perMinute);
  }

  /** Takes `n` tokens when available and returns 0; otherwise takes nothing and returns the wait in ms. */
  take(n: number): number {
    const w = this.wait(n);
    if (w > 0) return w;
    this.tokens -= Math.min(n, this.capacity);
    return 0;
  }

  available(): number {
    this.refill();
    return this.tokens;
  }
}
