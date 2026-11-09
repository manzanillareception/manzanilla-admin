import { getConnection } from './analytics';
import type { Access, Snapshot } from './types';

export function requestDeviceAccess(snapshot: Snapshot, input: { deviceId: string; desired: Access; reason: string; expectedRevision: number }, now = new Date(snapshot.asOf)): Snapshot {
  const device = snapshot.devices.find(d => d.id === input.deviceId);
  if (!device) throw new Error('Device not found.');
  if (!device.managed) throw new Error('Legacy device: a managed APK integration is required before policy control.');
  if (device.credential === 'revoked') throw new Error('Device credential is revoked; enroll again before changing service access.');
  if (device.access.revision !== input.expectedRevision) throw new Error('Policy changed. Refresh the device before trying again.');
  if (device.access.desired === input.desired) return snapshot;
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 160) throw new Error('Use a reason between 3 and 160 characters.');
  const revision = device.access.revision + 1;
  const at = now.toISOString();
  return {
    ...snapshot,
    devices: snapshot.devices.map(d => d.id === device.id ? { ...d, access: { ...d.access, desired: input.desired, revision, changedAt: at, reason } } : d),
    policyHistory: [{ id: `policy-${device.id}-${revision}`, deviceId: device.id, revision, desired: input.desired, at, reason }, ...snapshot.policyHistory],
  };
}
export function acknowledgeDevicePolicy(snapshot: Snapshot, input: { deviceId: string; revision: number }, now = new Date(snapshot.asOf)): Snapshot {
  const device = snapshot.devices.find(d => d.id === input.deviceId);
  if (!device) throw new Error('Device not found.');
  if (!device.managed || device.credential === 'revoked') throw new Error('Only an enrolled managed device can acknowledge policy.');
  if (device.access.revision !== input.revision) throw new Error('Stale policy receipt rejected.');
  if (getConnection(device, now.toISOString()) !== 'online') throw new Error('Device is not online; confirmation remains pending.');
  if (device.access.ackRevision === input.revision) return snapshot;
  return {
    ...snapshot,
    devices: snapshot.devices.map(d => d.id === device.id ? {
      ...d,
      access: { ...d.access, effective: d.access.desired, ackRevision: input.revision },
    } : d),
  };
}
