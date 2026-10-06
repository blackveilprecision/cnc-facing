/**
 * Per-client token buckets, so one visitor (or one stuck script) cannot keep the
 * box busy for everyone else. In memory and per process: this app is a single
 * container, so nothing fancier is needed.
 *
 * Two classes, because the routes cost very different amounts. The form calls
 * /api/plan on every keystroke, so it gets a generous bucket; /api/check parses
 * up to 32 MB of G-code per call, so it gets a small one.
 */

export interface Limit {
  /** Largest burst. */
  readonly capacity: number;
  /** Tokens added per second. */
  readonly perSecond: number;
}

export const LIMITS = {
  form: { capacity: 60, perSecond: 10 },
  check: { capacity: 6, perSecond: 0.2 },
} as const satisfies Record<string, Limit>;

export type LimitClass = keyof typeof LIMITS;

interface Bucket {
  tokens: number;
  at: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Spend one token. Returns 0 if allowed, else the seconds until one is free. */
  take(client: string, cls: LimitClass): number {
    const { capacity, perSecond } = LIMITS[cls];
    const t = this.now();
    this.sweep(t);
    const key = `${cls}|${client}`;
    const b = this.buckets.get(key) ?? { tokens: capacity, at: t };
    b.tokens = Math.min(capacity, b.tokens + ((t - b.at) / 1000) * perSecond);
    b.at = t;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      this.buckets.set(key, b);
      return 0;
    }
    this.buckets.set(key, b);
    return Math.ceil((1 - b.tokens) / perSecond);
  }

  /** Forget buckets that have refilled completely, so the map cannot grow without bound. */
  private sweep(t: number): void {
    if (t - this.lastSweep < 60_000) return;
    this.lastSweep = t;
    for (const [key, b] of this.buckets) {
      const cls = key.slice(0, key.indexOf("|")) as LimitClass;
      const { capacity, perSecond } = LIMITS[cls];
      if (b.tokens + ((t - b.at) / 1000) * perSecond >= capacity) this.buckets.delete(key);
    }
  }
}
