import { createServiceClient, getSupabaseEnv } from "../../../../../lib/supabase/server";
import { handleResendWebhook } from "../../../../../email/webhook-handler";
import { createDeliveryStore } from "../../../../../email/supabase-adapters";

import { readTextBody } from "../../../../../lib/api/read-body";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const env = getSupabaseEnv();
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!env || !secret) return Response.json({ error: { code: "SETUP_REQUIRED", message: "Not configured", retryable: true } }, { status: 503 });
  const body = await readTextBody(req, 256 * 1024);
  if (!body.ok) return body.response;
  const raw = body.text; // bounded, unparsed body required for signature
  const r = await handleResendWebhook(
    secret,
    { id: req.headers.get("svix-id"), timestamp: req.headers.get("svix-timestamp"), signature: req.headers.get("svix-signature") },
    raw,
    createDeliveryStore(createServiceClient(env)),
  );
  return Response.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
