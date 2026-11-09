import { errorResponse, jsonResponse } from '../auth/errors';
import { checkRateLimit } from '../auth/rate-limit';
import { requireDeviceScope } from '../auth/device';
import { readJsonBody } from './read-body';
import { sessionAdmissionSchema } from './schemas';
import { StoreError, type ControlStore } from '../server/types';

export async function handleSessionAdmission(store: ControlStore | null, request: Request): Promise<Response> {
  if (!store) return errorResponse(503, 'SETUP_REQUIRED', 'Session admission is not configured.');
  const auth = await requireDeviceScope(request);
  if (!auth.ok) return auth.response;

  const limit = checkRateLimit(`device:${auth.scope.deviceId}:sessions`, 60, 60_000);
  if (!limit.allowed) return errorResponse(429, 'RATE_LIMITED', 'Admission rate exceeded.', { retryable: true, retryAfterMs: limit.retryAfterMs });

  const body = await readJsonBody(request, 4 * 1024);
  if (!body.ok) return body.response;
  const parsed = sessionAdmissionSchema.safeParse(body.raw);
  if (!parsed.success) return errorResponse(400, 'VALIDATION_FAILED', 'Invalid session admission request.');

  try {
    const result = await store.admitSession(auth.scope.device, {
      sessionRef: parsed.data.sessionId,
      attemptRef: parsed.data.attemptId,
      feature: parsed.data.feature,
    });
    // Denials are 200 with admit:false - the app treats it as a hard stop for new voice starts.
    if (!result.admit) {
      return jsonResponse(200, { admit: false, reason: result.reason, policyRevision: result.policyRevision });
    }
    // provider is reserved in contract v1: policy gate only, no provider connection data.
    return jsonResponse(200, { admit: true, policyRevision: result.policyRevision, provider: null });
  } catch (error) {
    if (error instanceof StoreError) {
      return errorResponse(error.status, error.code, error.message, error.status === 503 ? { retryable: true, retryAfterMs: 5_000 } : {});
    }
    throw error;
  }
}
