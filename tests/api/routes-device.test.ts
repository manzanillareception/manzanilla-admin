vi.mock('../../src/lib/auth/rate-limit', () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterMs: 0 })) }));
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';

const state = vi.hoisted(() => ({
  store: null as null | InstanceType<typeof import('./memory-store').MemoryControlStore>,
  deviceAuth: null as unknown,
  hotelAuth: null as unknown,
}));

vi.mock('../../src/lib/server/deps', () => ({
  defaultDeps: () => ({ store: state.store, now: () => new Date() }),
}));
vi.mock('../../src/lib/auth/device', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/auth/device')>();
  return { ...actual, requireDeviceScope: async () => state.deviceAuth };
});
vi.mock('../../src/lib/auth/hotel', () => ({
  requireHotelScope: async () => state.hotelAuth,
}));

import { MemoryControlStore } from './memory-store';
import { POST as enrollPOST } from '../../src/app/api/v1/devices/enroll/route';
import { POST as heartbeatPOST } from '../../src/app/api/v1/devices/heartbeat/route';
import { POST as eventsPOST } from '../../src/app/api/v1/events/batch/route';
import { POST as sessionsPOST } from '../../src/app/api/v1/devices/sessions/route';
import { POST as ackPOST } from '../../src/app/api/v1/devices/policy-ack/route';

const BOOT = randomUUID();
let ip = 0;
function jsonReq(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  ip += 1;
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.9.0.${ip}`, ...headers },
    body: JSON.stringify(body),
  });
}
function sha256(s: string): string { return createHash('sha256').update(s, 'utf8').digest('hex'); }
function denied(status: number, code: string) {
  return { ok: false, response: Response.json({ error: { code, message: 'denied', retryable: false } }, { status }) };
}
function scopeFor(store: MemoryControlStore, deviceId: string) {
  const device = store.devices.get(deviceId)!;
  return { ok: true, scope: { deviceId, hotelId: device.hotelId, device } };
}
function ev(overrides: Record<string, unknown>): Record<string, unknown> {
  return { eventId: randomUUID(), bootId: BOOT, sequence: 1, occurredAt: new Date().toISOString(), build: '17.0.44', ...overrides };
}
function sessionEv(kind: string, sessionId: string, feature = 'translation', extra: Record<string, unknown> = {}) {
  return ev({ kind, sessionId, attemptId: `att-${sessionId}`, feature, ...extra });
}

let store: MemoryControlStore;
beforeEach(() => {
  store = new MemoryControlStore();
  state.store = store;
  state.deviceAuth = null;
  state.hotelAuth = null;
});

describe('POST /api/v1/devices/enroll', () => {
  const body = { label: 'Front desk', build: '17.0.44', bootId: BOOT };
  it('503 SETUP_REQUIRED when the store is not configured', async () => {
    state.store = null;
    const r = await enrollPOST(jsonReq('https://x/api/v1/devices/enroll', body, { authorization: 'Bearer jwt' }));
    expect(r.status).toBe(503);
    expect((await r.json()).error.code).toBe('SETUP_REQUIRED');
  });
  it('enrolls via the primary hotel-session path and returns a one-time credential', async () => {
    state.hotelAuth = { ok: true, scope: { hotelId: 'hotel-1', userId: 'u1' } };
    const r = await enrollPOST(jsonReq('https://x/api/v1/devices/enroll', body, { authorization: 'Bearer jwt' }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.deviceId).toBeTruthy();
    expect(j.deviceCredential.length).toBeGreaterThanOrEqual(32);
    expect(j.desiredAccess).toBe('pending'); // approval stays an independent admin action
    expect(j.policyRevision).toBe(1);
    expect(store.devices.get(j.deviceId)!.hotelId).toBe('hotel-1');
    expect(store.credentialHashes.get(j.deviceId)).toBe(sha256(j.deviceCredential));
  });
  it('enrolls via a one-use setup token (admin-assisted path)', async () => {
    const token = 'setup-token-plaintext-value';
    store.setupTokens.set(sha256(token), { hotelId: 'hotel-2', expiresAt: new Date(Date.now() + 3600e3).toISOString(), consumed: false });
    const r = await enrollPOST(jsonReq('https://x/api/v1/devices/enroll', { ...body, setupToken: token }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(store.devices.get(j.deviceId)!.hotelId).toBe('hotel-2');
    expect(store.setupTokens.get(sha256(token))!.consumed).toBe(true);
  });
  it('401 when neither credential path is supplied', async () => {
    const r = await enrollPOST(jsonReq('https://x/api/v1/devices/enroll', body));
    expect(r.status).toBe(401);
    expect((await r.json()).error.code).toBe('UNAUTHORIZED');
  });
  it('session path wins when both are supplied; the token is left untouched', async () => {
    const token = 'setup-token-plaintext-value';
    store.setupTokens.set(sha256(token), { hotelId: 'hotel-2', expiresAt: new Date(Date.now() + 3600e3).toISOString(), consumed: false });
    state.hotelAuth = { ok: true, scope: { hotelId: 'hotel-1', userId: 'u1' } };
    const r = await enrollPOST(jsonReq('https://x/api/v1/devices/enroll', { ...body, setupToken: token }, { authorization: 'Bearer jwt' }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(store.devices.get(j.deviceId)!.hotelId).toBe('hotel-1');
    expect(store.setupTokens.get(sha256(token))!.consumed).toBe(false);
  });
  it('401 SETUP_TOKEN_INVALID / SETUP_TOKEN_CONSUMED on bad tokens', async () => {
    let r = await enrollPOST(jsonReq('https://x/api/v1/devices/enroll', { ...body, setupToken: 'unknown-token' }));
    expect((await r.json()).error.code).toBe('SETUP_TOKEN_INVALID');
    const token = 'consumed-token';
    store.setupTokens.set(sha256(token), { hotelId: 'hotel-2', expiresAt: new Date(Date.now() + 3600e3).toISOString(), consumed: true });
    r = await enrollPOST(jsonReq('https://x/api/v1/devices/enroll', { ...body, setupToken: token }));
    expect((await r.json()).error.code).toBe('SETUP_TOKEN_CONSUMED');
  });
  it('400 VALIDATION_FAILED on an invalid body', async () => {
    state.hotelAuth = { ok: true, scope: { hotelId: 'hotel-1', userId: 'u1' } };
    const r = await enrollPOST(jsonReq('https://x/api/v1/devices/enroll', { build: '17.0.44', bootId: BOOT }, { authorization: 'Bearer jwt' }));
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe('VALIDATION_FAILED');
  });
  it('propagates hotel-session failure untouched', async () => {
    state.hotelAuth = denied(401, 'UNAUTHORIZED');
    const r = await enrollPOST(jsonReq('https://x/api/v1/devices/enroll', body, { authorization: 'Bearer jwt' }));
    expect(r.status).toBe(401);
  });
});

describe('POST /api/v1/devices/heartbeat', () => {
  const hb = { bootId: BOOT, sequence: 5, build: '17.0.44', mode: 'idle', microphone: 'unknown', occurredAt: new Date().toISOString() };
  it('applies a fresh heartbeat and returns current policy state', async () => {
    store.seedDevice({ id: 'dev-hb' });
    state.deviceAuth = scopeFor(store, 'dev-hb');
    const r = await heartbeatPOST(jsonReq('https://x/api/v1/devices/heartbeat', hb, { authorization: 'Bearer cred' }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.desiredAccess).toBe('pending');
    expect(j.policyRevision).toBe(1);
    expect(j.serverTime).toBeTruthy();
    expect(store.devices.get('dev-hb')!.lastHeartbeatSequence).toBe(5);
  });
  it('a replayed/old heartbeat returns 200 with current state and does not regress', async () => {
    store.seedDevice({ id: 'dev-hb2' });
    state.deviceAuth = scopeFor(store, 'dev-hb2');
    await heartbeatPOST(jsonReq('https://x/api/v1/devices/heartbeat', hb, { authorization: 'Bearer cred' }));
    const r = await heartbeatPOST(jsonReq('https://x/api/v1/devices/heartbeat', { ...hb, sequence: 2 }, { authorization: 'Bearer cred' }));
    expect(r.status).toBe(200);
    expect(store.devices.get('dev-hb2')!.lastHeartbeatSequence).toBe(5);
  });
  it('propagates device-auth failure untouched', async () => {
    state.deviceAuth = denied(401, 'CREDENTIAL_REVOKED');
    const r = await heartbeatPOST(jsonReq('https://x/api/v1/devices/heartbeat', hb, { authorization: 'Bearer cred' }));
    expect(r.status).toBe(401);
    expect((await r.json()).error.code).toBe('CREDENTIAL_REVOKED');
  });
});

describe('POST /api/v1/events/batch', () => {
  function envelope(events: Record<string, unknown>[]) {
    return { schemaVersion: 1, events };
  }
  it('accepts new events and counts duplicates on repost', async () => {
    store.seedDevice({ id: 'dev-ev', desiredAccess: 'approved', effectiveAccess: 'approved' });
    state.deviceAuth = scopeFor(store, 'dev-ev');
    const event = ev({ kind: 'diagnostic.snapshot', microphone: 'granted', batteryPercent: 90, freeMemoryMb: null });
    let r = await eventsPOST(jsonReq('https://x/api/v1/events/batch', envelope([event]), { authorization: 'Bearer cred' }));
    expect((await r.json()).accepted).toBe(1);
    r = await eventsPOST(jsonReq('https://x/api/v1/events/batch', envelope([event]), { authorization: 'Bearer cred' }));
    expect((await r.json()).duplicates).toBe(1);
  });
  it('403 DEVICE_BLOCKED for session data while blocked, but keeps ack/diagnostic intake', async () => {
    store.seedDevice({ id: 'dev-bl', desiredAccess: 'blocked', effectiveAccess: 'blocked' });
    state.deviceAuth = scopeFor(store, 'dev-bl');
    let r = await eventsPOST(jsonReq('https://x/api/v1/events/batch', envelope([sessionEv('session.started', 's1')]), { authorization: 'Bearer cred' }));
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe('DEVICE_BLOCKED');
    r = await eventsPOST(jsonReq('https://x/api/v1/events/batch', envelope([
      ev({ kind: 'policy.ack', revision: 1 }),
      ev({ kind: 'diagnostic.snapshot', microphone: 'unknown', batteryPercent: null, freeMemoryMb: null }),
    ]), { authorization: 'Bearer cred' }));
    expect(r.status).toBe(200);
    expect((await r.json()).accepted).toBe(2);
  });
  it('aborts the whole batch on FUTURE_REVISION and records nothing (transactional fail-closed)', async () => {
    store.seedDevice({ id: 'dev-ft', desiredAccess: 'approved', effectiveAccess: 'approved', policyRevision: 1 });
    state.deviceAuth = scopeFor(store, 'dev-ft');
    const started = sessionEv('session.started', 's-future');
    const r = await eventsPOST(jsonReq('https://x/api/v1/events/batch', envelope([started, ev({ kind: 'policy.ack', revision: 99 })]), { authorization: 'Bearer cred' }));
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe('FUTURE_REVISION');
    // The session.started from the aborted batch was NOT recorded: reposting it alone is accepted.
    const r2 = await eventsPOST(jsonReq('https://x/api/v1/events/batch', envelope([started]), { authorization: 'Bearer cred' }));
    expect((await r2.json()).accepted).toBe(1);
  });
  it('400 on out-of-window timestamps and on a feature change within a batch', async () => {
    store.seedDevice({ id: 'dev-val', desiredAccess: 'approved', effectiveAccess: 'approved' });
    state.deviceAuth = scopeFor(store, 'dev-val');
    let r = await eventsPOST(jsonReq('https://x/api/v1/events/batch',
      envelope([ev({ kind: 'diagnostic.snapshot', microphone: 'unknown', batteryPercent: null, freeMemoryMb: null, occurredAt: new Date(Date.now() + 3600e3).toISOString() })]),
      { authorization: 'Bearer cred' }));
    expect(r.status).toBe(400);
    r = await eventsPOST(jsonReq('https://x/api/v1/events/batch',
      envelope([sessionEv('session.started', 's-fx', 'translation'), sessionEv('session.connected', 's-fx', 'reception', { firstAudioMs: null })]),
      { authorization: 'Bearer cred' }));
    expect(r.status).toBe(400);
  });
  function updateStatusEv(extra: Record<string, unknown> = {}) {
    return ev({ kind: 'update.status', feedId: 'github:somdipto/manzanilla', state: 'installed', currentBuild: '17.0.44', discoveredVersion: null, publishedAt: null, progressPct: null, error: null, ...extra });
  }
  it('REV 12: accepts update.status in a v2 envelope, rejects it in v1, blocks it for blocked devices', async () => {
    store.seedDevice({ id: 'dev-u2', desiredAccess: 'approved', effectiveAccess: 'approved' });
    state.deviceAuth = scopeFor(store, 'dev-u2');
    let r = await eventsPOST(jsonReq('https://x/api/v1/events/batch', { schemaVersion: 2, events: [updateStatusEv()] }, { authorization: 'Bearer cred' }));
    expect(r.status).toBe(200);
    expect((await r.json()).accepted).toBe(1);
    // v1 envelope carrying the new kind fails the schema gate.
    r = await eventsPOST(jsonReq('https://x/api/v1/events/batch', { schemaVersion: 1, events: [updateStatusEv()] }, { authorization: 'Bearer cred' }));
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe('VALIDATION_FAILED');
    // Blocked device: update.status is NOT in the blocked-allowed set.
    store.seedDevice({ id: 'dev-ub', desiredAccess: 'blocked', effectiveAccess: 'blocked' });
    state.deviceAuth = scopeFor(store, 'dev-ub');
    r = await eventsPOST(jsonReq('https://x/api/v1/events/batch', { schemaVersion: 2, events: [updateStatusEv()] }, { authorization: 'Bearer cred' }));
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe('DEVICE_BLOCKED');
  });
  it('REV 12: a malformed update.status payload fails validation', async () => {
    store.seedDevice({ id: 'dev-u3', desiredAccess: 'approved', effectiveAccess: 'approved' });
    state.deviceAuth = scopeFor(store, 'dev-u3');
    const r = await eventsPOST(jsonReq('https://x/api/v1/events/batch', { schemaVersion: 2, events: [updateStatusEv({ state: 'mystery' })] }, { authorization: 'Bearer cred' }));
    expect(r.status).toBe(400);
  });
  it('409 INVALID_STATE when a session restarts after ending', async () => {
    store.seedDevice({ id: 'dev-end', desiredAccess: 'approved', effectiveAccess: 'approved' });
    state.deviceAuth = scopeFor(store, 'dev-end');
    await eventsPOST(jsonReq('https://x/api/v1/events/batch',
      envelope([sessionEv('session.started', 's-end'), sessionEv('session.ended', 's-end', 'translation', { durationMs: 1000, durationProvenance: 'observed' })]),
      { authorization: 'Bearer cred' }));
    const r = await eventsPOST(jsonReq('https://x/api/v1/events/batch', envelope([sessionEv('session.started', 's-end')]), { authorization: 'Bearer cred' }));
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe('INVALID_STATE');
  });
});

describe('POST /api/v1/devices/sessions', () => {
  const admission = { sessionId: 's-adm', attemptId: 'a-1', feature: 'translation' };
  it('denies pending devices with admit:false (immediate desired semantics)', async () => {
    store.seedDevice({ id: 'dev-p' });
    state.deviceAuth = scopeFor(store, 'dev-p');
    const r = await sessionsPOST(jsonReq('https://x/api/v1/devices/sessions', admission, { authorization: 'Bearer cred' }));
    const j = await r.json();
    expect(j.admit).toBe(false);
    expect(j.reason).toBe('pending');
  });
  it('denies blocked devices independent of any prior approval', async () => {
    store.seedDevice({ id: 'dev-b', desiredAccess: 'blocked', effectiveAccess: 'approved' });
    state.deviceAuth = scopeFor(store, 'dev-b');
    const r = await sessionsPOST(jsonReq('https://x/api/v1/devices/sessions', admission, { authorization: 'Bearer cred' }));
    const j = await r.json();
    expect(j.admit).toBe(false);
    expect(j.reason).toBe('blocked');
  });
  it('admits approved devices with provider:null in contract v1', async () => {
    store.seedDevice({ id: 'dev-a', desiredAccess: 'approved', effectiveAccess: 'approved' });
    state.deviceAuth = scopeFor(store, 'dev-a');
    const r = await sessionsPOST(jsonReq('https://x/api/v1/devices/sessions', admission, { authorization: 'Bearer cred' }));
    const j = await r.json();
    expect(j.admit).toBe(true);
    expect(j.provider).toBeNull();
  });
  it('409 INVALID_STATE on an ended session and 409 SESSION_FEATURE_MISMATCH on feature flip', async () => {
    store.seedDevice({ id: 'dev-s2', desiredAccess: 'approved', effectiveAccess: 'approved' });
    state.deviceAuth = scopeFor(store, 'dev-s2');
    await eventsPOST(jsonReq('https://x/api/v1/events/batch', { schemaVersion: 1, events: [sessionEv('session.started', 's-adm'), sessionEv('session.ended', 's-adm', 'translation', { durationMs: 10, durationProvenance: 'observed' })] }, { authorization: 'Bearer cred' }));
    let r = await sessionsPOST(jsonReq('https://x/api/v1/devices/sessions', admission, { authorization: 'Bearer cred' }));
    expect((await r.json()).error.code).toBe('INVALID_STATE');
    store.sessions.set('dev-s2:s-flip', { ref: 's-flip', feature: 'translation', state: 'creating', attempts: new Set() });
    r = await sessionsPOST(jsonReq('https://x/api/v1/devices/sessions', { sessionId: 's-flip', attemptId: 'a-2', feature: 'reception' }, { authorization: 'Bearer cred' }));
    expect((await r.json()).error.code).toBe('SESSION_FEATURE_MISMATCH');
  });
});

describe('POST /api/v1/devices/policy-ack', () => {
  it('records a current ACK and advances effectiveAccess; stale ACKs never regress', async () => {
    store.seedDevice({ id: 'dev-ack' });
    await store.setDevicePolicy('admin-a', 'dev-ack', { expectedRevision: 1, desiredAccess: 'approved', reason: 'approve' });
    state.deviceAuth = scopeFor(store, 'dev-ack');
    let r = await ackPOST(jsonReq('https://x/api/v1/devices/policy-ack', { revision: 2, bootId: BOOT, sequence: 1 }, { authorization: 'Bearer cred' }));
    expect(r.status).toBe(200);
    expect((await r.json()).acknowledged).toBe(true);
    expect(store.devices.get('dev-ack')!.ackRevision).toBe(2);
    expect(store.devices.get('dev-ack')!.effectiveAccess).toBe('approved');
    // Stale ACK for rev1: still 200, state unchanged.
    state.deviceAuth = scopeFor(store, 'dev-ack');
    r = await ackPOST(jsonReq('https://x/api/v1/devices/policy-ack', { revision: 1, bootId: BOOT, sequence: 2 }, { authorization: 'Bearer cred' }));
    expect(r.status).toBe(200);
    expect(store.devices.get('dev-ack')!.ackRevision).toBe(2);
  });
  it('400 when the ACK claims a revision the server never issued', async () => {
    store.seedDevice({ id: 'dev-ack2' });
    state.deviceAuth = scopeFor(store, 'dev-ack2');
    const r = await ackPOST(jsonReq('https://x/api/v1/devices/policy-ack', { revision: 5, bootId: BOOT, sequence: 1 }, { authorization: 'Bearer cred' }));
    expect(r.status).toBe(400);
  });
});

import { checkRateLimit } from '../../src/lib/auth/rate-limit';
describe('distributed limiter failure policy', () => {
  it('heartbeat fails closed with retryable 503 before reading the body', async () => {
    store.seedDevice({ id: 'dev-rate' });
    state.deviceAuth = scopeFor(store, 'dev-rate');
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, unavailable: true, retryAfterMs: 5000 });
    const req = jsonReq('https://x/api/v1/devices/heartbeat', {});
    const r = await heartbeatPOST(req);
    expect(r.status).toBe(503);
    expect((await r.json()).error).toMatchObject({ code: 'RATE_LIMIT_UNAVAILABLE', retryable: true, retryAfterMs: 5000 });
    expect(req.bodyUsed).toBe(false);
  });
  it('events return 429 (not 503) for a real exhausted window', async () => {
    store.seedDevice({ id: 'dev-rate-events', desiredAccess: 'approved', effectiveAccess: 'approved' });
    state.deviceAuth = scopeFor(store, 'dev-rate-events');
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, retryAfterMs: 30000 });
    const req = jsonReq('https://x/api/v1/events/batch', {});
    const r = await eventsPOST(req);
    expect(r.status).toBe(429);
    expect((await r.json()).error.code).toBe('RATE_LIMITED');
    expect(req.bodyUsed).toBe(false);
  });
});
