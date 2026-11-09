vi.mock('../../src/lib/auth/rate-limit', () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterMs: 0 })) }));
import { describe, expect, it, vi } from "vitest";
import { postAdminHotels, postHotelRecovery, type AdminGate } from "../../src/email/routes";

const ok: AdminGate = async () => ({ ok: true, admin: { userId: "a1" } });
const denied: AdminGate = async () => ({ ok: false, response: new Response("{}", { status: 403 }) });
const req = (b: unknown) => new Request("http://x/", { method: "POST", body: JSON.stringify(b) });
const hotel = { hotelName: "H", city: "C", email: "A@b.com", confirmEmail: "a@b.com" };

describe("admin hotel routes", () => {
  const mkDeps = (gate: AdminGate, calls: string[] = []) => ({
    gate, createHotelWithJob: async (i: any) => (calls.push(i.email), { hotelId: "h", jobId: "j", duplicate: i.email === "dup@b.com" }),
    runJob: async () => ({ status: "sent" }),
  });
  it("gate failure short-circuits", async () => {
    const calls: string[] = [];
    expect((await postAdminHotels(req(hotel), mkDeps(denied, calls))).status).toBe(403);
    expect(calls).toHaveLength(0);
  });
  it("rejects mismatched confirm and extra fields", async () => {
    expect((await postAdminHotels(req({ ...hotel, confirmEmail: "z@b.com" }), mkDeps(ok))).status).toBe(400);
    expect((await postAdminHotels(req({ ...hotel, role: "admin" }), mkDeps(ok))).status).toBe(400);
  });
  it("accepts, normalizes email, never returns password", async () => {
    const calls: string[] = [];
    const res = await postAdminHotels(req(hotel), mkDeps(ok, calls));
    expect(res.status).toBe(202); expect(calls).toEqual(["a@b.com"]);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await res.json())).not.toMatch(/password/i);
  });
  it("job run failure after create returns 202 in_progress, not 500", async () => {
    const d = { ...mkDeps(ok), runJob: async () => { throw new Error("lease lost"); } };
    const res = await postAdminHotels(req(hotel), d);
    expect(res.status).toBe(202); expect((await res.json()).status).toBe("in_progress");
  });
  it("needs_attention tells the operator to use recovery", async () => {
    const d = { ...mkDeps(ok), runJob: async () => ({ status: "needs_attention" }) };
    expect((await (await postAdminHotels(req(hotel), d)).json()).nextStep).toBe("use_recovery");
  });
  it("surfaces duplicate:true when an active job already existed", async () => {
    const res = await postAdminHotels(req({ ...hotel, email: "dup@b.com", confirmEmail: "dup@b.com" }), mkDeps(ok));
    expect((await res.json()).duplicate).toBe(true);
    expect((await (await postAdminHotels(req(hotel), mkDeps(ok))).json()).duplicate).toBe(false);
  });
  it("recovery validates id and mode", async () => {
    const d = { gate: ok, sendRecovery: async () => ({ jobId: "j" }) as any };
    expect((await postHotelRecovery(req({ mode: "guide" }), "nope", d)).status).toBe(400);
    expect((await postHotelRecovery(req({ mode: "old_password" }), "3f2b8f0e-6d1a-4c63-9a53-0d1f6f0a1b11", d)).status).toBe(400);
    expect((await postHotelRecovery(req({ mode: "guide" }), "3f2b8f0e-6d1a-4c63-9a53-0d1f6f0a1b11", d)).status).toBe(202);
  });
});

import { checkRateLimit } from '../../src/lib/auth/rate-limit';
describe('bounded admin email routes', () => {
  it('refuses a large hotel or recovery body without a database mutation', async () => {
    const create = vi.fn(); const recover = vi.fn();
    expect((await postAdminHotels(req({ ...hotel, padding: 'x'.repeat(9000) }), { gate: ok, createHotelWithJob: create, runJob: vi.fn() })).status).toBe(400);
    expect((await postHotelRecovery(req({ mode: 'guide', padding: 'x'.repeat(3000) }), '33333333-3333-4333-8333-333333333333', { gate: ok, sendRecovery: recover })).status).toBe(400);
    expect(create).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled();
  });
  it('returns 503 when the distributed limiter is unavailable, without reading/mutating', async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, retryAfterMs: 5000, unavailable: true });
    const r = req(hotel); const create = vi.fn();
    expect((await postAdminHotels(r, { gate: ok, createHotelWithJob: create, runJob: vi.fn() })).status).toBe(503);
    expect(r.bodyUsed).toBe(false); expect(create).not.toHaveBeenCalled();
  });
});
it('hotel create stops reading an overflowing stream before invoking create', async () => {
  let reads = 0; const cancel = vi.fn(); const create = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ pull(c) { reads++; c.enqueue(new Uint8Array(8193)); }, cancel }, { highWaterMark: 0 });
  const request = new Request('https://example.test', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
  const res = await postAdminHotels(request, { gate: ok, createHotelWithJob: create, runJob: vi.fn() });
  expect(res.status).toBe(400); expect(reads).toBe(1); expect(cancel).toHaveBeenCalledOnce(); expect(create).not.toHaveBeenCalled();
});
