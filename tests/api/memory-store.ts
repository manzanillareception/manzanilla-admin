import {
  StoreError,
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
} from '../../src/lib/server/types';
import type { TelemetryEvent } from '../../src/domain/telemetry';

interface SessionState {
  ref: string;
  feature: 'translation' | 'reception';
  state: 'creating' | 'connected' | 'ended';
  attempts: Set<string>;
}

/**
 * In-memory ControlStore mirroring the RPC semantics the contract requires
 * (0004rev4/0006rev2). Route unit tests run against this; the disposable-Postgres
 * chain in tests/rls verifies the real SQL.
 */
export class MemoryControlStore implements ControlStore {
  devices = new Map<string, DeviceRow>();
  setupTokens = new Map<string, { hotelId: string; expiresAt: string; consumed: boolean }>();
  incidents = new Map<string, { status: 'open' | 'triaged' | 'repair_requested' | 'resolved' }>();
  sessions = new Map<string, SessionState>(); // key deviceId:ref
  audit: { actor: string; deviceId: string; revision: number; desired: Access; reason: string }[] = [];
  seenEvents = new Set<string>();
  seenBoots = new Map<string, Set<string>>(); // deviceId -> bootIds
  repairRequests: { id: string; incidentId: string; target: string }[] = [];
  credentialHashes = new Map<string, string>(); // deviceId -> stored credential hash
  updateEvents: { deviceId: string; event: TelemetryEvent; occurredAt: string; receivedAt: string }[] = [];
  triageLog: { actor: string; incidentId: string; note: string | null }[] = [];

  private deviceKey(deviceId: string, ref: string) { return `${deviceId}:${ref}`; }

  seedDevice(partial: Partial<DeviceRow> & { id: string }): DeviceRow {
    const d: DeviceRow = {
      hotelId: 'hotel-1', code: 'DEV-TEST1', label: 'Tablet', build: '17.0.44', managed: true,
      credentialState: 'valid', desiredAccess: 'pending', effectiveAccess: 'pending',
      policyRevision: 1, ackRevision: 0, lastSeenAt: null, lastBootId: null,
      lastHeartbeatSequence: null, mode: 'idle', microphone: 'unknown', ...partial,
    };
    this.devices.set(d.id, d);
    return d;
  }

  async enrollDevice(input: EnrollInput): Promise<EnrollResult> {
    if ((input.setupTokenHash == null) === (input.hotelId == null)) {
      throw new StoreError(400, 'VALIDATION_FAILED', 'exactly one enrollment credential path is required');
    }
    let hotelId = input.hotelId;
    if (input.setupTokenHash != null) {
      const token = this.setupTokens.get(input.setupTokenHash);
      if (!token || token.expiresAt <= new Date().toISOString()) throw new StoreError(401, 'SETUP_TOKEN_INVALID', 'unknown or expired token');
      if (token.consumed) throw new StoreError(401, 'SETUP_TOKEN_CONSUMED', 'token already used');
      token.consumed = true;
      hotelId = token.hotelId;
    }
    for (const d of this.devices.values()) if (d.code === input.code) throw new StoreError(409, 'CONFLICT', 'code taken');
    const device = this.seedDevice({ id: `dev-${this.devices.size + 1}`, hotelId: hotelId!, code: input.code, label: input.label, build: input.build });
    this.credentialHashes.set(device.id, input.credentialHash);
    return { deviceId: device.id, hotelId: device.hotelId, desiredAccess: 'pending', policyRevision: 1 };
  }

  async recordHeartbeat(input: HeartbeatInput): Promise<HeartbeatResult> {
    const d = this.devices.get(input.deviceId);
    if (!d) throw new StoreError(404, 'NOT_FOUND', 'unknown device');
    const boots = this.seenBoots.get(d.id) ?? new Set<string>();
    this.seenBoots.set(d.id, boots);
    const isNew = !boots.has(input.bootId);
    const isCurrent = d.lastBootId === input.bootId;
    const advances = isCurrent && (d.lastHeartbeatSequence === null || input.sequence > d.lastHeartbeatSequence);
    const applied = isNew || advances;
    if (applied) {
      boots.add(input.bootId);
      Object.assign(d, { lastSeenAt: input.receivedAt, lastBootId: input.bootId, lastHeartbeatSequence: input.sequence, build: input.build, mode: input.mode, microphone: input.microphone });
    }
    return { applied, device: { ...d }, serverTime: new Date().toISOString() };
  }

  async ingestEvents(device: DeviceRow, events: TelemetryEvent[], receivedAt: string): Promise<IngestResult> {
    // Validate the whole batch first so a hard failure aborts like the Postgres
    // transaction does: nothing from the batch is recorded.
    for (const e of events) {
      const key = `${device.id}:${e.eventId}`;
      if (this.seenEvents.has(key)) continue;
      if (e.kind === 'session.started') {
        const s = this.sessions.get(this.deviceKey(device.id, e.sessionId!));
        if (s?.state === 'ended') throw new StoreError(409, 'INVALID_STATE', 'session has ended');
        if (s && s.feature !== e.feature) throw new StoreError(409, 'SESSION_FEATURE_MISMATCH', 'feature mismatch');
      }
      if (e.kind === 'policy.ack') {
        const d = this.devices.get(device.id)!;
        if ((e as { revision?: number }).revision! > d.policyRevision) throw new StoreError(409, 'FUTURE_REVISION', 'ack exceeds issued revision');
      }
    }
    let accepted = 0; let duplicates = 0;
    for (const e of events) {
      const key = `${device.id}:${e.eventId}`;
      if (this.seenEvents.has(key)) { duplicates += 1; continue; }
      if (e.kind === 'session.started') {
        const k = this.deviceKey(device.id, e.sessionId!);
        const s = this.sessions.get(k);
        if (!s) this.sessions.set(k, { ref: e.sessionId!, feature: e.feature!, state: 'creating', attempts: new Set([e.attemptId!]) });
      }
      if (e.kind === 'session.connected') {
        const s = this.sessions.get(this.deviceKey(device.id, e.sessionId!));
        if (s && s.state === 'creating') s.state = 'connected';
      }
      if (e.kind === 'session.ended') {
        const s = this.sessions.get(this.deviceKey(device.id, e.sessionId!));
        if (s) s.state = 'ended';
      }
      if (e.kind === 'update.status') {
        this.updateEvents.push({ deviceId: device.id, event: e, occurredAt: e.occurredAt, receivedAt });
      }
      this.seenEvents.add(key);
      accepted += 1;
    }
    return { accepted, duplicates };
  }

  async ackPolicy(deviceId: string, revision: number): Promise<DeviceRow> {
    const d = this.devices.get(deviceId);
    if (!d) throw new StoreError(404, 'NOT_FOUND', 'unknown device');
    if (revision > d.policyRevision) throw new StoreError(409, 'FUTURE_REVISION', 'ack exceeds issued revision');
    if (revision > d.ackRevision) {
      d.ackRevision = revision;
      if (revision === d.policyRevision) d.effectiveAccess = d.desiredAccess;
    }
    return { ...d };
  }

  async admitSession(device: DeviceRow, input: { sessionRef: string; attemptRef: string; feature: 'translation' | 'reception' }): Promise<AdmitResult> {
    const k = this.deviceKey(device.id, input.sessionRef);
    const existing = this.sessions.get(k);
    if (existing) {
      if (existing.state === 'ended') throw new StoreError(409, 'INVALID_STATE', 'session has ended');
      if (existing.feature !== input.feature) throw new StoreError(409, 'SESSION_FEATURE_MISMATCH', 'feature mismatch');
    }
    if (device.desiredAccess !== 'approved') {
      return { admit: false, reason: device.desiredAccess === 'blocked' ? 'blocked' : 'pending', policyRevision: device.policyRevision };
    }
    if (existing) existing.attempts.add(input.attemptRef);
    else this.sessions.set(k, { ref: input.sessionRef, feature: input.feature, state: 'creating', attempts: new Set([input.attemptRef]) });
    return { admit: true, reason: null, policyRevision: device.policyRevision };
  }

  async setDevicePolicy(actorUserId: string, deviceId: string, input: { expectedRevision: number; desiredAccess: Access; reason: string }): Promise<PolicyResult> {
    const d = this.devices.get(deviceId);
    if (!d) throw new StoreError(404, 'NOT_FOUND', 'unknown device');
    if (input.expectedRevision < d.policyRevision) {
      // Contract rev11: a true retry needs SAME actor, device, revision, desired AND reason.
      const recorded = this.audit.find((a) => a.actor === actorUserId && a.deviceId === deviceId
        && a.revision === input.expectedRevision + 1 && a.desired === input.desiredAccess && a.reason === input.reason);
      if (recorded) {
        // Historical result only: revision may be behind current; no mutation, no current claim.
        return { deviceId, revision: recorded.revision, desiredAccess: recorded.desired, effectiveAccess: d.effectiveAccess, recorded: true };
      }
      throw new StoreError(409, 'STALE_REVISION', `expected ${input.expectedRevision}, current ${d.policyRevision}`);
    }
    if (input.expectedRevision > d.policyRevision) throw new StoreError(409, 'STALE_REVISION', 'future revision');
    if (d.desiredAccess === input.desiredAccess) {
      return { deviceId, revision: d.policyRevision, desiredAccess: d.desiredAccess, effectiveAccess: d.effectiveAccess, recorded: false };
    }
    d.policyRevision += 1;
    d.desiredAccess = input.desiredAccess;
    this.audit.push({ actor: actorUserId, deviceId, revision: d.policyRevision, desired: input.desiredAccess, reason: input.reason });
    return { deviceId, revision: d.policyRevision, desiredAccess: d.desiredAccess, effectiveAccess: d.effectiveAccess, recorded: false };
  }

  async requestRepair(actorUserId: string, incidentId: string, target: 'android_handoff' | 'new_admin_repo' | 'manual_runbook'): Promise<RepairResult> {
    const inc = this.incidents.get(incidentId);
    if (!inc) throw new StoreError(404, 'NOT_FOUND', 'unknown incident');
    if (inc.status === 'resolved') throw new StoreError(409, 'INVALID_STATE', 'incident resolved');
    inc.status = 'repair_requested';
    const id = `rr-${this.repairRequests.length + 1}`;
    this.repairRequests.push({ id, incidentId, target });
    return { repairRequestId: id, state: 'brief_ready' };
  }

  async mintSetupToken(hotelId: string, tokenHash: string, expiresAt: string, _createdBy: string): Promise<SetupTokenResult> {
    this.setupTokens.set(tokenHash, { hotelId, expiresAt, consumed: false });
    return { expiresAt };
  }

  async triageIncident(actorUserId: string, incidentId: string, note: string | null): Promise<TriageResult> {
    const inc = this.incidents.get(incidentId);
    if (!inc) throw new StoreError(404, 'NOT_FOUND', 'unknown incident');
    if (inc.status !== 'open' && inc.status !== 'triaged') throw new StoreError(409, 'INVALID_STATE', `incident is ${inc.status}`);
    inc.status = 'triaged';
    this.triageLog.push({ actor: actorUserId, incidentId, note });
    return { incidentId, status: 'triaged' };
  }

  /** Contract rev13 derivation: latest accepted update.status per device (occurredAt, tiebreak receivedAt). */
  latestUpdate(deviceId: string) {
    const rows = this.updateEvents.filter((u) => u.deviceId === deviceId);
    if (rows.length === 0) return null;
    rows.sort((a, b) => a.occurredAt === b.occurredAt
      ? a.receivedAt.localeCompare(b.receivedAt)
      : a.occurredAt.localeCompare(b.occurredAt));
    const e = rows[rows.length - 1].event as Extract<TelemetryEvent, { kind: 'update.status' }>;
    // Legacy/incomplete rows (pre-0009 storage): required fields missing -> "not reported".
    if (e.feedId == null || e.state == null || e.currentBuild == null) return null;
    return {
      feedId: e.feedId, state: e.state, currentBuild: e.currentBuild,
      discoveredVersion: e.discoveredVersion, publishedAt: e.publishedAt,
      progressPct: e.progressPct, error: e.error, reportedAt: e.occurredAt,
    };
  }

  async readDashboardSnapshot(_query: DashboardQuery): Promise<DashboardPage> {
    return {
      schemaVersion: 1, asOf: new Date().toISOString(),
      hotels: [{ id: 'hotel-1', name: 'Test Hotel', city: 'Seville' }],
      devices: [...this.devices.values()].map((d) => ({
        id: d.id, code: d.code, label: d.label, hotelId: d.hotelId, build: d.build,
        managed: d.managed, credential: d.credentialState, lastSeenAt: d.lastSeenAt,
        microphone: d.microphone, mode: d.mode,
        access: { desired: d.desiredAccess, effective: d.effectiveAccess, revision: d.policyRevision, ackRevision: d.ackRevision, changedAt: new Date().toISOString(), reason: 'reason' },
        update: this.latestUpdate(d.id),
      })),
      sessions: [], traffic: [], incidents: [], policyHistory: [], repairRequests: [], nextCursor: null,
    };
  }
}
