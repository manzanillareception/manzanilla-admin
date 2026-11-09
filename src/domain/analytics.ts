import type { Connection, Device, Filters, Incident, SessionAttempt, Snapshot, TrafficSummary, UsageSummary } from './types';

const DAY = 86_400_000;
export function getConnection(device: Device, asOf: string): Connection {
  if (!device.lastSeenAt) return 'unknown';
  const age = Date.parse(asOf) - Date.parse(device.lastSeenAt);
  if (!Number.isFinite(age) || age < 0) return 'unknown';
  return age <= 90_000 ? 'online' : age <= 180_000 ? 'stale' : 'offline';
}
export function filterDevices(snapshot: Snapshot, filters: Filters): Device[] {
  return snapshot.devices.filter(d => (filters.hotelId === 'all' || d.hotelId === filters.hotelId) && (filters.deviceId === 'all' || d.id === filters.deviceId));
}
function windowFor(snapshot: Snapshot, filters: Filters) {
  const end = Date.parse(snapshot.asOf);
  const midnight = Date.parse(`${snapshot.asOf.slice(0, 10)}T00:00:00.000Z`);
  return { start: midnight - (filters.periodDays - 1) * DAY, end };
}
function days(snapshot: Snapshot, filters: Filters): string[] {
  const { start } = windowFor(snapshot, filters);
  return Array.from({ length: filters.periodDays }, (_, i) => new Date(start + i * DAY).toISOString().slice(0, 10));
}
function inWindow(at: string, window: { start: number; end: number }) {
  const time = Date.parse(at);
  return time >= window.start && time <= window.end;
}
function selectedAttempts(snapshot: Snapshot, filters: Filters): SessionAttempt[] {
  const deviceIds = new Set(filterDevices(snapshot, filters).map(d => d.id));
  const window = windowFor(snapshot, filters);
  return snapshot.sessions.filter(a => deviceIds.has(a.deviceId) && (filters.feature === 'all' || a.feature === filters.feature) && inWindow(a.startedAt, window));
}
export function filterIncidents(snapshot: Snapshot, filters: Filters): Incident[] {
  const deviceIds = new Set(filterDevices(snapshot, filters).map(d => d.id));
  const window = windowFor(snapshot, filters);
  return snapshot.incidents.filter(i => i.deviceIds.some(id => deviceIds.has(id)) && inWindow(i.lastSeenAt, window));
}
export function percentile95(samples: number[]): number | null {
  if (!samples.length) return null;
  const ordered = [...samples].sort((a, b) => a - b);
  return ordered[Math.ceil(ordered.length * 0.95) - 1];
}
export function summarizeUsage(snapshot: Snapshot, filters: Filters): UsageSummary {
  const attempts = selectedAttempts(snapshot, filters);
  const logical = new Set(attempts.map(a => a.sessionId));
  const connected = new Map<string, SessionAttempt>();
  for (const attempt of [...attempts].sort((a, b) => Date.parse(a.connectedAt ?? a.startedAt) - Date.parse(b.connectedAt ?? b.startedAt))) {
    if (attempt.connectedAt && !connected.has(attempt.sessionId)) connected.set(attempt.sessionId, attempt);
  }
  const connectedSessions = [...connected.values()];
  const timing = attempts.flatMap(a => a.firstAudioMs === null ? [] : [a.firstAudioMs]);
  const duration = (items: SessionAttempt[]) => items.reduce((n, a) => n + (a.durationMs ?? 0), 0) / 60_000;
  return {
    connectedSessions: connected.size, attempts: attempts.length,
    failedAttempts: attempts.filter(a => a.outcome === 'failed').length,
    retries: attempts.length - logical.size, minutes: duration(attempts),
    estimatedSessions: new Set(attempts.filter(a => a.durationProvenance === 'estimated').map(a => a.sessionId)).size,
    firstAudioP95Ms: percentile95(timing), timingSamples: timing.length,
    byFeature: (['translation', 'reception'] as const).map(feature => {
      const selected = attempts.filter(a => a.feature === feature);
      return { feature, sessions: connectedSessions.filter(a => a.feature === feature).length, minutes: duration(selected) };
    }),
    byDay: days(snapshot, filters).map(day => ({
      day,
      translation: connectedSessions.filter(a => a.feature === 'translation' && a.startedAt.slice(0, 10) === day).length,
      reception: connectedSessions.filter(a => a.feature === 'reception' && a.startedAt.slice(0, 10) === day).length,
    })),
  };
}
export function summarizeTraffic(snapshot: Snapshot, filters: Filters): TrafficSummary {
  const deviceIds = new Set(filterDevices(snapshot, filters).map(d => d.id));
  const window = windowFor(snapshot, filters);
  const buckets = snapshot.traffic.filter(b => deviceIds.has(b.deviceId) && inWindow(b.at, window));
  const requests = buckets.reduce((n, b) => n + b.requests, 0);
  const failedRequests = buckets.reduce((n, b) => n + b.failedRequests, 0);
  const timing = buckets.flatMap(b => b.latenciesMs);
  // Clip connected intervals to the reporting window; end events sort before starts.
  const boundaries: { at: number; delta: number }[] = [];
  const intervals = new Map<string, { from: number; to: number }[]>();
  for (const attempt of snapshot.sessions) {
    if (!deviceIds.has(attempt.deviceId) || !attempt.connectedAt) continue;
    const from = Math.max(Date.parse(attempt.connectedAt), window.start);
    const to = Math.min(attempt.endedAt ? Date.parse(attempt.endedAt) : window.end, window.end);
    if (from < to) intervals.set(attempt.sessionId, [...(intervals.get(attempt.sessionId) ?? []), { from, to }]);
  }
  for (const group of intervals.values()) {
    const ordered = group.sort((a, b) => a.from - b.from);
    const merged: { from: number; to: number }[] = [];
    for (const interval of ordered) {
      const previous = merged.at(-1);
      if (previous && interval.from <= previous.to) previous.to = Math.max(previous.to, interval.to);
      else merged.push({ ...interval });
    }
    for (const interval of merged) boundaries.push({ at: interval.from, delta: 1 }, { at: interval.to, delta: -1 });
  }
  boundaries.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let concurrent = 0, peakConcurrent = 0;
  for (const item of boundaries) { concurrent += item.delta; peakConcurrent = Math.max(peakConcurrent, concurrent); }
  return {
    requests, failedRequests, retryRequests: buckets.reduce((n, b) => n + b.retryRequests, 0),
    failureRate: requests ? failedRequests / requests : 0,
    ingressBytes: buckets.reduce((n, b) => n + b.ingressBytes, 0),
    latencyP95Ms: percentile95(timing), timingSamples: timing.length, peakConcurrent,
    byDay: days(snapshot, filters).map(day => {
      const selected = buckets.filter(b => b.at.slice(0, 10) === day);
      return { day, requests: selected.reduce((n, b) => n + b.requests, 0), failedRequests: selected.reduce((n, b) => n + b.failedRequests, 0) };
    }),
  };
}
