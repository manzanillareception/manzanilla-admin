import { decryptPayload, encryptPayload } from "./crypto";
import { generateInitialPassword } from "./password";
import { renderGuideOnly, renderWelcome } from "./templates";
import { sendViaResend, type SendResult } from "./resend";

export const RETRY_DEADLINE_MS = 23 * 60 * 60 * 1000;

export type JobStatus = "pending" | "auth_created" | "sent" | "needs_attention" | "done";

export interface Job {
  id: string;
  hotelId?: string;
  kind?: "welcome" | "guide" | "recovery";
  hotelName: string;
  email: string;
  status: JobStatus;
  authUserId?: string;
  sealedPassword?: string | null;
  createdAt: number; // fixed; never extended on retry
  providerId?: string;
  lastError?: string;
}

export interface Store {
  get(id: string): Promise<Job | undefined>;
  save(job: Job): Promise<void>;
  /**
   * Atomically take a short lease (single conditional UPDATE ... WHERE lease_until IS NULL OR lease_until < now
   * RETURNING). Returns false if another worker holds it. Never hold DB locks across external calls.
   * Interface-level tests use an in-memory fake; real concurrency needs Postgres tests.
   */
  claim(id: string, leaseMs: number, now: number): Promise<boolean>;
  release(id: string): Promise<void>;
}

export const LEASE_MS = 60_000;

/** Claim, run one step sequence, always release. Returns undefined if another worker holds the lease. */
export async function runJobLeased(d: Deps, id: string, run: (d: Deps, id: string) => Promise<Job> = runJob): Promise<Job | undefined> {
  const now = (d.now ?? Date.now)();
  if (!(await d.store.claim(id, LEASE_MS, now))) return undefined;
  try {
    return await run(d, id);
  } finally {
    await d.store.release(id);
  }
}

export interface AuthAdmin {
  /** Returns user id, or "exists" when the email is already registered. Must not reset existing users. */
  createUser(email: string, password: string, provisioningJobId: string): Promise<{ id: string } | "exists">;
  /** provisioningJobId is read from server-set app_metadata written by createUser (not user-editable). */
  findUserByEmail(email: string): Promise<{ id: string; provisioningJobId?: string } | undefined>;
}

export interface Deps {
  store: Store;
  auth: AuthAdmin;
  key: Buffer;
  apiKey: string;
  from: string;
  replyTo: string;
  loginUrl: string;
  /** Insert email_deliveries row for an accepted message (idempotent). */
  /** Idempotent link of the Auth user to its hotel (public.link_hotel_user). */
  linkHotelUser?: (hotelId: string, authUserId: string, email: string) => Promise<void>;
  /** Returns an app-owned reset link built from a generateLink hashed_token. Undefined => recovery job needs_attention. */
  generateRecoveryLink?: (email: string) => Promise<string | undefined>;
  recordDelivery?: (providerMessageId: string, jobId: string, kind: "welcome" | "guide" | "recovery") => Promise<void>;
  now?: () => number;
  send?: (apiKey: string, m: Parameters<typeof sendViaResend>[1]) => Promise<SendResult>;
}

// AAD binds the payload to the job id (preallocated by the caller before sealing).
const aad = (j: Pick<Job, "id">) => `welcome:${j.id}`;

/** Generates the initial password and seals it under the preallocated job id; no later "pending" write is needed. */
export function startJob(key: Buffer, id: string, hotelName: string, email: string, now: number): Job {
  const job: Job = { id, kind: "welcome", hotelName, email: email.trim().toLowerCase(), status: "pending", createdAt: now };
  return { ...job, sealedPassword: encryptPayload(key, generateInitialPassword(), aad(job)) };
}

/** Advance one job. Safe to call repeatedly (duplicate workers, retries after crash). */
export async function runJob(d: Deps, id: string): Promise<Job> {
  const now = (d.now ?? Date.now)();
  const send = d.send ?? sendViaResend;
  let job = await d.store.get(id);
  if (!job) throw new Error("unknown job");
  if (job.status === "sent" || job.status === "done" || job.status === "needs_attention") return job;

  const expired = now - job.createdAt > RETRY_DEADLINE_MS;

  if (job.status === "pending") {
    if (expired) return fail(d, job, "deadline passed before account creation");
    if (!job.sealedPassword) return fail(d, job, "credentials no longer held (payload wiped); use recovery: send guide or reset link");
    const password = decryptPayload(d.key, job.sealedPassword, aad(job));
    let created = await d.auth.createUser(job.email, password, job.id);
    if (created === "exists") {
      // Uncertain: could be our own earlier attempt (created, then stage write lost). Reconcile; never reset.
      const existing = await d.auth.findUserByEmail(job.email);
      if (!existing) return fail(d, job, "email conflict, account not found");
      if (existing.provisioningJobId === job.id) {
        created = { id: existing.id }; // our own earlier creation: continue to send with the sealed password
      } else {
        job = { ...job, status: "needs_attention", authUserId: existing.id, sealedPassword: null,
          lastError: "account already existed; password not changed, no credentials sent" };
        await d.store.save(job);
        return job;
      }
    }
    job = { ...job, status: "auth_created", authUserId: created.id };
    await d.store.save(job);
  }

  if (job.status === "auth_created") {
    if (job.hotelId && job.authUserId) await d.linkHotelUser?.(job.hotelId, job.authUserId, job.email);
    if (expired || !job.sealedPassword) {
      return expireWithoutPassword(d, job);
    }
    const password = decryptPayload(d.key, job.sealedPassword, aad(job));
    const body = renderWelcome({ hotelName: job.hotelName, loginEmail: job.email, password,
      loginUrl: d.loginUrl, supportEmail: d.replyTo });
    const r = await send(d.apiKey, { from: d.from, to: job.email, replyTo: d.replyTo, ...body,
      idempotencyKey: `welcome-${job.id}` });
    if (r.kind === "accepted") {
      // Delivery row first (idempotent). If it fails we retry with the same idempotency key.
      try { await d.recordDelivery?.(r.providerId, job.id, "welcome"); }
      catch { return job; }
      job = { ...job, status: "sent", providerId: r.providerId, sealedPassword: null };
    } else if (r.kind === "rejected") {
      job = { ...job, status: "needs_attention", sealedPassword: null, lastError: r.message };
    } else {
      return job; // uncertain: keep payload and state; retry with the same idempotency key
    }
    await d.store.save(job);
  }
  return job;
}

async function fail(d: Deps, job: Job, why: string): Promise<Job> {
  const j = { ...job, status: "needs_attention" as const, sealedPassword: null, lastError: why };
  await d.store.save(j);
  return j;
}

/** After deadline: drop the payload, mark for operator; operator may send a guide without password. */
async function expireWithoutPassword(d: Deps, job: Job): Promise<Job> {
  return fail(d, job, "retry deadline reached; credentials not sent");
}

export async function sendGuideOnly(d: Deps, job: Job): Promise<SendResult> {
  const body = renderGuideOnly({ hotelName: job.hotelName, loginEmail: job.email,
    loginUrl: d.loginUrl, supportEmail: d.replyTo });
  return (d.send ?? sendViaResend)(d.apiKey, { from: d.from, to: job.email, replyTo: d.replyTo, ...body,
    idempotencyKey: `guide-${job.id}-${(d.now ?? Date.now)()}` });
}

/**
 * Recovery jobs (kind guide | recovery). No password is ever involved.
 * guide: password-free sign-in guide. recovery: Supabase reset link (needs allow-listed redirect).
 * Never replays old credentials. Idempotency key is per job id.
 */
export async function runRecoveryJob(d: Deps, id: string): Promise<Job> {
  const send = d.send ?? sendViaResend;
  const job = await d.store.get(id);
  if (!job) throw new Error("unknown job");
  if (job.status !== "pending" || (job.kind !== "guide" && job.kind !== "recovery")) return job;
  if ((d.now ?? Date.now)() - job.createdAt > RETRY_DEADLINE_MS) return fail(d, job, "deadline passed");
  let body: { subject: string; text: string; html: string };
  if (job.kind === "guide") {
    body = renderGuideOnly({ hotelName: job.hotelName, loginEmail: job.email, loginUrl: d.loginUrl, supportEmail: d.replyTo });
  } else {
    const link = await d.generateRecoveryLink?.(job.email);
    if (!link) return fail(d, job, "reset link unavailable (redirect not configured)");
    const text = `Reset your Manzanilla password: ${link}\nIf you did not ask for this, ignore this email.\nQuestions: ${d.replyTo}`;
    body = { subject: "Reset your Manzanilla password", text, html: `<p>Reset your Manzanilla password: <a href="${link}">reset link</a></p><p>If you did not ask for this, ignore this email.</p>` };
  }
  const r = await send(d.apiKey, { from: d.from, to: job.email, replyTo: d.replyTo, ...body, idempotencyKey: `${job.kind}-${job.id}` });
  if (r.kind === "accepted") {
    try { await d.recordDelivery?.(r.providerId, job.id, job.kind); } catch { return job; }
    const j = { ...job, status: "sent" as const, providerId: r.providerId };
    await d.store.save(j);
    return j;
  }
  if (r.kind === "rejected") return fail(d, job, r.message);
  return job;
}

const PROD_ORIGIN = "https://admin.manzanillareception.com";
/** App-owned confirm route (backend lane). It exchanges token_hash via verifyOtp; nothing is exchanged by GoTrue redirect. */
export const RECOVERY_CONFIRM_PATH = "/api/v1/auth/confirm";
export const RECOVERY_NEXT = "/reset-password";

/** Hard allowlist for the origin used in reset links. Production: exactly the constant. Local only outside production. */
export function validRecoveryOrigin(origin: string | undefined, nodeEnv: string | undefined = process.env.NODE_ENV): string | undefined {
  if (!origin) return undefined;
  if (origin === PROD_ORIGIN) return origin;
  if (nodeEnv !== "production" && /^http:\/\/(localhost|127\.0\.0\.1):\d{2,5}$/.test(origin)) return origin;
  return undefined;
}

/** Builds the app-owned link from a GoTrue hashed_token. The token never appears in logs or errors. */
export function buildRecoveryLink(origin: string, hashedToken: string): string {
  const q = new URLSearchParams({ token_hash: hashedToken, type: "recovery", next: RECOVERY_NEXT });
  return `${origin}${RECOVERY_CONFIRM_PATH}?${q.toString()}`;
}
