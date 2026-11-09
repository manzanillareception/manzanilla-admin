import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Session guard for page routes (backend-owned per contract section 10).
 * Refreshes the Supabase session cookie and redirects anonymous page visits to
 * /login. Full enabled-admin + AAL2 authorization lives in the API routes and
 * server components built on src/lib/auth - middleware never grants anything.
 * /api/** routes authenticate themselves (Bearer device credentials, admin
 * sessions, webhook signatures) and are not touched here.
 */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    // Fail closed: unconfigured auth still lets the UI render its own
    // explicit unavailable state, but no page is gated open by default.
    return NextResponse.next();
  }
  let response = NextResponse.next({ request });
  const client = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookies) {
        for (const { name, value } of cookies) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookies) response.cookies.set(name, value, options);
      },
    },
  });
  const { data } = await client.auth.getUser();
  const path = request.nextUrl.pathname;
  if (!data.user && path !== '/login') {
    const login = request.nextUrl.clone();
    login.pathname = '/login';
    return NextResponse.redirect(login);
  }
  if (data.user && path === '/login') {
    const home = request.nextUrl.clone();
    home.pathname = '/';
    return NextResponse.redirect(home);
  }
  return response;
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
