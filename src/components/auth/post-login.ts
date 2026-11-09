/**
 * Pure post-sign-in routing decision, mirroring the backend gate in
 * src/lib/auth/admin.ts (backend-owned): AAL2 is required when MFA is enforced;
 * with no enrolled factor every privileged route returns MFA_SETUP_REQUIRED.
 * Kept pure so the decision is unit-tested without a Supabase client.
 */
export type PostLoginRoute = '/' | '/mfa/enroll' | '/mfa/challenge';

export interface AssuranceLevel {
  currentLevel: string | null;
  nextLevel: string | null;
}

export function decidePostLogin(
  aal: AssuranceLevel | null,
  totpFactors: readonly { status: string }[],
): PostLoginRoute {
  if (!aal) return '/';
  if (aal.currentLevel === 'aal2') return '/';
  if (aal.nextLevel === 'aal2') {
    // A verified factor exists and the session must complete the challenge.
    return totpFactors.some((f) => f.status === 'verified') ? '/mfa/challenge' : '/mfa/enroll';
  }
  // nextLevel !== 'aal2': no enrolled factor. When the deployment enforces MFA
  // the dashboard API answers MFA_SETUP_REQUIRED and links to enrollment;
  // without enforcement the dashboard is usable directly.
  return '/';
}
