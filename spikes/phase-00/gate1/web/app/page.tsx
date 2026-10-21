'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { createNotesRepository, makeEmptyNote } from './lib/local-notes.js';
import { filterNotes } from './lib/mvp-utils.mjs';

function textOf(document: any) {
  const text: string[] = [];
  const walk = (node: any) => { if (node?.type === 'text') text.push(node.text); else if (node?.type === 'hardBreak') text.push(' '); (node?.content ?? []).forEach(walk); };
  walk(document);
  return text.join(' ').replace(/\s+/g, ' ').trim();
}

export default function Home() {
  const [notes, setNotes] = useState<any[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const repo = createNotesRepository();
  async function refresh() { try { setNotes(await repo.list()); setError(''); } catch (e) { setError(e instanceof Error ? e.message : 'Could not open local notes.'); } finally { setReady(true); } }
  useEffect(() => { void refresh(); }, []);
  const active = filterNotes(notes, query, 'active');
  async function createNote() {
    try { const note = await repo.create(makeEmptyNote()); location.assign(`/notes/${encodeURIComponent(note.id)}`); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not create a note.'); }
  }
  return <>
    <div className="page-heading"><div><p className="eyebrow">A quiet place to think</p><h1 className="page-title">Your notes</h1><p className="page-lede">A little space for what you want to remember.</p></div><div className="actions"><button className="btn btn-primary" onClick={createNote}>＋ New note</button></div></div>
    {error && <div className="notice error" role="alert">{error} Your notes stay stored locally.</div>}
    <div className="search-row"><label className="screen-reader" htmlFor="note-search">Search notes</label><input id="note-search" className="searchbox" type="search" placeholder="Search your notes…" value={query} onChange={(event) => setQuery(event.target.value)} /><span className="toolbar-label">{active.length} {active.length === 1 ? 'note' : 'notes'}</span></div>
    {active.length ? <section className="notes-grid" aria-label="Active notes">{active.map((note: any) => <Link className="note-card" href={`/notes/${encodeURIComponent(note.id)}`} key={note.id}><h2>{note.title || 'Untitled note'}</h2><p className="note-preview">{textOf(note.document) || 'Start with a thought…'}</p><div className="note-meta"><span>{new Date(note.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span><span>Open ↗</span></div></Link>)}</section>
      : <div className="empty-state"><h2>{ready ? (query ? 'No notes found' : 'A fresh page') : 'Opening your notes…'}</h2><p>{ready ? (query ? 'Try another word or phrase.' : 'Create a note to get your thoughts started.') : 'Everything is stored on this device.'}</p>{ready && !query && <button className="btn btn-primary" onClick={createNote}>Create your first note</button>}</div>}
  </>;
}
