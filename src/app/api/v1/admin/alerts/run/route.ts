import { errorResponse, jsonResponse } from "../../../../../../lib/auth/errors";
import { checkRateLimit } from "../../../../../../lib/auth/rate-limit";
import { clientIp } from "../../../../../../lib/api/read-body";
import { requireEnabledAdmin } from "../../../../../../lib/auth/admin";
import { createServiceClient, getSupabaseEnv } from "../../../../../../lib/supabase/server";
import { captureSender, resendSender, runAlertWorker } from "../../../../../../email/alert-worker";

/** Explicit operator invocation of one alert worker pass. Admin-gated; capture mode when
 *  ALERT_CAPTURE_PATH is set (local runs never touch the provider). */
export async function POST(request: Request): Promise<Response> {
  // CSRF: cookie-authenticated mutation - a cross-origin form post is rejected. Same-origin
  // fetches and non-browser clients (no Origin header) pass.
  const origin = request.headers.get("origin");
  if (origin) {
    let host: string | null = null;
    try { host = new URL(origin).host; } catch { /* invalid origin */ }
    if (!host || host !== request.headers.get("host")) {
      return errorResponse(403, "FORBIDDEN", "Cross-origin request rejected.");
    }
  }
  const limit = checkRateLimit(`ip:${clientIp(request)}:alerts-run`, 10, 60_000);
  if (!limit.allowed) return errorResponse(429, "RATE_LIMITED", "Too many worker runs.", { retryable: true, retryAfterMs: limit.retryAfterMs });
  // MFA: requireEnabledAdmin enforces aal2 whenever the environment requires MFA (contract rev7).
  const auth = await requireEnabledAdmin(request);
  if (!auth.ok) return auth.response;
  const env = getSupabaseEnv();
  const db = env ? createServiceClient(env) : null;
  if (!db) return errorResponse(503, "SETUP_REQUIRED", "Alert worker is not configured.");
  // Capture mode is a local-only adapter; a production build can never select it.
  const capturePath = process.env.NODE_ENV === "production" ? undefined : process.env.ALERT_CAPTURE_PATH;
  const sender = capturePath
    ? captureSender(capturePath)
    : process.env.RESEND_API_KEY && process.env.EMAIL_FROM && process.env.EMAIL_REPLY_TO
      ? resendSender(process.env.RESEND_API_KEY)
      : null;
  if (!sender) return errorResponse(503, "SETUP_REQUIRED", "No alert sender configured.");
  const result = await runAlertWorker({ db, sender, from: process.env.EMAIL_FROM ?? "alerts@localhost", replyTo: process.env.EMAIL_REPLY_TO ?? "support@localhost" });
  return jsonResponse(202, result);
}
