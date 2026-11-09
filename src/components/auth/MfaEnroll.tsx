'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LoaderCircle, ShieldCheck } from 'lucide-react';
import { createClient } from '../../lib/supabase/browser';
import { AuthShell, AuthUnavailable } from './AuthShell';
import { enrollTotpFactor, isFactorNameConflict, type TotpEnrollResult } from './mfa-enrollment';

/**
 * TOTP enrollment. The backend returns MFA_SETUP_REQUIRED until an enabled
 * admin has a verified authenticator factor; this flow enrolls one with the
 * backend-owned browser client and verifies the first code, which lifts the
 * session to AAL2.
 */
export function MfaEnroll() {
  const router = useRouter();
  const [factorId, setFactorId] = useState('');
  const [qr, setQr] = useState('');
  const [secret, setSecret] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(true);

  const client = createClient();
  // Enroll is a server-side mutation (it creates a factor). React StrictMode
  // double-invokes effects in development, so keep a single in-flight enroll
  // per mounted component; a second enroll would 422 on the friendly name and
  // the cleanup pass would delete the factor whose QR is on screen.
  const enrollOnce = useRef<Promise<TotpEnrollResult> | null>(null);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    (async () => {
      const { data: userData } = await client.auth.getUser();
      if (!userData.user) { if (!cancelled) { setNeedsSignIn(true); setStarting(false); } return; }
      const aal = await client.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aal.data?.currentLevel === 'aal2') { router.replace('/'); return; }
      if (!enrollOnce.current) enrollOnce.current = enrollTotpFactor(client.auth.mfa);
      const { data, error: enrollError } = await enrollOnce.current;
      if (cancelled) return;
      if (enrollError || !data) {
        setError(enrollError && isFactorNameConflict(enrollError)
          ? 'An authenticator is already registered under this name on your account. Remove it from your account security settings, then retry.'
          : enrollError?.message ?? 'Could not start authenticator setup.');
        setStarting(false);
        return;
      }
      setFactorId(data.id);
      const raw = data.totp.qr_code;
      // auth-js returns a full data URI; older shapes were raw SVG markup or bare base64.
      setQr(raw.startsWith('data:') ? raw : raw.trimStart().startsWith('<svg') ? `data:image/svg+xml;utf8,${encodeURIComponent(raw)}` : `data:image/svg+xml;base64,${raw}`);
      setSecret(data.totp.secret);
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
    router.push('/');
    router.refresh();
  };

  return (
    <AuthShell eyebrow="MANZANILLA · INTERNAL" title="Set up two-factor authentication">
      <div className="detail-icon"><ShieldCheck size={26} /></div>
      {needsSignIn ? <>
        <p>Sign in first, then set up your authenticator.</p>
        <a className="button button-primary full-width" href="/login">Go to sign in</a>
      </> : starting ? <>
        <p>Preparing your authenticator setup…</p>
        <LoaderCircle className="spin" size={22} />
      </> : !factorId ? (
        // No factor to verify against: setup could not start. Show only the
        // reason, not a dead code entry.
        <p className="form-error" role="alert">{error || 'Could not start authenticator setup.'}</p>
      ) : <>
        <p>Scan this code with your authenticator app, then enter the 6-digit code it shows.</p>
        {qr && <img className="auth-qr" src={qr} alt="Authenticator QR code" width={180} height={180} />}
        {secret && <details className="chart-data"><summary>Enter the key manually instead</summary><code className="token-box">{secret}</code></details>}
        <div className="form-stack">
          <label className="field-label" htmlFor="mfa-enroll-code">6-digit code</label>
          <input id="mfa-enroll-code" className="text-field" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void verify(); }} />
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <button className="button button-primary full-width" disabled={code.trim().length !== 6 || busy} onClick={() => void verify()}>{busy ? 'Verifying…' : 'Verify & finish setup'}</button>
      </>}
    </AuthShell>
  );
}
