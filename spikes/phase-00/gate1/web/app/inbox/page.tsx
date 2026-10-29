'use client';

import { useEffect, useMemo, useState } from 'react';
import { GuardedLink as Link } from '../ui/navigation-guard';
import { createNotesRepository } from '../lib/local-notes.js';
import { discoverAi } from '../lib/ai-sync-client.mjs';
import { fetchSuggestionInbox } from '../lib/ai-inbox.mjs';

type Row = { id: string; noteId: string; createdAt: number; providerIdentity: string; revisionChanged: boolean; itemCount: number; pendingCount: number };

export default function AiInboxPage() {
  const repository = useMemo(() => createNotesRepository(), []);
  const [state, setState] = useState<'loading' | 'disabled' | 'unpaired' | 'offline' | 'ready'>('loading');
  const [rows, setRows] = useState<Row[]>([]), [titles, setTitles] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    void (async () => {
      try { const status = await discoverAi(); if (!status.enabled) { if (alive) setState('disabled'); return; } }
      catch { if (alive) setState('disabled'); return; }
      try {
        const list: Row[] = await fetchSuggestionInbox();
        const found: Record<string, string> = {};
        for (const row of list) { const note = await repository.get(row.noteId); if (note) found[row.noteId] = note.title || 'Untitled note'; }
        if (alive) { setRows(list); setTitles(found); setState('ready'); }
      } catch (error: any) { if (alive) setState(error?.status === 401 ? 'unpaired' : 'offline'); }
    })();
    return () => { alive = false; };
  }, [repository]);

  const pending = rows.filter(row => row.pendingCount > 0);
  return <section className="ai-inbox-page">
    <header className="page-heading"><p className="eyebrow">AI Inbox</p><h1 className="page-title">Suggestions waiting for you</h1>
      <p className="page-lede">AI only proposes. Open a note to review each suggestion with its source quote and a preview; nothing changes until you approve it.</p></header>
    {state === 'loading' && <div className="empty-state"><h2>Checking the paired Mac…</h2></div>}
    {state === 'disabled' && <div className="empty-state"><h2>AI suggestions are off</h2><p>They are disabled on this server. Your notes and Text Sync work as usual.</p></div>}
    {state === 'unpaired' && <div className="empty-state"><h2>Pair this browser first</h2><p>Suggestions live on your paired Mac.</p><Link className="btn" href="/sync">Open Sync Setup</Link></div>}
    {state === 'offline' && <div className="empty-state"><h2>The paired Mac is not reachable</h2><p>Try again when you are online. Decisions you already made are queued on this device.</p></div>}
    {state === 'ready' && !pending.length && <div className="empty-state"><h2>All caught up</h2><p>There are no suggestions to review.</p></div>}
    {state === 'ready' && pending.length > 0 && <ul className="ai-inbox-list">
      {pending.map(row => <li key={row.id}>
        {titles[row.noteId]
          ? <Link className="ai-inbox-row" href={`/notes/${encodeURIComponent(row.noteId)}#ai-suggestions`}>
            <span className="ai-inbox-title">{titles[row.noteId]}</span>
            <span className="ai-inbox-count">{row.pendingCount} of {row.itemCount} to review</span>
            <span className="ai-inbox-when">{new Date(row.createdAt).toLocaleDateString()}{row.revisionChanged ? ' · note changed since' : ''}</span>
          </Link>
          : <div className="ai-inbox-row is-missing"><span className="ai-inbox-title">A note that is not on this device</span><span className="ai-inbox-count">{row.pendingCount} to review</span><span className="ai-inbox-when">Review it on the device that has the note.</span></div>}
      </li>)}
    </ul>}
  </section>;
}
