import { createServerClient } from '@supabase/ssr';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseEnv, type SupabaseEnv } from './env';

export type ServiceClient = SupabaseClient;

/** Service-role client. Server-only: bypasses RLS, so every caller must authorize first. */
export function createServiceClient(env: SupabaseEnv): ServiceClient {
  return createClient(env.url, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export interface RequestAuth {
  client: SupabaseClient;
  /** Merge refreshed session cookies (if any) into an outgoing response. */
  applyCookies(response: Response): Response;
}

/**
 * SSR client bound to one incoming request's cookies. Refreshed session cookies
 * are buffered; handlers must return them via applyCookies or the session stalls.
 */
export function createRequestClient(env: SupabaseEnv, request: Request): RequestAuth {
  const pending: { name: string; value: string; options?: Record<string, unknown> }[] = [];
  const client = createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll() {
        const header = request.headers.get('cookie') ?? '';
        return header
          .split(';')
          .map((part) => part.trim())
          .filter(Boolean)
          .map((part) => {
            const eq = part.indexOf('=');
            return { name: eq === -1 ? part : part.slice(0, eq), value: eq === -1 ? '' : decodeURIComponent(part.slice(eq + 1)) };
          });
      },
      setAll(cookies) {
        pending.push(...cookies);
      },
    },
  });
  return {
    client,
    applyCookies(response: Response): Response {
      if (!pending.length) return response;
      const headers = new Headers(response.headers);
      for (const cookie of pending) {
        const opts = (cookie.options ?? {}) as { maxAge?: number; path?: string; sameSite?: string; secure?: boolean; httpOnly?: boolean };
        let line = `${cookie.name}=${encodeURIComponent(cookie.value)}; Path=${opts.path ?? '/'}`;
        if (opts.maxAge !== undefined) line += `; Max-Age=${opts.maxAge}`;
        if (opts.sameSite) line += `; SameSite=${opts.sameSite}`;
        if (opts.secure !== false) line += '; Secure';
        if (opts.httpOnly !== false) line += '; HttpOnly';
        headers.append('Set-Cookie', line);
      }
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    },
  };
}

export { getSupabaseEnv };
export type { SupabaseEnv };
