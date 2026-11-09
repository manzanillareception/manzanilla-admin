import { errorResponse, jsonResponse } from '../auth/errors';
import { requireEnabledAdmin } from '../auth/admin';
import { checkRateLimit } from '../auth/rate-limit';
import { readJsonBody } from './read-body';
import { triageSchema } from './schemas';
import { StoreError, type ControlStore } from '../server/types';

export async function handleAdminTriage(store: ControlStore | null, request: Request, incidentId: string): Promise<Response> {
  if (!store) return errorResponse(503, 'SETUP_REQUIRED', 'Incident triage is not configured.');
  const auth = await requireEnabledAdmin(request);
  if (!auth.ok) return auth.response;

  const limit = checkRateLimit(`admin:${auth.admin.userId}:triage`, 60, 60_000);
  if (!limit.allowed) return auth.applyCookies(errorResponse(429, 'RATE_LIMITED', 'Triage rate exceeded.', { retryable: true, retryAfterMs: limit.retryAfterMs }));

  if (!/^[0-9a-fA-F-]{36}$/.test(incidentId)) {
    return auth.applyCookies(errorResponse(400, 'VALIDATION_FAILED', 'Invalid incident id.'));
  }
  // Optional body: empty means no note (contract rev9).
  let note: string | null = null;
  const body = await readJsonBody(request, 2 * 1024, { allowEmpty: true });
  if (!body.ok) return auth.applyCookies(body.response);
  if (body.raw !== undefined) {
    const parsed = triageSchema.safeParse(body.raw);
    if (!parsed.success) return auth.applyCookies(errorResponse(400, 'VALIDATION_FAILED', 'Invalid triage request.'));
    note = parsed.data.note ?? null;
  }

  try {
    const result = await store.triageIncident(auth.admin.userId, incidentId.toLowerCase(), note);
    return auth.applyCookies(jsonResponse(200, { incidentId: result.incidentId, status: result.status }));
  } catch (error) {
    if (error instanceof StoreError) {
      return auth.applyCookies(errorResponse(error.status, error.code, error.message, error.status === 503 ? { retryable: true, retryAfterMs: 5_000 } : {}));
    }
    throw error;
  }
}
