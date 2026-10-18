/**
 * Small in-memory guards for the paid text-to-speech path. They live in one
 * server process, so on serverless hosting each instance counts separately and a
 * restart resets them: a speed bump against casual credit burning, not security.
 */

const MAX_TRACKED_KEYS = 1000;

export interface CharBudget {
  /** Spend `chars` for `key` if the window still has room; false means over budget. */
  tryConsume(key: string, chars: number): boolean;
  /** Give characters back (the request that spent them never reached the paid API). */
  refund(key: string, chars: number): void;
}

/** Fixed-window budget of characters per key. */
export function createCharBudget(options: { limit: number; windowMs: number; now?: () => number }): CharBudget {
  const { limit, windowMs, now = Date.now } = options;
  const buckets = new Map<string, { used: number; resetAt: number }>();

  // Spoofed client ids must not grow memory without bound: drop expired, then oldest. Known limit:
  // 1,001 distinct ids evict the oldest bucket, which resets that client's budget, so the global
  // budget (not this per-client one) is the real bound on spend.
  const prune = () => {
    if (buckets.size <= MAX_TRACKED_KEYS) return;
    const current = now();
    for (const [key, bucket] of buckets) if (bucket.resetAt <= current) buckets.delete(key);
    while (buckets.size > MAX_TRACKED_KEYS) buckets.delete(buckets.keys().next().value as string);
  };

  const bucketFor = (key: string) => {
    const existing = buckets.get(key);
    if (existing && existing.resetAt > now()) return existing;
    const fresh = { used: 0, resetAt: now() + windowMs };
    buckets.set(key, fresh);
    prune();
    return fresh;
  };

  return {
    tryConsume(key, chars) {
      const bucket = bucketFor(key);
      if (bucket.used + chars > limit) return false;
      bucket.used += chars;
      return true;
    },
    refund(key, chars) {
      const bucket = buckets.get(key);
      if (bucket) bucket.used = Math.max(0, bucket.used - chars);
    },
  };
}

export interface Semaphore {
  /** Resolves with a release function once a slot is free. */
  acquire(): Promise<() => void>;
}

/** Caps how many calls run at once; extra callers wait their turn instead of failing. */
export function createSemaphore(max: number): Semaphore {
  let active = 0;
  const waiting: Array<() => void> = [];

  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };

  return {
    async acquire() {
      if (active < max) {
        active += 1;
        return release;
      }
      await new Promise<void>((resolve) => waiting.push(resolve));
      return release;
    },
  };
}
