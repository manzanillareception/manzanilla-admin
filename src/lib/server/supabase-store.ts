import type { TelemetryEvent } from '../../domain/telemetry';
import { createServiceClient, getSupabaseEnv, type ServiceClient } from '../supabase/server';
import { rowToDevice } from './rows';
import {
  StoreError,
  type DeviceUpdateProjection,
  type Access,
  type AdmitResult,
  type ControlStore,
  type DashboardPage,
  type DashboardQuery,
  type DeviceRow,
  type EnrollInput,
  type EnrollResult,
  type HeartbeatInput,
  type HeartbeatResult,
  type IngestResult,
  type PolicyResult,
  type RepairResult,
  type SetupTokenResult,
  type TriageResult,
} from './types';

/**
 * Maps a PostgREST RPC failure to a contract error. RPCs raise app errors as
 * `MNZ:<CODE>:<message>`; anything else is an infrastructure failure (UNAVAILABLE).
 */
function mapRpcError(error: { message?: string; code?: string } | null): StoreError {
  // Raw Postgres constraint codes surfaced by PostgREST.
  if (error?.code === '23503') return new StoreError(400, 'VALIDATION_FAILED', 'Referenced record does not exist.');
  if (error?.code === '23505') return new StoreError(409, 'CONFLICT', 'Record already exists.');
  const message = error?.message ?? '';
  const match = /MNZ:([A-Z_]+):(.*)/.exec(message);
  if (match) {
    const code = match[1];
    const text = match[2].trim() || code;
    const status =
      code === 'VALIDATION_FAILED' ? 400
      : code === 'SETUP_TOKEN_INVALID' || code === 'SETUP_TOKEN_CONSUMED' || code === 'UNAUTHORIZED' ? 401
      : code === 'FORBIDDEN' ? 403
      : code === 'STALE_REVISION' ? 409
      : code === 'NOT_FOUND' ? 404
      : code === 'CONFLICT' ? 409
      : 400;
    return new StoreError(status, code, text);
  }
  return new StoreError(503, 'UNAVAILABLE', 'Control store is unavailable.');
}

export class SupabaseControlStore implements ControlStore {
  constructor(private readonly service: ServiceClient) {}

  private async call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.service.rpc(fn, args);
    if (error) throw mapRpcError(error);
    return data as T;
  }

  async enrollDevice(input: EnrollInput): Promise<EnrollResult> {
    const rows = await this.call<Record<string, unknown>[]>('control_enroll_device', {
      p_token_hash: input.setupTokenHash ?? null,
      p_hotel_id: input.hotelId ?? null,
      p_credential_hash: input.credentialHash,
      p_code: input.code,
      p_label: input.label,
      p_build: input.build,
    });
    const row = rows[0];
    if (!row) throw new StoreError(503, 'UNAVAILABLE', 'Enrollment returned no device.');
    return {
      deviceId: String(row.device_id),
      hotelId: String(row.hotel_id),
      desiredAccess: 'pending',
      policyRevision: Number(row.policy_revision),
    };
  }

  async recordHeartbeat(input: HeartbeatInput): Promise<HeartbeatResult> {
    const rows = await this.call<Record<string, unknown>[]>('control_record_heartbeat', {
      p_device_id: input.deviceId,
      p_boot_id: input.bootId,
      p_sequence: input.sequence,
      p_build: input.build,
      p_mode: input.mode,
      p_microphone: input.microphone,
      p_received_at: input.receivedAt,
    });
    const row = rows[0];
    if (!row) throw new StoreError(503, 'UNAVAILABLE', 'Heartbeat returned no device.');
    return { applied: Boolean(row.applied), device: rowToDevice(row), serverTime: input.receivedAt };
  }

  async ingestEvents(device: DeviceRow, events: TelemetryEvent[], receivedAt: string): Promise<IngestResult> {
    const rows = await this.call<Record<string, unknown>[]>('control_ingest_events', {
      p_device_id: device.id,
      p_received_at: receivedAt,
      p_events: events,
    });
    const row = rows[0];
    if (!row) throw new StoreError(503, 'UNAVAILABLE', 'Ingest returned no result.');
    return { accepted: Number(row.accepted), duplicates: Number(row.duplicates) };
  }

  async ackPolicy(deviceId: string, revision: number): Promise<DeviceRow> {
    const rows = await this.call<Record<string, unknown>[]>('control_ack_policy', {
      p_device_id: deviceId,
      p_revision: revision,
    });
    const row = rows[0];
    if (!row) throw new StoreError(503, 'UNAVAILABLE', 'Policy ACK returned no device.');
    return rowToDevice(row);
  }

  async admitSession(device: DeviceRow, input: { sessionRef: string; attemptRef: string; feature: 'translation' | 'reception' }): Promise<AdmitResult> {
    const rows = await this.call<Record<string, unknown>[]>('control_admit_session', {
      p_device_id: device.id,
      p_session_ref: input.sessionRef,
      p_attempt_ref: input.attemptRef,
      p_feature: input.feature,
    });
    const row = rows[0];
    if (!row) throw new StoreError(503, 'UNAVAILABLE', 'Admission returned no result.');
    return {
      admit: Boolean(row.admit),
      reason: (row.reason as AdmitResult['reason']) ?? null,
      policyRevision: Number(row.policy_revision),
    };
  }

  async setDevicePolicy(actorUserId: string, deviceId: string, input: { expectedRevision: number; desiredAccess: 'pending' | 'approved' | 'blocked'; reason: string }): Promise<PolicyResult> {
    const rows = await this.call<Record<string, unknown>[]>('control_set_device_policy', {
      p_actor: actorUserId,
      p_device_id: deviceId,
      p_expected_revision: input.expectedRevision,
      p_desired: input.desiredAccess,
      p_reason: input.reason,
    });
    const row = rows[0];
    if (!row) throw new StoreError(503, 'UNAVAILABLE', 'Policy update returned no device.');
    return {
      deviceId: String(row.device_id),
      revision: Number(row.policy_revision),
      desiredAccess: row.desired_access as PolicyResult['desiredAccess'],
      effectiveAccess: row.effective_access as PolicyResult['effectiveAccess'],
      recorded: row.recorded === true,
    };
  }

  async requestRepair(actorUserId: string, incidentId: string, target: 'android_handoff' | 'new_admin_repo' | 'manual_runbook'): Promise<RepairResult> {
    const rows = await this.call<Record<string, unknown>[]>('control_request_repair', {
      p_actor: actorUserId,
      p_incident_id: incidentId,
      p_target: target,
    });
    const row = rows[0];
    if (!row) throw new StoreError(503, 'UNAVAILABLE', 'Repair request returned no id.');
    return { repairRequestId: String(row.repair_request_id), state: 'brief_ready' };
  }

  async mintSetupToken(hotelId: string, tokenHash: string, expiresAt: string, createdBy: string): Promise<SetupTokenResult> {
    await this.call<null>('control_mint_setup_token', {
      p_hotel_id: hotelId,
      p_token_hash: tokenHash,
      p_expires_at: expiresAt,
      p_created_by: createdBy,
    });
    return { expiresAt };
  }

  async triageIncident(actorUserId: string, incidentId: string, note: string | null): Promise<TriageResult> {
    const rows = await this.call<Record<string, unknown>[]>('control_triage_incident', {
      p_actor: actorUserId,
      p_incident_id: incidentId,
      p_note: note,
    });
    const row = rows[0];
    if (!row) throw new StoreError(503, 'UNAVAILABLE', 'Triage returned no incident.');
    return { incidentId: String(row.incident_id), status: String(row.status) };
  }

  /**
   * Dashboard read model (contract rev9). Reads public control-foundation tables as
   * service_role (0006: no SQL needed; RLS bypass is the service key). Sessions page at
   * SESSION_PAGE rows; later pages carry only the sessions slice so client-side merges
   * never duplicate the other arrays.
   */
  async readDashboardSnapshot(query: DashboardQuery): Promise<DashboardPage> {
    const periodDays = Math.min(30, Math.max(1, Math.trunc(query.periodDays)));
    const since = new Date(Date.now() - periodDays * 86_400_000).toISOString();
    const offset = decodeCursor(query.cursor);
    const firstPage = offset === 0;

    const sessionsRows = await this.selectRows('session_attempts',
      'id,session_id,device_id,started_at,connected_at,ended_at,outcome,first_audio_ms,failure_code',
      firstPage ? { gte: ['started_at', since], order: 'started_at', from: 0, to: SESSION_PAGE } : { gte: ['started_at', since], order: 'started_at', from: offset, to: offset + SESSION_PAGE });
    const nextCursor = sessionsRows.length > SESSION_PAGE ? encodeCursor(offset + SESSION_PAGE) : null;
    const attempts = sessionsRows.slice(0, SESSION_PAGE);

    const sessionIds = [...new Set(attempts.map((a) => String(a.session_id)))];
    const sessionMeta = sessionIds.length
      ? await this.selectRows('voice_sessions', 'id,device_id,feature,duration_ms,duration_provenance', { in: ['id', sessionIds] })
      : [];
    const metaByKey = new Map(sessionMeta.map((r) => [`${r.device_id}:${r.id}`, r]));
    const durationAttached = new Set<string>();
    const sessions = attempts.map((a) => {
      const meta = metaByKey.get(`${a.device_id}:${a.session_id}`);
      let durationMs: number | null = null;
      let durationProvenance: 'observed' | 'estimated' | 'unknown' = 'unknown';
      if (meta && a.connected_at && !durationAttached.has(String(meta.id))) {
        durationMs = meta.duration_ms === null ? null : Number(meta.duration_ms);
        durationProvenance = (meta.duration_provenance as 'observed' | 'estimated' | 'unknown') ?? 'unknown';
        durationAttached.add(String(meta.id));
      }
      return {
        id: String(a.id), sessionId: String(a.session_id), deviceId: String(a.device_id),
        feature: (meta?.feature as 'translation' | 'reception') ?? 'translation',
        startedAt: String(a.started_at), connectedAt: a.connected_at ? String(a.connected_at) : null,
        endedAt: a.ended_at ? String(a.ended_at) : null,
        outcome: a.outcome as 'completed' | 'failed' | 'active',
        durationMs, durationProvenance,
        firstAudioMs: a.first_audio_ms === null ? null : Number(a.first_audio_ms),
        failureCode: a.failure_code ? String(a.failure_code) : null,
      };
    });

    if (!firstPage) {
      return { schemaVersion: 1, asOf: new Date().toISOString(), hotels: [], devices: [], sessions, traffic: [], incidents: [], policyHistory: [], repairRequests: [], nextCursor };
    }

    const [hotels, devicesRows, auditRows, trafficRows, incidentRows, incidentDeviceRows, repairRows, updateRows] = await Promise.all([
      this.selectRows('hotels', 'id,name,city', { order: 'name' }),
      this.selectRows('devices', 'id,hotel_id,code,label,build,managed,credential_state,desired_access,effective_access,policy_revision,ack_revision,policy_changed_at,last_seen_at,microphone,mode', { order: 'code' }),
      this.selectRows('admin_audit', 'id,device_id,incident_id,action,policy_revision,desired_access,reason,created_at', { gte: ['created_at', since], order: 'created_at' }),
      this.selectRows('traffic_buckets', 'device_id,bucket_at,requests,failed_requests,retry_requests,ingress_bytes,latency_histogram', { gte: ['bucket_at', since], order: 'bucket_at' }),
      this.selectRows('incidents', 'id,fingerprint,error_code,component,severity,build,first_seen_at,last_seen_at,occurrences,status,fix_class,due_at', { gte: ['last_seen_at', since], order: 'last_seen_at' }),
      this.selectRows('incident_devices', 'incident_id,device_id', {}),
      this.selectRows('repair_requests', 'id,incident_id,target,state,created_at', { gte: ['created_at', since], order: 'created_at' }),
      // REV 13 (0009): latest accepted update.status per device. Ordered newest-first
      // (occurred_at, tiebreak received_at); the first row seen per device wins.
      this.selectRows('technical_events',
        'device_id,occurred_at,received_at,update_feed_id,update_state,update_current_build,update_discovered_version,update_published_at,update_progress_pct,update_error',
        { eq: ['kind', 'update.status'], order: 'occurred_at', desc: true, order2: 'received_at' }),
    ]);
    const latestUpdate = new Map<string, Record<string, unknown>>();
    for (const u of updateRows) {
      const key = String(u.device_id);
      if (!latestUpdate.has(key)) latestUpdate.set(key, u);
    }

    const latestReason = new Map<string, string>();
    for (const a of [...auditRows].sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)))) {
      if (a.action === 'policy_requested' && a.device_id && !latestReason.has(String(a.device_id))) {
        latestReason.set(String(a.device_id), String(a.reason));
      }
    }
    const devices = devicesRows.map((d) => ({
      id: String(d.id), code: String(d.code), label: String(d.label), hotelId: String(d.hotel_id), build: String(d.build),
      managed: Boolean(d.managed), credential: d.credential_state as 'valid' | 'revoked',
      lastSeenAt: d.last_seen_at ? String(d.last_seen_at) : null,
      microphone: d.microphone as 'granted' | 'denied' | 'unknown',
      mode: d.mode as 'idle' | 'translation' | 'reception',
      access: {
        desired: d.desired_access as Access, effective: d.effective_access as Access,
        revision: Number(d.policy_revision), ackRevision: Number(d.ack_revision),
        changedAt: String(d.policy_changed_at),
        reason: latestReason.get(String(d.id)) ?? 'No recorded reason',
      },
      // REV 13: null = never reported (rendered "Not reported"); never folded into presence.
      update: (() => {
        const u = latestUpdate.get(String(d.id));
        if (!u) return null;
        // Legacy/incomplete rows (pre-0009 storage): required fields are NULL. Yield
        // "not reported" - never fabricate a projection from null coerced to strings.
        if (u.update_feed_id == null || u.update_state == null || u.update_current_build == null) return null;
        return {
          feedId: String(u.update_feed_id), state: String(u.update_state) as DeviceUpdateProjection['state'],
          currentBuild: String(u.update_current_build),
          discoveredVersion: u.update_discovered_version === null ? null : String(u.update_discovered_version),
          publishedAt: u.update_published_at === null ? null : String(u.update_published_at),
          progressPct: u.update_progress_pct === null ? null : Number(u.update_progress_pct),
          error: u.update_error === null ? null : String(u.update_error),
          reportedAt: String(u.occurred_at),
        };
      })(),
    }));
    const devicesByIncident = new Map<string, string[]>();
    for (const row of incidentDeviceRows) {
      const list = devicesByIncident.get(String(row.incident_id)) ?? [];
      list.push(String(row.device_id));
      devicesByIncident.set(String(row.incident_id), list);
    }
    const incidents = incidentRows.map((i) => ({
      id: String(i.id), fingerprint: String(i.fingerprint), code: String(i.error_code), component: String(i.component),
      severity: String(i.severity), title: INCIDENT_TITLES[String(i.error_code)] ?? 'Incident',
      firstSeenAt: String(i.first_seen_at), lastSeenAt: String(i.last_seen_at),
      deviceIds: devicesByIncident.get(String(i.id)) ?? [],
      occurrences: Number(i.occurrences), build: String(i.build), status: String(i.status),
      owner: null, fixClass: String(i.fix_class),
      nextStep: NEXT_STEPS[String(i.fix_class)] ?? 'Review this incident.',
      dueAt: String(i.due_at),
    }));
    const traffic = trafficRows.map((t) => ({
      id: `${t.device_id}:${t.bucket_at}`, deviceId: String(t.device_id), at: String(t.bucket_at),
      requests: Number(t.requests), failedRequests: Number(t.failed_requests),
      retryRequests: Number(t.retry_requests), ingressBytes: Number(t.ingress_bytes),
      latenciesMs: (t.latency_histogram as number[] | null ?? []).map(Number),
    }));
    const policyHistory = auditRows
      .filter((a) => a.action === 'policy_requested' && a.device_id)
      .map((a) => ({
        id: String(a.id), deviceId: String(a.device_id), revision: Number(a.policy_revision),
        desired: a.desired_access as Access, at: String(a.created_at), reason: String(a.reason),
      }));
    const repairRequests = repairRows.map((r) => ({
      id: String(r.id), incidentId: String(r.incident_id), createdAt: String(r.created_at),
      target: String(r.target), state: 'brief_ready' as const,
    }));

    return {
      schemaVersion: 1, asOf: new Date().toISOString(),
      hotels: hotels.map((h) => ({ id: String(h.id), name: String(h.name), city: String(h.city) })),
      devices, sessions, traffic, incidents, policyHistory, repairRequests, nextCursor,
    };
  }

  private async selectRows(table: string, columns: string, opts: {
    gte?: [string, string]; in?: [string, string[]]; eq?: [string, string];
    order?: string; desc?: boolean; order2?: string; from?: number; to?: number;
  }): Promise<Record<string, unknown>[]> {
    let q = this.service.from(table).select(columns);
    if (opts.gte) q = q.gte(opts.gte[0], opts.gte[1]);
    if (opts.in) q = q.in(opts.in[0], opts.in[1]);
    if (opts.eq) q = q.eq(opts.eq[0], opts.eq[1]);
    if (opts.order) q = q.order(opts.order, { ascending: opts.desc !== true });
    if (opts.order2) q = q.order(opts.order2, { ascending: opts.desc !== true });
    if (opts.from !== undefined && opts.to !== undefined) q = q.range(opts.from, opts.to - 1);
    const { data, error } = await q;
    if (error) throw new StoreError(503, 'UNAVAILABLE', `Dashboard read failed: ${error.message}`);
    return (data ?? []) as unknown as Record<string, unknown>[];
  }
}

const SESSION_PAGE = 200;

/** Server-owned allowlist: titles and next steps are derived, never device text. */
const INCIDENT_TITLES: Record<string, string> = {
  CONNECTION_TIMEOUT: 'Connection attempts timing out',
  MIC_PERMISSION_DENIED: 'Microphone permission denied',
  PROVIDER_UNAVAILABLE: 'Voice provider unavailable',
  AUDIO_STARTUP_TIMEOUT: 'Audio startup timed out',
  POLICY_SYNC_FAILED: 'Policy sync failed',
};
const NEXT_STEPS: Record<string, string> = {
  code_candidate: 'Reproduce in isolation, add a failing test and prepare a reviewed draft PR.',
  configuration: 'Review configuration and policy revision ordering before any code change.',
  external: 'Check the provider service-status page through a trusted operator.',
  hotel_action: 'Confirm power, Wi-Fi and microphone permission with the hotel.',
};

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | null): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: unknown };
    if (typeof parsed.o === 'number' && Number.isInteger(parsed.o) && parsed.o >= 0) return parsed.o;
  } catch { /* fall through */ }
  throw new StoreError(400, 'VALIDATION_FAILED', 'Invalid cursor.');
}

/** Build the store from environment; null when unconfigured (fail closed). */
export function createStoreFromEnv(): SupabaseControlStore | null {
  const env = getSupabaseEnv();
  if (!env) return null;
  return new SupabaseControlStore(createServiceClient(env));
}
