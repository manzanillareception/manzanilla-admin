export interface OutgoingEmail {
  from: string;
  to: string;
  replyTo: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
}

export type SendResult =
  | { kind: "accepted"; providerId: string }
  | { kind: "rejected"; status: number; message: string }
  | { kind: "uncertain"; message: string };

/** Resend REST client. Tracking is a domain setting; credential mail must keep it off. */
export async function sendViaResend(
  apiKey: string,
  m: OutgoingEmail,
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "idempotency-key": m.idempotencyKey,
      },
      body: JSON.stringify({
        from: m.from, to: [m.to], reply_to: m.replyTo, subject: m.subject, text: m.text, html: m.html,
      }),
    });
  } catch (e) {
    return { kind: "uncertain", message: e instanceof Error ? e.message : "network" };
  }
  if (res.ok) {
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    return body.id ? { kind: "accepted", providerId: body.id } : { kind: "uncertain", message: "no id" };
  }
  // 429 and 5xx: retry with same key. Other 4xx: permanent.
  if (res.status === 429 || res.status >= 500) return { kind: "uncertain", message: `status ${res.status}` };
  return { kind: "rejected", status: res.status, message: `status ${res.status}` };
}
