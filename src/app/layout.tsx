import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'Manzanilla — Fleet control', description: 'Private, content-free device operations. Local demonstration.' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
