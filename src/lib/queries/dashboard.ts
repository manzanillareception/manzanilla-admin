import type { Device, Incident, PolicyChange, RepairRequest, SessionAttempt, Snapshot, TrafficBucket } from '../../domain/types';

/**
 * Dashboard read mapping (dashboard lane, src/lib/queries/**).
 *
 * Pure, dependency-free mapping from the control-foundation schema
 * (supabase/migrations/202611090001_control_foundation.sql, snake_case rows)
 * to the dashboard read model consumed by ControlCenter. The backend/
 * integration wiring calls this after authorized server-side reads; this
 * module never touches the network, env or a database client itself.
 *
 * Read-contract proposal reported to the contract owner: the live dashboard
 * needs `GET /api/v1/admin/dashboard?periodDays=&cursor=` returning the
 * Snapshot-shaped payload validated in src/components/data/live-source.ts,
 * plus these non-secret extras when available:
 *  - provisioning/delivery state per hotel (public.provisioning_job_status)
 *  - latest policy reason per device (admin_audit)
 */

export interface HotelRow { id: string; name: string; city: string }
export interface DeviceRow {
  id: string; hotel_id: string; code: string; label: string; build: string;
  managed: boolean; credential_state: 'valid' | 'revoked';
  desired_access: Device['access']['desired']; effective_access: Device['access']['effective'];
  policy_revision: number | string; ack_revision: number | string;
  policy_changed_at: string; last_seen_at: string | null;
  microphone: Device['microphone']; mode: Device['mode'];
}
export interface SessionRow {
  id: string; device_id: string; feature: 'translation' | 'reception';
  started_at: string; connected_at: string | null; ended_at: string | null;
  duration_ms: number | string | null; duration_provenance: 'observed' | 'estimated' | 'unknown';
}
export interface AttemptRow {
  id: string; session_id: string; device_id: string; attempt_number: number;
  started_at: string; connected_at: string | null; ended_at: string | null;
  outcome: 'completed' | 'failed' | 'active';
  first_audio_ms: number | null; failure_code: SessionAttempt['failureCode'];
}
export interface TrafficRow {
  device_id: string; bucket_at: string; requests: number | string; failed_requests: number | string;
  retry_requests: number | string; ingress_bytes: number | string; latency_histogram: number[] | string[];
}
export interface IncidentRow {
  id: string; fingerprint: string; error_code: Incident['code']; component: Incident['component'];
  severity: Incident['severity']; build: string; first_seen_at: string; last_seen_at: string;
  occurrences: number | string; status: Incident['status']; fix_class: Incident['fixClass']; due_at: string;
}
export interface IncidentDeviceRow { incident_id: string; device_id: string }
export interface AuditRow {
  id: number | string; device_id: string | null; action: string;
  policy_revision: number | string | null; desired_access: PolicyChange['desired'] | null;
  reason: string; created_at: string;
}
export interface RepairRow { id: string; incident_id: string; target: RepairRequest['target']; state: 'brief_ready'; created_at: string }

export interface DashboardRows {
  hotels: HotelRow[];
  devices: DeviceRow[];
  sessions: SessionRow[];
  attempts: AttemptRow[];
  traffic: TrafficRow[];
  incidents: IncidentRow[];
  incidentDevices: IncidentDeviceRow[];
  audit: AuditRow[];
  repairs: RepairRow[];
}

/** Server-owned allowlist: titles and next steps are derived, never device text. */
const INCIDENT_TITLES: Record<Incident['code'], string> = {
  CONNECTION_TIMEOUT: 'Connection attempts timing out',
  MIC_PERMISSION_DENIED: 'Microphone permission denied',
  PROVIDER_UNAVAILABLE: 'Voice provider unavailable',
  AUDIO_STARTUP_TIMEOUT: 'Audio startup timed out',
  POLICY_SYNC_FAILED: 'Policy sync failed',
};
const NEXT_STEPS: Record<Incident['fixClass'], string> = {
  code_candidate: 'Reproduce in isolation, add a failing test and prepare a reviewed draft PR.',
  configuration: 'Review configuration and policy revision ordering before any code change.',
  external: 'Check the provider service-status page through a trusted operator.',
  hotel_action: 'Confirm power, Wi-Fi and microphone permission with the hotel.',
};

const toNumber = (v: number | string | null): number | null => v === null ? null : Number(v);

/** Session duration lives on the session row; attach it to the first connected attempt so per-session totals stay exact. */
function mapAttempts(rows: DashboardRows): SessionAttempt[] {
  const sessionsByKey = new Map(rows.sessions.map((s) => [`${s.device_id}:${s.id}`, s]));
  const durationAttached = new Set<string>();
  const sorted = [...rows.attempts].sort((a, b) => Date.parse(a.connected_at ?? a.started_at) - Date.parse(b.connected_at ?? b.started_at));
  return sorted.map((a) => {
    const session = sessionsByKey.get(`${a.device_id}:${a.session_id}`);
    let durationMs: number | null = null;
    let durationProvenance: SessionAttempt['durationProvenance'] = 'unknown';
    if (session && a.connected_at && !durationAttached.has(session.id)) {
      durationMs = toNumber(session.duration_ms);
      durationProvenance = session.duration_provenance;
      durationAttached.add(session.id);
    }
    return {
      id: a.id, sessionId: a.session_id, deviceId: a.device_id,
      feature: session?.feature ?? 'translation',
      startedAt: a.started_at, connectedAt: a.connected_at, endedAt: a.ended_at,
      outcome: a.outcome, durationMs, durationProvenance,
      firstAudioMs: a.first_audio_ms, failureCode: a.failure_code,
    };
  });
}

export function mapRowsToSnapshot(rows: DashboardRows, asOf: string): Snapshot {
  const latestReason = new Map<string, string>();
  for (const a of [...rows.audit].sort((x, y) => Date.parse(y.created_at) - Date.parse(x.created_at))) {
    if (a.action === 'policy_requested' && a.device_id && !latestReason.has(a.device_id)) latestReason.set(a.device_id, a.reason);
  }
  const devices: Device[] = rows.devices.map((d) => ({
    id: d.id, code: d.code, label: d.label, hotelId: d.hotel_id, build: d.build,
    managed: d.managed, credential: d.credential_state, lastSeenAt: d.last_seen_at,
    microphone: d.microphone, mode: d.mode,
    access: {
      desired: d.desired_access, effective: d.effective_access,
      revision: Number(d.policy_revision), ackRevision: Number(d.ack_revision),
      changedAt: d.policy_changed_at, reason: latestReason.get(d.id) ?? 'No recorded reason',
    },
  }));
  const deviceCountByIncident = new Map<string, string[]>();
  for (const row of rows.incidentDevices) {
    deviceCountByIncident.set(row.incident_id, [...(deviceCountByIncident.get(row.incident_id) ?? []), row.device_id]);
  }
  const incidents: Incident[] = rows.incidents.map((i) => ({
    id: i.id, fingerprint: i.fingerprint, code: i.error_code, component: i.component,
    severity: i.severity, title: INCIDENT_TITLES[i.error_code],
    firstSeenAt: i.first_seen_at, lastSeenAt: i.last_seen_at,
    deviceIds: deviceCountByIncident.get(i.id) ?? [],
    occurrences: Number(i.occurrences), build: i.build, status: i.status,
    owner: null, fixClass: i.fix_class, nextStep: NEXT_STEPS[i.fix_class], dueAt: i.due_at,
  }));
  const traffic: TrafficBucket[] = rows.traffic.map((t) => ({
    id: `${t.device_id}:${t.bucket_at}`, deviceId: t.device_id, at: t.bucket_at,
    requests: Number(t.requests), failedRequests: Number(t.failed_requests),
    retryRequests: Number(t.retry_requests), ingressBytes: Number(t.ingress_bytes),
    latenciesMs: t.latency_histogram.map(Number),
  }));
  const policyHistory: PolicyChange[] = rows.audit
    .filter((a) => a.action === 'policy_requested' && a.device_id && a.desired_access && a.policy_revision !== null)
    .map((a) => ({ id: `audit-${a.id}`, deviceId: a.device_id as string, revision: Number(a.policy_revision), desired: a.desired_access as PolicyChange['desired'], at: a.created_at, reason: a.reason }));
  const repairRequests: RepairRequest[] = rows.repairs.map((r) => ({ id: r.id, incidentId: r.incident_id, createdAt: r.created_at, target: r.target, state: r.state }));
  return {
    schemaVersion: 1, asOf,
    hotels: rows.hotels.map((h) => ({ id: h.id, name: h.name, city: h.city })),
    devices, sessions: mapAttempts(rows), traffic, incidents, policyHistory, repairRequests,
  };
}
