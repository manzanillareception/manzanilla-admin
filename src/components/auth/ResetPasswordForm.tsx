'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LoaderCircle, LockKeyhole } from 'lucide-react';
import { createClient } from '../../lib/supabase/browser';
import { AuthShell, AuthUnavailable } from './AuthShell';
import { isInsufficientAal, requiresAal2 } from './aal-gate';

/**
 * Landing page for the password reset link. The link exchanges through
 * /api/v1/auth/callback (backend-owned), so by the time this page renders the
 * browser holds a live recovery session and updateUser can set the password.
 * The recovery session is AAL1; when the account has a verified factor,
 * GoTrue rejects updateUser with 401 insufficient_aal, so we route through
 * the TOTP challenge first and return here once the session is AAL2.
 */
export function ResetPasswordForm() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [session, setSession] = useState<'checking' | 'ok' | 'missing' | 'challenge'>('checking');
  const [aalBlocked, setAalBlocked] = useState(false);
  const [busy, setBusy] = useState(false);

  const client = createClient();

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    (async () => {
      const { data } = await client.auth.getUser();
      if (cancelled) return;
      if (!data.user) { setSession('missing'); return; }
      const aal = await client.auth.mfa.getAuthenticatorAssuranceLevel();
      if (cancelled) return;
      if (requiresAal2(aal.data)) {
        // AAL1 recovery session + verified factor: updateUser would 401.
        setSession('challenge');
        router.replace(`/mfa/challenge?next=${encodeURIComponent('/reset-password')}`);
        return;
      }
      setSession('ok');
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!client) return <AuthUnavailable />;

  const valid = password.length >= 8 && password === confirm;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true); setError('');
    const { error: updateError } = await client.auth.updateUser({ password });
    if (updateError) {
      // Fallback if the preemptive gate was bypassed or the factor state
      // changed mid-flow: never render the raw insufficient_aal text.
      if (isInsufficientAal(updateError)) { setAalBlocked(true); setError(''); setBusy(false); return; }
      setError(updateError.message); setBusy(false); return;
    }
    setDone(true);
    setTimeout(() => { router.push('/'); router.refresh(); }, 1500);
  };

  return (
    <AuthShell eyebrow="MANZANILLA · INTERNAL" title="Choose a new password">
      <div className="detail-icon"><LockKeyhole size={26} /></div>
      {session === 'checking' ? <LoaderCircle className="spin" size={22} /> : session === 'missing' ? <>
        <p>This reset link is invalid or has expired.</p>
        <a className="button button-primary full-width" href="/login">Back to sign in</a>
      </> : session === 'challenge' ? <>
        <p>Your account has two-factor authentication, so we need a fresh code before changing the password. Taking you there…</p>
        <LoaderCircle className="spin" size={22} />
      </> : aalBlocked ? <>
        <p>For security, changing the password on an account with two-factor authentication needs a fresh authenticator code first.</p>
        <a className="button button-primary full-width" href={`/mfa/challenge?next=${encodeURIComponent('/reset-password')}`}>Verify two-factor to continue</a>
      </> : done ? <>
        <p>Your password is updated. Opening fleet control…</p>
      </> : <>
        <div className="form-stack">
          <label className="field-label" htmlFor="new-password">New password</label>
          <input id="new-password" className="text-field" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <label className="field-label" htmlFor="new-password-confirm">Confirm new password</label>
          <input id="new-password-confirm" className="text-field" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          {password.length > 0 && password.length < 8 && <p className="form-error" role="alert">Use at least 8 characters.</p>}
          {confirm && confirm !== password && <p className="form-error" role="alert">The passwords do not match.</p>}
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <button className="button button-primary full-width" disabled={!valid || busy} onClick={() => void submit()}>{busy ? 'Updating…' : 'Update password'}</button>
      </>}
    </AuthShell>
  );
}
