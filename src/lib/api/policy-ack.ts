import { errorResponse, jsonResponse } from '../auth/errors';
import { checkRateLimit } from '../auth/rate-limit';
import { requireDeviceScope } from '../auth/device';
import { readJsonBody } from './read-body';
import { policyAckSchema } from './schemas';
import { StoreError, type ControlStore } from '../server/types';

export async function handlePolicyAck(store: ControlStore | null, request: Request): Promise<Response> {
  if (!store) return errorResponse(503, 'SETUP_REQUIRED', 'Policy acknowledgement is not configured.');
  const auth = await requireDeviceScope(request);
  if (!auth.ok) return auth.response;

  const limit = checkRateLimit(`device:${auth.scope.deviceId}:ack`, 60, 60_000);
  if (!limit.allowed) return errorResponse(429, 'RATE_LIMITED', 'ACK rate exceeded.', { retryable: true, retryAfterMs: limit.retryAfterMs });

  const body = await readJsonBody(request, 4 * 1024);
  if (!body.ok) return body.response;
  const parsed = policyAckSchema.safeParse(body.raw);
  if (!parsed.success) return errorResponse(400, 'VALIDATION_FAILED', 'Invalid policy acknowledgement.');

  // A device cannot acknowledge a revision the server never issued.
  if (parsed.data.revision > auth.scope.device.policyRevision) {
    return errorResponse(400, 'VALIDATION_FAILED', 'Revision is ahead of the current policy revision.');
  }

  try {
    // Stale ACKs are recorded but never change later state; ack_revision is monotonic.
    await store.ackPolicy(auth.scope.deviceId, parsed.data.revision);
    return jsonResponse(200, { acknowledged: true, revision: parsed.data.revision });
  } catch (error) {
    if (error instanceof StoreError) {
      return errorResponse(error.status, error.code, error.message, error.status === 503 ? { retryable: true, retryAfterMs: 5_000 } : {});
    }
    throw error;
  }
}
