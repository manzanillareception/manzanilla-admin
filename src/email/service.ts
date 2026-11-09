import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadPayloadKey } from "./crypto";
import { RETRY_DEADLINE_MS, runJob, runJobLeased, runRecoveryJob, startJob, buildRecoveryLink, validRecoveryOrigin, type Deps } from "./provisioning";
import { createAuthAdmin, createStore, linkHotelUser, recordDelivery } from "./supabase-adapters";
import type { HotelDeps, RecoveryDeps } from "./routes";

/** Builds deps from env. Returns null (route answers 503 SETUP_REQUIRED) if any required value is missing. */
export function buildDeps(db: SupabaseClient, env: NodeJS.ProcessEnv = process.env): Deps | null {
  const { RESEND_API_KEY, EMAIL_FROM, EMAIL_REPLY_TO, EMAIL_PAYLOAD_KEY, ADMIN_BASE_URL } = env;
  if (!RESEND_API_KEY || !EMAIL_FROM || !EMAIL_REPLY_TO || !EMAIL_PAYLOAD_KEY || !ADMIN_BASE_URL) return null;
  const origin = validRecoveryOrigin(env.RECOVERY_LINK_ORIGIN, env.NODE_ENV); // hard allowlist
  return {
    store: createStore(db, `worker-${randomUUID()}`),
    auth: createAuthAdmin(db),
    key: loadPayloadKey(EMAIL_PAYLOAD_KEY),
    apiKey: RESEND_API_KEY, from: EMAIL_FROM, replyTo: EMAIL_REPLY_TO, loginUrl: ADMIN_BASE_URL,
    linkHotelUser: (h, u, e) => linkHotelUser(db, h, u, e),
    recordDelivery: (m, j, k) => recordDelivery(db, m, j, k),
    generateRecoveryLink: origin
      ? async (email) => {
          // hashed_token + app-owned verifyOtp route keeps one token-exchange path; no implicit fragment.
          const { data, error } = await db.auth.admin.generateLink({ type: "recovery", email });
          const hashed = error ? undefined : data.properties?.hashed_token;
          return hashed ? buildRecoveryLink(origin, hashed) : undefined;
        }
      : undefined,
  };
}

type Gate = HotelDeps["gate"];

export function hotelRouteDeps(db: SupabaseClient, d: Deps, gate: Gate): HotelDeps {
  return {
    gate,
    async createHotelWithJob({ hotelName, city, email, adminUserId }) {
      const preJobId = randomUUID(); // AAD binds the sealed payload to this id
      const sealed = startJob(d.key, preJobId, hotelName, email, Date.now()).sealedPassword;
      const { data, error } = await db.rpc("create_hotel_with_job", {
        p_name: hotelName, p_city: city, p_email: email, p_sealed_password: sealed,
        p_deadline_at: new Date(Date.now() + RETRY_DEADLINE_MS).toISOString(), p_admin: adminUserId, p_job_id: preJobId,
      });
      if (error) throw new Error(`create_hotel_with_job: ${error.code ?? "error"}`);
      const r = (Array.isArray(data) ? data[0] : data) as { hotel_id: string; job_id: string; already_existed: boolean };
      return { hotelId: r.hotel_id, jobId: r.job_id, duplicate: r.already_existed === true };
    },
    async runJob(jobId) {
      const j = await runJobLeased(d, jobId, runJob);
      return j ? { status: j.status, lastError: j.lastError } : undefined;
    },
  };
}

export function recoveryRouteDeps(db: SupabaseClient, d: Deps, gate: Gate): RecoveryDeps {
  return {
    gate,
    async sendRecovery(hotelId, mode, adminUserId) {
      const { data, error } = await db.rpc("create_recovery_job", {
        p_hotel_id: hotelId, p_kind: mode === "guide" ? "guide" : "recovery", p_admin: adminUserId, p_job_id: randomUUID(),
      });
      if (error) {
        if (error.message?.includes("MNZ:NOT_FOUND")) return "not_found";
        throw new Error(`create_recovery_job: ${error.code ?? "error"}`);
      }
      const r = (Array.isArray(data) ? data[0] : data) as { job_id: string };
      try { await runJobLeased(d, r.job_id, runRecoveryJob); } catch { /* job exists; operator can retry */ }
      return { jobId: r.job_id };
    },
  };
}
