/** Environment resolution. Missing config must fail closed (SETUP_REQUIRED), never fall back to demo. */
export interface SupabaseEnv {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
  mfaRequired: boolean;
}

// Production requires https. Outside production an explicit loopback URL
// (http://localhost / 127.0.0.1 / [::1], optional port) is allowed so a local
// disposable stack can be configured; every other non-https URL stays rejected.
function isAcceptableUrl(url: string, isProduction: boolean): boolean {
  if (/^https:\/\/[a-z0-9.-]+(:\d+)?(\/|$)/.test(url)) return true;
  return !isProduction && /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(url);
}

export function getSupabaseEnv(read: (key: string) => string | undefined = (k) => process.env[k]): SupabaseEnv | null {
  const url = read('SUPABASE_URL') ?? read('NEXT_PUBLIC_SUPABASE_URL');
  const anonKey = read('SUPABASE_ANON_KEY') ?? read('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  const serviceRoleKey = read('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !anonKey || !serviceRoleKey) return null;
  const isProduction = read('NODE_ENV') === 'production';
  if (!isAcceptableUrl(url, isProduction)) return null;
  // MFA is mandatory in production (contract rev7): ADMIN_MFA_REQUIRED=false is honored
  // ONLY when NODE_ENV !== 'production'; a production build requires MFA regardless.
  const mfaRequired = !(read('ADMIN_MFA_REQUIRED') === 'false' && read('NODE_ENV') !== 'production');
  return { url: url.replace(/\/$/, ''), anonKey, serviceRoleKey, mfaRequired };
}

/** Public browser-client config (safe to expose; anon key only). */
export function getPublicSupabaseEnv(): { url: string; anonKey: string } | null {
  // STATIC property accesses only. Next.js inlines NEXT_PUBLIC_* values into the browser
  // bundle at build time; a dynamic process.env[key] read is never inlined and evaluates
  // to undefined in the client, leaving every auth page "not configured" (dashboard-lane
  // production blocker). The service-role key is deliberately NOT consulted here: it must
  // never reach a browser bundle. The non-public fallbacks compile to undefined in the
  // client and keep the previous server-side behavior intact.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  const isProduction = process.env.NODE_ENV === 'production';
  if (!isAcceptableUrl(url, isProduction)) return null;
  return { url: url.replace(/\/$/, ''), anonKey };
}
