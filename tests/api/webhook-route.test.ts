import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ configured: true, handle: vi.fn() }));
vi.mock('../../src/lib/supabase/server', () => ({ getSupabaseEnv: () => state.configured ? {} : null, createServiceClient: () => ({}) }));
vi.mock('../../src/email/webhook-handler', () => ({ handleResendWebhook: (...args: unknown[]) => state.handle(...args) }));
vi.mock('../../src/email/supabase-adapters', () => ({ createDeliveryStore: () => ({}) }));
import { POST } from '../../src/app/api/v1/webhooks/resend/route';
beforeEach(() => { state.configured = true; state.handle.mockReset(); process.env.RESEND_WEBHOOK_SECRET = 'test-only'; });
describe('webhook bounded route', () => {
  it('passes the exact bounded unparsed text to signature verification', async () => {
    state.handle.mockResolvedValue({ status: 200, body: { ok: true } });
    const body = ' {"type":"email.delivered"} ';
    expect((await POST(new Request('https://example.test', { method: 'POST', body }))).status).toBe(200);
    expect(state.handle.mock.calls[0][2]).toBe(body);
  });
  it('cancels oversized chunked body before calling signature handler', async () => {
    const cancel = vi.fn(); let reads = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) { reads++; c.enqueue(new Uint8Array(256 * 1024 + 1)); }, cancel }, { highWaterMark: 0 });
    const req = new Request('https://example.test', { method: 'POST', body, duplex: 'half' } as RequestInit);
    expect((await POST(req)).status).toBe(400);
    expect(cancel).toHaveBeenCalledOnce(); expect(reads).toBe(1);
    expect(state.handle).not.toHaveBeenCalled();
  });
});
