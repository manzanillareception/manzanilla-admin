import { z } from 'zod';
import type { Access, Incident } from '../../domain/types';
import {
  DashboardError,
  type CreateHotelInput,
  type CreateHotelResult,
  type DashboardDataSource,
  type DashboardRead,
  type PolicyInput,
  type RecoveryMode,
  type RepairResult,
  type SetupTokenResult,
} from './types';

/**
 * Live control-plane client.
 *
 * Reads use `GET /api/v1/admin/dashboard`, a READ-CONTRACT PROPOSAL reported to
 * the contract owner (the frozen v1 route set defines mutations only). Until the
 * route lands it returns 404/503 and this client surfaces an honest unavailable
 * state — it never substitutes demo data.
 *
 * Mutations use frozen v1 routes:
 *  - POST /api/v1/admin/devices/:deviceId/policy
 *  - POST /api/v1/admin/incidents/:incidentId/repair
 *  - POST /api/v1/admin/devices/setup-tokens
 *  - POST /api/v1/admin/hotels (email lane owns the final body shape; the field
 *    names below are the dashboard's proposal, isolated in createHotel())
 *  - POST /api/v1/admin/incidents/:incidentId/triage is a PROPOSAL (the frozen
 *    set has no triage route; reported to the contract owner).
 */

const BASE = '/api/v1';
const MAX_PAGES = 20;

/** Pilot default dashboard refresh (spec target; pauses when the tab is hidden). */
export const LIVE_POLL_MS = 15_000;

const timestamp = z.iso.datetime({ offset: true });
const access = z.enum(['pending', 'approved', 'blocked']);
const feature = z.enum(['translation', 'reception']);
const errorCode = z.enum(['CONNECTION_TIMEOUT', 'MIC_PERMISSION_DENIED', 'PROVIDER_UNAVAILABLE', 'AUDIO_STARTUP_TIMEOUT', 'POLICY_SYNC_FAILED']);

// REV 13: the ONE additive Snapshot key. Optional + nullable; every other unknown
// key stays a hard reject via the strict object below.
const deviceUpdateSchema = z.strictObject({
  feedId: z.string().min(1).max(200),
  state: z.enum(['up_to_date', 'update_available', 'downloading', 'downloaded', 'installing', 'installed', 'failed']),
  currentBuild: z.string().min(1),
  discoveredVersion: z.string().min(1).max(100).nullable(),
  publishedAt: timestamp.nullable(),
  progressPct: z.number().int().min(0).max(100).nullable(),
  error: z.string().min(1).max(500).nullable(),
  reportedAt: timestamp,
});

const snapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  asOf: timestamp,
  hotels: z.array(z.strictObject({ id: z.string().min(1), name: z.string(), city: z.string() })),
  devices: z.array(z.strictObject({
    id: z.string().min(1), code: z.string(), label: z.string(), hotelId: z.string(), build: z.string(),
    managed: z.boolean(), credential: z.enum(['valid', 'revoked']), lastSeenAt: timestamp.nullable(),
    microphone: z.enum(['granted', 'denied', 'unknown']), mode: z.union([feature, z.literal('idle')]),
    access: z.strictObject({ desired: access, effective: access, revision: z.number().int(), ackRevision: z.number().int(), changedAt: timestamp, reason: z.string() }),
    update: deviceUpdateSchema.nullable().optional(),
  })),
  sessions: z.array(z.strictObject({
    id: z.string(), sessionId: z.string(), deviceId: z.string(), feature,
    startedAt: timestamp, connectedAt: timestamp.nullable(), endedAt: timestamp.nullable(),
    outcome: z.enum(['completed', 'failed', 'active']), durationMs: z.number().nullable(),
    durationProvenance: z.enum(['observed', 'estimated', 'unknown']), firstAudioMs: z.number().nullable(),
    failureCode: errorCode.nullable(),
  })),
  traffic: z.array(z.strictObject({
    id: z.string(), deviceId: z.string(), at: timestamp, requests: z.number(), failedRequests: z.number(),
    retryRequests: z.number(), ingressBytes: z.number(), latenciesMs: z.array(z.number()),
  })),
  incidents: z.array(z.strictObject({
    id: z.string(), fingerprint: z.string(), code: errorCode, component: z.enum(['android', 'control', 'provider', 'network']),
    severity: z.enum(['critical', 'high', 'medium']), title: z.string(), firstSeenAt: timestamp, lastSeenAt: timestamp,
    deviceIds: z.array(z.string()), occurrences: z.number(), build: z.string(),
    status: z.enum(['open', 'triaged', 'repair_requested', 'resolved']),
    owner: z.string().nullable(), fixClass: z.enum(['code_candidate', 'configuration', 'external', 'hotel_action']),
    nextStep: z.string(), dueAt: timestamp,
  })),
  policyHistory: z.array(z.strictObject({ id: z.string(), deviceId: z.string(), revision: z.number().int(), desired: access, at: timestamp, reason: z.string() })),
  repairRequests: z.array(z.strictObject({ id: z.string(), incidentId: z.string(), createdAt: timestamp, target: z.enum(['android_handoff', 'new_admin_repo', 'manual_runbook']), state: z.literal('brief_ready') })),
});

const pageSchema = snapshotSchema.extend({ nextCursor: z.string().nullable().optional() });
type SnapshotPage = z.infer<typeof snapshotSchema>;

const errorEnvelope = z.looseObject({ error: z.looseObject({ code: z.string(), message: z.string(), retryable: z.boolean().optional(), retryAfterMs: z.number().optional() }) });

function mapError(status: number, body: unknown): DashboardError {
  const parsed = errorEnvelope.safeParse(body);
  const e = parsed.success ? parsed.data.error : undefined;
  const message = e?.message || `Request failed with HTTP ${status}.`;
  const retryAfterMs = typeof e?.retryAfterMs === 'number' ? e.retryAfterMs : undefined;
  switch (e?.code) {
    case 'UNAUTHORIZED': return new DashboardError('unauthorized', message, false, undefined, e.code);
    case 'FORBIDDEN': return new DashboardError('forbidden', message, false, undefined, e.code);
    case 'MFA_SETUP_REQUIRED': return new DashboardError('forbidden', message, false, undefined, e.code);
    case 'CREDENTIAL_REVOKED': return new DashboardError('unauthorized', message, false, undefined, e.code);
    case 'SETUP_REQUIRED': return new DashboardError('setup-required', message, true, undefined, e.code);
    case 'UNAVAILABLE': return new DashboardError('unavailable', message, true, retryAfterMs, e.code);
    case 'RATE_LIMITED': return new DashboardError('rate-limited', message, true, retryAfterMs, e.code);
    case 'STALE_REVISION': return new DashboardError('conflict', message, false, undefined, e.code);
    case 'FUTURE_REVISION': return new DashboardError('conflict', message, false, undefined, e.code);
    case 'SESSION_FEATURE_MISMATCH': return new DashboardError('conflict', message, false, undefined, e.code);
    case 'INVALID_STATE': return new DashboardError('invalid-state', message, false, undefined, e.code);
    case 'NOT_FOUND': return new DashboardError('not-found', message, false, undefined, e.code);
    case 'VALIDATION_FAILED': return new DashboardError('validation', message, false, undefined, e.code);
    default: break;
  }
  if (status === 401) return new DashboardError('unauthorized', message);
  if (status === 403) return new DashboardError('forbidden', message);
  if (status === 404) return new DashboardError('unavailable', 'This route is not connected yet. The read/action contract is pending.', true);
  if (status === 409) return new DashboardError('conflict', message);
  if (status === 429) return new DashboardError('rate-limited', message, true, retryAfterMs);
  if (status >= 500) return new DashboardError('unavailable', message, true);
  return new DashboardError('validation', message);
}

async function request(path: string, init: RequestInit | undefined, signal?: AbortSignal): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...init?.headers },
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new DashboardError('network', 'Cannot reach the control API. Check the deployment and your connection.', true);
  }
  let body: unknown = null;
  const text = await res.text();
  if (text) { try { body = JSON.parse(text); } catch { /* non-JSON body handled below */ } }
  if (!res.ok) throw mapError(res.status, body);
  return body;
}

async function post(path: string, payload: unknown): Promise<unknown> {
  return request(path, { method: 'POST', body: JSON.stringify(payload) });
}

/** Repair target follows the same server-owned rule as the demo brief. */
export function repairTargetFor(incident: Incident): 'android_handoff' | 'new_admin_repo' | 'manual_runbook' {
  return incident.fixClass === 'code_candidate' ? (incident.component === 'control' ? 'new_admin_repo' : 'android_handoff') : 'manual_runbook';
}

export function createLiveSource(options?: { periodDays?: 1 | 7 | 30 }): DashboardDataSource {
  const periodDays = options?.periodDays ?? 30;

  async function load(signal?: AbortSignal): Promise<DashboardRead> {
    let cursor: string | null = null;
    let merged: SnapshotPage | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({ periodDays: String(periodDays) });
      if (cursor) params.set('cursor', cursor);
      const raw = await request(`/admin/dashboard?${params}`, undefined, signal);
      const parsed = pageSchema.safeParse(raw);
      if (!parsed.success) throw new DashboardError('bad-response', 'The control API returned data outside the dashboard contract. Nothing was rendered.');
      const { nextCursor, ...snapshot } = parsed.data;
      if (!merged) {
        merged = snapshot;
      } else {
        const prior: SnapshotPage = merged;
        merged = {
          ...prior,
          devices: [...prior.devices, ...snapshot.devices],
          sessions: [...prior.sessions, ...snapshot.sessions],
          traffic: [...prior.traffic, ...snapshot.traffic],
          incidents: [...prior.incidents, ...snapshot.incidents],
          policyHistory: [...prior.policyHistory, ...snapshot.policyHistory],
          repairRequests: [...prior.repairRequests, ...snapshot.repairRequests],
        };
      }
      cursor = nextCursor ?? null;
      if (!cursor) break;
    }
    if (!merged) throw new DashboardError('bad-response', 'The control API returned no dashboard page.');
    return { snapshot: merged, asOf: merged.asOf };
  }

  return {
    mode: 'live',
    load,
    requestPolicy: async (input: PolicyInput): Promise<DashboardRead> => {
      const raw = await post(`/admin/devices/${encodeURIComponent(input.deviceId)}/policy`, {
        expectedRevision: input.expectedRevision,
        desiredAccess: input.desired satisfies Access,
        reason: input.reason,
      });
      // rev11: recorded:true means the response is the historical result of an
      // already-recorded retry, not current state; the reload below re-reads
      // current state, and the caller's notice reflects the recorded outcome.
      const recorded = z.looseObject({ recorded: z.boolean().optional() }).safeParse(raw);
      const read = await load();
      return recorded.success && recorded.data.recorded === true ? { ...read, recordedRetry: true } : read;
    },
    triageIncident: async (incidentId: string): Promise<DashboardRead> => {
      // PROPOSED route — pending contract-owner ratification (frozen v1 has no triage route).
      await post(`/admin/incidents/${encodeURIComponent(incidentId)}/triage`, {});
      return load();
    },
    prepareRepair: async (incident: Incident): Promise<RepairResult> => {
      await post(`/admin/incidents/${encodeURIComponent(incident.id)}/repair`, { target: repairTargetFor(incident) });
      return { read: await load(), packet: null };
    },
    createHotel: async (input: CreateHotelInput): Promise<CreateHotelResult> => {
      // Canonical email-lane body: { hotelName, city, email, confirmEmail }.
      const raw = await post('/admin/hotels', { hotelName: input.hotelName, city: input.city, email: input.email, confirmEmail: input.confirmEmail });
      // REV 13: 202 { hotelId, jobId, duplicate, status, nextStep? }. A job-execution
      // throw still returns 202 with the durable status; nextStep: "use_recovery"
      // appears only when status is needs_attention.
      const parsed = z.looseObject({
        hotelId: z.string().min(1),
        jobId: z.string().min(1),
        duplicate: z.boolean(),
        status: z.string().min(1),
        nextStep: z.string().min(1).optional(),
      }).safeParse(raw);
      if (!parsed.success) throw new DashboardError('bad-response', 'The hotel-creation response was outside the contract. Check the hotel list before retrying.');
      const read = await load();
      return { read, ...parsed.data };
    },
    sendRecovery: async (hotelId: string, mode: RecoveryMode): Promise<DashboardRead> => {
      // REV 13: POST /admin/hotels/:hotelId/recovery { mode: "guide" | "reset_link" }
      // -> 202 { jobId }; 404 unknown hotel. Sends exactly the chosen mode.
      const raw = await post(`/admin/hotels/${encodeURIComponent(hotelId)}/recovery`, { mode });
      const parsed = z.looseObject({ jobId: z.string().min(1) }).safeParse(raw);
      if (!parsed.success) throw new DashboardError('bad-response', 'The recovery response was outside the contract. Check the hotel before retrying.');
      return load();
    },
    mintSetupToken: async (hotelId: string): Promise<SetupTokenResult> => {
      const raw = await post('/admin/devices/setup-tokens', { hotelId });
      const parsed = z.strictObject({ setupToken: z.string().min(1), expiresAt: timestamp }).safeParse(raw);
      if (!parsed.success) throw new DashboardError('bad-response', 'The setup-token response was outside the contract. The token was not displayed.');
      return parsed.data;
    },
  };
}
