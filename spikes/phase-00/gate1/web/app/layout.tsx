import type { Metadata, Viewport } from 'next';
import './globals.css';
import { AppShell } from './ui/app-shell';

export const metadata: Metadata = {
  title: 'noteOS — notes that stay yours',
  applicationName: 'Note OS',
  description: 'Private notes stored on this device.',
  appleWebApp: { capable: true, title: 'Note OS', statusBarStyle: 'default' },
  icons: {
    icon: [{ url: '/icons/noteos-192.png', sizes: '192x192', type: 'image/png' }],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#f7f5f0' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="vi"><body><AppShell>{children}</AppShell></body></html>;
}
