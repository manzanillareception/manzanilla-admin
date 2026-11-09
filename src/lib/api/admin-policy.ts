import { errorResponse, jsonResponse } from '../auth/errors';
import { requireEnabledAdmin } from '../auth/admin';
import { checkRateLimit } from '../auth/rate-limit';
import { readJsonBody } from './read-body';
import { adminPolicySchema } from './schemas';
import { StoreError, type ControlStore } from '../server/types';

export async function handleAdminPolicy(store: ControlStore | null, request: Request, deviceId: string): Promise<Response> {
  if (!store) return errorResponse(503, 'SETUP_REQUIRED', 'Policy control is not configured.');
  const auth = await requireEnabledAdmin(request);
  if (!auth.ok) return auth.response;

  const limit = checkRateLimit(`admin:${auth.admin.userId}:policy`, 120, 60_000);
  if (!limit.allowed) return auth.applyCookies(errorResponse(429, 'RATE_LIMITED', 'Policy mutation rate exceeded.', { retryable: true, retryAfterMs: limit.retryAfterMs }));

  if (!/^[0-9a-fA-F-]{36}$/.test(deviceId)) {
    return auth.applyCookies(errorResponse(400, 'VALIDATION_FAILED', 'Invalid device id.'));
  }
  const body = await readJsonBody(request, 4 * 1024);
  if (!body.ok) return auth.applyCookies(body.response);
  const parsed = adminPolicySchema.safeParse(body.raw);
  if (!parsed.success) return auth.applyCookies(errorResponse(400, 'VALIDATION_FAILED', 'Invalid policy request.'));

  try {
    // Atomic in one RPC: revision check, revision advance, audit append.
    const result = await store.setDevicePolicy(auth.admin.userId, deviceId.toLowerCase(), parsed.data);
    return auth.applyCookies(jsonResponse(200, {
      deviceId: result.deviceId,
      revision: result.revision,
      desiredAccess: result.desiredAccess,
      effectiveAccess: result.effectiveAccess,
      // Contract rev11: true only for the historical recorded result of a true retry.
      recorded: result.recorded,
    }));
  } catch (error) {
    if (error instanceof StoreError) {
      return auth.applyCookies(errorResponse(error.status, error.code, error.message, error.status === 503 ? { retryable: true, retryAfterMs: 5_000 } : {}));
    }
    throw error;
  }
}
