import { afterEach, describe, expect, it } from 'vitest';
import { getPublicSupabaseEnv, getSupabaseEnv } from '../src/lib/supabase/env';

function envOf(vars: Record<string, string>): (key: string) => string | undefined {
  return (key) => vars[key];
}
const KEYS = { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service' };

describe('getSupabaseEnv', () => {
  it('fails closed (null) when any variable is missing', () => {
    expect(getSupabaseEnv(envOf({}))).toBeNull();
    expect(getSupabaseEnv(envOf({ SUPABASE_URL: KEYS.SUPABASE_URL, SUPABASE_ANON_KEY: 'anon' }))).toBeNull();
  });
  it('accepts an https URL and trims a trailing slash', () => {
    const env = getSupabaseEnv(envOf({ ...KEYS, SUPABASE_URL: 'https://project.supabase.co/', NODE_ENV: 'production' }));
    expect(env).not.toBeNull();
    expect(env!.url).toBe('https://project.supabase.co');
  });
  it('rejects non-https URLs in production, including loopback', () => {
    expect(getSupabaseEnv(envOf({ ...KEYS, SUPABASE_URL: 'http://localhost:54321', NODE_ENV: 'production' }))).toBeNull();
    expect(getSupabaseEnv(envOf({ ...KEYS, SUPABASE_URL: 'http://127.0.0.1:54321', NODE_ENV: 'production' }))).toBeNull();
  });
  it('rejects non-loopback http URLs outside production', () => {
    expect(getSupabaseEnv(envOf({ ...KEYS, SUPABASE_URL: 'http://192.168.1.10:54321', NODE_ENV: 'development' }))).toBeNull();
    expect(getSupabaseEnv(envOf({ ...KEYS, SUPABASE_URL: 'http://evil.example.com', NODE_ENV: 'development' }))).toBeNull();
    expect(getSupabaseEnv(envOf({ ...KEYS, SUPABASE_URL: 'http://localhost.evil.com', NODE_ENV: 'development' }))).toBeNull();
  });
  it('accepts explicit loopback http URLs outside production (local disposable stack)', () => {
    for (const url of ['http://localhost:54321', 'http://127.0.0.1:8000', 'http://[::1]:9999', 'http://localhost']) {
      const env = getSupabaseEnv(envOf({ ...KEYS, SUPABASE_URL: url, NODE_ENV: 'development' }));
      expect(env, url).not.toBeNull();
      expect(env!.url).toBe(url.replace(/\/$/, ''));
    }
  });
  it('requires MFA in production even when ADMIN_MFA_REQUIRED=false; honors the dev opt-out', () => {
    const prod = getSupabaseEnv(envOf({ ...KEYS, NODE_ENV: 'production', ADMIN_MFA_REQUIRED: 'false' }));
    expect(prod!.mfaRequired).toBe(true);
    const dev = getSupabaseEnv(envOf({ ...KEYS, NODE_ENV: 'development', ADMIN_MFA_REQUIRED: 'false' }));
    expect(dev!.mfaRequired).toBe(false);
    const devDefault = getSupabaseEnv(envOf({ ...KEYS, NODE_ENV: 'development' }));
    expect(devDefault!.mfaRequired).toBe(true);
  });
});

describe('getPublicSupabaseEnv (browser client config; reads process.env directly)', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });
  it('returns url+anonKey from NEXT_PUBLIC_* WITHOUT any service-role key', () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
    expect(getPublicSupabaseEnv()).toEqual({ url: 'https://project.supabase.co', anonKey: 'anon' });
  });
  it('fails closed when a public variable is missing', () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
    expect(getPublicSupabaseEnv()).toBeNull();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
    expect(getPublicSupabaseEnv()).toBeNull();
  });
  it('applies the same URL policy as the server env (no non-loopback http outside https)', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://192.168.1.10:54321';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
    expect(getPublicSupabaseEnv()).toBeNull();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
    expect(getPublicSupabaseEnv()).not.toBeNull();
  });
});

describe('URL policy: https with port (self-hosted Supabase in production)', () => {
  it('accepts https URLs with a numeric port; keeps rejecting credentials, malformed ports and lookalikes', () => {
    const prod = { ...KEYS, NODE_ENV: 'production' };
    expect(getSupabaseEnv(envOf({ ...prod, SUPABASE_URL: 'https://selfhosted.example.com:8443' }))).not.toBeNull();
    expect(getSupabaseEnv(envOf({ ...prod, SUPABASE_URL: 'https://selfhosted.example.com:8443/' }))).not.toBeNull();
    expect(getSupabaseEnv(envOf({ ...prod, SUPABASE_URL: 'https://project.supabase.co' }))).not.toBeNull();
    expect(getSupabaseEnv(envOf({ ...prod, SUPABASE_URL: 'https://user:pass@evil.com' }))).toBeNull();
    expect(getSupabaseEnv(envOf({ ...prod, SUPABASE_URL: 'https://user:8443@evil.com' }))).toBeNull();
    expect(getSupabaseEnv(envOf({ ...prod, SUPABASE_URL: 'https://host:abc' }))).toBeNull();
    expect(getSupabaseEnv(envOf({ ...prod, SUPABASE_URL: 'https://host:' }))).toBeNull();
    expect(getSupabaseEnv(envOf({ ...prod, SUPABASE_URL: 'http://localhost:54321' }))).toBeNull();
    expect(getSupabaseEnv(envOf({ ...prod, SUPABASE_URL: 'http://localhost.evil.com:54321' }))).toBeNull();
  });
});
