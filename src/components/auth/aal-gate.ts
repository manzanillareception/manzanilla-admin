import type { AuthError } from '@supabase/supabase-js';

/**
 * AAL gating for the recovery flow.
 *
 * GoTrue requires an AAL2 session for updateUser (password/email) when the
 * account has MFA enabled. The emailed reset link establishes only an AAL1
 * recovery session, so a reset for any MFA-enrolled admin used to dead-end
 * on a raw 401 insufficient_aal. The reset page preempts this by routing
 * through the TOTP challenge first; these helpers carry the decision, the
 * safe return path, and the fallback error mapping.
 */

/** True when the session is AAL1 but the account has a verified factor, so a password update would be rejected until the challenge lifts it. */
export function requiresAal2(aal: { currentLevel?: string | null; nextLevel?: string | null } | null | undefined): boolean {
  return !!aal && aal.currentLevel === 'aal1' && aal.nextLevel === 'aal2';
}

/**
 * Same-origin app path or the fallback. Mirrors the backend callback's rule
 * (leading single slash, no protocol-relative //) and additionally rejects
 * backslashes and control characters that browsers may reinterpret.
 */
export function safeNextPath(next: string | null | undefined, fallback = '/'): string {
  if (!next) return fallback;
  if (!next.startsWith('/') || next.startsWith('//')) return fallback;
  if (/[\r\n\\]/.test(next)) return fallback;
  return next;
}

/** True when GoTrue rejected a call because the session is not yet AAL2. */
export function isInsufficientAal(error: AuthError | null | undefined): boolean {
  if (!error) return false;
  const code = (error as { code?: unknown }).code;
  if (code === 'insufficient_aal') return true;
  return (error.status === 401 || error.status === 403) && /aal2/i.test(error.message ?? '');
}
