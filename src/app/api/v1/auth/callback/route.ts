import { getSupabaseEnv, createRequestClient } from '../../../../../lib/supabase/server';
import { safeNextPath } from '../../../../../lib/auth/safe-next';

/**
 * Supabase SSR code-exchange callback (recovery / confirm links land here from the
 * project's Site URL). Backend-owned per contract section 10. `next` is same-origin
 * paths only (safeNextPath: single leading slash, no //, no backslash/control
 * chars): anything else falls back to the dashboard root (no open redirects).
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const next = safeNextPath(url.searchParams.get('next'), '/');
  const origin = url.origin;

  const env = getSupabaseEnv();
  if (!env || !code) {
    return Response.redirect(`${origin}/login?error=auth`, 302);
  }
  const requestAuth = createRequestClient(env, request);
  const { error } = await requestAuth.client.auth.exchangeCodeForSession(code);
  if (error) {
    return Response.redirect(`${origin}/login?error=auth`, 302);
  }
  return requestAuth.applyCookies(Response.redirect(`${origin}${next}`, 302));
}
