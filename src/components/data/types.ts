import type { Access, Incident, Snapshot } from '../../domain/types';

/** REV 13: per-device update state, derived server-side from the latest accepted update.status event. */
export type DeviceUpdateState = 'up_to_date' | 'update_available' | 'downloading' | 'downloaded' | 'installing' | 'installed' | 'failed';

export interface DeviceUpdate {
  /** Release feed the device polls (e.g. "github:somdipto/manzanilla"). */
  feedId: string;
  state: DeviceUpdateState;
  /** Installed build, as reported by the device. */
  currentBuild: string;
  /** Version discovered on the feed, when one was found. */
  discoveredVersion: string | null;
  /** Feed-side publish time of discoveredVersion. */
  publishedAt: string | null;
  /** 0..100; only meaningful while downloading/installing. */
  progressPct: number | null;
  /** Failure detail; only for state "failed". */
  error: string | null;
  /** When the latest update.status event occurred. */
  reportedAt: string;
}

/**
 * REV 13 adds ONE optional+nullable Snapshot key: devices[].update. The contract-owner
 * type in src/domain/types.ts gains it at integration time; until then the dashboard
 * views devices through this local extension. null/absent = never reported.
 */
export type SnapshotDevice = Snapshot['devices'][number] & { update?: DeviceUpdate | null };
export type SnapshotView = Omit<Snapshot, 'devices'> & { devices: SnapshotDevice[] };

/** Recovery modes accepted by POST /admin/hotels/:hotelId/recovery (REV 13). */
export type RecoveryMode = 'guide' | 'reset_link';

/** POST /admin/hotels 202 body (REV 13) plus the reloaded read. */
export interface CreateHotelResult {
  read: DashboardRead;
  hotelId: string;
  jobId: string;
  duplicate: boolean;
  status: string;
  /** Present only when status is needs_attention (sealed password gone; requeue cannot resend). */
  nextStep?: string;
}
import type { RepairPacket } from '../../domain/repair';

/** How the dashboard got its data. Demo is explicit and never an error fallback. */
export type SourceMode = 'live' | 'demo';

export type DashboardErrorKind =
  | 'unauthorized'   // 401 UNAUTHORIZED — sign-in required
  | 'forbidden'      // 403 FORBIDDEN / MFA_SETUP_REQUIRED — signed in, not an enabled admin (or MFA incomplete)
  | 'setup-required' // 503 SETUP_REQUIRED — backend route not connected yet
  | 'unavailable'    // 503 UNAVAILABLE / 404 route missing / 5xx
  | 'rate-limited'   // 429 RATE_LIMITED
  | 'conflict'       // 409 STALE_REVISION / FUTURE_REVISION — record changed server-side
  | 'invalid-state'  // 409 INVALID_STATE — action no longer valid for the record's state
  | 'not-found'      // 404 NOT_FOUND — record no longer exists
  | 'validation'     // 400 VALIDATION_FAILED
  | 'network'        // fetch failed / aborted by server
  | 'bad-response';  // 2xx payload failed contract validation

export class DashboardError extends Error {
  constructor(
    public readonly kind: DashboardErrorKind,
    message: string,
    public readonly retryable = false,
    public readonly retryAfterMs?: number,
    /** Server error code when known (e.g. MFA_SETUP_REQUIRED); drives the right next step. */
    public readonly serverCode?: string,
  ) { super(message); this.name = 'DashboardError'; }
}

export interface DashboardRead {
  snapshot: SnapshotView;
  /** Server-observed data time. Presence classes (online/stale/offline) are computed against this. */
  asOf: string;
  /** Set when a mutation response was the historical result of an already-recorded retry (rev11). */
  recordedRetry?: boolean;
}

export interface PolicyInput {
  deviceId: string;
  desired: Access;
  reason: string;
  expectedRevision: number;
}

export interface CreateHotelInput {
  hotelName: string;
  city: string;
  email: string;
  confirmEmail: string;
}

export interface SetupTokenResult {
  setupToken: string;
  expiresAt: string;
}

export interface RepairResult {
  read: DashboardRead;
  /** Demo builds the sanitized packet locally. Live returns null: the brief is server-owned. */
  packet: RepairPacket | null;
}

export interface DashboardDataSource {
  readonly mode: SourceMode;
  load(signal?: AbortSignal): Promise<DashboardRead>;
  requestPolicy(input: PolicyInput): Promise<DashboardRead>;
  triageIncident(incidentId: string): Promise<DashboardRead>;
  prepareRepair(incident: Incident): Promise<RepairResult>;
  /** Live only. Demo stays a fixed synthetic fleet. */
  createHotel?(input: CreateHotelInput): Promise<CreateHotelResult>;
  /** Live only. Emails the hotel a sign-in guide (no password) or a password reset
   *  link - exactly the chosen mode, never both. REV 13 recovery route. */
  sendRecovery?(hotelId: string, mode: RecoveryMode): Promise<DashboardRead>;
  /** Live only. Mints a one-use device setup token; the plaintext is shown once, never stored here. */
  mintSetupToken?(hotelId: string): Promise<SetupTokenResult>;
}
