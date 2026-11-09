import { createHash } from 'node:crypto';
import { errorResponse } from './errors';
import { createServiceClient, getSupabaseEnv } from '../supabase/server';
import type { DeviceRow } from '../server/types';
import { rowToDevice } from '../server/rows';

export interface DeviceScope {
  deviceId: string;
  hotelId: string;
  device: DeviceRow;
}

export type DeviceAuthResult =
  | { ok: true; scope: DeviceScope }
  | { ok: false; response: Response };

export function hashDeviceSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Contract section 1: 32-4096 chars, no whitespace/control characters. */
export function isValidDeviceCredentialFormat(credential: string): boolean {
  return credential.length >= 32 && credential.length <= 4096 && !/[\s\x00-\x1f\x7f]/.test(credential);
}

/**
 * Device-installation gate. Scope is always derived from the authenticated
 * credential hash; request JSON can never supply hotelId/deviceId.
 */
export async function requireDeviceScope(request: Request): Promise<DeviceAuthResult> {
  const env = getSupabaseEnv();
  if (!env) {
    return { ok: false, response: errorResponse(503, 'SETUP_REQUIRED', 'Authentication is not configured.') };
  }
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  if (!match || !isValidDeviceCredentialFormat(match[1])) {
    return { ok: false, response: errorResponse(401, 'UNAUTHORIZED', 'A valid device credential is required.') };
  }
  const tokenHash = hashDeviceSecret(match[1]);
  const service = createServiceClient(env);
  // public.credential_device_lookup is a security-definer RPC (service_role only):
  // private.device_credentials is not PostgREST-exposed.
  const { data, error } = await service.rpc('credential_device_lookup', { p_token_hash: tokenHash });
  if (error) {
    return { ok: false, response: errorResponse(503, 'UNAVAILABLE', 'Credential store is unavailable.', { retryable: true, retryAfterMs: 5_000 }) };
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    return { ok: false, response: errorResponse(401, 'UNAUTHORIZED', 'Unknown device credential.') };
  }
  const device = rowToDevice(row);
  if (device.credentialState === 'revoked') {
    return { ok: false, response: errorResponse(401, 'CREDENTIAL_REVOKED', 'This installation credential has been revoked.') };
  }
  return { ok: true, scope: { deviceId: device.id, hotelId: device.hotelId, device } };
}
