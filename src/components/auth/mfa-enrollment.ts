import type { AuthError } from '@supabase/supabase-js';

/**
 * TOTP enrollment with recovery for abandoned setups.
 *
 * GoTrue enforces a unique friendly name per user. Enrolling without a
 * friendly name stores an empty one; leaving the page before verifying then
 * orphans that UNVERIFIED factor, and every later enroll 422s with
 * mfa_factor_name_conflict, permanently blocking setup (lead's real-GoTrue
 * repro). We always send a fixed friendly name and, on a name conflict,
 * delete only the user's own stale UNVERIFIED factors (never a verified one)
 * and retry once. A conflict held by a VERIFIED factor is surfaced honestly.
 */

export const TOTP_FRIENDLY_NAME = 'Authenticator app';

export interface TotpEnrollResult {
  data: { id: string; totp: { qr_code: string; secret: string } } | null;
  error: AuthError | null;
}

/** Minimal MFA surface used here, so tests can drive it without auth-js. */
export interface TotpEnrollDeps {
  enroll(params: { factorType: 'totp'; friendlyName: string }): Promise<TotpEnrollResult>;
  listFactors(): Promise<{
    // auth-js 2.x fills the typed buckets with VERIFIED factors only; every
    // factor (including unverified) lands in `all`. Read stale factors from
    // `all`, falling back to the typed bucket for older/custom shapes.
    data: { totp?: { id: string; status?: string }[]; all?: { id: string; factor_type?: string; status?: string }[] } | null;
    error: AuthError | null;
  }>;
  unenroll(params: { factorId: string }): Promise<{ data: unknown; error: AuthError | null }>;
}

/** True when GoTrue rejected the enroll because the friendly name is taken. */
export function isFactorNameConflict(error: AuthError | null | undefined): boolean {
  if (!error) return false;
  const code = (error as { code?: unknown }).code;
  if (code === 'mfa_factor_name_conflict') return true;
  return error.status === 422 && /friendly name/i.test(error.message ?? '');
}

/**
 * Enroll a TOTP factor, recovering from a name conflict held by stale
 * UNVERIFIED factors of this user. Returns the enroll result; a conflict
 * that survives cleanup (a verified factor owns the name) is returned as-is.
 */
export async function enrollTotpFactor(mfa: TotpEnrollDeps): Promise<TotpEnrollResult> {
  const first = await mfa.enroll({ factorType: 'totp', friendlyName: TOTP_FRIENDLY_NAME });
  if (!first.error || !isFactorNameConflict(first.error)) return first;

  const { data: factors, error: listError } = await mfa.listFactors();
  if (listError || !factors) return first;
  const listed = factors.all
    ? factors.all.filter((f) => f.factor_type === 'totp')
    : factors.totp ?? [];
  const stale = listed.filter((f) => f.status === 'unverified');
  if (stale.length === 0) return first;

  for (const factor of stale) {
    const { error } = await mfa.unenroll({ factorId: factor.id });
    if (error) return { data: null, error };
  }
  return mfa.enroll({ factorType: 'totp', friendlyName: TOTP_FRIENDLY_NAME });
}
