'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';
import { createClient } from '../../lib/supabase/browser';

/** Signs out of the admin session and returns to /login. */
export function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="icon-button"
      aria-label="Sign out"
      title="Sign out"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void (async () => {
          const client = createClient();
          try { if (client) await client.auth.signOut(); } finally {
            router.push('/login');
            router.refresh();
          }
        })();
      }}
    ><LogOut size={18} /></button>
  );
}
