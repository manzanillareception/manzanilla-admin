import { describe, expect, it } from "vitest";
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
