import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLiveSource, repairTargetFor } from '../src/components/data/live-source';
import { DashboardError } from '../src/components/data/types';
import { createDemoSource } from '../src/components/data/demo-source';
import { mapRowsToSnapshot, type DashboardRows } from '../src/lib/queries/dashboard';
import type { Incident, Snapshot } from '../src/domain/types';

const NOW = '2026-11-10T09:00:00.000Z';

function emptySnapshot(): Snapshot {
  return { schemaVersion: 1, asOf: NOW, hotels: [], devices: [], sessions: [], traffic: [], incidents: [], policyHistory: [], repairRequests: [] };
}

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('live dashboard source', () => {
  it('parses a valid snapshot page and reports the server as-of time', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(200, emptySnapshot())));
    const source = createLiveSource();
    const read = await source.load();
    expect(read.asOf).toBe(NOW);
    expect(read.snapshot.devices).toHaveLength(0);
  });

  it('accumulates paginated snapshots via nextCursor without duplicating the first page', async () => {
    const page1 = { ...emptySnapshot(), hotels: [{ id: 'h1', name: 'Hotel Mar', city: 'Barcelona, ES' }], devices: [{ id: 'd1', code: 'D1', label: 'Front desk', hotelId: 'h1', build: '17.0.43', managed: true, credential: 'valid', lastSeenAt: null, microphone: 'unknown', mode: 'idle', access: { desired: 'pending', effective: 'pending', revision: 1, ackRevision: 0, changedAt: NOW, reason: 'Enrolled' } }], nextCursor: 'c2' };
    const page2 = { ...emptySnapshot(), incidents: [{ id: 'i1', fingerprint: 'fp', code: 'CONNECTION_TIMEOUT', component: 'network', severity: 'high', title: 'Connection attempts timing out', firstSeenAt: NOW, lastSeenAt: NOW, deviceIds: ['d1'], occurrences: 3, build: '17.0.43', status: 'open', owner: null, fixClass: 'hotel_action', nextStep: 'Check Wi-Fi', dueAt: NOW }], nextCursor: null };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(respond(200, page1))
      .mockResolvedValueOnce(respond(200, page2));
    vi.stubGlobal('fetch', fetchMock);
    const read = await createLiveSource().load();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('cursor=c2');
    expect(read.snapshot.devices).toHaveLength(1);
    expect(read.snapshot.incidents).toHaveLength(1);
  });

  it('maps the §8 error envelope to honest states and never returns demo data', async () => {
    const cases: [number, string, string][] = [
      [401, 'UNAUTHORIZED', 'unauthorized'],
      [403, 'FORBIDDEN', 'forbidden'],
      [403, 'MFA_SETUP_REQUIRED', 'forbidden'],
      [503, 'SETUP_REQUIRED', 'setup-required'],
      [503, 'UNAVAILABLE', 'unavailable'],
      [429, 'RATE_LIMITED', 'rate-limited'],
      [409, 'STALE_REVISION', 'conflict'],
      [409, 'FUTURE_REVISION', 'conflict'],
      [409, 'SESSION_FEATURE_MISMATCH', 'conflict'],
      [409, 'INVALID_STATE', 'invalid-state'],
      [404, 'NOT_FOUND', 'not-found'],
      [400, 'VALIDATION_FAILED', 'validation'],
    ];
    for (const [status, code, kind] of cases) {
      vi.stubGlobal('fetch', vi.fn(async () => respond(status, { error: { code, message: `msg-${code}`, retryable: false } })));
      const error = await createLiveSource().load().catch((e) => e);
      expect(error).toBeInstanceOf(DashboardError);
      expect((error as DashboardError).kind).toBe(kind);
    }
  });

  it('treats a missing read route as unavailable, not as demo', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(404, {})));
    const error = await createLiveSource().load().catch((e) => e);
    expect(error).toBeInstanceOf(DashboardError);
    expect((error as DashboardError).kind).toBe('unavailable');
  });

  it('rejects a 200 payload outside the contract instead of rendering it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(200, { hello: 'world' })));
    const error = await createLiveSource().load().catch((e) => e);
    expect(error).toBeInstanceOf(DashboardError);
    expect((error as DashboardError).kind).toBe('bad-response');
  });

  it('maps network failure to a retryable network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const error = await createLiveSource().load().catch((e) => e);
    expect(error).toBeInstanceOf(DashboardError);
    expect((error as DashboardError).kind).toBe('network');
    expect((error as DashboardError).retryable).toBe(true);
  });

  it('sends the frozen policy body and reloads after the mutation', async () => {
    const calls: [string, RequestInit?][] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      if (init?.method === 'POST') return respond(200, { deviceId: 'd1', revision: 4, desiredAccess: 'blocked', effectiveAccess: 'approved' });
      return respond(200, emptySnapshot());
    }));
    await createLiveSource().requestPolicy({ deviceId: 'd1', desired: 'blocked', reason: 'Operator review', expectedRevision: 3 });
    expect(calls[0][0]).toBe('/api/v1/admin/devices/d1/policy');
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({ expectedRevision: 3, desiredAccess: 'blocked', reason: 'Operator review' });
    expect(calls[1][0]).toContain('/api/v1/admin/dashboard');
  });

  it('sends the canonical email-lane hotel body with confirmed address', async () => {
    const calls: [string, RequestInit?][] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      if (init?.method === 'POST') return respond(202, { hotelId: 'h1', jobId: 'j1', duplicate: false, status: 'in_progress' });
      return respond(200, emptySnapshot());
    }));
    const result = await createLiveSource().createHotel!({ hotelName: 'Hotel Mar', city: 'Barcelona, ES', email: 'reception@hotel.example', confirmEmail: 'reception@hotel.example' });
    expect(result).toMatchObject({ hotelId: 'h1', jobId: 'j1', duplicate: false, status: 'in_progress' });
    expect(calls[0][0]).toBe('/api/v1/admin/hotels');
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({ hotelName: 'Hotel Mar', city: 'Barcelona, ES', email: 'reception@hotel.example', confirmEmail: 'reception@hotel.example' });
  });

  it('derives repair targets with the server-owned rule', () => {
    const base = { fixClass: 'code_candidate' } as Incident;
    expect(repairTargetFor({ ...base, component: 'control' })).toBe('new_admin_repo');
    expect(repairTargetFor({ ...base, component: 'android' })).toBe('android_handoff');
    expect(repairTargetFor({ ...base, fixClass: 'external', component: 'provider' })).toBe('manual_runbook');
  });
});

describe('demo source stays explicit', () => {
  it('loads synthetic data only when constructed and supports local mutations', async () => {
    const source = createDemoSource();
    const read = await source.load();
    expect(read.snapshot.devices.length).toBeGreaterThan(0);
    const device = read.snapshot.devices.find((d) => d.managed && d.credential === 'valid' && d.access.desired === 'approved')!;
    const changed = await source.requestPolicy({ deviceId: device.id, desired: 'blocked', reason: 'Operator review', expectedRevision: device.access.revision });
    expect(changed.snapshot.devices.find((d) => d.id === device.id)!.access.desired).toBe('blocked');
  });
});

describe('dashboard row mapping (control-foundation schema)', () => {
  it('maps rows to the read model with separate states preserved', () => {
    const rows: DashboardRows = {
      hotels: [{ id: 'h1', name: 'Hotel Mar', city: 'Barcelona, ES' }],
      devices: [{ id: 'd1', hotel_id: 'h1', code: 'MAR-01', label: 'Front desk', build: '17.0.43', managed: true, credential_state: 'valid', desired_access: 'blocked', effective_access: 'approved', policy_revision: 4, ack_revision: 3, policy_changed_at: NOW, last_seen_at: NOW, microphone: 'granted', mode: 'translation' }],
      sessions: [{ id: 's1', device_id: 'd1', feature: 'translation', started_at: NOW, connected_at: NOW, ended_at: null, duration_ms: 300000, duration_provenance: 'observed' }],
      attempts: [
        { id: 'a1', session_id: 's1', device_id: 'd1', attempt_number: 1, started_at: NOW, connected_at: null, ended_at: NOW, outcome: 'failed', first_audio_ms: null, failure_code: 'CONNECTION_TIMEOUT' },
        { id: 'a2', session_id: 's1', device_id: 'd1', attempt_number: 2, started_at: NOW, connected_at: NOW, ended_at: null, outcome: 'active', first_audio_ms: 500, failure_code: null },
      ],
      traffic: [{ device_id: 'd1', bucket_at: NOW, requests: 10, failed_requests: 1, retry_requests: 2, ingress_bytes: 4096, latency_histogram: [120, 240] }],
      incidents: [{ id: 'i1', fingerprint: 'fp', error_code: 'CONNECTION_TIMEOUT', component: 'network', severity: 'high', build: '17.0.43', first_seen_at: NOW, last_seen_at: NOW, occurrences: 3, status: 'open', fix_class: 'hotel_action', due_at: NOW }],
      incidentDevices: [{ incident_id: 'i1', device_id: 'd1' }],
      audit: [{ id: 7, device_id: 'd1', action: 'policy_requested', policy_revision: 4, desired_access: 'blocked', reason: 'Service blocked for operational review', created_at: NOW }],
      repairs: [{ id: 'r1', incident_id: 'i1', target: 'manual_runbook', state: 'brief_ready', created_at: NOW }],
    };
    const snapshot = mapRowsToSnapshot(rows, NOW);
    const device = snapshot.devices[0];
    expect(device.access).toMatchObject({ desired: 'blocked', effective: 'approved', revision: 4, ackRevision: 3, reason: 'Service blocked for operational review' });
    const failed = snapshot.sessions.find((a) => a.id === 'a1')!;
    const connected = snapshot.sessions.find((a) => a.id === 'a2')!;
    expect(failed.durationMs).toBeNull();
    expect(connected).toMatchObject({ durationMs: 300000, durationProvenance: 'observed', feature: 'translation' });
    expect(snapshot.incidents[0]).toMatchObject({ title: 'Connection attempts timing out', deviceIds: ['d1'], occurrences: 3, owner: null });
    expect(snapshot.incidents[0].nextStep).toContain('hotel');
    expect(snapshot.traffic[0]).toMatchObject({ requests: 10, failedRequests: 1, latenciesMs: [120, 240] });
    expect(snapshot.policyHistory[0]).toMatchObject({ deviceId: 'd1', revision: 4, desired: 'blocked' });
    expect(snapshot.repairRequests[0]).toMatchObject({ incidentId: 'i1', state: 'brief_ready' });
  });
});

describe('rev11 recorded retry', () => {
  it('flags a historical recorded policy response so the UI can say so', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return respond(200, { deviceId: 'd1', revision: 4, desiredAccess: 'blocked', effectiveAccess: 'approved', recorded: true });
      return respond(200, emptySnapshot());
    }));
    const read = await createLiveSource().requestPolicy({ deviceId: 'd1', desired: 'blocked', reason: 'Operator review', expectedRevision: 3 });
    expect(read.recordedRetry).toBe(true);
  });
  it('treats recorded:false/absent as a fresh change', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return respond(200, { deviceId: 'd1', revision: 4, desiredAccess: 'blocked', effectiveAccess: 'approved', recorded: false });
      return respond(200, emptySnapshot());
    }));
    const read = await createLiveSource().requestPolicy({ deviceId: 'd1', desired: 'blocked', reason: 'Operator review', expectedRevision: 3 });
    expect(read.recordedRetry).toBeUndefined();
  });
});

describe('rev13 devices[].update', () => {
  const device = { id: 'd1', code: 'D1', label: 'Front desk', hotelId: 'h1', build: '17.0.43', managed: true, credential: 'valid', lastSeenAt: null, microphone: 'unknown', mode: 'idle', access: { desired: 'approved', effective: 'approved', revision: 1, ackRevision: 1, changedAt: NOW, reason: 'Enrolled' } };
  it('accepts the optional update key and carries it through', async () => {
    const update = { feedId: 'github:somdipto/manzanilla', state: 'update_available', currentBuild: '17.0.43', discoveredVersion: '17.1.0', publishedAt: NOW, progressPct: null, error: null, reportedAt: NOW };
    vi.stubGlobal('fetch', vi.fn(async () => respond(200, { ...emptySnapshot(), devices: [{ ...device, update }] })));
    const read = await createLiveSource().load();
    expect(read.snapshot.devices[0].update).toMatchObject({ state: 'update_available', discoveredVersion: '17.1.0' });
  });
  it('accepts update:null and an absent update key (never reported)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(200, { ...emptySnapshot(), devices: [{ ...device, update: null }] })));
    const read = await createLiveSource().load();
    expect(read.snapshot.devices[0].update).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => respond(200, { ...emptySnapshot(), devices: [device] })));
    const read2 = await createLiveSource().load();
    expect(read2.snapshot.devices[0].update).toBeUndefined();
  });
  it('still hard-rejects other unknown device keys', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(200, { ...emptySnapshot(), devices: [{ ...device, surprise: true }] })));
    await expect(createLiveSource().load()).rejects.toMatchObject({ kind: 'bad-response' });
  });
  it('rejects an update payload outside the ratified shape', async () => {
    const bad = { feedId: 'f', state: 'up_to_date', currentBuild: '1.0', discoveredVersion: null, publishedAt: null, progressPct: 120, error: null, reportedAt: NOW };
    vi.stubGlobal('fetch', vi.fn(async () => respond(200, { ...emptySnapshot(), devices: [{ ...device, update: bad }] })));
    await expect(createLiveSource().load()).rejects.toMatchObject({ kind: 'bad-response' });
  });
});

describe('update-state rendering copy', () => {
  it('describes every state honestly, including never-reported', async () => {
    const { describeUpdate } = await import('../src/components/data/update-state');
    expect(describeUpdate(null)).toMatchObject({ label: 'Not reported', tone: 'muted' });
    expect(describeUpdate(undefined)).toMatchObject({ label: 'Not reported', tone: 'muted' });
    const base = { feedId: 'f', discoveredVersion: null, publishedAt: null, progressPct: null, error: null, reportedAt: NOW, currentBuild: '17.0.43' };
    expect(describeUpdate({ ...base, state: 'up_to_date' }).label).toBe('Up to date · 17.0.43');
    expect(describeUpdate({ ...base, state: 'update_available', discoveredVersion: '17.1.0' })).toMatchObject({ label: 'Update available → 17.1.0', tone: 'attention' });
    expect(describeUpdate({ ...base, state: 'downloading', progressPct: 40 }).label).toBe('Downloading update · 40%');
    expect(describeUpdate({ ...base, state: 'failed', error: 'checksum mismatch' })).toMatchObject({ label: 'Update failed · checksum mismatch', tone: 'bad' });
    expect(describeUpdate({ ...base, state: 'installed', currentBuild: '17.1.0' }).label).toBe('Installed · 17.1.0');
  });
});

describe('rev13 hotel create + recovery', () => {
  const created = { hotelId: 'h9', jobId: 'j9', duplicate: false, status: 'in_progress' };
  it('returns the 202 job fields alongside the reloaded read', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return respond(202, { ...created, status: 'needs_attention', nextStep: 'use_recovery' });
      return respond(200, emptySnapshot());
    }));
    const result = await createLiveSource().createHotel!({ hotelName: 'Hotel Mar', city: 'Barcelona, ES', email: 'a@b.co', confirmEmail: 'a@b.co' });
    expect(result).toMatchObject({ hotelId: 'h9', jobId: 'j9', status: 'needs_attention', nextStep: 'use_recovery' });
    expect(result.read.asOf).toBe(NOW);
  });
  it('rejects a create response outside the contract instead of guessing', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return respond(202, { ok: true });
      return respond(200, emptySnapshot());
    }));
    await expect(createLiveSource().createHotel!({ hotelName: 'H', city: 'C', email: 'a@b.co', confirmEmail: 'a@b.co' })).rejects.toMatchObject({ kind: 'bad-response' });
  });
  it('sends exactly the chosen recovery mode to the recovery route', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return respond(202, { jobId: 'j10' });
      return respond(200, emptySnapshot());
    });
    vi.stubGlobal('fetch', fetchMock);
    await createLiveSource().sendRecovery!('h9', 'reset_link');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/admin/hotels/h9/recovery');
    expect(JSON.parse(String(init.body))).toEqual({ mode: 'reset_link' });
  });
});

describe('recovery AAL gate', () => {
  it('requires the challenge only when the session is AAL1 and the account can reach AAL2', async () => {
    const { requiresAal2 } = await import('../src/components/auth/aal-gate');
    expect(requiresAal2({ currentLevel: 'aal1', nextLevel: 'aal2' })).toBe(true);
    expect(requiresAal2({ currentLevel: 'aal2', nextLevel: 'aal2' })).toBe(false);
    expect(requiresAal2({ currentLevel: 'aal1', nextLevel: 'aal1' })).toBe(false);
    expect(requiresAal2(null)).toBe(false);
    expect(requiresAal2(undefined)).toBe(false);
  });

  it('keeps only same-origin paths for the post-challenge return', async () => {
    const { safeNextPath } = await import('../src/components/auth/aal-gate');
    expect(safeNextPath('/reset-password')).toBe('/reset-password');
    expect(safeNextPath('/mfa/enroll?x=1')).toBe('/mfa/enroll?x=1');
    expect(safeNextPath('/')).toBe('/');
    expect(safeNextPath('https://evil.example/x')).toBe('/');
    expect(safeNextPath('//evil.example/x')).toBe('/');
    expect(safeNextPath('/\\evil.example')).toBe('/');
    expect(safeNextPath('/reset\nSet-Cookie:x')).toBe('/');
    expect(safeNextPath('javascript:alert(1)')).toBe('/');
    expect(safeNextPath('')).toBe('/');
    expect(safeNextPath(null)).toBe('/');
    expect(safeNextPath(undefined)).toBe('/');
    expect(safeNextPath('/custom', '/login')).toBe('/custom');
  });

  it('maps the insufficient_aal rejection by code and by 401/403 message', async () => {
    const { isInsufficientAal } = await import('../src/components/auth/aal-gate');
    expect(isInsufficientAal(Object.assign(new Error('AAL2 session is required'), { status: 401, code: 'insufficient_aal' }) as never)).toBe(true);
    expect(isInsufficientAal(Object.assign(new Error('AAL2 session is required to update email or password'), { status: 401 }) as never)).toBe(true);
    expect(isInsufficientAal(Object.assign(new Error('Invalid login credentials'), { status: 400 }) as never)).toBe(false);
    expect(isInsufficientAal(Object.assign(new Error('weak password'), { status: 422 }) as never)).toBe(false);
    expect(isInsufficientAal(null)).toBe(false);
  });
});

describe('forbidden-state presentation', () => {
  it('keeps "No admin access" only for real non-members and routes MFA states calmly', async () => {
    const { forbiddenPresentation } = await import('../src/components/forbidden-state');
    // Enabled admin, no verified factor: the gate's dedicated code.
    expect(forbiddenPresentation('MFA_SETUP_REQUIRED', 'Enroll an authenticator factor before using admin operations.', null)).toBe('mfa-setup');
    // Enabled admin, verified factor, AAL1 session: the gate's own message.
    expect(forbiddenPresentation('FORBIDDEN', 'Multi-factor authentication is required for admin operations.', null)).toBe('mfa-challenge');
    // Same situation, message reworded beyond recognition: client AAL read still catches it.
    expect(forbiddenPresentation('FORBIDDEN', 'Forbidden.', { currentLevel: 'aal1', nextLevel: 'aal2' })).toBe('mfa-challenge');
    // Regression (QA): a denied account with a personal verified factor must NOT
    // be told 'your account is fine' - explicit membership denial beats the AAL read.
    expect(forbiddenPresentation('FORBIDDEN', 'This account is not an enabled internal admin.', { currentLevel: 'aal1', nextLevel: 'aal2' })).toBe('no-access');
    // Real non-member: neither signal.
    expect(forbiddenPresentation('FORBIDDEN', 'This account is not an enabled internal admin.', { currentLevel: 'aal1', nextLevel: 'aal1' })).toBe('no-access');
    expect(forbiddenPresentation('FORBIDDEN', 'This account is not an enabled internal admin.', null)).toBe('no-access');
    // AAL2 already: membership really is the problem.
    expect(forbiddenPresentation('FORBIDDEN', 'This account is not an enabled internal admin.', { currentLevel: 'aal2', nextLevel: 'aal2' })).toBe('no-access');
    expect(forbiddenPresentation(undefined, undefined, null)).toBe('no-access');
  });
});

describe('post-login routing', () => {
  it('mirrors the backend AAL gate', async () => {
    const { decidePostLogin } = await import('../src/components/auth/post-login');
    expect(decidePostLogin({ currentLevel: 'aal2', nextLevel: 'aal2' }, [])).toBe('/');
    expect(decidePostLogin({ currentLevel: 'aal1', nextLevel: 'aal2' }, [{ status: 'verified' }])).toBe('/mfa/challenge');
    expect(decidePostLogin({ currentLevel: 'aal1', nextLevel: 'aal2' }, [{ status: 'unverified' }])).toBe('/mfa/enroll');
    expect(decidePostLogin({ currentLevel: 'aal1', nextLevel: 'aal1' }, [])).toBe('/');
    expect(decidePostLogin(null, [])).toBe('/');
  });
});

describe('MFA enrollment recovery (abandoned setup)', () => {
  const enrollOk = { data: { id: 'f-new', totp: { qr_code: 'data:image/svg+xml;utf-8,x', secret: 'JBSWY3DPEHPK3PXP' } }, error: null };
  const nameConflict = () => Object.assign(new Error('A factor with the same friendly name already exists'), { status: 422, code: 'mfa_factor_name_conflict' }) as unknown as import('@supabase/supabase-js').AuthError;
  const fakeMfa = (factors: { id: string; status: string }[], calls: string[]) => ({
    enroll: async () => {
      calls.push('enroll');
      return factors.some((f) => f.status === 'unverified' || f.status === 'verified') && factors.length > 0 && calls.filter((c) => c === 'enroll').length === 1
        ? { data: null, error: nameConflict() }
        : enrollOk;
    },
    // Mirror auth-js 2.x: typed buckets carry VERIFIED factors only; every
    // factor, including stale unverified ones, is in `all`.
    listFactors: async () => ({
      data: {
        totp: factors.filter((f) => f.status === 'verified').map((f) => ({ ...f })),
        all: factors.map((f) => ({ ...f, factor_type: 'totp' })),
      },
      error: null,
    }),
    unenroll: async ({ factorId }: { factorId: string }) => {
      calls.push(`unenroll:${factorId}`);
      const i = factors.findIndex((f) => f.id === factorId);
      if (i >= 0) factors.splice(i, 1);
      return { data: {}, error: null };
    },
  });

  it('detects the GoTrue name-conflict error by code and by 422 message', async () => {
    const { isFactorNameConflict } = await import('../src/components/auth/mfa-enrollment');
    expect(isFactorNameConflict(nameConflict() as never)).toBe(true);
    expect(isFactorNameConflict(Object.assign(new Error('friendly name already exists'), { status: 422 }) as never)).toBe(true);
    expect(isFactorNameConflict(Object.assign(new Error('Invalid login'), { status: 400 }) as never)).toBe(false);
    expect(isFactorNameConflict(null)).toBe(false);
  });

  it('sends a fixed friendly name and enrolls cleanly when no conflict exists', async () => {
    const { enrollTotpFactor, TOTP_FRIENDLY_NAME } = await import('../src/components/auth/mfa-enrollment');
    const seen: string[] = [];
    const mfa = {
      enroll: async (p: { factorType: 'totp'; friendlyName: string }) => { seen.push(p.friendlyName); return enrollOk; },
      listFactors: async () => ({ data: { totp: [] }, error: null }),
      unenroll: async () => ({ data: {}, error: null }),
    };
    const result = await enrollTotpFactor(mfa);
    expect(result.error).toBeNull();
    expect(result.data?.id).toBe('f-new');
    expect(seen).toEqual([TOTP_FRIENDLY_NAME]);
  });

  it('recovers from an abandoned setup: deletes only the stale UNVERIFIED factor and retries once', async () => {
    const { enrollTotpFactor } = await import('../src/components/auth/mfa-enrollment');
    const calls: string[] = [];
    // Verified factor must never be touched; stale unverified one holds the name.
    const factors = [{ id: 'f-verified', status: 'verified' }, { id: 'f-stale', status: 'unverified' }];
    const result = await enrollTotpFactor(fakeMfa(factors, calls));
    expect(result.error).toBeNull();
    expect(calls).toEqual(['enroll', 'unenroll:f-stale', 'enroll']);
    expect(factors).toEqual([{ id: 'f-verified', status: 'verified' }]);
  });

  it('keeps every unverified stale factor cleanup away from phone/webauthn factors in the mixed bucket', async () => {
    const { enrollTotpFactor } = await import('../src/components/auth/mfa-enrollment');
    const calls: string[] = [];
    const deleted: string[] = [];
    const mfa = {
      enroll: async () => calls.push('enroll') === 1
        ? { data: null, error: nameConflict() }
        : enrollOk,
      listFactors: async () => ({
        data: {
          totp: [],
          all: [
            { id: 'p1', factor_type: 'phone', status: 'unverified' },
            { id: 't-stale', factor_type: 'totp', status: 'unverified' },
            { id: 'w1', factor_type: 'webauthn', status: 'verified' },
          ],
        },
        error: null,
      }),
      unenroll: async ({ factorId }: { factorId: string }) => { deleted.push(factorId); return { data: {}, error: null }; },
    };
    const result = await enrollTotpFactor(mfa);
    expect(result.error).toBeNull();
    expect(deleted).toEqual(['t-stale']);
  });

  it('never deletes a VERIFIED factor even when it holds the name; the conflict surfaces honestly', async () => {
    const { enrollTotpFactor } = await import('../src/components/auth/mfa-enrollment');
    const calls: string[] = [];
    const factors = [{ id: 'f-verified', status: 'verified' }];
    const result = await enrollTotpFactor(fakeMfa(factors, calls));
    expect(result.error).not.toBeNull();
    expect((result.error as unknown as { code?: string }).code).toBe('mfa_factor_name_conflict');
    expect(calls).toEqual(['enroll']);
    expect(factors).toHaveLength(1);
  });
});
