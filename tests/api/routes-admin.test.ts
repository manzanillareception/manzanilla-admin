vi.mock('../../src/lib/auth/rate-limit', () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterMs: 0 })) }));
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';

const state = vi.hoisted(() => ({
  store: null as null | InstanceType<typeof import('./memory-store').MemoryControlStore>,
  adminAuth: null as unknown,
}));

vi.mock('../../src/lib/server/deps', () => ({
  defaultDeps: () => ({ store: state.store, now: () => new Date() }),
}));
vi.mock('../../src/lib/auth/admin', () => ({
  requireEnabledAdmin: async () => state.adminAuth,
}));

import { MemoryControlStore } from './memory-store';
import { POST as policyPOST } from '../../src/app/api/v1/admin/devices/[deviceId]/policy/route';
import { POST as triagePOST } from '../../src/app/api/v1/admin/incidents/[incidentId]/triage/route';
import { POST as repairPOST } from '../../src/app/api/v1/admin/incidents/[incidentId]/repair/route';
import { POST as tokensPOST } from '../../src/app/api/v1/admin/devices/setup-tokens/route';
import { GET as dashboardGET } from '../../src/app/api/v1/admin/dashboard/route';

const DEVICE = '11111111-1111-1111-1111-111111111111';
const INCIDENT = '22222222-2222-2222-2222-222222222222';
const HOTEL = '33333333-3333-4333-8333-333333333333'; // RFC 9562 variant-valid for z.uuid()

function adminOk(userId = 'admin-a') {
  return { ok: true, admin: { userId, email: null, aal: 'aal2' }, applyCookies: (r: Response) => r };
}
function denied(status: number, code: string) {
  return { ok: false, response: Response.json({ error: { code, message: 'denied', retryable: false } }, { status }) };
}
function jsonReq(url: string, body: unknown): Request {
  return new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
function ctx(params: Record<string, string>): never {
  return { params: Promise.resolve(params) } as never;
}
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

let store: MemoryControlStore;
beforeEach(() => {
  store = new MemoryControlStore();
  state.store = store;
  state.adminAuth = adminOk();
});

describe('POST /api/v1/admin/devices/[deviceId]/policy', () => {
  beforeEach(() => { store.seedDevice({ id: DEVICE }); });
  const call = (deviceId: string, body: unknown) =>
    policyPOST(jsonReq(`https://x/api/v1/admin/devices/${deviceId}/policy`, body), ctx({ deviceId }));

  it('503 SETUP_REQUIRED when the store is not configured', async () => {
    state.store = null;
    const r = await call(DEVICE, { expectedRevision: 1, desiredAccess: 'approved', reason: 'r' });
    expect(r.status).toBe(503);
  });
  it('propagates an admin-gate denial untouched', async () => {
    state.adminAuth = denied(403, 'MFA_SETUP_REQUIRED');
    const r = await call(DEVICE, { expectedRevision: 1, desiredAccess: 'approved', reason: 'r' });
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe('MFA_SETUP_REQUIRED');
  });
  it('applies a fresh change with recorded:false and appends one audit row', async () => {
    const r = await call(DEVICE, { expectedRevision: 1, desiredAccess: 'approved', reason: 'initial approval' });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toMatchObject({ deviceId: DEVICE, revision: 2, desiredAccess: 'approved', recorded: false });
    expect(store.audit).toHaveLength(1);
  });
  it('same-state no-op keeps the revision and is recorded:false', async () => {
    await store.setDevicePolicy('admin-a', DEVICE, { expectedRevision: 1, desiredAccess: 'approved', reason: 'initial approval' });
    const r = await call(DEVICE, { expectedRevision: 2, desiredAccess: 'approved', reason: 'reaffirm' });
    const j = await r.json();
    expect(j.revision).toBe(2);
    expect(j.recorded).toBe(false);
  });
  it('a true retry (same actor/revision/desired/reason) returns the recorded historical result', async () => {
    await store.setDevicePolicy('admin-a', DEVICE, { expectedRevision: 1, desiredAccess: 'approved', reason: 'initial approval' });
    await store.setDevicePolicy('admin-b', DEVICE, { expectedRevision: 2, desiredAccess: 'blocked', reason: 'incident' }); // current is now rev3
    const r = await call(DEVICE, { expectedRevision: 1, desiredAccess: 'approved', reason: 'initial approval' });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toMatchObject({ revision: 2, desiredAccess: 'approved', recorded: true }); // historical, NOT current
    expect(store.audit).toHaveLength(2); // no new audit row
    expect(store.devices.get(DEVICE)!.policyRevision).toBe(3); // no mutation
    expect(store.devices.get(DEVICE)!.desiredAccess).toBe('blocked');
  });
  it('409 STALE_REVISION on a different reason, another actor, or a changed desired state - fail closed, no mutation', async () => {
    await store.setDevicePolicy('admin-a', DEVICE, { expectedRevision: 1, desiredAccess: 'approved', reason: 'initial approval' });
    let r = await call(DEVICE, { expectedRevision: 1, desiredAccess: 'approved', reason: 'a different rationale' });
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe('STALE_REVISION');
    state.adminAuth = adminOk('admin-b');
    r = await call(DEVICE, { expectedRevision: 1, desiredAccess: 'approved', reason: 'initial approval' });
    expect(r.status).toBe(409);
    state.adminAuth = adminOk();
    r = await call(DEVICE, { expectedRevision: 1, desiredAccess: 'blocked', reason: 'initial approval' });
    expect(r.status).toBe(409);
    r = await call(DEVICE, { expectedRevision: 7, desiredAccess: 'blocked', reason: 'future' });
    expect(r.status).toBe(409);
    expect(store.devices.get(DEVICE)!.policyRevision).toBe(2); // untouched through all failures
    expect(store.audit).toHaveLength(1);
  });
  it('400 VALIDATION_FAILED on a bad device id and on an over-length reason', async () => {
    let r = await call('not-a-uuid', { expectedRevision: 1, desiredAccess: 'approved', reason: 'r' });
    expect(r.status).toBe(400);
    r = await call(DEVICE, { expectedRevision: 1, desiredAccess: 'approved', reason: 'x'.repeat(501) });
    expect(r.status).toBe(400);
  });
  it('404 NOT_FOUND on an unknown device', async () => {
    const r = await call(randomUUID(), { expectedRevision: 1, desiredAccess: 'approved', reason: 'r' });
    expect(r.status).toBe(404);
  });
});

describe('POST /api/v1/admin/incidents/[incidentId]/triage', () => {
  it('triages an open incident with or without a note', async () => {
    store.incidents.set(INCIDENT, { status: 'open' });
    let r = await triagePOST(jsonReq('https://x', { note: 'seen' }), ctx({ incidentId: INCIDENT }));
    expect((await r.json()).status).toBe('triaged');
    expect(store.triageLog[0].note).toBe('seen');
    // triaged -> triaged is allowed; repair_requested is not.
    store.incidents.set(INCIDENT, { status: 'repair_requested' });
    r = await triagePOST(jsonReq('https://x', {}), ctx({ incidentId: INCIDENT }));
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe('INVALID_STATE');
  });
  it('404 on an unknown incident and 400 on a bad id', async () => {
    let r = await triagePOST(jsonReq('https://x', {}), ctx({ incidentId: INCIDENT }));
    expect(r.status).toBe(404);
    r = await triagePOST(jsonReq('https://x', {}), ctx({ incidentId: 'bad' }));
    expect(r.status).toBe(400);
  });
});

describe('POST /api/v1/admin/incidents/[incidentId]/repair', () => {
  it('requests a server-owned repair brief for a known incident', async () => {
    store.incidents.set(INCIDENT, { status: 'open' });
    const r = await repairPOST(jsonReq('https://x', { target: 'android_handoff' }), ctx({ incidentId: INCIDENT }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.state).toBe('brief_ready');
    expect(j.repairRequestId).toBeTruthy();
    expect(store.incidents.get(INCIDENT)!.status).toBe('repair_requested');
  });
  it('404 on unknown, 409 once resolved, 400 on a bad target', async () => {
    store.incidents.set(INCIDENT, { status: 'resolved' });
    let r = await repairPOST(jsonReq('https://x', { target: 'android_handoff' }), ctx({ incidentId: INCIDENT }));
    expect(r.status).toBe(409);
    r = await repairPOST(jsonReq('https://x', { target: 'manual_runbook' }), ctx({ incidentId: randomUUID() }));
    expect(r.status).toBe(404);
    r = await repairPOST(jsonReq('https://x', { target: 'nope' }), ctx({ incidentId: INCIDENT }));
    expect(r.status).toBe(400);
  });
});

describe('POST /api/v1/admin/devices/setup-tokens', () => {
  it('mints a one-use token shown once; only its hash is stored', async () => {
    const r = await tokensPOST(jsonReq('https://x', { hotelId: HOTEL }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.setupToken.length).toBeGreaterThanOrEqual(32);
    expect(j.expiresAt).toBeTruthy();
    const entry = store.setupTokens.get(sha256(j.setupToken));
    expect(entry).toBeDefined();
    expect(entry!.hotelId).toBe(HOTEL);
    expect(entry!.consumed).toBe(false);
  });
  it('400 on an invalid hotel id or an out-of-range expiry', async () => {
    let r = await tokensPOST(jsonReq('https://x', { hotelId: 'nope' }));
    expect(r.status).toBe(400);
    r = await tokensPOST(jsonReq('https://x', { hotelId: HOTEL, expiresInHours: 100 }));
    expect(r.status).toBe(400);
  });
});

describe('GET /api/v1/admin/dashboard', () => {
  it('returns the ratified v1 snapshot shape', async () => {
    store.seedDevice({ id: DEVICE });
    const r = await dashboardGET(new Request('https://x/api/v1/admin/dashboard'));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.schemaVersion).toBe(1);
    expect(j.asOf).toBeTruthy();
    expect(Array.isArray(j.hotels)).toBe(true);
    expect(j.devices[0].access.desired).toBe('pending');
  });
  it('REV 13: devices[].update carries the latest accepted update.status; null when never reported', async () => {
    store.seedDevice({ id: DEVICE });
    const base = { eventId: randomUUID(), bootId: randomUUID(), sequence: 1, build: '17.0.44' };
    const up = (over: Record<string, unknown>) => ({
      ...base, kind: 'update.status' as const, feedId: 'github:somdipto/manzanilla', state: 'update_available' as const,
      currentBuild: '17.0.44', discoveredVersion: '17.0.45', publishedAt: null, progressPct: null, error: null,
      occurredAt: '2026-11-10T03:00:00+05:30', ...over,
    });
    const device = store.devices.get(DEVICE)!;
    // Older occurredAt must lose even when received later; same occurredAt -> receivedAt tiebreak.
    await store.ingestEvents(device, [up({ eventId: randomUUID(), state: 'installed', discoveredVersion: null, occurredAt: '2026-11-10T02:00:00+05:30' })], '2026-11-10T03:10:00+05:30');
    await store.ingestEvents(device, [up({})], '2026-11-10T03:05:00+05:30');
    await store.ingestEvents(device, [up({ eventId: randomUUID(), state: 'failed', error: 'checksum mismatch' })], '2026-11-10T03:06:00+05:30');
    let r = await dashboardGET(new Request('https://x/api/v1/admin/dashboard'));
    let j = await r.json();
    // Latest = same occurredAt as 'update_available' but later receivedAt: failed wins.
    expect(j.devices[0].update).toMatchObject({ state: 'failed', error: 'checksum mismatch', reportedAt: '2026-11-10T03:00:00+05:30', feedId: 'github:somdipto/manzanilla' });
    store.seedDevice({ id: '99999999-9999-4999-8999-999999999999' });
    r = await dashboardGET(new Request('https://x/api/v1/admin/dashboard'));
    j = await r.json();
    expect(j.devices.find((d: { id: string }) => d.id === '99999999-9999-4999-8999-999999999999').update).toBeNull();
  });
  it('REV 13: a legacy/incomplete update row yields update:null, never a fabricated projection', async () => {
    store.seedDevice({ id: DEVICE });
    // Pre-0009 storage shape: kind row exists, all typed update columns NULL.
    store.updateEvents.push({
      deviceId: DEVICE,
      event: { kind: 'update.status', occurredAt: '2026-11-10T01:00:00+05:30' } as never,
      occurredAt: '2026-11-10T01:00:00+05:30', receivedAt: '2026-11-10T01:00:01+05:30',
    });
    const r = await dashboardGET(new Request('https://x/api/v1/admin/dashboard'));
    const j = await r.json();
    const update = j.devices[0].update;
    expect(update).toBeNull();
    expect(JSON.stringify(update)).not.toContain('"null"');
  });
  it('400 on a non-numeric periodDays and 503 when unconfigured', async () => {
    let r = await dashboardGET(new Request('https://x/api/v1/admin/dashboard?periodDays=abc'));
    expect(r.status).toBe(400);
    state.store = null;
    r = await dashboardGET(new Request('https://x/api/v1/admin/dashboard'));
    expect(r.status).toBe(503);
  });
});

import { checkRateLimit } from '../../src/lib/auth/rate-limit';
it('distributed limiter outage refuses admin mutation before body read', async () => {
  vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, unavailable: true, retryAfterMs: 5000 });
  const req = jsonReq(`https://x/api/v1/admin/devices/${DEVICE}/policy`, {});
  const r = await policyPOST(req, ctx({ deviceId: DEVICE }));
  expect(r.status).toBe(503);
  expect((await r.json()).error.code).toBe('RATE_LIMIT_UNAVAILABLE');
  expect(req.bodyUsed).toBe(false);
});
