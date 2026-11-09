import { randomBytes, randomInt } from 'node:crypto';
import { errorResponse, jsonResponse } from '../auth/errors';
import { checkRateLimit } from '../auth/rate-limit';
import { hashDeviceSecret } from '../auth/device';
import { requireHotelScope } from '../auth/hotel';
import { readJsonBody, clientIp } from './read-body';
import { enrollSchema } from './schemas';
import { StoreError, type ControlStore } from '../server/types';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function deviceCode(): string {
  let suffix = '';
  for (let i = 0; i < 8; i += 1) suffix += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `DEV-${suffix}`;
}

/** High-entropy installation credential, returned exactly once at enrollment. */
export function generateDeviceCredential(): string {
  return randomBytes(48).toString('base64url');
}

/**
 * Contract rev6: two credential paths, exactly one required.
 * 1. PRIMARY (original user spec): hotel email/password Supabase session in Bearer;
 *    hotel scope resolved server-side from public.hotel_users.
 * 2. Assisted: one-use setup token in the body (admin-assisted installs).
 * Enrollment only creates a PENDING device; approval stays an independent admin action.
 */
export async function handleEnroll(store: ControlStore | null, request: Request): Promise<Response> {
  if (!store) return errorResponse(503, 'SETUP_REQUIRED', 'Enrollment is not configured.');
  const limit = await checkRateLimit(`ip:${clientIp(request)}:enroll`, 10, 60_000);
  if (!limit.allowed) return errorResponse(limit.unavailable ? 503 : 429, limit.unavailable ? 'RATE_LIMIT_UNAVAILABLE' : 'RATE_LIMITED', limit.unavailable ? 'Rate limit service unavailable; retry shortly.' : 'Too many enrollment attempts.', { retryable: true, retryAfterMs: limit.retryAfterMs });

  const body = await readJsonBody(request, 8 * 1024);
  if (!body.ok) return body.response;
  const parsed = enrollSchema.safeParse(body.raw);
  if (!parsed.success) return errorResponse(400, 'VALIDATION_FAILED', 'Invalid enrollment request.');

  const hasBearer = /^Bearer .+$/.test(request.headers.get('authorization') ?? '');
  const hasToken = typeof parsed.data.setupToken === 'string' && parsed.data.setupToken.length > 0;
  if (!hasBearer && !hasToken) {
    return errorResponse(401, 'UNAUTHORIZED', 'A hotel session or one-use setup token is required.');
  }

  let hotelId: string | undefined;
  let setupTokenHash: string | undefined;
  if (hasBearer) {
    // Session path wins when both are supplied; the token is left untouched.
    const hotel = await requireHotelScope(request);
    if (!hotel.ok) return hotel.response;
    hotelId = hotel.scope.hotelId;
  } else {
    setupTokenHash = hashDeviceSecret(parsed.data.setupToken as string);
  }

  const credential = generateDeviceCredential();
  const input = {
    hotelId,
    setupTokenHash,
    credentialHash: hashDeviceSecret(credential),
    label: parsed.data.label,
    build: parsed.data.build,
  };
  // Code collisions are unique-violations; retry with a fresh code before failing closed.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await store.enrollDevice({ ...input, code: deviceCode() });
      return jsonResponse(200, {
        deviceId: result.deviceId,
        deviceCredential: credential,
        desiredAccess: result.desiredAccess,
        policyRevision: result.policyRevision,
      });
    } catch (error) {
      if (error instanceof StoreError) {
        if (error.code === 'CONFLICT' && attempt < 2) continue;
        return errorResponse(error.status, error.code, error.message, error.status === 503 ? { retryable: true, retryAfterMs: 5_000 } : {});
      }
      throw error;
    }
  }
  return errorResponse(503, 'UNAVAILABLE', 'Enrollment could not allocate a device code.', { retryable: true, retryAfterMs: 5_000 });
}
