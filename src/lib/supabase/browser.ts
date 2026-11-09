import { createBrowserClient } from '@supabase/ssr';
import { getPublicSupabaseEnv } from './env';

/**
 * Browser client for the dashboard lane's login / MFA-enrollment UI.
 * Anon key only; no privileged data access is possible through it
 * (RLS: enabled-admin reads with AAL2 only). Returns null when unconfigured
 * so the UI can show an explicit unavailable state instead of demo data.
 */
export function createClient() {
  const env = getPublicSupabaseEnv();
  if (!env) return null;
  return createBrowserClient(env.url, env.anonKey);
}
