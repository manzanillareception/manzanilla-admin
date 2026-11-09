import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthAdmin, Job, Store } from "./provisioning";
import { RETRY_DEADLINE_MS } from "./provisioning";
import type { DeliveryStore } from "./webhook-handler";
import type { DeliveryState } from "./webhook";

/**
 * Supabase adapters over public service-role RPC wrappers (migration 0003) and the Auth admin API.
 * Service-role client only. Uses RPCs from migrations 0003 and 0005 (get_provisioning_job returns the sealed payload, service_role only).
 * NOT run against a real database yet.
 */
type Row = {
  id: string; hotel_id: string; kind: Job["kind"]; hotel_name: string; email: string; status: Job["status"]; auth_user_id: string | null;
  sealed_password: string | null; deadline_at: string; provider_message_id: string | null; last_error: string | null;
};

export function createStore(db: SupabaseClient, workerId: string): Store {
  return {
    async get(id) {
      const { data, error } = await db.rpc("get_provisioning_job", { p_job_id: id });
      if (error) throw new Error(`get_provisioning_job: ${error.code ?? "error"}`);
      const r = (Array.isArray(data) ? data[0] : data) as Row | null | undefined;
      if (!r) return undefined;
      return {
        id: r.id, hotelId: r.hotel_id, kind: r.kind, hotelName: r.hotel_name, email: r.email, status: r.status,
        authUserId: r.auth_user_id ?? undefined, sealedPassword: r.sealed_password,
        createdAt: new Date(r.deadline_at).getTime() - RETRY_DEADLINE_MS, // deadline is fixed in the DB
        providerId: r.provider_message_id ?? undefined, lastError: r.last_error ?? undefined,
      };
    },
    async save(job) {
      const wipe = job.sealedPassword == null;
      const { data, error } = await db.rpc("provisioning_stage_write", {
        p_job_id: job.id, p_worker: workerId, p_status: job.status,
        p_auth_user_id: job.authUserId ?? null,
        p_sealed_password: job.sealedPassword ?? null, p_set_sealed: wipe,
        p_provider_message_id: job.providerId ?? null, p_last_error: job.lastError ?? null,
        p_clear_error: false,
      });
      if (error) throw new Error(`provisioning_stage_write: ${error.code ?? "error"}`);
      if (data !== true) throw new Error("lease lost or illegal transition"); // zero rows written: stop this run
    },
    async claim(id, leaseMs) {
      const { data, error } = await db.rpc("claim_provisioning_job", {
        p_job_id: id, p_worker: workerId, p_lease_seconds: Math.ceil(leaseMs / 1000),
      });
      if (error) throw new Error(`claim_provisioning_job: ${error.code ?? "error"}`);
      return data !== null && data !== undefined;
    },
    async release(id) {
      await db.rpc("release_provisioning_job", { p_job_id: id, p_worker: workerId });
    },
  };
}

export function createAuthAdmin(db: SupabaseClient): AuthAdmin {
  return {
    async createUser(email, password, provisioningJobId) {
      const { data, error } = await db.auth.admin.createUser({
        email, password, email_confirm: true, // admin-provisioned: not proof of inbox ownership
        app_metadata: { provisioning_job_id: provisioningJobId }, // server-set; never user_metadata
      });
      if (error) {
        if (error.code === "email_exists" || /already (been )?registered/i.test(error.message)) return "exists";
        throw new Error(`createUser: ${error.code ?? "error"}`);
      }
      return { id: data.user.id };
    },
    async findUserByEmail(email) {
      const { data, error } = await db.rpc("lookup_auth_user_by_email", { p_email: email });
      if (error) throw new Error(`lookup_auth_user_by_email: ${error.code ?? "error"}`);
      const r = (Array.isArray(data) ? data[0] : data) as { id: string; provisioning_job_id: string | null } | undefined;
      return r ? { id: r.id, provisioningJobId: r.provisioning_job_id ?? undefined } : undefined;
    },
  };
}

export function createDeliveryStore(db: SupabaseClient): DeliveryStore {
  return {
    async markSeen(svixId) {
      // public.mark_webhook_seen(p_svix_id) = INSERT ... ON CONFLICT DO NOTHING; returns true only for the
      // single caller that inserted. Requested migration; the private schema is not exposed directly.
      const { data, error } = await db.rpc("mark_webhook_seen", { p_svix_id: svixId });
      if (error) throw new Error(`mark_webhook_seen: ${error.code ?? "error"}`);
      return data === true;
    },
    async advance(id, state: DeliveryState, at) {
      const { data, error } = await db.rpc("advance_email_delivery", { p_id: id, p_state: state, p_event_at: at.toISOString() });
      if (error) throw new Error(`advance_email_delivery: ${error.code ?? "error"}`);
      return (data ?? null) as DeliveryState | null;
    },
  };
}

export async function recordDelivery(db: SupabaseClient, providerMessageId: string, jobId: string, kind: "welcome" | "guide" | "recovery") {
  const { error } = await db.from("email_deliveries").upsert(
    { provider_message_id: providerMessageId, job_id: jobId, kind, state: "accepted" },
    { onConflict: "provider_message_id", ignoreDuplicates: true },
  );
  if (error) throw new Error("email_deliveries insert failed");
}

export async function linkHotelUser(db: SupabaseClient, hotelId: string, authUserId: string, email: string) {
  const { error } = await db.rpc("link_hotel_user", { p_hotel_id: hotelId, p_auth_user_id: authUserId, p_email: email });
  if (error) throw new Error(`link_hotel_user: ${error.code ?? "error"}`);
}
