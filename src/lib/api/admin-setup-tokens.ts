import { randomBytes } from 'node:crypto';
import { errorResponse, jsonResponse } from '../auth/errors';
import { requireEnabledAdmin } from '../auth/admin';
import { checkRateLimit } from '../auth/rate-limit';
import { hashDeviceSecret } from '../auth/device';
import { readJsonBody } from './read-body';
import { setupTokenMintSchema } from './schemas';
import { StoreError, type ControlStore } from '../server/types';

/**
 * Mint a one-use device setup token (contract section 10 ruling). The plaintext is
 * returned exactly once here; only its SHA-256 hash is stored. It is shown once in
 * the admin dashboard and NEVER emailed.
 */
export async function handleMintSetupToken(store: ControlStore | null, request: Request): Promise<Response> {
  if (!store) return errorResponse(503, 'SETUP_REQUIRED', 'Setup tokens are not configured.');
  const auth = await requireEnabledAdmin(request);
  if (!auth.ok) return auth.response;

  const limit = await checkRateLimit(`admin:${auth.admin.userId}:setup-tokens`, 30, 60_000);
  if (!limit.allowed) return auth.applyCookies(errorResponse(limit.unavailable ? 503 : 429, limit.unavailable ? 'RATE_LIMIT_UNAVAILABLE' : 'RATE_LIMITED', limit.unavailable ? 'Rate limit service unavailable; retry shortly.' : 'Setup token mint rate exceeded.', { retryable: true, retryAfterMs: limit.retryAfterMs }));

  const body = await readJsonBody(request, 2 * 1024);
  if (!body.ok) return auth.applyCookies(body.response);
  const parsed = setupTokenMintSchema.safeParse(body.raw);
  if (!parsed.success) return auth.applyCookies(errorResponse(400, 'VALIDATION_FAILED', 'Invalid setup token request.'));

  const expiresAt = new Date(Date.now() + (parsed.data.expiresInHours ?? 48) * 3_600_000).toISOString();
  const setupToken = randomBytes(32).toString('base64url');
  try {
    await store.mintSetupToken(parsed.data.hotelId, hashDeviceSecret(setupToken), expiresAt, auth.admin.userId);
    return auth.applyCookies(jsonResponse(200, { setupToken, expiresAt }));
  } catch (error) {
    if (error instanceof StoreError) {
      return auth.applyCookies(errorResponse(error.status, error.code, error.message, error.status === 503 ? { retryable: true, retryAfterMs: 5_000 } : {}));
    }
    throw error;
  }
}
