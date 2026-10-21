import type { Metadata } from 'next';
import './globals.css';
import { AppShell } from './ui/app-shell';

export const metadata: Metadata = { title: 'noteOS — notes that stay yours', description: 'Private notes stored on this device.' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="vi"><body><AppShell>{children}</AppShell></body></html>;
}
