import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * App-owned recovery confirm route. The email lane builds links from a GoTrue
 * generateLink hashed_token: GET must render a confirmation page WITHOUT
 * consuming the single-use token (scanners/prefetchers), POST exchanges it via
 * verifyOtp and sets the session cookies. Failure paths never carry the token
 * and never set cookies.
 */
const state = vi.hoisted(() => ({
  env: null as null | { url: string; anonKey: string; serviceRoleKey: string },
  verifyCalls: [] as { token_hash: string; type: string }[],
  verifyError: null as null | { message: string },
  exchangeError: null as null | { message: string },
}));

vi.mock('../../src/lib/supabase/server', () => ({
  getSupabaseEnv: () => state.env,
  createRequestClient: (_env: unknown, _request: Request) => {
    const pending: { name: string; value: string }[] = [];
    return {
      client: {
        auth: {
          verifyOtp: async (params: { token_hash: string; type: string }) => {
            state.verifyCalls.push(params);
            if (state.verifyError) return { data: { user: null, session: null }, error: state.verifyError };
            pending.push({ name: 'sb-session', value: 'session-token' }); // what @supabase/ssr does on success
            return { data: { user: { id: 'u1' }, session: { access_token: 'x' } }, error: null };
          },
          exchangeCodeForSession: async (_code: string) => {
            if (state.exchangeError) return { data: { user: null, session: null }, error: state.exchangeError };
            pending.push({ name: 'sb-session', value: 'session-token' });
            return { data: { user: { id: 'u1' }, session: { access_token: 'x' } }, error: null };
          },
        },
      },
      applyCookies: (response: Response) => {
        if (!pending.length) return response;
        const headers = new Headers(response.headers);
        for (const c of pending) headers.append('Set-Cookie', `${c.name}=${c.value}; Path=/; HttpOnly`);
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      },
    };
  },
}));

import { GET, POST } from '../../src/app/api/v1/auth/confirm/route';
import { GET as callbackGET } from '../../src/app/api/v1/auth/callback/route';

const ORIGIN = 'https://admin.example.test';
const TOKEN = 'hashed_token_abc123';

function confirmUrl(query: string): string {
  return `${ORIGIN}/api/v1/auth/confirm?${query}`;
}
function formReq(body: Record<string, string> | string): Request {
  return new Request(`${ORIGIN}/api/v1/auth/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
    body: typeof body === 'string' ? body : new URLSearchParams(body).toString(),
  });
}

beforeEach(() => {
  state.env = { url: 'https://supabase.example.test', anonKey: 'anon', serviceRoleKey: 'service' };
  state.verifyCalls = [];
  state.verifyError = null;
  state.exchangeError = null;
});

describe('GET /api/v1/auth/confirm', () => {
  it('renders the confirmation page WITHOUT consuming the token (no verifyOtp)', async () => {
    const res = await GET(new Request(confirmUrl(`token_hash=${TOKEN}&type=recovery&next=%2Freset-password`)));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin');
    const html = await res.text();
    expect(html).toContain('<meta name="referrer" content="strict-origin" />');
    expect(html).toContain('method="post"');
    expect(html).toContain('action="/api/v1/auth/confirm"'); // body POST: token leaves the URL
    expect(html).toContain(`value="${TOKEN}"`);
    expect(html).toContain('value="/reset-password"');
    expect(state.verifyCalls).toEqual([]); // the whole point: prefetch/scanner-safe
  });

  it('is idempotent across repeated GETs (scanner hitting twice)', async () => {
    const url = confirmUrl(`token_hash=${TOKEN}&type=recovery`);
    expect((await GET(new Request(url))).status).toBe(200);
    expect((await GET(new Request(url))).status).toBe(200);
    expect(state.verifyCalls).toEqual([]);
  });

  it('defaults next to /reset-password when next is missing', async () => {
    const res = await GET(new Request(confirmUrl(`token_hash=${TOKEN}&type=recovery`)));
    expect(await res.text()).toContain('value="/reset-password"');
  });

  it('redirects to the login error when token_hash is missing or type is wrong', async () => {
    for (const q of ['type=recovery', `token_hash=${TOKEN}&type=signup`, `token_hash=&type=recovery`, '']) {
      const res = await GET(new Request(confirmUrl(q)));
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(`${ORIGIN}/login?error=auth`);
    }
    expect(state.verifyCalls).toEqual([]);
  });

  it.each([
    '//evil.example',
    '/\\evil.example',
    'https://evil.example',
    '/reset-password' + '\r\n' + 'Set-Cookie: x=1',
    '/reset-password\\@evil.example',
  ])('falls back to /reset-password for hostile next %s', async (hostile) => {
    const res = await GET(new Request(confirmUrl(`token_hash=${TOKEN}&type=recovery&next=${encodeURIComponent(hostile)}`)));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('value="/reset-password"');
    expect(html).not.toContain('evil.example');
  });

  it('HTML-escapes the token inside the page (no markup injection)', async () => {
    const evil = '"><script>alert(1)</script>';
    const res = await GET(new Request(confirmUrl(`token_hash=${encodeURIComponent(evil)}&type=recovery`)));
    const html = await res.text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });
});

describe('POST /api/v1/auth/confirm', () => {
  it('exchanges token_hash via verifyOtp, sets session cookies, redirects to next', async () => {
    const res = await POST(formReq({ token_hash: TOKEN, type: 'recovery', next: '/reset-password' }));
    expect(state.verifyCalls).toEqual([{ token_hash: TOKEN, type: 'recovery' }]);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/reset-password`);
    expect(res.headers.get('set-cookie')).toContain('sb-session=session-token');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('defaults next to /reset-password and preserves a safe custom next', async () => {
    const res = await POST(formReq({ token_hash: TOKEN, type: 'recovery' }));
    expect(res.headers.get('location')).toBe(`${ORIGIN}/reset-password`);
    const res2 = await POST(formReq({ token_hash: TOKEN, type: 'recovery', next: '/mfa/challenge?next=%2Freset-password' }));
    expect(res2.headers.get('location')).toBe(`${ORIGIN}/mfa/challenge?next=%2Freset-password`);
  });

  it('verifyOtp failure (expired/reused/unknown token): error redirect, no cookies, no token in location', async () => {
    state.verifyError = { message: 'Token has expired or is invalid' }; // GoTrue's replay/expiry answer
    const res = await POST(formReq({ token_hash: TOKEN, type: 'recovery', next: '/reset-password' }));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/login?error=auth`);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('location')).not.toContain(TOKEN);
  });

  it('rejects missing token or wrong type without calling verifyOtp', async () => {
    const bodies: Record<string, string>[] = [{ type: 'recovery' }, { token_hash: TOKEN, type: 'invite' }, { token_hash: '', type: 'recovery' }];
    for (const body of bodies) {
      const res = await POST(formReq(body));
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(`${ORIGIN}/login?error=auth`);
      expect(res.headers.get('set-cookie')).toBeNull();
    }
    expect(state.verifyCalls).toEqual([]);
  });

  it.each(['//evil.example', '/\\evil.example', 'https://evil.example'])(
    'never redirects off-origin for hostile next %s',
    async (hostile) => {
      const res = await POST(formReq({ token_hash: TOKEN, type: 'recovery', next: hostile }));
      expect(res.headers.get('location')).toBe(`${ORIGIN}/reset-password`);
    },
  );

  it('tolerates a malformed body', async () => {
    const res = await POST(new Request(`${ORIGIN}/api/v1/auth/confirm`, { method: 'POST', body: '%' }));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/login?error=auth`);
    expect(state.verifyCalls).toEqual([]);
  });

  it.each([
    { origin: 'https://attacker.example' },
    { origin: 'null' },
    {},
    { origin: ORIGIN, 'sec-fetch-site': 'cross-site' },
  ])('rejects login CSRF without exchanging a token or setting cookies: %j', async (headers) => {
    const req = new Request(`${ORIGIN}/api/v1/auth/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } as HeadersInit,
      body: new URLSearchParams({ token_hash: TOKEN, type: 'recovery' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/login?error=auth`);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(state.verifyCalls).toEqual([]);
    expect(req.bodyUsed).toBe(false);
  });

  it('accepts browser same-origin submission with no Referer', async () => {
    const req = formReq({ token_hash: TOKEN, type: 'recovery' });
    req.headers.set('sec-fetch-site', 'same-origin');
    const res = await POST(req);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/reset-password`);
    expect(res.headers.get('set-cookie')).toContain('sb-session=');
  });

  it('requires the configured recovery origin too when configured', async () => {
    vi.stubEnv('RECOVERY_LINK_ORIGIN', 'https://canonical.example');
    try {
      const res = await POST(formReq({ token_hash: TOKEN, type: 'recovery' }));
      expect(res.headers.get('location')).toBe(`${ORIGIN}/login?error=auth`);
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(state.verifyCalls).toEqual([]);
    } finally { vi.unstubAllEnvs(); }
  });

  it('accepts the exact form byte cap but refuses one byte over without exchanging a token', async () => {
    const prefix = new URLSearchParams({ token_hash: TOKEN, type: 'recovery' }).toString() + '&padding=';
    const exact = prefix + 'x'.repeat(8192 - prefix.length);
    expect((await POST(formReq(exact))).headers.get('location')).toBe(`${ORIGIN}/reset-password`);
    state.verifyCalls = [];
    const over = await POST(formReq(exact + 'x'));
    expect(over.headers.get('location')).toBe(`${ORIGIN}/login?error=auth`);
    expect(over.headers.get('cache-control')).toBe('no-store');
    expect(state.verifyCalls).toEqual([]);
  });

  it('cancels an overflowing chunked form before reading the rest', async () => {
    const cancel = vi.fn();
    let reads = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { reads++; controller.enqueue(new Uint8Array(8193)); }, cancel,
    }, { highWaterMark: 0 });
    const req = new Request(`${ORIGIN}/api/v1/auth/confirm`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN }, body: stream, duplex: 'half',
    } as RequestInit);
    expect((await POST(req)).headers.get('location')).toBe(`${ORIGIN}/login?error=auth`);
    expect(reads).toBe(1);
    expect(cancel).toHaveBeenCalledOnce();
    expect(state.verifyCalls).toEqual([]);
  });

  it('rejects multipart uploads without reading their body', async () => {
    const req = new Request(`${ORIGIN}/api/v1/auth/confirm`, { method: 'POST', body: new FormData() });
    expect((await POST(req)).headers.get('location')).toBe(`${ORIGIN}/login?error=auth`);
    expect(req.bodyUsed).toBe(false);
    expect(state.verifyCalls).toEqual([]);
  });

  it('fails closed when Supabase env is unconfigured', async () => {
    state.env = null;
    const res = await POST(formReq({ token_hash: TOKEN, type: 'recovery', next: '/reset-password' }));
    expect(res.headers.get('location')).toBe(`${ORIGIN}/login?error=auth`);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});

describe('GET /api/v1/auth/callback (safeNextPath hardening)', () => {
  it('falls back to / for backslash and protocol-relative next (the old check let /\\ through)', async () => {
    for (const hostile of ['//evil.example', '/\\evil.example', 'https://evil.example']) {
      const res = await callbackGET(new Request(`${ORIGIN}/api/v1/auth/callback?code=x&next=${encodeURIComponent(hostile)}`));
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(`${ORIGIN}/`);
    }
  });

  it('still honors a safe next and applies session cookies on a good exchange', async () => {
    const res = await callbackGET(new Request(`${ORIGIN}/api/v1/auth/callback?code=x&next=%2Freset-password`));
    expect(res.headers.get('location')).toBe(`${ORIGIN}/reset-password`);
    expect(res.headers.get('set-cookie')).toContain('sb-session=session-token');
  });

  it('redirects to the login error on a failed exchange', async () => {
    state.exchangeError = { message: 'bad code' };
    const res = await callbackGET(new Request(`${ORIGIN}/api/v1/auth/callback?code=x&next=%2Freset-password`));
    expect(res.headers.get('location')).toBe(`${ORIGIN}/login?error=auth`);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});
