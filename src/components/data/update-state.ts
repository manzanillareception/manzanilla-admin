import type { DeviceUpdate } from './types';

/**
 * Honest per-device update rendering (REV 12/13). The device-reported state is
 * shown exactly as derived server-side; a device that never sent update.status
 * reads "Not reported" - never guessed from build or connectivity.
 */
export interface UpdateDescription {
  label: string;
  tone: 'ok' | 'attention' | 'bad' | 'muted';
}

export function describeUpdate(update: DeviceUpdate | null | undefined): UpdateDescription {
  if (!update) return { label: 'Not reported', tone: 'muted' };
  switch (update.state) {
    case 'up_to_date':
      return { label: `Up to date · ${update.currentBuild}`, tone: 'ok' };
    case 'update_available':
      return { label: `Update available${update.discoveredVersion ? ` → ${update.discoveredVersion}` : ''}`, tone: 'attention' };
    case 'downloading':
      return { label: `Downloading update${update.progressPct != null ? ` · ${update.progressPct}%` : ''}`, tone: 'attention' };
    case 'downloaded':
      return { label: `Update downloaded${update.discoveredVersion ? ` · ${update.discoveredVersion}` : ''}`, tone: 'attention' };
    case 'installing':
      return { label: `Installing update${update.progressPct != null ? ` · ${update.progressPct}%` : ''}`, tone: 'attention' };
    case 'installed':
      return { label: `Installed · ${update.currentBuild}`, tone: 'ok' };
    case 'failed':
      return { label: `Update failed${update.error ? ` · ${update.error}` : ''}`, tone: 'bad' };
  }
}
