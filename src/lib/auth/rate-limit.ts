/**
 * In-process sliding-window rate limiter. Per instance only: sufficient for the
 * single-deployment pilot; not a fleet-wide limit. Keys are caller-chosen
 * (e.g. `device:<id>:heartbeat` or `ip:<addr>:enroll`).
 */
interface Bucket { stamps: number[] }
const buckets = new Map<string, Bucket>();
const SWEEP_EVERY = 500;
let sinceSweep = 0;

export interface RateLimitDecision { allowed: boolean; retryAfterMs: number }

export function checkRateLimit(key: string, limit: number, windowMs: number, now = Date.now()): RateLimitDecision {
  const bucket = buckets.get(key) ?? { stamps: [] };
  bucket.stamps = bucket.stamps.filter((t) => now - t < windowMs);
  buckets.set(key, bucket);
  if (++sinceSweep >= SWEEP_EVERY) {
    sinceSweep = 0;
    for (const [k, b] of buckets) if (b.stamps.every((t) => now - t >= windowMs)) buckets.delete(k);
  }
  if (bucket.stamps.length >= limit) {
    const oldest = bucket.stamps[0];
    return { allowed: false, retryAfterMs: Math.max(250, windowMs - (now - oldest)) };
  }
  bucket.stamps.push(now);
  return { allowed: true, retryAfterMs: 0 };
}

/** Test hook: clear all buckets. */
export function resetRateLimits(): void { buckets.clear(); sinceSweep = 0; }
