import { z } from "zod";
import { readJsonBody } from "../lib/api/read-body";
import { checkRateLimit } from "../lib/auth/rate-limit";

/** Local mirror of the backend lane's frozen helper types (src/lib/auth/admin.ts). */
export type AdminGate = (req: Request) => Promise<{ ok: true; admin: { userId: string }; applyCookies?: (r: Response) => Response } | { ok: false; response: Response }>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const err = (status: number, code: string, message: string, retryable = false) =>
  json(status, { error: { code, message, retryable } });

export const createHotelBody = z.object({
  hotelName: z.string().trim().min(1).max(120),
  city: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
  /** Admin must confirm the reviewed destination; guards against misdirected sends. */
  confirmEmail: z.string().trim().toLowerCase().email().max(254),
}).strict().refine((b) => b.email === b.confirmEmail, { message: "email confirmation mismatch", path: ["confirmEmail"] });

export interface HotelDeps {
  gate: AdminGate;
  /** Creates hotel row + pending provisioning job in one DB transaction. Returns existing ids on duplicate request. */
  createHotelWithJob(input: { hotelName: string; city: string; email: string; adminUserId: string }): Promise<{ hotelId: string; jobId: string; duplicate: boolean }>;
  /** Leased run; returns status only, never password or sealed payload. */
  runJob(jobId: string): Promise<{ status: string; lastError?: string } | undefined>;
}

export async function postAdminHotels(req: Request, d: HotelDeps): Promise<Response> {
  const auth = await d.gate(req);
  if (!auth.ok) return auth.response;
  const limit = await checkRateLimit(`admin:${auth.admin.userId}:create-hotel`, 10, 60_000);
  if (!limit.allowed) return err(limit.unavailable ? 503 : 429, limit.unavailable ? "RATE_LIMIT_UNAVAILABLE" : "RATE_LIMITED", "Please retry shortly.", true);
  const body = await readJsonBody(req, 8192);
  if (!body.ok) return body.response;
  const parsed = createHotelBody.safeParse(body.raw);
  if (!parsed.success) return err(400, "VALIDATION_FAILED", "Invalid hotel request");
  const { hotelId, jobId, duplicate } = await d.createHotelWithJob({
    hotelName: parsed.data.hotelName, city: parsed.data.city, email: parsed.data.email, adminUserId: auth.admin.userId,
  });
  // The hotel and job already exist. A failure while running the job (provider, lease, network) must not
  // look like a failed create: report in_progress and let a retry or the operator continue.
  let r: { status: string; lastError?: string } | undefined;
  try { r = await d.runJob(jobId); } catch { r = undefined; }
  const status = r?.status ?? "in_progress";
  // needs_attention means the sealed password is gone; requeue cannot resend it. Operator uses recovery.
  const nextStep = status === "needs_attention" ? "use_recovery" : undefined;
  // Delivery state is "accepted by provider", not "read".
  return json(202, { hotelId, jobId, duplicate, status, ...(nextStep ? { nextStep } : {}) });
}

export interface RecoveryDeps {
  gate: AdminGate;
  /** Sends guide without password, or a reset link. Never replays old credentials. */
  sendRecovery(hotelId: string, mode: "guide" | "reset_link", adminUserId: string): Promise<{ jobId: string } | "not_found">;
}

export async function postHotelRecovery(req: Request, hotelId: string, d: RecoveryDeps): Promise<Response> {
  const auth = await d.gate(req);
  if (!auth.ok) return auth.response;
  if (!z.string().uuid().safeParse(hotelId).success) return err(400, "VALIDATION_FAILED", "Invalid hotel id");
  const limit = await checkRateLimit(`admin:${auth.admin.userId}:recovery`, 10, 60_000);
  if (!limit.allowed) return err(limit.unavailable ? 503 : 429, limit.unavailable ? "RATE_LIMIT_UNAVAILABLE" : "RATE_LIMITED", "Please retry shortly.", true);
  const body = await readJsonBody(req, 2048);
  if (!body.ok) return body.response;
  const p = z.object({ mode: z.enum(["guide", "reset_link"]) }).strict().safeParse(body.raw);
  if (!p.success) return err(400, "VALIDATION_FAILED", "Invalid recovery request");
  let r: Awaited<ReturnType<RecoveryDeps["sendRecovery"]>>;
  try { r = await d.sendRecovery(hotelId, p.data.mode, auth.admin.userId); }
  catch { return err(500, "INTERNAL", "Could not start recovery.", true); }
  if (r === "not_found") return err(404, "NOT_FOUND", "Hotel not found");
  return json(202, { jobId: r.jobId });
}
