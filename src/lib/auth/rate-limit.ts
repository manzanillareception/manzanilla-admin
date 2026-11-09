import { createHash } from 'node:crypto';
import { createServiceClient, getSupabaseEnv } from '../supabase/server';

export interface RateLimitDecision { allowed: boolean; retryAfterMs: number; unavailable?: boolean }

/** Fleet-wide fixed window in Postgres. No local fallback: all protected routes
 * return retryable 503 when unavailable, and 429 only for an exhausted bucket.
 * Heartbeats/events must retry with the same event IDs; outages never grant
 * access or accept unmetered writes. Session admission stays fail-closed.
 */
export async function checkRateLimit(key: string, limit: number, windowMs: number): Promise<RateLimitDecision> {
  try {
    const env = getSupabaseEnv();
    if (!env) throw new Error('unconfigured');
    const { data, error } = await createServiceClient(env).rpc('control_check_rate_limit', {
      p_key: createHash('sha256').update(key).digest('hex'), p_limit: limit, p_window_ms: windowMs,
    }).abortSignal(AbortSignal.timeout(3000));
    if (error || !data || typeof data.allowed !== 'boolean' ||
        !Number.isFinite(data.retry_after_ms) || data.retry_after_ms < 0) throw new Error('unavailable');
    return { allowed: data.allowed, retryAfterMs: data.retry_after_ms };
  } catch {
    return { allowed: false, retryAfterMs: 5000, unavailable: true };
  }
}
