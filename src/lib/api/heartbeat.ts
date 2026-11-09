import { errorResponse, jsonResponse } from '../auth/errors';
import { checkRateLimit } from '../auth/rate-limit';
import { requireDeviceScope } from '../auth/device';
import { readJsonBody } from './read-body';
import { heartbeatSchema } from './schemas';
import { StoreError, type ControlStore } from '../server/types';

export async function handleHeartbeat(store: ControlStore | null, request: Request): Promise<Response> {
  if (!store) return errorResponse(503, 'SETUP_REQUIRED', 'Heartbeat is not configured.');
  const auth = await requireDeviceScope(request);
  if (!auth.ok) return auth.response;

  const limit = checkRateLimit(`device:${auth.scope.deviceId}:heartbeat`, 120, 60_000);
  if (!limit.allowed) return errorResponse(429, 'RATE_LIMITED', 'Heartbeat rate exceeded.', { retryable: true, retryAfterMs: limit.retryAfterMs });

  const body = await readJsonBody(request, 8 * 1024);
  if (!body.ok) return body.response;
  const parsed = heartbeatSchema.safeParse(body.raw);
  if (!parsed.success) return errorResponse(400, 'VALIDATION_FAILED', 'Invalid heartbeat request.');

  const receivedAt = new Date().toISOString();
  try {
    const result = await store.recordHeartbeat({
      deviceId: auth.scope.deviceId,
      bootId: parsed.data.bootId,
      sequence: parsed.data.sequence,
      build: parsed.data.build,
      mode: parsed.data.mode,
      microphone: parsed.data.microphone,
      receivedAt,
    });
    // Replays return 200 with current policy state; `applied` is internal only.
    return jsonResponse(200, {
      desiredAccess: result.device.desiredAccess,
      effectiveAccess: result.device.effectiveAccess,
      policyRevision: result.device.policyRevision,
      serverTime: result.serverTime,
    });
  } catch (error) {
    if (error instanceof StoreError) {
      return errorResponse(error.status, error.code, error.message, error.status === 503 ? { retryable: true, retryAfterMs: 5_000 } : {});
    }
    throw error;
  }
}
