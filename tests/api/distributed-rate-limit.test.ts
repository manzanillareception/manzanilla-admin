import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
const state = vi.hoisted(() => ({ rpc: vi.fn(), configured: true }));
vi.mock('../../src/lib/supabase/server', () => ({
  getSupabaseEnv: () => state.configured ? {} : null,
  createServiceClient: () => ({ rpc: (...args: unknown[]) => ({ abortSignal: () => state.rpc(...args) }) }),
}));
import { checkRateLimit } from '../../src/lib/auth/rate-limit';
import { clientIp } from '../../src/lib/api/read-body';
beforeEach(() => { state.configured = true; state.rpc.mockReset(); });
afterEach(() => vi.unstubAllEnvs());

describe('distributed limiter', () => {
  it('sends a hashed key and shared window to RPC, never retains a local allowance', async () => {
    state.rpc.mockResolvedValue({ data: { allowed: true, retry_after_ms: 0 }, error: null });
    expect(await checkRateLimit('device:a:events', 60, 60000)).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(state.rpc).toHaveBeenCalledWith('control_check_rate_limit', {
      p_key: createHash('sha256').update('device:a:events').digest('hex'), p_limit: 60, p_window_ms: 60000,
    });
    state.rpc.mockResolvedValue({ data: { allowed: false, retry_after_ms: 1234 }, error: null });
    expect(await checkRateLimit('device:a:events', 60, 60000)).toEqual({ allowed: false, retryAfterMs: 1234 });
    expect(state.rpc).toHaveBeenCalledTimes(2);
  });
  it.each([null, {}, { allowed: true }, { allowed: true, retry_after_ms: -1 }])('fails closed on malformed RPC output %j', async (data) => {
    state.rpc.mockResolvedValue({ data, error: null });
    expect(await checkRateLimit('k', 10, 60000)).toEqual({ allowed: false, retryAfterMs: 5000, unavailable: true });
  });
  it('fails closed on missing config, database errors and network exceptions', async () => {
    state.configured = false;
    expect((await checkRateLimit('k', 10, 60000)).unavailable).toBe(true);
    state.configured = true;
    state.rpc.mockResolvedValue({ data: null, error: { message: 'db error' } });
    expect((await checkRateLimit('k', 10, 60000)).unavailable).toBe(true);
    state.rpc.mockRejectedValue(new Error('network'));
    expect((await checkRateLimit('k', 10, 60000)).unavailable).toBe(true);
  });
});

describe('platform IP trust', () => {
  const request = (headers: Record<string, string>) => new Request('https://example.test', { headers });
  it('ignores all caller IP headers outside Vercel', () => {
    vi.stubEnv('VERCEL', '');
    expect(clientIp(request({ 'x-forwarded-for': '1.1.1.1', 'x-real-ip': '2.2.2.2', 'x-vercel-forwarded-for': '3.3.3.3' }))).toBe('unknown');
  });
  it('uses only a valid single Vercel platform IP when VERCEL=1', () => {
    vi.stubEnv('VERCEL', '1');
    expect(clientIp(request({ 'x-forwarded-for': '1.1.1.1', 'x-vercel-forwarded-for': '2001:db8::1' }))).toBe('2001:db8::1');
    expect(clientIp(request({ 'x-forwarded-for': '1.1.1.1' }))).toBe('unknown');
    for (const v of ['garbage', '1.1.1.1, 2.2.2.2', '999.1.1.1']) expect(clientIp(request({ 'x-vercel-forwarded-for': v }))).toBe('unknown');
  });
});
