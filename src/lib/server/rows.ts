import type { DeviceRow } from './types';

/** Map a Postgres/PostgREST snake_case device row (joined with credential state) to DeviceRow. */
export function rowToDevice(row: Record<string, unknown>): DeviceRow {
  return {
    id: String(row.id),
    hotelId: String(row.hotel_id),
    code: String(row.code),
    label: String(row.label),
    build: String(row.build),
    managed: Boolean(row.managed),
    credentialState: (row.credential_state as DeviceRow['credentialState']) ?? 'valid',
    desiredAccess: row.desired_access as DeviceRow['desiredAccess'],
    effectiveAccess: row.effective_access as DeviceRow['effectiveAccess'],
    policyRevision: Number(row.policy_revision),
    ackRevision: Number(row.ack_revision),
    lastSeenAt: (row.last_seen_at as string | null) ?? null,
    lastBootId: (row.last_boot_id as string | null) ?? null,
    lastHeartbeatSequence: row.last_heartbeat_sequence === null || row.last_heartbeat_sequence === undefined ? null : Number(row.last_heartbeat_sequence),
    mode: (row.mode as DeviceRow['mode']) ?? 'idle',
    microphone: (row.microphone as DeviceRow['microphone']) ?? 'unknown',
  };
}
