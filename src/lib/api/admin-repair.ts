import { errorResponse, jsonResponse } from '../auth/errors';
import { requireEnabledAdmin } from '../auth/admin';
import { checkRateLimit } from '../auth/rate-limit';
import { readJsonBody } from './read-body';
import { repairRequestSchema } from './schemas';
import { StoreError, type ControlStore } from '../server/types';

export async function handleAdminRepair(store: ControlStore | null, request: Request, incidentId: string): Promise<Response> {
  if (!store) return errorResponse(503, 'SETUP_REQUIRED', 'Repair requests are not configured.');
  const auth = await requireEnabledAdmin(request);
  if (!auth.ok) return auth.response;

  const limit = checkRateLimit(`admin:${auth.admin.userId}:repair`, 60, 60_000);
  if (!limit.allowed) return auth.applyCookies(errorResponse(429, 'RATE_LIMITED', 'Repair request rate exceeded.', { retryable: true, retryAfterMs: limit.retryAfterMs }));

  if (!/^[0-9a-fA-F-]{36}$/.test(incidentId)) {
    return auth.applyCookies(errorResponse(400, 'VALIDATION_FAILED', 'Invalid incident id.'));
  }
  const body = await readJsonBody(request, 2 * 1024);
  if (!body.ok) return auth.applyCookies(body.response);
  const parsed = repairRequestSchema.safeParse(body.raw);
  if (!parsed.success) return auth.applyCookies(errorResponse(400, 'VALIDATION_FAILED', 'Invalid repair request.'));

  try {
    // Server-owned sanitized brief only; device text is never executed or echoed (AGENTS.md).
    const result = await store.requestRepair(auth.admin.userId, incidentId.toLowerCase(), parsed.data.target);
    return auth.applyCookies(jsonResponse(200, { repairRequestId: result.repairRequestId, state: result.state }));
  } catch (error) {
    if (error instanceof StoreError) {
      return auth.applyCookies(errorResponse(error.status, error.code, error.message, error.status === 503 ? { retryable: true, retryAfterMs: 5_000 } : {}));
    }
    throw error;
  }
}
