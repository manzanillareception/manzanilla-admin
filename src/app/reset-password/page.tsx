import type { Metadata } from 'next';
import { ResetPasswordForm } from '../../components/auth/ResetPasswordForm';

export const metadata: Metadata = { title: 'Reset password — Manzanilla fleet control' };

export default function ResetPasswordPage() {
  return <ResetPasswordForm />;
}
