import { telemetryEnvelopeSchema } from '../../domain/telemetry';
import { errorResponse, jsonResponse } from '../auth/errors';
import { checkRateLimit } from '../auth/rate-limit';
import { requireDeviceScope } from '../auth/device';
import { readJsonBody } from './read-body';
import { StoreError, type ControlStore } from '../server/types';

const MAX_BATCH_BYTES = 64 * 1024;
const FUTURE_SKEW_MS = 120_000;
const HISTORY_MS = 30 * 86_400_000;
const BLOCKED_ALLOWED_KINDS = new Set(['policy.ack', 'diagnostic.snapshot']);

export async function handleEventBatch(store: ControlStore | null, request: Request): Promise<Response> {
  if (!store) return errorResponse(503, 'SETUP_REQUIRED', 'Event ingestion is not configured.');
  const auth = await requireDeviceScope(request);
  if (!auth.ok) return auth.response;

  const limit = await checkRateLimit(`device:${auth.scope.deviceId}:events`, 60, 60_000);
  if (!limit.allowed) return errorResponse(limit.unavailable ? 503 : 429, limit.unavailable ? 'RATE_LIMIT_UNAVAILABLE' : 'RATE_LIMITED', limit.unavailable ? 'Rate limit service unavailable; retry shortly.' : 'Event batch rate exceeded.', { retryable: true, retryAfterMs: limit.retryAfterMs });

  const body = await readJsonBody(request, MAX_BATCH_BYTES);
  if (!body.ok) return body.response;

  const parsed = telemetryEnvelopeSchema.safeParse(body.raw);
  if (!parsed.success) return errorResponse(400, 'VALIDATION_FAILED', 'Telemetry envelope failed schema validation.');
  const envelope = parsed.data;

  // A service-blocked device keeps diagnostics and ACKs; voice/session data stops here.
  if (auth.scope.device.desiredAccess === 'blocked') {
    const disallowed = envelope.events.some((event) => !BLOCKED_ALLOWED_KINDS.has(event.kind));
    if (disallowed) {
      return errorResponse(403, 'DEVICE_BLOCKED', 'This installation is blocked; only policy.ack and diagnostic.snapshot are accepted.');
    }
  }

  // Clock window: an out-of-window event rejects the whole batch (matches the frozen
  // domain reference ingestTelemetry, which throws on the same condition).
  const receivedMs = Date.now();
  for (const event of envelope.events) {
    const occurred = Date.parse(event.occurredAt);
    if (occurred > receivedMs + FUTURE_SKEW_MS || occurred < receivedMs - HISTORY_MS) {
      return errorResponse(400, 'VALIDATION_FAILED', 'Event timestamp is outside the ingestion window.');
    }
  }

  try {
    const result = await store.ingestEvents(auth.scope.device, envelope.events, new Date(receivedMs).toISOString());
    return jsonResponse(200, { accepted: result.accepted, duplicates: result.duplicates });
  } catch (error) {
    if (error instanceof StoreError) {
      return errorResponse(error.status, error.code, error.message, error.status === 503 ? { retryable: true, retryAfterMs: 5_000 } : {});
    }
    throw error;
  }
}
