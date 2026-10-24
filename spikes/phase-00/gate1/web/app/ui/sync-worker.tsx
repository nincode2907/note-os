'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createNotesRepository } from '../lib/local-notes.js';
import { synchronize } from '../lib/sync-client.mjs';
import { syncRetryDelay, SYNC_RETRY_LIMIT } from '../lib/sync-retry.mjs';

export function SyncWorker() {
  const [status, setStatus] = useState('saved-device');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const running = useRef(false);
  const rerun = useRef(false);
  const retries = useRef(0);
  const run = useCallback(async () => {
    if (running.current) { rerun.current = true; return; }
    running.current = true;
    try {
      const result = await synchronize({ repository: createNotesRepository(), onState: state => setStatus(state) });
      setStatus(result.status);
      if (result.retryable && retries.current < SYNC_RETRY_LIMIT) {
        retries.current += 1;
        retryTimer.current = setTimeout(() => { retryTimer.current = null; void run(); }, syncRetryDelay(retries.current));
      } else if (!result.retryable) retries.current = 0;
    } catch { setStatus('needs-review'); retries.current = 0; }
    finally {
      running.current = false;
      if (rerun.current) { rerun.current = false; void run(); }
    }
  }, []);
  const activity = useCallback((delayOrEvent?: number | Event) => {
    const delay = typeof delayOrEvent === 'number' ? delayOrEvent : 900;
    retries.current = 0;
    if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null; }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; void run(); }, delay);
  }, [run]);

  useEffect(() => {
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('noteos-local-commits');
    const visibility = () => { if (document.visibilityState === 'visible') activity(0); };
    const offline = () => setStatus('waiting-connection');
    window.addEventListener('noteos:local-note-commit', activity);
    window.addEventListener('noteos:sync-state-changed', activity);
    window.addEventListener('online', activity);
    window.addEventListener('offline', offline);
    document.addEventListener('visibilitychange', visibility);
    if (channel) channel.onmessage = () => activity();
    void run();
    return () => {
      window.removeEventListener('noteos:local-note-commit', activity);
      window.removeEventListener('noteos:sync-state-changed', activity);
      window.removeEventListener('online', activity);
      window.removeEventListener('offline', offline);
      document.removeEventListener('visibilitychange', visibility);
      channel?.close(); if (timer.current) clearTimeout(timer.current); if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, [activity, run]);

  const labels: Record<string,string> = { 'saved-device': 'Saved on this device', 'waiting': 'Waiting for another tab', 'waiting-connection': 'Waiting for connection', 'needs-pairing': 'Pair this installation', pending: 'Waiting to sync', syncing: 'Syncing', synced: 'Synced to Mac', 'media-local-only': 'Audio stays on this device', 'needs-review': 'Needs review' };
  return <span className={`sync-worker-state state-${status}`} role="status" aria-live="polite">{labels[status] ?? 'Sync unavailable'}</span>;
}
