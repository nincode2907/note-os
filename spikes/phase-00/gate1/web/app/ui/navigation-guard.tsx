'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';

type Guard = () => Promise<boolean>;
const NavigationContext = createContext<{ register: (guard: Guard) => () => void; navigate: (href: string) => Promise<void> } | null>(null);

export function NavigationGuardProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const guard = useRef<Guard | null>(null);
  const register = useCallback((next: Guard) => { guard.current = next; return () => { if (guard.current === next) guard.current = null; }; }, []);
  const navigate = useCallback(async (href: string) => { if (!guard.current || await guard.current()) router.push(href); }, [router]);
  const value = useMemo(() => ({ register, navigate }), [register, navigate]);
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

export function useNavigationGuard(guard: Guard) {
  const navigation = useContext(NavigationContext);
  useEffect(() => navigation?.register(guard), [navigation, guard]);
}

export function GuardedLink({ href, ...props }: Omit<React.ComponentProps<typeof Link>, 'href' | 'onNavigate'> & { href: string }) {
  const navigation = useContext(NavigationContext);
  return <Link {...props} href={href} onNavigate={(event) => { if (navigation) { event.preventDefault(); void navigation.navigate(href); } }} />;
}
