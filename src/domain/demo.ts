import type { Device, ErrorCode, Incident, SessionAttempt, Snapshot, TrafficBucket } from './types';

const DAY = 86_400_000;
export function createDemoSnapshot(now = new Date()): Snapshot {
  const clock = now.getTime();
  if (!Number.isFinite(clock)) throw new Error('Invalid demo clock.');
  const asOf = now.toISOString();
  const ago = (ms: number) => new Date(clock - ms).toISOString();
  const hotels = [
    { id: 'hotel-mar', name: 'Hotel Mar', city: 'Barcelona, ES' },
    { id: 'hotel-oliva', name: 'Casa Oliva', city: 'Valencia, ES' },
    { id: 'hotel-harbour', name: 'Harbour House', city: 'Lisbon, PT' },
    { id: 'hotel-north', name: 'Northlight Hotel', city: 'Amsterdam, NL' },
  ];
  const device = (id: string, hotelId: string, label: string, lastSeenMs: number | null, desired: Device['access']['desired'] = 'approved', extra: Partial<Device> = {}): Device => ({
    id, code: id.toUpperCase(), label, hotelId, build: '17.0.43', managed: true, credential: 'valid',
    lastSeenAt: lastSeenMs === null ? null : ago(lastSeenMs), microphone: 'granted', mode: 'idle',
    access: { desired, effective: desired, revision: 3, ackRevision: 3, changedAt: ago(DAY), reason: 'Pilot device enrollment' }, ...extra,
  });
  const devices: Device[] = [
    device('mar-01', 'hotel-mar', 'Front desk', 20_000, 'approved', { mode: 'translation' }),
    device('mar-02', 'hotel-mar', 'Night reception', 35_000, 'approved', { mode: 'reception' }),
    device('mar-03', 'hotel-mar', 'Lobby backup', 26 * 60_000),
    device('oliva-01', 'hotel-oliva', 'Front desk', 46_000, 'approved', { microphone: 'denied' }),
    device('oliva-02', 'hotel-oliva', 'New installation', 12_000, 'pending', { microphone: 'unknown' }),
    device('harbour-01', 'hotel-harbour', 'Front desk', 31_000, 'blocked'),
    device('harbour-02', 'hotel-harbour', 'Night reception', 130_000),
    device('north-01', 'hotel-north', 'Front desk · legacy APK', 42_000, 'approved', { managed: false, build: '17.0.40' }),
    device('north-02', 'hotel-north', 'Replacement unit', null, 'pending', { microphone: 'unknown' }),
  ];
  const sessions: SessionAttempt[] = [];
  const traffic: TrafficBucket[] = [];
  const midnight = Date.parse(`${asOf.slice(0, 10)}T00:00:00.000Z`);
  const reportingDevices = devices.filter(d => !['oliva-02', 'north-02'].includes(d.id));
  for (let day = 6; day >= 0; day--) {
    const dayStart = midnight - day * DAY;
    const dayEnd = Math.min(dayStart + 20 * 3_600_000, clock - 15 * 60_000);
    if (dayEnd < dayStart) continue;
    reportingDevices.forEach((d, deviceIndex) => {
      // A device runs one voice session at a time. Reserve seven-minute slots,
      // including retry/capture overhead, and reduce early-day volume to fit.
      const slotMs = 7 * 60_000;
      const permittedEnd = d.access.desired === 'blocked' ? Math.min(dayEnd, Date.parse(d.access.changedAt)) : dayEnd;
      const requestedCount = 5 + ((6 - day + deviceIndex) % 5);
      const count = Math.min(requestedCount, Math.max(0, Math.floor((permittedEnd - dayStart) / slotMs)));
      const first = Math.max(dayStart, Math.min(dayStart + 8 * 3_600_000, permittedEnd - count * slotMs));
      const stride = count ? Math.floor((permittedEnd - first) / count) : slotMs;
      for (let index = 0; index < count; index++) {
        const started = first + index * stride + deviceIndex * 700;
        const sessionId = `session-${day}-${d.id}-${index}`;
        const feature = (index + deviceIndex) % 3 === 0 ? 'reception' as const : 'translation' as const;
        const seed = day * 31 + deviceIndex * 7 + index;
        const retry = seed % 9 === 0;
        const failed = seed % 19 === 0;
        if (retry) sessions.push({
          id: `${sessionId}-a1`, sessionId, deviceId: d.id, feature,
          startedAt: new Date(started).toISOString(), connectedAt: null, endedAt: new Date(started + 4_000).toISOString(),
          outcome: 'failed', durationMs: null, durationProvenance: 'unknown', firstAudioMs: null, failureCode: 'CONNECTION_TIMEOUT',
        });
        const attemptStart = started + (retry ? 10_000 : 0);
        const durationMs = (90 + seed % 270) * 1_000;
        if (attemptStart + durationMs + 650 > clock) continue;
        sessions.push({
          id: `${sessionId}-a${retry ? 2 : 1}`, sessionId, deviceId: d.id, feature,
          startedAt: new Date(attemptStart).toISOString(),
          connectedAt: failed ? null : new Date(attemptStart + 650).toISOString(),
          endedAt: new Date(attemptStart + (failed ? 5_000 : durationMs + 650)).toISOString(),
          outcome: failed ? 'failed' : 'completed', durationMs: failed ? null : durationMs,
          durationProvenance: failed ? 'unknown' : seed % 23 === 0 ? 'estimated' : 'observed',
          firstAudioMs: failed || seed % 5 === 0 ? null : 280 + seed % 850,
          failureCode: failed ? 'AUDIO_STARTUP_TIMEOUT' : null,
        });
      }
      const requests = 420 + deviceIndex * 61 + (6 - day) * 37;
      const failedRequests = (day + deviceIndex) % 7 === 0 ? 13 : (day + deviceIndex) % 5;
      traffic.push({
        id: `bucket-${day}-${d.id}`, deviceId: d.id, at: new Date(Math.max(dayStart, dayEnd)).toISOString(),
        requests, failedRequests, retryRequests: failedRequests + (deviceIndex % 3), ingressBytes: requests * (420 + deviceIndex * 12),
        latenciesMs: Array.from({ length: 18 }, (_, i) => 42 + ((i * 17 + day * 31 + deviceIndex * 11) % 180)),
      });
    });
  }
  for (const [index, d] of devices.slice(0, 2).entries()) sessions.push({
    id: `live-${d.id}-a1`, sessionId: `live-${d.id}`, deviceId: d.id, feature: index === 0 ? 'translation' : 'reception',
    startedAt: ago(110_000), connectedAt: ago(109_000), endedAt: null, outcome: 'active',
    durationMs: 109_000, durationProvenance: 'estimated', firstAudioMs: 460 + index * 160, failureCode: null,
  });
  const incident = (id: string, code: ErrorCode, component: Incident['component'], severity: Incident['severity'], title: string, deviceIds: string[], occurrences: number, fixClass: Incident['fixClass'], nextStep: string, ageMinutes: number): Incident => ({
    id, fingerprint: `${component}:${code}:17.0.43`, code, component, severity, title, deviceIds, occurrences,
    firstSeenAt: ago((ageMinutes + 24) * 60_000), lastSeenAt: ago(ageMinutes * 60_000), build: '17.0.43',
    status: 'open', owner: null, fixClass, nextStep, dueAt: new Date(clock + (severity === 'critical' ? 60 : 240) * 60_000).toISOString(),
  });
  const incidents: Incident[] = [
    incident('INC-1042', 'AUDIO_STARTUP_TIMEOUT', 'android', 'critical', 'Audio startup exceeded its deadline', ['mar-02', 'harbour-02'], 8, 'code_candidate', 'Reproduce audio startup on the affected build; prepare an Android handoff.', 4),
    incident('INC-1041', 'CONNECTION_TIMEOUT', 'network', 'high', 'Lobby backup stopped reporting', ['mar-03'], 6, 'hotel_action', 'Ask the hotel to check power and Wi-Fi before opening a code repair.', 26),
    incident('INC-1040', 'MIC_PERMISSION_DENIED', 'android', 'medium', 'Microphone permission is disabled', ['oliva-01'], 3, 'configuration', 'Use the Android permission guide; preserve enrollment and local data.', 12),
    incident('INC-1039', 'PROVIDER_UNAVAILABLE', 'provider', 'high', 'Voice provider rejected a connection', ['mar-01', 'harbour-02'], 4, 'external', 'Check provider health and retry policy; do not rotate keys automatically.', 40),
    incident('INC-1038', 'POLICY_SYNC_FAILED', 'control', 'high', 'Policy receipt could not be recorded', ['harbour-01'], 2, 'code_candidate', 'Reproduce policy receipt handling in this new control-plane repository.', 55),
  ];
  return { schemaVersion: 1, asOf, hotels, devices, sessions, traffic, incidents, policyHistory: [], repairRequests: [] };
}
