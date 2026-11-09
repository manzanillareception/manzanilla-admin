import { Suspense } from 'react';
import type { Metadata } from 'next';
import { LoginForm } from '../../components/auth/LoginForm';

export const metadata: Metadata = { title: 'Sign in — Manzanilla fleet control' };

export default function LoginPage() {
  return <Suspense><LoginForm /></Suspense>;
}
