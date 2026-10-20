import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'noteOS Gate 1 harness' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body style={{fontFamily:'system-ui',margin:'24px',maxWidth:900}}>{children}</body></html>;
}
