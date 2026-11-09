import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptPayload, encryptPayload } from "../../src/email/crypto";
import { generateInitialPassword } from "../../src/email/password";
import { renderAlert, renderWelcome } from "../../src/email/templates";
import { advance, eventToState, verifyWebhook } from "../../src/email/webhook";
import { RETRY_DEADLINE_MS, runJob, runJobLeased, startJob, type Job, type Deps } from "../../src/email/provisioning";
import { sendViaResend } from "../../src/email/resend";

const key = randomBytes(32);
function mk(over: Partial<Deps> = {}) {
  const jobs = new Map<string, Job>(); const leases = new Map<string, number>();
  let created = 0, now = 1_000_000;
  const sent: string[] = [];
  const deps: Deps = {
    store: { get: async (i) => jobs.get(i), save: async (j) => void jobs.set(j.id, j),
      claim: async (i, ms, n) => { const u = leases.get(i); if (u && u > n) return false; leases.set(i, n + ms); return true; },
      release: async (i) => void leases.delete(i) },
    auth: { createUser: async () => { created++; return { id: "u1" }; }, findUserByEmail: async () => ({ id: "u0" }) },
    key, apiKey: "k", from: "Manzanilla <no-reply@mail.example.test>", replyTo: "support@example.test",
    loginUrl: "https://admin.example.test", now: () => now,
    send: async (_k, m) => { sent.push(m.text); return { kind: "accepted", providerId: "p1" }; },
    ...over,
  };
  return { deps, jobs, sent, created: () => created, advance: (ms: number) => (now += ms) };
}

describe("primitives", () => {
  it("passwords are strong and varied", () => {
    const a = generateInitialPassword(), b = generateInitialPassword();
    expect(a).toHaveLength(16); expect(a).not.toBe(b);
  });
  it("encrypts with AAD binding", () => {
    const s = encryptPayload(key, "pw", "a");
    expect(decryptPayload(key, s, "a")).toBe("pw");
    expect(() => decryptPayload(key, s, "b")).toThrow();
  });
  it("escapes html in templates", () => {
    expect(renderWelcome({ hotelName: "<b>x</b>", loginEmail: "a@b.c", password: "p", loginUrl: "u", supportEmail: "s" }).html)
      .not.toContain("<b>x</b>");
    expect(renderAlert({ incidentId: "1", severity: "critical", kind: "k", hotelName: "h", deviceLabel: "d", dashboardUrl: "u" }).text)
      .toContain("not acknowledgement");
  });
});

describe("webhook", () => {
  const secret = "whsec_" + randomBytes(24).toString("base64");
  const sign = (id: string, ts: string, body: string) =>
    "v1," + createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${ts}.${body}`).digest("base64");
  it("verifies, rejects tampering and stale timestamps", () => {
    const ts = "1000", body = "{}";
    const h = { id: "m1", timestamp: ts, signature: sign("m1", ts, body) };
    expect(verifyWebhook(secret, h, body, 1000)).toBe(true);
    expect(verifyWebhook(secret, h, "{x}", 1000)).toBe(false);
    expect(verifyWebhook(secret, h, body, 9999)).toBe(false);
    expect(verifyWebhook(secret, { ...h, signature: null }, body, 1000)).toBe(false);
  });
  it("handles out-of-order states", () => {
    expect(advance("delivered", "accepted")).toBe("delivered");
    expect(advance("delivered", "bounced")).toBe("bounced");
    expect(advance("bounced", "delivered")).toBe("bounced");
    expect(advance("accepted", "delayed")).toBe("delayed");
    expect(eventToState("email.opened")).toBeNull();
    expect(eventToState("email.complained")).toBe("complained");
    expect(advance("failed", "complained")).toBe("failed");
  });
});

describe("provisioning", () => {
  it("creates account, sends once, wipes payload", async () => {
    const t = mk(); t.jobs.set("j", startJob(key, "j", "Hotel", "A@B.com", 1_000_000));
    const j = await runJob(t.deps, "j");
    expect(j.status).toBe("sent"); expect(j.sealedPassword).toBeNull();
    expect(t.sent[0]).toContain("Password:");
    await runJob(t.deps, "j"); // duplicate worker
    expect(t.sent).toHaveLength(1); expect(t.created()).toBe(1);
  });
  it("timeout after send retries with same password", async () => {
    let n = 0; const t = mk({ send: async (_k, m) => { t0.push(m.text); return ++n === 1 ? { kind: "uncertain", message: "timeout" } : { kind: "accepted", providerId: "p" }; } });
    const t0: string[] = [];
    t.jobs.set("j", startJob(key, "j", "H", "a@b.com", 1_000_000));
    expect((await runJob(t.deps, "j")).status).toBe("auth_created");
    expect((await runJob(t.deps, "j")).status).toBe("sent");
    expect(t0[0]).toBe(t0[1]);
  });
  it("email conflict never resets or sends credentials", async () => {
    const t = mk({ auth: { createUser: async () => "exists" as const, findUserByEmail: async () => ({ id: "u9", provisioningJobId: "other" }) } });
    t.jobs.set("j", startJob(key, "j", "H", "a@b.com", 1_000_000));
    const j = await runJob(t.deps, "j");
    expect(j.status).toBe("needs_attention"); expect(t.sent).toHaveLength(0); expect(j.sealedPassword).toBeNull();
  });
  it("past 23h deadline drops credentials", async () => {
    const t = mk({ send: async () => ({ kind: "uncertain", message: "x" }) });
    t.jobs.set("j", startJob(key, "j", "H", "a@b.com", 1_000_000));
    await runJob(t.deps, "j"); t.advance(RETRY_DEADLINE_MS + 1);
    const j = await runJob(t.deps, "j");
    expect(j.status).toBe("needs_attention"); expect(j.sealedPassword).toBeNull(); expect(j.createdAt).toBe(1_000_000);
  });
});

describe("auth reconcile", () => {
  it("own earlier creation continues to send", async () => {
    const t = mk({ auth: { createUser: async () => "exists" as const, findUserByEmail: async () => ({ id: "u7", provisioningJobId: "j" }) } });
    t.jobs.set("j", startJob(key, "j", "H", "a@b.com", 1_000_000));
    const j = await runJob(t.deps, "j");
    expect(j.status).toBe("sent"); expect(j.authUserId).toBe("u7");
  });
});

describe("lease", () => {
  it("second worker is refused while lease held", async () => {
    const t = mk(); t.jobs.set("j", startJob(key, "j", "H", "a@b.com", 1_000_000));
    expect(await t.deps.store.claim("j", 60000, 1_000_000)).toBe(true);
    expect(await runJobLeased(t.deps, "j")).toBeUndefined();
    await t.deps.store.release("j");
    expect((await runJobLeased(t.deps, "j"))?.status).toBe("sent");
  });
});

describe("resend client", () => {
  const r = (status: number, body: unknown = {}) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  const m = { from: "f", to: "t", replyTo: "r", subject: "s", text: "t", html: "h", idempotencyKey: "k" };
  it("classifies results", async () => {
    expect(await sendViaResend("k", m, r(200, { id: "x" }))).toEqual({ kind: "accepted", providerId: "x" });
    expect((await sendViaResend("k", m, r(429))).kind).toBe("uncertain");
    expect((await sendViaResend("k", m, r(422))).kind).toBe("rejected");
    expect((await sendViaResend("k", m, (async () => { throw new Error("t"); }) as unknown as typeof fetch)).kind).toBe("uncertain");
  });
});

import { handleResendWebhook } from "../../src/email/webhook-handler";
describe("webhook handler", () => {
  const secret = "whsec_" + randomBytes(24).toString("base64");
  const sig = (id: string, ts: string, b: string) =>
    "v1," + createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${ts}.${b}`).digest("base64");
  const RANK: Record<string, number> = { queued: 0, accepted: 1, delayed: 2, delivered: 3, bounced: 4, failed: 4, complained: 4 };
  function store(known = ["e1"]) {
    const seen = new Set<string>(); const st = new Map<string, any>(known.map((k) => [k, "queued"]));
    return { st, s: {
      markSeen: async (i: string) => !seen.has(i) && !!seen.add(i),
      advance: async (m: string, v: any) => { const c = st.get(m); if (c === undefined) return null; if (RANK[c] < RANK[v]) st.set(m, v); return st.get(m); },
    } };
  }
  const body = (type: string) => JSON.stringify({ type, data: { email_id: "e1" } });
  it("dedupes, ignores unsigned, never regresses", async () => {
    const { st, s } = store(); const now = 1_000_000; const ts = String(now / 1000);
    const h = (id: string, b: string) => ({ id, timestamp: ts, signature: sig(id, ts, b) });
    const b1 = body("email.delivered");
    expect((await handleResendWebhook(secret, h("a", b1), b1, s, now)).status).toBe(200);
    expect((await handleResendWebhook(secret, h("a", b1), b1, s, now)).body.reason).toBe("duplicate");
    const b2 = body("email.sent");
    await handleResendWebhook(secret, h("b", b2), b2, s, now);
    expect(st.get("e1")).toBe("delivered");
    expect((await handleResendWebhook(secret, { id: "c", timestamp: ts, signature: "v1,AAAA" }, b1, s, now)).status).toBe(401);
    expect((await handleResendWebhook(undefined, h("a", b1), b1, s, now)).status).toBe(503);
  });
  it("unknown provider id returns 500 so Resend retries, and is not marked seen", async () => {
    const { s } = store([]); const now = 1_000_000; const ts = String(now / 1000); const b = body("email.delivered");
    const r = await handleResendWebhook(secret, { id: "z", timestamp: ts, signature: sig("z", ts, b) }, b, s, now);
    expect(r.status).toBe(500);
    expect(await s.markSeen("z")).toBe(true);
  });
  it("first terminal wins: failed then bounced keeps failed; complained is terminal", async () => {
    const { st, s } = store(["e1"]); const now = 1_000_000; const ts = String(now / 1000);
    for (const [id, t] of [["1", "email.failed"], ["2", "email.bounced"], ["3", "email.complained"]]) {
      const b = body(t); await handleResendWebhook(secret, { id, timestamp: ts, signature: sig(id, ts, b) }, b, s, now);
    }
    expect(st.get("e1")).toBe("failed");
  });
});

import { runRecoveryJob } from "../../src/email/provisioning";
describe("recovery jobs", () => {
  it("guide mail carries no password and no old credentials", async () => {
    const t = mk(); t.jobs.set("r", { id: "r", kind: "guide", hotelName: "H", email: "a@b.com", status: "pending", createdAt: 1_000_000 });
    const j = await runRecoveryJob(t.deps, "r");
    expect(j.status).toBe("sent"); expect(t.sent[0]).not.toMatch(/Password:/);
  });
  it("reset link without configured redirect needs attention and sends nothing", async () => {
    const t = mk(); t.jobs.set("r", { id: "r", kind: "recovery", hotelName: "H", email: "a@b.com", status: "pending", createdAt: 1_000_000 });
    const j = await runRecoveryJob(t.deps, "r");
    expect(j.status).toBe("needs_attention"); expect(t.sent).toHaveLength(0);
  });
  it("reset link is sent when generator is configured", async () => {
    const t = mk({ generateRecoveryLink: async () => "https://x.test/reset?t=1" });
    t.jobs.set("r", { id: "r", kind: "recovery", hotelName: "H", email: "a@b.com", status: "pending", createdAt: 1_000_000 });
    expect((await runRecoveryJob(t.deps, "r")).status).toBe("sent"); expect(t.sent[0]).toContain("https://x.test/reset");
  });
});

import { buildRecoveryLink, validRecoveryOrigin } from "../../src/email/provisioning";
describe("recovery link origin and construction", () => {
  const prod = "https://admin.manzanillareception.com";
  it("accepts only the exact prod origin in production", () => {
    expect(validRecoveryOrigin(prod, "production")).toBe(prod);
    expect(validRecoveryOrigin(prod + "/", "production")).toBeUndefined();
    expect(validRecoveryOrigin(prod + "/x", "production")).toBeUndefined();
    expect(validRecoveryOrigin("https://admin.manzanillareception.com.evil.test", "production")).toBeUndefined();
    expect(validRecoveryOrigin("http://localhost:3000", "production")).toBeUndefined();
    expect(validRecoveryOrigin(undefined, "production")).toBeUndefined();
  });
  it("allows local origin only outside production", () => {
    expect(validRecoveryOrigin("http://localhost:3000", "development")).toBeDefined();
    expect(validRecoveryOrigin("http://localhost:3000/path", "development")).toBeUndefined();
    expect(validRecoveryOrigin("https://localhost:3000", "development")).toBeUndefined();
  });
  it("builds an app-owned confirm link with encoded token and fixed next", () => {
    const u = new URL(buildRecoveryLink(prod, "a b&c=d"));
    expect(u.origin).toBe(prod); expect(u.pathname).toBe("/api/v1/auth/confirm");
    expect(u.searchParams.get("token_hash")).toBe("a b&c=d");
    expect(u.searchParams.get("type")).toBe("recovery"); expect(u.searchParams.get("next")).toBe("/reset-password");
  });
});
describe("job-bound sealing", () => {
  it("payload sealed for one job id cannot be opened as another", () => {
    const a = startJob(key, "id-a", "H", "a@b.com", 0);
    expect(() => decryptPayload(key, a.sealedPassword!, "welcome:id-b")).toThrow();
    expect(decryptPayload(key, a.sealedPassword!, "welcome:id-a")).toHaveLength(16);
  });
});

describe("requeued job with wiped payload", () => {
  it("does not send and tells operator to use recovery", async () => {
    const t = mk(); t.jobs.set("j", { id: "j", kind: "welcome", hotelName: "H", email: "a@b.com", status: "pending", createdAt: 1_000_000, sealedPassword: null });
    const j = await runJob(t.deps, "j");
    expect(j.status).toBe("needs_attention"); expect(j.lastError).toMatch(/use recovery/); expect(t.sent).toHaveLength(0);
  });
});
