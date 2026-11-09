'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LoaderCircle, ShieldCheck } from 'lucide-react';
import { createClient } from '../../lib/supabase/browser';
import { AuthShell, AuthUnavailable } from './AuthShell';
import { safeNextPath } from './aal-gate';

/**
 * TOTP challenge for a session that has an enrolled factor but is not yet AAL2.
 * The backend gate (src/lib/auth/admin.ts) returns FORBIDDEN until this lifts
 * the session to AAL2. A `next` query param names where to go afterwards
 * (e.g. back to /reset-password during recovery); it is validated as a
 * same-origin path and defaults to the dashboard.
 */
export function MfaChallenge() {
  const router = useRouter();
  const [factorId, setFactorId] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [needsEnroll, setNeedsEnroll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(true);
  const [next, setNext] = useState('/');

  const client = createClient();

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    // Read `next` in the effect (not useSearchParams) so the page stays
    // statically prerenderable without a Suspense boundary.
    setNext(safeNextPath(new URLSearchParams(window.location.search).get('next')));
    (async () => {
      const { data: userData } = await client.auth.getUser();
      if (!userData.user) { if (!cancelled) { setNeedsSignIn(true); setStarting(false); } return; }
      const aal = await client.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aal.data?.currentLevel === 'aal2') { router.replace(safeNextPath(new URLSearchParams(window.location.search).get('next'))); return; }
      const { data: factors } = await client.auth.mfa.listFactors();
      const factor = factors?.totp.find((f) => f.status === 'verified');
      if (cancelled) return;
      if (!factor) { setNeedsEnroll(true); setStarting(false); return; }
      setFactorId(factor.id);
      setStarting(false);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!client) return <AuthUnavailable />;

  const verify = async () => {
    if (busy || !factorId) return;
    setBusy(true); setError('');
    const { data: challenge, error: challengeError } = await client.auth.mfa.challenge({ factorId });
    if (challengeError || !challenge) { setError(challengeError?.message ?? 'Could not start code verification.'); setBusy(false); return; }
    const { error: verifyError } = await client.auth.mfa.verify({ factorId, challengeId: challenge.id, code: code.trim() });
    if (verifyError) { setError(verifyError.message); setBusy(false); return; }
    router.push(next);
    router.refresh();
  };

  return (
    <AuthShell eyebrow="MANZANILLA · INTERNAL" title="Two-factor check">
      <div className="detail-icon"><ShieldCheck size={26} /></div>
      {needsSignIn ? <>
        <p>Sign in first, then complete the two-factor check.</p>
        <a className="button button-primary full-width" href="/login">Go to sign in</a>
      </> : needsEnroll ? <>
        <p>This account has no authenticator set up yet.</p>
        <a className="button button-primary full-width" href="/mfa/enroll">Set up two-factor authentication</a>
      </> : starting ? <>
        <p>Checking your authenticator…</p>
        <LoaderCircle className="spin" size={22} />
      </> : <>
        <p>Enter the 6-digit code from your authenticator app.</p>
        <div className="form-stack">
          <label className="field-label" htmlFor="mfa-challenge-code">6-digit code</label>
          <input id="mfa-challenge-code" className="text-field" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void verify(); }} />
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <button className="button button-primary full-width" disabled={code.trim().length !== 6 || busy} onClick={() => void verify()}>{busy ? 'Verifying…' : 'Verify'}</button>
      </>}
    </AuthShell>
  );
}
