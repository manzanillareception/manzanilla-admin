import { notFound } from 'next/navigation';
import DemoDashboard from '../../components/DemoDashboard';

/**
 * Explicit synthetic demo. Mechanically excluded from production builds unless
 * DEMO_MODE is set (contract-owner ruling): the demo is synthetic fixtures,
 * never an error fallback, and never a path to real data.
 */
export default function DemoPage() {
  if (process.env.NODE_ENV === 'production' && !process.env.DEMO_MODE) notFound();
  return <DemoDashboard />;
}
