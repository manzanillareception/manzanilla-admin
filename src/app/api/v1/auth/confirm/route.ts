import { getSupabaseEnv, createRequestClient } from '../../../../../lib/supabase/server';
import { safeNextPath } from '../../../../../lib/auth/safe-next';
import { readTextBody } from '../../../../../lib/api/read-body';

export const dynamic = 'force-dynamic';

const LOGIN_ERROR = '/login?error=auth';
const DEFAULT_NEXT = '/reset-password';
const SENSITIVE_HEADERS = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'strict-origin', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" } as const;
function authRedirect(origin: string, status: number): Response {
  return new Response(null, { status, headers: { Location: `${origin}${LOGIN_ERROR}`, ...SENSITIVE_HEADERS } });
}

/**
 * App-owned recovery confirm (contract section 10). The email lane builds these
 * links from a GoTrue generateLink hashed_token; nothing here depends on GoTrue's
 * redirect or the implicit fragment. The token is single-use and is consumed ONLY
 * by the POST below: GET renders a plain confirmation page so mail scanners and
 * browser prefetchers cannot burn it. The token reaches the POST in the form
 * body; with Referrer-Policy: strict-origin and no-store it does not propagate
 * into referrers or caches, and this route never logs it.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const tokenHash = url.searchParams.get('token_hash') ?? '';
  if (!tokenHash || tokenHash.length > 1024 || url.searchParams.get('type') !== 'recovery') {
    return authRedirect(url.origin, 302);
  }
  const next = safeNextPath(url.searchParams.get('next'), DEFAULT_NEXT);
  return new Response(confirmPage(tokenHash, next), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...SENSITIVE_HEADERS },
  });
}

export async function POST(request: Request): Promise<Response> {
  const origin = new URL(request.url).origin;
  const fail = (): Response => authRedirect(origin, 303);

  // Login CSRF: a cross-site form must not install an attacker's session.
  // Require Origin even if Referer is absent: browsers send it on normal POST
  // form submission; legacy/non-browser clients must supply it explicitly.
  // Neither Referer nor a missing Sec-Fetch-Site is a substitute for Origin.
  const postedOrigin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  const configuredOrigin = process.env.RECOVERY_LINK_ORIGIN;
  if (postedOrigin !== origin || site === 'cross-site' ||
      (configuredOrigin && postedOrigin !== configuredOrigin)) return fail();

  // This page submits only a small URL-encoded form. Never buffer an
  // arbitrary multipart upload or trust the caller's Content-Length.
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') return fail();
  const body = await readTextBody(request, 8192);
  if (!body.ok) return fail();
  const form = new URLSearchParams(body.text);
  const tokenField = form.get('token_hash');
  const nextField = form.get('next');
  const tokenHash = typeof tokenField === 'string' ? tokenField : '';
  if (!tokenHash || tokenHash.length > 1024 || form.get('type') !== 'recovery') {
    return fail();
  }
  const next = safeNextPath(typeof nextField === 'string' ? nextField : null, DEFAULT_NEXT);

  const env = getSupabaseEnv();
  if (!env) {
    return fail();
  }
  const requestAuth = createRequestClient(env, request);
  const { error } = await requestAuth.client.auth.verifyOtp({ token_hash: tokenHash, type: 'recovery' });
  if (error) {
    // Expired, already-used or unknown token: GoTrue enforces single use and
    // expiry; the location never carries the token back.
    return fail();
  }
  return requestAuth.applyCookies(
    new Response(null, { status: 303, headers: { Location: `${origin}${next}`, ...SENSITIVE_HEADERS } }),
  );
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function confirmPage(tokenHash: string, next: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="strict-origin" />
<title>Confirm your password reset - Manzanilla</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #faf7f2; color: #232323; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 26rem; margin: 1rem; padding: 2rem; background: #fff; border: 1px solid #e7e2d9; border-radius: 0.75rem; }
  h1 { margin: 0 0 0.75rem; font-size: 1.25rem; }
  p { margin: 0 0 1.5rem; line-height: 1.5; color: #4a4a4a; }
  button { width: 100%; padding: 0.75rem 1rem; font-size: 1rem; border: 0; border-radius: 0.5rem; background: #1d4ed8; color: #fff; cursor: pointer; }
  button:hover { background: #1e40af; }
</style>
</head>
<body>
<main>
<h1>Confirm your password reset</h1>
<p>You asked for a password reset link for a Manzanilla account. Continue only if you requested this; the link works once.</p>
<form method="post" action="/api/v1/auth/confirm">
<input type="hidden" name="token_hash" value="${escapeAttr(tokenHash)}" />
<input type="hidden" name="type" value="recovery" />
<input type="hidden" name="next" value="${escapeAttr(next)}" />
<button type="submit">Continue to password reset</button>
</form>
</main>
</body>
</html>`;
}
