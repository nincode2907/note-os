'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createNotesRepository } from '../lib/local-notes.js';
import { synchronize } from '../lib/sync-client.mjs';

export function SyncWorker() {
  const [status, setStatus] = useState('saved-device');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const run = useCallback(async () => {
    try {
      const result = await synchronize({ repository: createNotesRepository(), onState: state => setStatus(state) });
      setStatus(result.status);
    } catch { setStatus('needs-review'); }
  }, []);
  const debouncedRun = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void run(), 900);
  }, [run]);

  useEffect(() => {
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('noteos-local-commits');
    const visibility = () => { if (document.visibilityState === 'visible') void run(); };
    window.addEventListener('noteos:local-note-commit', debouncedRun);
    window.addEventListener('online', debouncedRun);
    document.addEventListener('visibilitychange', visibility);
    if (channel) channel.onmessage = debouncedRun;
    void run();
    return () => {
      window.removeEventListener('noteos:local-note-commit', debouncedRun);
      window.removeEventListener('online', debouncedRun);
      document.removeEventListener('visibilitychange', visibility);
      channel?.close(); if (timer.current) clearTimeout(timer.current);
    };
  }, [debouncedRun, run]);

  const labels: Record<string,string> = { 'saved-device': 'Sync · Saved on device', waiting: 'Sync · Waiting for another tab', pending: 'Sync · Pending', syncing: 'Sync · Syncing', synced: 'Sync · Text synced', 'media-local-only': 'Sync · Audio stays on this device', 'needs-review': 'Sync · Needs review' };
  return <span className={`sync-worker-state state-${status}`} role="status" aria-live="polite">{labels[status] ?? 'Sync · Saved on device'}</span>;
}
