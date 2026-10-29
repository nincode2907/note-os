'use client';

import { GuardedLink as Link, NavigationGuardProvider } from './navigation-guard';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { SyncWorker } from './sync-worker';

const links = [
  ['/', '⌂', 'Notes'], ['/archive', '▤', 'Archive'], ['/trash', '⌫', 'Trash'], ['/backup', '↥', 'Backup'], ['/sync', '⇄', 'Sync Setup'],
];

const aiInboxLink = ['/inbox', '✦', 'AI Inbox'];

function NavLinks({ pathname, aiEnabled = false }: { pathname: string; aiEnabled?: boolean }) {
  const visible = aiEnabled ? [...links.slice(0, 1), aiInboxLink, ...links.slice(1)] : links;
  return <>{visible.map(([href, icon, label]) => <Link key={href} href={href} className={`nav-link ${pathname === href ? 'active' : ''}`}><span className="nav-icon" aria-hidden="true">{icon}</span>{label}</Link>)}</>;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [usage, setUsage] = useState('Local storage'), [aiEnabled, setAiEnabled] = useState(false);
  useEffect(() => {
    // The AI Inbox appears only when the paired server reports AI organize enabled.
    let active = true;
    fetch('/api/v1/ai/status', { credentials: 'same-origin', cache: 'no-store' }).then(response => response.ok ? response.json() : null)
      .then(status => { if (active) setAiEnabled(status?.enabled === true); }).catch(() => {});
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    let alive = true;
    const register = () => {
      void navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
        .then(registration => { if (alive) return registration.update(); })
        .catch(() => {});
    };
    register();
    const onVisible = () => { if (document.visibilityState === 'visible') register(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { alive = false; document.removeEventListener('visibilitychange', onVisible); };
  }, []);
  useEffect(() => {
    let active = true;
    navigator.storage?.persist?.().catch(() => false);
    navigator.storage?.estimate?.().then((result) => {
      if (!active || !result.quota) return;
      const used = Math.round((result.usage ?? 0) / 1024 / 1024);
      const quota = Math.round(result.quota / 1024 / 1024);
      setUsage(`${used} MB used · ${quota} MB available`);
    }).catch(() => {});
    return () => { active = false; };
  }, []);
  return <NavigationGuardProvider><div className="app-frame">
    <aside className="rail">
      <Link href="/" className="brand"><span className="brand-mark">n</span>noteOS</Link>
      <nav className="nav-group" aria-label="Main navigation"><NavLinks pathname={pathname} aiEnabled={aiEnabled} /></nav>
      <div className="nav-bottom">
        <SyncWorker />
        <div className="privacy-card"><strong><span aria-hidden="true">● </span>Private by default</strong><p>Your notes live in this browser. Text sync starts only after you pair and approve notes.</p></div>
        <p className="storage-caption">{usage}</p>
      </div>
    </aside>
    <div className="main-area">
      <header className="mobile-head"><Link href="/" className="brand"><span className="brand-mark">n</span>noteOS</Link><nav className="mobile-nav" aria-label="Main navigation"><NavLinks pathname={pathname} aiEnabled={aiEnabled} /></nav></header>
      <main className="main-content">{children}</main>
    </div>
  </div></NavigationGuardProvider>;
}
