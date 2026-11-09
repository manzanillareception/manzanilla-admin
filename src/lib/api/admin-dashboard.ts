import { errorResponse, jsonResponse } from '../auth/errors';
import { requireEnabledAdmin } from '../auth/admin';
import { checkRateLimit } from '../auth/rate-limit';
import { StoreError, type ControlStore } from '../server/types';

export async function handleAdminDashboard(store: ControlStore | null, request: Request): Promise<Response> {
  if (!store) return errorResponse(503, 'SETUP_REQUIRED', 'Dashboard read is not configured.');
  const auth = await requireEnabledAdmin(request);
  if (!auth.ok) return auth.response;

  const limit = checkRateLimit(`admin:${auth.admin.userId}:dashboard`, 120, 60_000);
  if (!limit.allowed) return auth.applyCookies(errorResponse(429, 'RATE_LIMITED', 'Dashboard read rate exceeded.', { retryable: true, retryAfterMs: limit.retryAfterMs }));

  const url = new URL(request.url);
  const rawDays = url.searchParams.get('periodDays');
  const periodDays = rawDays === null ? 30 : Number(rawDays);
  if (!Number.isFinite(periodDays)) {
    return auth.applyCookies(errorResponse(400, 'VALIDATION_FAILED', 'Invalid periodDays.'));
  }
  const cursor = url.searchParams.get('cursor');

  try {
    const page = await store.readDashboardSnapshot({ periodDays, cursor });
    return auth.applyCookies(jsonResponse(200, page));
  } catch (error) {
    if (error instanceof StoreError) {
      return auth.applyCookies(errorResponse(error.status, error.code, error.message, error.status === 503 ? { retryable: true, retryAfterMs: 5_000 } : {}));
    }
    throw error;
  }
}
