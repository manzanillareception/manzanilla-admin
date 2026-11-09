import { eventToState, verifyWebhook, type DeliveryState } from "./webhook";

export interface DeliveryStore {
  /** Insert svix id; false if already seen (duplicate delivery). */
  markSeen(svixId: string): Promise<boolean>;
  /**
   * Atomic rank-ordered advance via public.advance_email_delivery. Returns the resulting state,
   * or null when the provider message id is unknown (never creates a row).
   */
  advance(providerMessageId: string, state: DeliveryState, at: Date): Promise<DeliveryState | null>;
}

export interface WebhookResult { status: number; body: { ok: boolean; reason?: string } }

/** Pure handler; the route file only reads headers/raw body and calls this. */
export async function handleResendWebhook(
  secret: string | undefined,
  headers: { id?: string | null; timestamp?: string | null; signature?: string | null },
  rawBody: string,
  store: DeliveryStore,
  now = Date.now(),
): Promise<WebhookResult> {
  if (!secret) return { status: 503, body: { ok: false, reason: "setup_required" } };
  if (!verifyWebhook(secret, headers, rawBody, Math.floor(now / 1000))) return { status: 401, body: { ok: false } };
  let evt: { type?: unknown; data?: { email_id?: unknown } };
  try { evt = JSON.parse(rawBody); } catch { return { status: 400, body: { ok: false } }; }
  if (!evt || typeof evt !== "object" || Array.isArray(evt)) return { status: 400, body: { ok: false } };
  const state = typeof evt.type === "string" ? eventToState(evt.type) : null;
  const mid = evt.data?.email_id;
  if (!state || typeof mid !== "string" || !mid || mid.length > 256) return { status: 200, body: { ok: true, reason: "ignored" } };
  // Apply first, record the id after: a crash between the two means a harmless re-apply
  // (advance is monotonic), never a lost event.
  try {
    const result = await store.advance(mid, state, new Date(now));
    // Unknown id: the send path inserts the row at provider acceptance; Resend should retry.
    if (result === null) return { status: 500, body: { ok: false, reason: "unknown_message_retry" } };
    if (!(await store.markSeen(headers.id as string))) return { status: 200, body: { ok: true, reason: "duplicate" } };
    return { status: 200, body: { ok: true } };
  } catch {
    // Do not expose provider IDs or database diagnostics; ask provider to retry.
    return { status: 503, body: { ok: false, reason: "storage_unavailable_retry" } };
  }
}
