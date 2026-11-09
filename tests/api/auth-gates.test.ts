import { beforeEach, describe, expect, it, vi } from 'vitest';

// Controllable Supabase boundary. Every gate must fail closed from these states.
const state = vi.hoisted(() => ({
  env: null as null | { url: string; anonKey: string; serviceKey: string; mfaRequired: boolean },
  user: null as null | { id: string; email?: string },
  userError: null as null | Error,
  membership: undefined as undefined | null | { user_id: string; enabled: boolean },
  membershipError: null as null | Error,
  assurance: null as null | { currentLevel: string; nextLevel: string },
  aalError: null as null | Error,
  rpcData: null as unknown,
  rpcError: null as null | Error,
  hotelUser: undefined as undefined | null | { hotel_id: string },
  hotelUserError: null as null | Error,
  jwtUser: null as null | { id: string; email?: string },
  jwtError: null as null | Error,
}));

vi.mock('../../src/lib/supabase/server', () => ({
  getSupabaseEnv: () => state.env,
  createRequestClient: () => ({
    client: {
      auth: {
        getUser: async () => ({ data: { user: state.user }, error: state.userError }),
        mfa: {
          getAuthenticatorAssuranceLevel: async () => ({ data: state.assurance, error: state.aalError }),
        },
      },
    },
    applyCookies: (response: Response) => response,
  }),
  createServiceClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            table === 'admin_members'
              ? { data: state.membership, error: state.membershipError }
              : { data: state.hotelUser, error: state.hotelUserError },
        }),
      }),
    }),
    rpc: async () => ({ data: state.rpcData, error: state.rpcError }),
  }),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: state.jwtUser }, error: state.jwtError }) },
  }),
}));

import { requireEnabledAdmin } from '../../src/lib/auth/admin';
import { requireDeviceScope, hashDeviceSecret } from '../../src/lib/auth/device';
import { requireHotelScope } from '../../src/lib/auth/hotel';

const ENV = { url: 'https://example.supabase.co', anonKey: 'anon', serviceKey: 'service', mfaRequired: true };

function requestWithBearer(token: string): Request {
  return new Request('https://admin.example/api/v1/x', { headers: { authorization: `Bearer ${token}` } });
}

beforeEach(() => {
  state.env = { ...ENV };
  state.user = null; state.userError = null;
  state.membership = undefined; state.membershipError = null;
  state.assurance = null; state.aalError = null;
  state.rpcData = null; state.rpcError = null;
  state.hotelUser = undefined; state.hotelUserError = null;
  state.jwtUser = null; state.jwtError = null;
});

describe('requireEnabledAdmin', () => {
  it('503 SETUP_REQUIRED when auth is not configured', async () => {
    state.env = null;
    const r = await requireEnabledAdmin(requestWithBearer('x'));
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.response.status).toBe(503); expect((await r.response.json()).error.code).toBe('SETUP_REQUIRED'); }
  });
  it('401 UNAUTHORIZED without a valid session', async () => {
    const r = await requireEnabledAdmin(requestWithBearer('x'));
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.response.status).toBe(401); expect((await r.response.json()).error.code).toBe('UNAUTHORIZED'); }
  });
  it('503 when the membership store is unavailable', async () => {
    state.user = { id: 'u1' }; state.membershipError = new Error('down');
    const r = await requireEnabledAdmin(requestWithBearer('x'));
    if (!r.ok) { expect(r.response.status).toBe(503); expect((await r.response.json()).error.code).toBe('UNAVAILABLE'); } else expect.unreachable();
  });
  it('403 FORBIDDEN for a non-member', async () => {
    state.user = { id: 'u1' }; state.membership = null;
    const r = await requireEnabledAdmin(requestWithBearer('x'));
    if (!r.ok) { expect(r.response.status).toBe(403); expect((await r.response.json()).error.code).toBe('FORBIDDEN'); } else expect.unreachable();
  });
  it('403 FORBIDDEN for a disabled admin', async () => {
    state.user = { id: 'u1' }; state.membership = { user_id: 'u1', enabled: false };
    const r = await requireEnabledAdmin(requestWithBearer('x'));
    if (!r.ok) { expect(r.response.status).toBe(403); expect((await r.response.json()).error.code).toBe('FORBIDDEN'); } else expect.unreachable();
  });
  it('503 when assurance cannot be verified', async () => {
    state.user = { id: 'u1' }; state.membership = { user_id: 'u1', enabled: true }; state.aalError = new Error('down');
    const r = await requireEnabledAdmin(requestWithBearer('x'));
    if (!r.ok) { expect(r.response.status).toBe(503); expect((await r.response.json()).error.code).toBe('UNAVAILABLE'); } else expect.unreachable();
  });
  it('403 MFA_SETUP_REQUIRED for an enabled admin with no enrolled factor', async () => {
    state.user = { id: 'u1' }; state.membership = { user_id: 'u1', enabled: true };
    state.assurance = { currentLevel: 'aal1', nextLevel: 'aal1' };
    const r = await requireEnabledAdmin(requestWithBearer('x'));
    if (!r.ok) { expect(r.response.status).toBe(403); expect((await r.response.json()).error.code).toBe('MFA_SETUP_REQUIRED'); } else expect.unreachable();
  });
  it('403 FORBIDDEN for aal1 with an enrolled but unverified factor', async () => {
    state.user = { id: 'u1' }; state.membership = { user_id: 'u1', enabled: true };
    state.assurance = { currentLevel: 'aal1', nextLevel: 'aal2' };
    const r = await requireEnabledAdmin(requestWithBearer('x'));
    if (!r.ok) { expect(r.response.status).toBe(403); expect((await r.response.json()).error.code).toBe('FORBIDDEN'); } else expect.unreachable();
  });
  it('passes at aal2', async () => {
    state.user = { id: 'u1', email: 'a@b.c' }; state.membership = { user_id: 'u1', enabled: true };
    state.assurance = { currentLevel: 'aal2', nextLevel: 'aal2' };
    const r = await requireEnabledAdmin(requestWithBearer('x'));
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.admin.userId).toBe('u1'); expect(r.admin.aal).toBe('aal2'); }
  });
  it('passes enabled admins at aal1 when MFA is not required', async () => {
    state.env = { ...ENV, mfaRequired: false };
    state.user = { id: 'u1' }; state.membership = { user_id: 'u1', enabled: true };
    const r = await requireEnabledAdmin(requestWithBearer('x'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.admin.aal).toBe('aal1');
  });
});

const CREDENTIAL = 'cd'.repeat(24); // 48 chars, no whitespace

describe('requireDeviceScope', () => {
  it('401 on a malformed credential', async () => {
    const r = await requireDeviceScope(requestWithBearer('short'));
    if (!r.ok) { expect(r.response.status).toBe(401); expect((await r.response.json()).error.code).toBe('UNAUTHORIZED'); } else expect.unreachable();
  });
  it('503 retryable when the credential store is down', async () => {
    state.rpcError = new Error('down');
    const r = await requireDeviceScope(requestWithBearer(CREDENTIAL));
    if (!r.ok) {
      expect(r.response.status).toBe(503);
      const body = await r.response.json();
      expect(body.error.code).toBe('UNAVAILABLE');
      expect(body.error.retryable).toBe(true);
    } else expect.unreachable();
  });
  it('401 on an unknown credential', async () => {
    state.rpcData = null;
    const r = await requireDeviceScope(requestWithBearer(CREDENTIAL));
    if (!r.ok) { expect(r.response.status).toBe(401); } else expect.unreachable();
  });
  it('401 CREDENTIAL_REVOKED on a revoked installation', async () => {
    state.rpcData = {
      id: 'd1', hotel_id: 'h1', code: 'DEV-X', label: 't', build: '17.0.44', managed: true,
      credential_state: 'revoked', desired_access: 'approved', effective_access: 'approved',
      policy_revision: 3, ack_revision: 3, last_seen_at: null, last_boot_id: null,
      last_heartbeat_sequence: null, mode: 'idle', microphone: 'unknown',
    };
    const r = await requireDeviceScope(requestWithBearer(CREDENTIAL));
    if (!r.ok) { expect(r.response.status).toBe(401); expect((await r.response.json()).error.code).toBe('CREDENTIAL_REVOKED'); } else expect.unreachable();
  });
  it('derives scope from the credential row only', async () => {
    state.rpcData = {
      id: 'd1', hotel_id: 'h1', code: 'DEV-X', label: 't', build: '17.0.44', managed: true,
      credential_state: 'valid', desired_access: 'approved', effective_access: 'approved',
      policy_revision: 3, ack_revision: 2, last_seen_at: null, last_boot_id: null,
      last_heartbeat_sequence: null, mode: 'idle', microphone: 'unknown',
    };
    const r = await requireDeviceScope(requestWithBearer(CREDENTIAL));
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.scope.deviceId).toBe('d1'); expect(r.scope.hotelId).toBe('h1'); expect(r.scope.device.policyRevision).toBe(3); }
  });
  it('hashDeviceSecret is sha256 hex', () => {
    expect(hashDeviceSecret('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('requireHotelScope', () => {
  it('401 without a bearer session', async () => {
    const r = await requireHotelScope(new Request('https://x'));
    if (!r.ok) { expect(r.response.status).toBe(401); } else expect.unreachable();
  });
  it('401 on an invalid hotel JWT', async () => {
    state.jwtError = new Error('bad jwt');
    const r = await requireHotelScope(requestWithBearer('jwt'));
    if (!r.ok) { expect(r.response.status).toBe(401); } else expect.unreachable();
  });
  it('503 when the hotel directory is unavailable', async () => {
    state.jwtUser = { id: 'u1' }; state.hotelUserError = new Error('down');
    const r = await requireHotelScope(requestWithBearer('jwt'));
    if (!r.ok) { expect(r.response.status).toBe(503); } else expect.unreachable();
  });
  it('403 for an account with no hotel membership (cross-hotel/not-a-hotel)', async () => {
    state.jwtUser = { id: 'u1' }; state.hotelUser = null;
    const r = await requireHotelScope(requestWithBearer('jwt'));
    if (!r.ok) { expect(r.response.status).toBe(403); expect((await r.response.json()).error.code).toBe('FORBIDDEN'); } else expect.unreachable();
  });
  it('resolves hotel identity server-side from hotel_users, never from the request', async () => {
    state.jwtUser = { id: 'u1' }; state.hotelUser = { hotel_id: 'hotel-9' };
    const r = await requireHotelScope(requestWithBearer('jwt'));
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.scope.hotelId).toBe('hotel-9'); expect(r.scope.userId).toBe('u1'); }
  });
});
