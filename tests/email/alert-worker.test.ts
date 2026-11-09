import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { alertMessage, captureSender, runAlertWorker, type AlertRow, type IncidentRow } from "../../src/email/alert-worker";

const row: AlertRow = { id: "a1", incident_id: "i1", recipient: "ops@example.com", attempts: 0 };
const inc: IncidentRow = { reference: "INC-1", severity: "high", component: "network", error_code: "CONNECTION_TIMEOUT", occurrences: 3, due_at: "2026-11-10T08:00:00Z" };

function fakeDb(markErrors = false) {
  return {
    rpc: vi.fn(async (name: string) => {
      if (name === "claim_alert_notifications") return { data: ["a1"], error: null };
      return { data: "sent", error: markErrors ? { message: "lease lost" } : null };
    }),
    from: vi.fn((t: string) => ({
      select: () => ({ eq: () => ({ limit: () => Promise.resolve({ data: t === "alert_notifications" ? [row] : [inc] }) }) }),
    })),
  };
}

describe("alert worker", () => {
  it("claims, sends and marks each attempt", async () => {
    const db = fakeDb();
    const sender = vi.fn(async () => ({ kind: "accepted", providerId: "p1" }) as const);
    const r = await runAlertWorker({ db: db as never, sender, from: "a@b.c", replyTo: "s@b.c", workerId: "w1" });
    expect(r).toEqual({ claimed: 1, sent: 1, failed: 0 });
    expect(db.rpc).toHaveBeenCalledWith("mark_alert_attempt", { p_id: "a1", p_worker: "w1", p_ok: true });
  });
  it("records failed attempts without throwing", async () => {
    const db = fakeDb();
    const sender = vi.fn(async () => ({ kind: "uncertain", message: "status 500" }) as const);
    const r = await runAlertWorker({ db: db as never, sender, from: "a@b.c", replyTo: "s@b.c", workerId: "w1" });
    expect(r).toEqual({ claimed: 1, sent: 0, failed: 1 });
    expect(db.rpc).toHaveBeenCalledWith("mark_alert_attempt", { p_id: "a1", p_worker: "w1", p_ok: false });
  });
  it("idempotency key is stable per row+attempt", () => {
    const m = alertMessage("f", "r", row, inc);
    expect(m.idempotencyKey).toBe("alert-a1-attempt-1");
    expect(m.subject).toContain("INC-1");
    expect(m.text).not.toContain("device");
  });
  it("capture adapter appends JSONL and never sends", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cap-"));
    const p = join(dir, "capture.jsonl");
    const s = captureSender(p);
    const r = await s(alertMessage("f", "r", row, inc));
    expect(r.kind).toBe("accepted");
    expect(readFileSync(p, "utf8")).toContain("ops@example.com");
  });
});
