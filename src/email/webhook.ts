import { createHmac, timingSafeEqual } from "node:crypto";

/** Verify a Svix-style signed Resend webhook. Returns false on any problem. */
export function verifyWebhook(
  secret: string,
  headers: { id?: string | null; timestamp?: string | null; signature?: string | null },
  rawBody: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > toleranceSeconds) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest();
  return signature.split(" ").some((part) => {
    const [v, sig] = part.split(",");
    if (v !== "v1" || !sig) return false;
    const got = Buffer.from(sig, "base64");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

export type DeliveryState = "queued" | "accepted" | "delivered" | "delayed" | "bounced" | "failed" | "complained";
const RANK: Record<DeliveryState, number> = { queued: 0, accepted: 1, delayed: 2, delivered: 3, bounced: 4, failed: 4, complained: 4 };

export function eventToState(type: string): DeliveryState | null {
  switch (type) {
    case "email.sent": return "accepted";
    case "email.delivered": return "delivered";
    case "email.delivery_delayed": return "delayed";
    case "email.bounced": return "bounced";
    case "email.failed": case "email.suppressed": return "failed";
    case "email.complained": return "complained";
    default: return null;
  }
}

/** Out-of-order safe: never move to a lower-ranked state; terminal states stay put. */
export function advance(current: DeliveryState, next: DeliveryState): DeliveryState {
  if (RANK[current] >= 4) return current;
  return RANK[next] > RANK[current] ? next : current;
}
