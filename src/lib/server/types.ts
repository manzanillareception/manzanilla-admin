import type { TelemetryEvent } from '../../domain/telemetry';

export type Access = 'pending' | 'approved' | 'blocked';

export interface DeviceRow {
  id: string;
  hotelId: string;
  code: string;
  label: string;
  build: string;
  managed: boolean;
  credentialState: 'valid' | 'revoked';
  desiredAccess: Access;
  effectiveAccess: Access;
  policyRevision: number;
  ackRevision: number;
  lastSeenAt: string | null;
  lastBootId: string | null;
  lastHeartbeatSequence: number | null;
  mode: 'idle' | 'translation' | 'reception';
  microphone: 'granted' | 'denied' | 'unknown';
}

/** Store errors carry a contract section-8 code and HTTP status. */
export class StoreError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface EnrollInput {
  /** Exactly one enrollment credential path is set (contract rev6). */
  setupTokenHash?: string;
  hotelId?: string;
  credentialHash: string;
  code: string;
  label: string;
  build: string;
}

export interface EnrollResult {
  deviceId: string;
  hotelId: string;
  desiredAccess: Access;
  policyRevision: number;
}

export interface HeartbeatInput {
  deviceId: string;
  bootId: string;
  sequence: number;
  build: string;
  mode: 'idle' | 'translation' | 'reception';
  microphone: 'granted' | 'denied' | 'unknown';
  receivedAt: string;
}

export interface HeartbeatResult {
  /** false when (bootId, sequence) did not strictly advance: 200 but no presence update. */
  applied: boolean;
  device: DeviceRow;
  serverTime: string;
}

export interface IngestResult {
  accepted: number;
  duplicates: number;
}

export type DenyReason = 'pending' | 'blocked' | 'unavailable';

export interface AdmitResult {
  admit: boolean;
  reason: DenyReason | null;
  policyRevision: number;
}

export interface PolicyResult {
  deviceId: string;
  revision: number;
  desiredAccess: Access;
  effectiveAccess: Access;
  /**
   * Contract rev11: true ONLY when the response is the historical recorded result
   * of a retried operation (revision may be behind current); false on a fresh
   * change or same-state no-op, where the row reflects current state.
   */
  recorded: boolean;
}

export interface RepairResult {
  repairRequestId: string;
  state: 'brief_ready';
}

export interface SetupTokenResult {
  expiresAt: string;
}

export interface TriageResult {
  incidentId: string;
  status: string;
}

/**
 * Contract rev13: the ONE optional nullable Snapshot addition - the device's latest
 * accepted update.status (by occurredAt, tiebreak receivedAt). null or absent = never
 * reported; presence/heartbeat recency is a separate signal, never folded in.
 */
export interface DeviceUpdateProjection {
  feedId: string;
  state: 'up_to_date' | 'update_available' | 'downloading' | 'downloaded' | 'installing' | 'installed' | 'failed';
  currentBuild: string;
  discoveredVersion: string | null;
  publishedAt: string | null;
  progressPct: number | null;
  error: string | null;
  reportedAt: string;
}

/**
 * Dashboard read model (contract rev9, ratified from the dashboard lane's
 * live-source zod schema). Strict payload: unknown fields are rejected client-side.
 */
export interface DashboardSnapshot {
  schemaVersion: 1;
  asOf: string;
  hotels: { id: string; name: string; city: string }[];
  devices: {
    id: string; code: string; label: string; hotelId: string; build: string;
    managed: boolean; credential: 'valid' | 'revoked'; lastSeenAt: string | null;
    microphone: 'granted' | 'denied' | 'unknown'; mode: 'idle' | 'translation' | 'reception';
    access: { desired: Access; effective: Access; revision: number; ackRevision: number; changedAt: string; reason: string };
    update?: DeviceUpdateProjection | null;
  }[];
  sessions: {
    id: string; sessionId: string; deviceId: string; feature: 'translation' | 'reception';
    startedAt: string; connectedAt: string | null; endedAt: string | null;
    outcome: 'completed' | 'failed' | 'active'; durationMs: number | null;
    durationProvenance: 'observed' | 'estimated' | 'unknown'; firstAudioMs: number | null;
    failureCode: string | null;
  }[];
  traffic: {
    id: string; deviceId: string; at: string; requests: number; failedRequests: number;
    retryRequests: number; ingressBytes: number; latenciesMs: number[];
  }[];
  incidents: {
    id: string; fingerprint: string; code: string; component: string; severity: string;
    title: string; firstSeenAt: string; lastSeenAt: string; deviceIds: string[];
    occurrences: number; build: string; status: string; owner: string | null;
    fixClass: string; nextStep: string; dueAt: string;
  }[];
  policyHistory: { id: string; deviceId: string; revision: number; desired: Access; at: string; reason: string }[];
  repairRequests: { id: string; incidentId: string; createdAt: string; target: string; state: 'brief_ready' }[];
}

export interface DashboardPage extends DashboardSnapshot {
  nextCursor?: string | null;
}

export interface DashboardQuery {
  /** Clamped server-side to 1..30. */
  periodDays: number;
  /** Opaque cursor from a previous page; null for the first page. */
  cursor: string | null;
}

/**
 * Transactional control-plane store. The Supabase implementation performs each
 * mutation inside ONE security-definer RPC (one Postgres transaction); the
 * in-memory implementation in tests mirrors the same semantics.
 */
export interface ControlStore {
  enrollDevice(input: EnrollInput): Promise<EnrollResult>;
  recordHeartbeat(input: HeartbeatInput): Promise<HeartbeatResult>;
  ingestEvents(device: DeviceRow, events: TelemetryEvent[], receivedAt: string): Promise<IngestResult>;
  ackPolicy(deviceId: string, revision: number): Promise<DeviceRow>;
  admitSession(device: DeviceRow, input: { sessionRef: string; attemptRef: string; feature: 'translation' | 'reception' }): Promise<AdmitResult>;
  setDevicePolicy(actorUserId: string, deviceId: string, input: { expectedRevision: number; desiredAccess: Access; reason: string }): Promise<PolicyResult>;
  requestRepair(actorUserId: string, incidentId: string, target: 'android_handoff' | 'new_admin_repo' | 'manual_runbook'): Promise<RepairResult>;
  mintSetupToken(hotelId: string, tokenHash: string, expiresAt: string, createdBy: string): Promise<SetupTokenResult>;
  triageIncident(actorUserId: string, incidentId: string, note: string | null): Promise<TriageResult>;
  readDashboardSnapshot(query: DashboardQuery): Promise<DashboardPage>;
}
