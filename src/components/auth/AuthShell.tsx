'use client';

import type { ReactNode } from 'react';
import { LockKeyhole } from 'lucide-react';

/**
 * Shared chrome for the auth pages (login, MFA, recovery). Renders the same
 * honest unavailable card when the deployment has no Supabase config - the
 * backend-owned browser factory returns null in that case.
 */
export function AuthShell({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  return (
    <main className="status-shell">
      <div className="status-card auth-card">
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}

export function AuthUnavailable() {
  return (
    <AuthShell eyebrow="MANZANILLA · INTERNAL" title="Sign-in is not configured">
      <div className="detail-icon"><LockKeyhole size={26} /></div>
      <p>This deployment has no authentication configuration yet. Contact the administrator who provisions this workspace.</p>
    </AuthShell>
  );
}
