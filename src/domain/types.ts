export type Feature = 'translation' | 'reception';
export type Access = 'pending' | 'approved' | 'blocked';
export type Connection = 'online' | 'stale' | 'offline' | 'unknown';
export type ErrorCode = 'CONNECTION_TIMEOUT' | 'MIC_PERMISSION_DENIED' | 'PROVIDER_UNAVAILABLE' | 'AUDIO_STARTUP_TIMEOUT' | 'POLICY_SYNC_FAILED';
export interface Hotel { id: string; name: string; city: string }
export interface Device {
  id: string; code: string; label: string; hotelId: string; build: string;
  managed: boolean; credential: 'valid' | 'revoked'; lastSeenAt: string | null;
  microphone: 'granted' | 'denied' | 'unknown'; mode: Feature | 'idle';
  access: { desired: Access; effective: Access; revision: number; ackRevision: number; changedAt: string; reason: string };
}
export interface SessionAttempt {
  id: string; sessionId: string; deviceId: string; feature: Feature;
  startedAt: string; connectedAt: string | null; endedAt: string | null;
  outcome: 'completed' | 'failed' | 'active'; durationMs: number | null;
  durationProvenance: 'observed' | 'estimated' | 'unknown'; firstAudioMs: number | null;
  failureCode: ErrorCode | null;
}
export interface TrafficBucket {
  id: string; deviceId: string; at: string; requests: number; failedRequests: number;
  retryRequests: number; ingressBytes: number; latenciesMs: number[];
}
export interface Incident {
  id: string; fingerprint: string; code: ErrorCode; component: 'android' | 'control' | 'provider' | 'network';
  severity: 'critical' | 'high' | 'medium'; title: string; firstSeenAt: string; lastSeenAt: string;
  deviceIds: string[]; occurrences: number; build: string;
  status: 'open' | 'triaged' | 'repair_requested' | 'resolved';
  owner: string | null; fixClass: 'code_candidate' | 'configuration' | 'external' | 'hotel_action';
  nextStep: string; dueAt: string;
}
export interface PolicyChange { id: string; deviceId: string; revision: number; desired: Access; at: string; reason: string }
export interface RepairRequest { id: string; incidentId: string; createdAt: string; target: 'android_handoff' | 'new_admin_repo' | 'manual_runbook'; state: 'brief_ready' }
export interface Snapshot {
  schemaVersion: 1; asOf: string; hotels: Hotel[]; devices: Device[]; sessions: SessionAttempt[];
  traffic: TrafficBucket[]; incidents: Incident[]; policyHistory: PolicyChange[]; repairRequests: RepairRequest[];
}
export interface Filters { hotelId: string; deviceId: string; feature: Feature | 'all'; periodDays: 1 | 7 | 30 }
export const DEFAULT_FILTERS: Filters = { hotelId: 'all', deviceId: 'all', feature: 'all', periodDays: 7 };
export const FEATURE_LABELS: Record<Feature, string> = { translation: 'Translation', reception: 'Night receptionist' };
export interface UsageSummary {
  connectedSessions: number; attempts: number; failedAttempts: number; retries: number;
  minutes: number; estimatedSessions: number; firstAudioP95Ms: number | null; timingSamples: number;
  byFeature: { feature: Feature; sessions: number; minutes: number }[];
  byDay: { day: string; translation: number; reception: number }[];
}
export interface TrafficSummary {
  requests: number; failedRequests: number; retryRequests: number; failureRate: number;
  ingressBytes: number; latencyP95Ms: number | null; timingSamples: number; peakConcurrent: number;
  byDay: { day: string; requests: number; failedRequests: number }[];
}
