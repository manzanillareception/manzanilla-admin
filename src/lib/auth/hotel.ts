import { createClient } from '@supabase/supabase-js';
import { errorResponse } from './errors';
import { createServiceClient, getSupabaseEnv } from '../supabase/server';

export interface HotelScope {
  hotelId: string;
  userId: string;
}

export type HotelAuthResult =
  | { ok: true; scope: HotelScope }
  | { ok: false; response: Response };

/**
 * Hotel-session gate for POST /devices/enroll (contract rev6, primary path from the
 * original user spec: one-time hotel email/password on the tablet). Verifies the
 * Supabase JWT, then resolves hotel_id from public.hotel_users server-side. The
 * request body can never supply hotel identity. A hotel session enrolls installations
 * for its own hotel only and gains no fleet read access.
 */
export async function requireHotelScope(request: Request): Promise<HotelAuthResult> {
  const env = getSupabaseEnv();
  if (!env) {
    return { ok: false, response: errorResponse(503, 'SETUP_REQUIRED', 'Authentication is not configured.') };
  }
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) {
    return { ok: false, response: errorResponse(401, 'UNAUTHORIZED', 'A hotel session or one-use setup token is required.') };
  }
  const jwt = match[1];
  const anon = createClient(env.url, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await anon.auth.getUser(jwt);
  if (error || !data.user) {
    return { ok: false, response: errorResponse(401, 'UNAUTHORIZED', 'Invalid hotel session.') };
  }
  const service = createServiceClient(env);
  const { data: membership, error: membershipError } = await service
    .from('hotel_users')
    .select('hotel_id')
    .eq('auth_user_id', data.user.id)
    .maybeSingle();
  if (membershipError) {
    return { ok: false, response: errorResponse(503, 'UNAVAILABLE', 'Hotel directory is unavailable.', { retryable: true, retryAfterMs: 5_000 }) };
  }
  if (!membership) {
    return { ok: false, response: errorResponse(403, 'FORBIDDEN', 'This account is not a hotel account.') };
  }
  return { ok: true, scope: { hotelId: String(membership.hotel_id), userId: data.user.id } };
}
