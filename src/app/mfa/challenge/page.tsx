import type { Metadata } from 'next';
import { MfaChallenge } from '../../../components/auth/MfaChallenge';

export const metadata: Metadata = { title: 'Two-factor check — Manzanilla fleet control' };

export default function MfaChallengePage() {
  return <MfaChallenge />;
}
