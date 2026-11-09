'use client';

import { useMemo } from 'react';
import ControlCenter from './ControlCenter';
import { createDemoSource } from './data/demo-source';

/** Explicit synthetic demo, reachable only at /demo. Never an error fallback. */
export default function DemoDashboard() {
  const source = useMemo(() => createDemoSource(), []);
  return <ControlCenter source={source} />;
}
