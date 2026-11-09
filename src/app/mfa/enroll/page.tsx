import type { Metadata } from 'next';
import { MfaEnroll } from '../../../components/auth/MfaEnroll';

export const metadata: Metadata = { title: 'Set up two-factor — Manzanilla fleet control' };

export default function MfaEnrollPage() {
  return <MfaEnroll />;
}
