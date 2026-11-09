import { z } from 'zod';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/);
const build = z.string().regex(/^[0-9]{1,4}(\.[0-9]{1,4}){0,3}$/);
const timestamp = z.iso.datetime({ offset: true });
const feature = z.enum(['translation', 'reception']);
export const errorCodeSchema = z.enum(['CONNECTION_TIMEOUT', 'MIC_PERMISSION_DENIED', 'PROVIDER_UNAVAILABLE', 'AUDIO_STARTUP_TIMEOUT', 'POLICY_SYNC_FAILED']);
const base = {
  eventId: z.uuid(), bootId: z.uuid(), sequence: z.number().int().min(0).max(2_147_483_647),
  occurredAt: timestamp, build,
};
const session = { ...base, sessionId: identifier, attemptId: identifier, feature };
export const telemetryEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...session, kind: z.literal('session.started') }),
  z.strictObject({ ...session, kind: z.literal('session.connected'), firstAudioMs: z.number().int().min(0).max(120_000).nullable() }),
  z.strictObject({ ...session, kind: z.literal('session.ended'), durationMs: z.number().int().min(0).max(86_400_000), durationProvenance: z.enum(['observed', 'estimated']) }),
  z.strictObject({ ...session, kind: z.literal('connection.failed'), code: errorCodeSchema }),
  z.strictObject({ ...base, kind: z.literal('policy.ack'), revision: z.number().int().min(1).max(2_147_483_647) }),
  z.strictObject({ ...base, kind: z.literal('diagnostic.snapshot'), microphone: z.enum(['granted', 'denied', 'unknown']), batteryPercent: z.number().int().min(0).max(100).nullable(), freeMemoryMb: z.number().int().min(0).max(1_048_576).nullable() }),
  // REV 12 (schemaVersion 2): device-reported update funnel state. Blocked devices may not send it.
  z.strictObject({ ...base, kind: z.literal('update.status'), feedId: z.string().min(1).max(200), state: z.enum(['up_to_date', 'update_available', 'downloading', 'downloaded', 'installing', 'installed', 'failed']), currentBuild: build, discoveredVersion: z.string().min(1).max(100).nullable(), publishedAt: timestamp.nullable(), progressPct: z.number().int().min(0).max(100).nullable(), error: z.string().min(1).max(500).nullable() }),
]);
export const telemetryEnvelopeSchema = z.strictObject({ schemaVersion: z.union([z.literal(1), z.literal(2)]), events: z.array(telemetryEventSchema).min(1).max(100) }).superRefine((envelope, context) => {
  const features = new Map<string, string>();
  for (const [index, event] of envelope.events.entries()) {
    if (event.kind === 'update.status' && envelope.schemaVersion !== 2) context.addIssue({ code: 'custom', path: ['events', index, 'kind'], message: 'update.status requires schemaVersion 2.' });
    if (!('sessionId' in event)) continue;
    const previous = features.get(event.sessionId);
    if (previous && previous !== event.feature) context.addIssue({ code: 'custom', path: ['events', index, 'feature'], message: 'A logical session cannot change feature.' });
    features.set(event.sessionId, event.feature);
  }
});
export type TelemetryEvent = z.infer<typeof telemetryEventSchema>;
export interface StoredTechnicalEvent { deviceId: string; hotelId: string; receivedAt: string; event: TelemetryEvent }
export interface TelemetryLedger { events: StoredTechnicalEvent[]; lastHeartbeatByDevice: Record<string, string> }
export interface AuthenticatedDeviceScope { deviceId: string; hotelId: string; receivedAt: string }

/** Pure ingestion reference. Production must perform the dedupe transactionally in Postgres. */
export function ingestTelemetry(ledger: TelemetryLedger, raw: unknown, scope: AuthenticatedDeviceScope): TelemetryLedger {
  const serialized = JSON.stringify(raw);
  if (serialized === undefined || new TextEncoder().encode(serialized).length > 65_536) throw new Error('Telemetry batch exceeds 64 KiB.');
  const batch = telemetryEnvelopeSchema.parse(raw);
  const received = Date.parse(scope.receivedAt);
  if (!Number.isFinite(received)) throw new Error('Invalid receive time.');
  const seen = new Set(ledger.events.map(row => `${row.deviceId}:${row.event.eventId}`));
  const sessionFeatures = new Map<string, string>(ledger.events.flatMap(row => 'sessionId' in row.event ? [[`${row.deviceId}:${row.event.sessionId}`, row.event.feature] as const] : []));
  const added: StoredTechnicalEvent[] = [];
  for (const event of batch.events) {
    const occurred = Date.parse(event.occurredAt);
    if (occurred > received + 120_000 || occurred < received - 30 * 86_400_000) throw new Error('Event timestamp is outside the ingestion window.');
    const key = `${scope.deviceId}:${event.eventId}`;
    if (seen.has(key)) continue;
    if ('sessionId' in event) {
      const sessionKey = `${scope.deviceId}:${event.sessionId}`;
      const previous = sessionFeatures.get(sessionKey);
      if (previous && previous !== event.feature) throw new Error('A logical session cannot change feature.');
      sessionFeatures.set(sessionKey, event.feature);
    }
    seen.add(key);
    added.push({ deviceId: scope.deviceId, hotelId: scope.hotelId, receivedAt: scope.receivedAt, event });
  }
  // Historical uploads are never heartbeats and never reopen a session.
  return { events: [...ledger.events, ...added], lastHeartbeatByDevice: ledger.lastHeartbeatByDevice };
}
