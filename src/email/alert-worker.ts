import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendViaResend, type OutgoingEmail, type SendResult } from "./resend";

/** Alert mail carries only server-owned incident fields - never device text or event payloads. */
export interface AlertRow { id: string; incident_id: string; recipient: string; attempts: number }
export interface IncidentRow { reference: string; severity: string; component: string; error_code: string; occurrences: number; due_at: string }

export type AlertSender = (m: OutgoingEmail) => Promise<SendResult>;

/** Local capture adapter: appends JSONL instead of sending. Real sends stay externally gated. */
export function captureSender(path: string): AlertSender {
  return async (m) => {
    await appendFile(path, JSON.stringify({ to: m.to, subject: m.subject, idempotencyKey: m.idempotencyKey, at: new Date().toISOString() }) + "\n");
    return { kind: "accepted", providerId: `capture-${randomUUID()}` };
  };
}

export function resendSender(apiKey: string): AlertSender {
  return (m) => sendViaResend(apiKey, m);
}

export function alertMessage(from: string, replyTo: string, row: AlertRow, inc: IncidentRow): OutgoingEmail {
  const subject = `[Manzanilla] Incident ${inc.reference} (${inc.severity})`;
  const text = `Incident ${inc.reference}\nSeverity: ${inc.severity}\nComponent: ${inc.component}\nCode: ${inc.error_code}\nOccurrences: ${inc.occurrences}\nDue: ${inc.due_at}\n`;
  // Per-attempt key (backend review, crash-safe): attempts increments ONLY on a lease-fenced
  // mark, so a crash between provider acceptance and the mark replays the same attempt number -
  // the provider sees the same Idempotency-Key and dedupes.
  return { from, to: row.recipient, replyTo, subject, text, html: "", idempotencyKey: `alert-${row.id}-attempt-${row.attempts + 1}` };
}

export interface AlertWorkerDeps { db: SupabaseClient; sender: AlertSender; from: string; replyTo: string; workerId?: string; limit?: number }

/** One bounded worker pass: claim due alerts under lease, send, record each attempt lease-fenced. */
export async function runAlertWorker(d: AlertWorkerDeps): Promise<{ claimed: number; sent: number; failed: number }> {
  const workerId = d.workerId ?? `alert-worker-${randomUUID()}`;
  const { data: ids, error } = await d.db.rpc("claim_alert_notifications", { p_worker: workerId, p_limit: d.limit ?? 20, p_lease_seconds: 120 });
  if (error) throw new Error(`claim_alert_notifications: ${error.message}`);
  let sent = 0, failed = 0;
  for (const id of (ids ?? []) as string[]) {
    const { data: rows } = await d.db.from("alert_notifications").select("id,incident_id,recipient,attempts").eq("id", id).limit(1);
    const row = rows?.[0] as AlertRow | undefined;
    if (!row) continue;
    const { data: incs } = await d.db.from("incidents").select("reference,severity,component,error_code,occurrences,due_at").eq("id", row.incident_id).limit(1);
    const inc = incs?.[0] as IncidentRow | undefined;
    if (!inc) continue;
    const r = await d.sender(alertMessage(d.from, d.replyTo, row, inc));
    const ok = r.kind === "accepted";
    const { error: markErr } = await d.db.rpc("mark_alert_attempt", { p_id: row.id, p_worker: workerId, p_ok: ok });
    if (markErr) continue; // lease lost or already advanced; another worker owns the outcome
    if (ok) sent += 1; else failed += 1;
  }
  return { claimed: ((ids ?? []) as string[]).length, sent, failed };
}
