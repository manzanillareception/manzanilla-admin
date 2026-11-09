'use client';

import { useMemo } from 'react';
import ControlCenter from './ControlCenter';
import { createLiveSource } from './data/live-source';

/**
 * Production dashboard. Reads and mutations go to the same-origin control API.
 * On 401/403 it shows sign-in/no-access; on SETUP_REQUIRED/network failure it
 * shows unavailable/stale. It never falls back to demo data.
 */
export default function LiveDashboard() {
  const source = useMemo(() => createLiveSource({ periodDays: 30 }), []);
  return <ControlCenter source={source} />;
}
