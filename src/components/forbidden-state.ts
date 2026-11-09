import type { AssuranceLevel } from './auth/post-login';

/**
 * Presentation for a 403 from the admin gate (src/lib/auth/admin.ts, backend-
 * owned). The gate answers FORBIDDEN for two very different situations: an
 * account with no enabled admin membership, and an enabled admin whose
 * session has not completed the two-factor challenge yet (AAL1). Only the
 * first should see "No admin access"; the second gets a calm next step.
 *
 * Signal order matters. The backend checks membership BEFORE the AAL branch,
 * so its explicit messages are authoritative in both directions:
 * "Multi-factor authentication is required" means the account IS an enabled
 * admin, and "not an enabled internal admin" means it is NOT - the latter
 * wins even when the session happens to hold a personal verified factor
 * (client-side AAL says nothing about membership). The client AAL read is
 * only a rewording fallback for the MFA case, never an override of an
 * explicit membership denial.
 */
export type ForbiddenPresentation = 'mfa-setup' | 'mfa-challenge' | 'no-access';

export function forbiddenPresentation(
  serverCode: string | undefined,
  serverMessage: string | undefined,
  aal: AssuranceLevel | null,
): ForbiddenPresentation {
  if (serverCode === 'MFA_SETUP_REQUIRED') return 'mfa-setup';
  if (serverCode === 'FORBIDDEN') {
    if (serverMessage && /multi-?factor|\bMFA\b/i.test(serverMessage)) return 'mfa-challenge';
    if (serverMessage && /not an enabled/i.test(serverMessage)) return 'no-access';
    if (aal && aal.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') return 'mfa-challenge';
  }
  return 'no-access';
}
