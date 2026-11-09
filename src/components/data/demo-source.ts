import { createDemoSnapshot } from '../../domain/demo';
import { acknowledgeDevicePolicy, requestDeviceAccess } from '../../domain/operations';
import { prepareRepair } from '../../domain/repair';
import type { Access, Incident, Snapshot } from '../../domain/types';
import type { DashboardDataSource, DashboardRead, PolicyInput, RepairResult } from './types';

const STORAGE = 'manzanilla-admin-demo-v1';

const isAccess = (v: unknown): v is Access => v === 'pending' || v === 'approved' || v === 'blocked';

function restore(): Snapshot {
  try {
    const raw = localStorage.getItem(STORAGE);
    if (!raw || raw.length > 100_000) return createDemoSnapshot();
    return parseSaved(raw);
  } catch { return createDemoSnapshot(); }
}

function parseSaved(raw: string): Snapshot {
  const saved = JSON.parse(raw);
  if (saved.schemaVersion !== 1 || typeof saved.asOf !== 'string' || !Number.isFinite(Date.parse(saved.asOf))) return createDemoSnapshot();
  const base = createDemoSnapshot(new Date(saved.asOf));
  if (Array.isArray(saved.devices)) for (const savedDevice of saved.devices) {
    const item = base.devices.find((d) => d.id === savedDevice.id);
    const a = savedDevice.access;
    if (item?.managed && item.credential === 'valid' && a && isAccess(a.desired) && isAccess(a.effective) && Number.isSafeInteger(a.revision) && Number.isSafeInteger(a.ackRevision) && a.revision >= item.access.revision && a.ackRevision >= 0 && a.ackRevision <= a.revision && typeof a.changedAt === 'string' && Number.isFinite(Date.parse(a.changedAt)) && typeof a.reason === 'string' && a.reason.length <= 160) item.access = { desired: a.desired, effective: a.effective, revision: a.revision, ackRevision: a.ackRevision, changedAt: a.changedAt, reason: a.reason };
  }
  if (Array.isArray(saved.statuses)) for (const entry of saved.statuses) {
    const item = base.incidents.find((i) => i.id === entry.id);
    if (item && ['open', 'triaged', 'repair_requested', 'resolved'].includes(entry.status)) item.status = entry.status;
  }
  if (Array.isArray(saved.policyHistory)) base.policyHistory = saved.policyHistory.filter((h: Record<string, unknown>) => base.devices.some((d) => d.id === h.deviceId) && typeof h.id === 'string' && Number.isSafeInteger(h.revision) && isAccess(h.desired) && typeof h.at === 'string' && Number.isFinite(Date.parse(h.at)) && typeof h.reason === 'string' && h.reason.length <= 160).slice(0, 100).map((h: Snapshot['policyHistory'][number]) => ({ id: h.id, deviceId: h.deviceId, revision: h.revision, desired: h.desired, at: h.at, reason: h.reason }));
  if (Array.isArray(saved.repairRequests)) base.repairRequests = saved.repairRequests.filter((r: Record<string, unknown>) => typeof r.id === 'string' && base.incidents.some((i) => i.id === r.incidentId) && typeof r.createdAt === 'string' && Number.isFinite(Date.parse(r.createdAt)) && ['android_handoff', 'new_admin_repo', 'manual_runbook'].includes(String(r.target)) && r.state === 'brief_ready').slice(0, 30).map((r: Snapshot['repairRequests'][number]) => ({ id: r.id, incidentId: r.incidentId, createdAt: r.createdAt, target: r.target, state: r.state }));
  return base;
}

function persist(snapshot: Snapshot) {
  try { localStorage.setItem(STORAGE, JSON.stringify({ schemaVersion: 1, asOf: snapshot.asOf, devices: snapshot.devices.map(({ id, access }) => ({ id, access })), statuses: snapshot.incidents.map(({ id, status }) => ({ id, status })), policyHistory: snapshot.policyHistory, repairRequests: snapshot.repairRequests })); } catch { /* Demo remains usable if browser storage is unavailable. */ }
}

export interface DemoSource extends DashboardDataSource {
  /** Demo-only: simulates a device policy receipt. Never shown in live mode. */
  simulateDeviceAck(deviceId: string): DashboardRead;
  /** Demo-only: discards local edits and regenerates the synthetic fleet. */
  reset(): DashboardRead;
}

/**
 * Explicit synthetic demo. State lives in this browser only; it is never used
 * as a fallback when the live backend errors — callers must choose it on purpose.
 */
export function createDemoSource(): DemoSource {
  let current: Snapshot | null = null;
  const read = (): DashboardRead => {
    if (!current) { current = restore(); persist(current); }
    return { snapshot: current, asOf: current.asOf };
  };
  const update = (next: Snapshot): DashboardRead => {
    current = next;
    persist(next);
    return { snapshot: next, asOf: next.asOf };
  };
  return {
    mode: 'demo',
    load: () => Promise.resolve(read()),
    requestPolicy: (input: PolicyInput) => Promise.resolve(update(requestDeviceAccess(read().snapshot, input))),
    triageIncident: (incidentId: string) => {
      const snapshot = read().snapshot;
      return Promise.resolve(update({ ...snapshot, incidents: snapshot.incidents.map((i) => i.id === incidentId && i.status === 'open' ? { ...i, status: 'triaged' } : i) }));
    },
    prepareRepair: (incident: Incident): Promise<RepairResult> => {
      const result = prepareRepair(read().snapshot, incident.id);
      return Promise.resolve({ read: update(result.snapshot), packet: result.packet });
    },
    simulateDeviceAck: (deviceId: string) => {
      const snapshot = read().snapshot;
      const device = snapshot.devices.find((d) => d.id === deviceId);
      if (!device) throw new Error('Device not found.');
      return update(acknowledgeDevicePolicy(snapshot, { deviceId, revision: device.access.revision }));
    },
    reset: () => update(createDemoSnapshot()),
  };
}
