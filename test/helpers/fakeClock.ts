// A manual clock for the lookup service and the cache. advance() runs the
// timers that fall due, in order, and lets promises settle after each one.

import type { Clock } from "../../src/core/ports";

interface Timer {
  id: number;
  at: number;
  callback: () => void;
}

/** Lets pending promise callbacks (and the ones they schedule) run. */
export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}

export class FakeClock implements Clock {
  private t: number;
  private timers: Timer[] = [];
  private nextId = 1;

  constructor(start = Date.UTC(2026, 9, 5, 12, 0, 0)) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.push({ id, at: this.t + Math.max(0, ms), callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }

  pendingTimers(): number {
    return this.timers.length;
  }

  /** Moves time forward by `ms`, running every timer that falls due. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    await settle();
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = Math.max(this.t, next.at);
      next.callback();
      await settle();
    }
    this.t = end;
    await settle();
  }
}
