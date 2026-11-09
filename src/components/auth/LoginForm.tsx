'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { LoaderCircle, LockKeyhole } from 'lucide-react';
import { createClient } from '../../lib/supabase/browser';
import { AuthShell, AuthUnavailable } from './AuthShell';
import { decidePostLogin } from './post-login';

/**
 * Sign-in plus self-service password recovery request. Recovery request lives
 * here (not its own route) because the backend-owned middleware only exempts
 * /login for anonymous visitors; the reset link itself lands on
 * /api/v1/auth/callback and continues to /reset-password with a live session.
 */
export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [mode, setMode] = useState<'signin' | 'recover'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  const client = createClient();
  if (!client) return <AuthUnavailable />;

  const linkFailed = params.get('error') === 'auth';

  const signIn = async () => {
    if (busy) return;
    setBusy(true); setError(''); setInfo('');
    const { error: signInError } = await client.auth.signInWithPassword({ email: email.trim(), password });
    if (signInError) { setError(signInError.message); setBusy(false); return; }
    let route = '/';
    try {
      const [aal, factors] = await Promise.all([
        client.auth.mfa.getAuthenticatorAssuranceLevel(),
        client.auth.mfa.listFactors(),
      ]);
      route = decidePostLogin(aal.data ?? null, factors.data?.totp ?? []);
    } catch { /* The dashboard API re-checks AAL; fall through to the dashboard. */ }
    router.push(route as '/');
    router.refresh();
  };

  const requestRecovery = async () => {
    if (busy) return;
    setBusy(true); setError(''); setInfo('');
    const redirectTo = `${window.location.origin}/api/v1/auth/callback?next=/reset-password`;
    const { error: resetError } = await client.auth.resetPasswordForEmail(email.trim(), { redirectTo });
    // Never confirm whether an address is registered.
    setInfo(resetError ? 'The reset link could not be sent right now. Try again in a few minutes.' : 'If this address belongs to an enabled admin, a reset link is on its way.');
    setBusy(false);
  };

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  return (
    <AuthShell eyebrow="MANZANILLA · INTERNAL" title={mode === 'signin' ? 'Sign in to fleet control' : 'Reset your password'}>
      <div className="detail-icon"><LockKeyhole size={26} /></div>
      {linkFailed && <p className="form-error" role="alert">That sign-in link did not work. Sign in below or request a new link.</p>}
      <div className="form-stack">
        <label className="field-label" htmlFor="login-email">Email</label>
        <input id="login-email" className="text-field" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@manzanilla.example" />
        {mode === 'signin' && <>
          <label className="field-label" htmlFor="login-password">Password</label>
          <input id="login-password" className="text-field" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void signIn(); }} />
        </>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {info && <p className="microcopy" role="status">{info}</p>}
      </div>
      {mode === 'signin' ? <>
        <button className="button button-primary full-width" disabled={!emailValid || !password || busy} onClick={() => void signIn()}>{busy ? <LoaderCircle className="spin" size={16} /> : null}{busy ? 'Signing in…' : 'Sign in'}</button>
        <button className="text-button space-top" onClick={() => { setMode('recover'); setError(''); setInfo(''); }}>Forgot your password?</button>
      </> : <>
        <button className="button button-primary full-width" disabled={!emailValid || busy} onClick={() => void requestRecovery()}>{busy ? 'Sending…' : 'Email me a reset link'}</button>
        <button className="text-button space-top" onClick={() => { setMode('signin'); setError(''); setInfo(''); }}>Back to sign in</button>
      </>}
      <p className="microcopy">Enabled internal admins only. Two-factor authentication is enforced on every admin request.</p>
    </AuthShell>
  );
}
