import { errorResponse } from './errors';
import { createRequestClient, createServiceClient, getSupabaseEnv } from '../supabase/server';

export interface AdminIdentity {
  userId: string;
  email: string | null;
  aal: string;
}

export type AdminAuthResult =
  | { ok: true; admin: AdminIdentity; applyCookies: (response: Response) => Response }
  | { ok: false; response: Response };

/**
 * Enabled internal-admin gate for every privileged /api/v1/admin route.
 * Fail closed at every step; membership is re-checked against the database on
 * every request via the service-role client; AAL comes from Supabase
 * server-side, never from cached JWT role claims or user-editable metadata.
 */
export async function requireEnabledAdmin(request: Request): Promise<AdminAuthResult> {
  const env = getSupabaseEnv();
  if (!env) {
    return { ok: false, response: errorResponse(503, 'SETUP_REQUIRED', 'Authentication is not configured.') };
  }
  const requestAuth = createRequestClient(env, request);
  const { data: userData, error: userError } = await requestAuth.client.auth.getUser();
  const user = userData?.user;
  if (userError || !user) {
    return { ok: false, response: requestAuth.applyCookies(errorResponse(401, 'UNAUTHORIZED', 'A valid admin session is required.')) };
  }

  const service = createServiceClient(env);
  const { data: membership, error: membershipError } = await service
    .from('admin_members')
    .select('user_id, enabled')
    .eq('user_id', user.id)
    .maybeSingle();
  if (membershipError) {
    return { ok: false, response: requestAuth.applyCookies(errorResponse(503, 'UNAVAILABLE', 'Authorization store is unavailable.', { retryable: true, retryAfterMs: 5_000 })) };
  }
  if (!membership || membership.enabled !== true) {
    return { ok: false, response: requestAuth.applyCookies(errorResponse(403, 'FORBIDDEN', 'This account is not an enabled internal admin.')) };
  }

  if (env.mfaRequired) {
    const { data: assurance, error: aalError } = await requestAuth.client.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aalError || !assurance) {
      return { ok: false, response: requestAuth.applyCookies(errorResponse(503, 'UNAVAILABLE', 'Authenticator assurance could not be verified.', { retryable: true, retryAfterMs: 5_000 })) };
    }
    if (assurance.nextLevel === 'aal2' && assurance.currentLevel !== 'aal2') {
      return { ok: false, response: requestAuth.applyCookies(errorResponse(403, 'FORBIDDEN', 'Multi-factor authentication is required for admin operations.')) };
    }
    if (assurance.nextLevel !== 'aal2') {
      // Enabled admin with no enrolled factor: only the MFA enrollment flow (Supabase
      // Auth APIs from the browser) is allowed. Every privileged route stops here.
      return { ok: false, response: requestAuth.applyCookies(errorResponse(403, 'MFA_SETUP_REQUIRED', 'Enroll an authenticator factor before using admin operations.')) };
    }
  }

  return {
    ok: true,
    admin: { userId: user.id, email: user.email ?? null, aal: env.mfaRequired ? 'aal2' : 'aal1' },
    applyCookies: requestAuth.applyCookies,
  };
}
