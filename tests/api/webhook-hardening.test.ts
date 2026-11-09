import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { handleResendWebhook } from '../../src/email/webhook-handler';
import { verifyWebhook } from '../../src/email/webhook';
const secret = 'whsec_' + Buffer.alloc(32, 7).toString('base64');
const now = 1700000000000;
const headers = (body: string, ts = '1700000000') => ({ id: 'svix-a', timestamp: ts, signature: 'v1,' + createHmac('sha256', Buffer.alloc(32, 7)).update(`svix-a.${ts}.${body}`).digest('base64') });
const store = () => ({ advance: vi.fn(async () => 'delivered' as const), markSeen: vi.fn(async () => true) });
describe('signed webhook negative cases', () => {
  it('validates exact body, timestamp window, header shape and key material', () => {
    const raw = '{"type":"email.delivered","data":{"email_id":"a"}}';
    expect(verifyWebhook(secret, headers(raw), raw, now / 1000)).toBe(true);
    expect(verifyWebhook(secret, headers(raw), raw + ' ', now / 1000)).toBe(false);
    expect(verifyWebhook(secret, headers(raw, '1699999600'), raw, now / 1000)).toBe(false);
    expect(verifyWebhook(secret, headers(raw, '1700000400'), raw, now / 1000)).toBe(false);
    expect(verifyWebhook('whsec_!!!', headers(raw), raw, now / 1000)).toBe(false);
    expect(verifyWebhook(secret, { ...headers(raw), signature: 'v1,garbage' }, raw, now / 1000)).toBe(false);
    expect(verifyWebhook(secret, { ...headers(raw), signature: 'v0,ignore ' + headers(raw).signature }, raw, now / 1000)).toBe(true);
  });
  it('unsigned requests never touch storage', async () => {
    const s = store();
    expect((await handleResendWebhook(secret, {}, '{}', s, now)).status).toBe(401);
    expect(s.advance).not.toHaveBeenCalled(); expect(s.markSeen).not.toHaveBeenCalled();
  });
  it.each(['null', '[]', 'bad JSON'])('handles signed malformed payload %s without throwing', async (raw) => {
    const s = store(); expect((await handleResendWebhook(secret, headers(raw), raw, s, now)).status).toBe(400);
    expect(s.advance).not.toHaveBeenCalled();
  });
  it('storage failure retries without marking the event or exposing diagnostics', async () => {
    const raw = '{"type":"email.complained","data":{"email_id":"a"}}'; const s = store();
    s.advance.mockRejectedValue(new Error('secret database diagnostic'));
    const r = await handleResendWebhook(secret, headers(raw), raw, s, now);
    expect(r.status).toBe(503); expect(JSON.stringify(r)).not.toContain('diagnostic');
    expect(s.markSeen).not.toHaveBeenCalled();
  });
});
