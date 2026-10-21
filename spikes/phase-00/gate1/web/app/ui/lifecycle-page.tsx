'use client';

import Link from 'next/link';
import { recoveryEntries, finishDeletedNote, recoveryStorage } from '../lib/recovery-journal.mjs';
import { useEffect, useState } from 'react';
import { createNotesRepository, NoteConflictError, NoteNotFoundError } from '../lib/local-notes.js';

function textOf(document: any) { const out: string[] = []; const walk = (n: any) => { if (n?.type === 'text') out.push(n.text); (n?.content ?? []).forEach(walk); }; walk(document); return out.join(' ').replace(/\s+/g, ' ').trim(); }

export function LifecyclePage({ lifecycle }: { lifecycle: 'archived' | 'trashed' }) {
  const [notes, setNotes] = useState<any[]>([]); const [error, setError] = useState(''); const [pending, setPending] = useState<any>(null); const [backupRequested, setBackupRequested] = useState(false); const [backupConfirmed, setBackupConfirmed] = useState(false);
  const repo = createNotesRepository();
  async function refresh() { try { setNotes((await repo.list()).filter((note: any) => note.lifecycle === lifecycle)); } catch (e) { setError(e instanceof Error ? e.message : 'Could not load notes.'); } }
  useEffect(() => { void refresh(); }, []);
  async function change(note: any, next: 'active' | 'trashed') { try { await repo.setLifecycle(note.id, next, note.revision); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : 'Could not update note.'); } }
  async function exportBeforeDelete() {
    try {
      const allNotes = await repo.list();
      const blob = new Blob([JSON.stringify({ format: 'noteos.local-backup', version: 1, exportedAt: new Date().toISOString(), notes: allNotes }, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `noteos-backup-${new Date().toISOString().slice(0, 10)}.json`; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 60_000); setBackupRequested(true); setBackupConfirmed(false); setError('Download requested. noteOS cannot verify that your browser saved the file. Check your downloads before continuing.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not prepare a full backup.'); }
  }
  async function deleteForever() {
    if (!pending || !backupRequested || !backupConfirmed) return;
    try { const entries = recoveryEntries(recoveryStorage(), pending.id); const deleted = await repo.deleteForever(pending.id, pending.revision); finishDeletedNote(recoveryStorage(), deleted, entries); setPending(null); setBackupRequested(false); setBackupConfirmed(false); await refresh(); }
    catch (e) {
      if (e instanceof NoteConflictError) setError('This note changed in another tab. It was not deleted. Review the refreshed note and start the confirmation again.');
      else if (e instanceof NoteNotFoundError) setError('This note was already removed in another tab. The list has been refreshed.');
      else setError(e instanceof Error ? e.message : 'Could not delete note.');
      setPending(null); setBackupRequested(false); setBackupConfirmed(false); await refresh();
    }
  }
  const archived = lifecycle === 'archived';
  return <>
    <div className="page-heading"><div><p className="eyebrow">Your library</p><h1 className="page-title">{archived ? 'Archive' : 'Trash'}</h1><p className="page-lede">{archived ? 'Notes you have set aside. Restore them whenever you like.' : 'Trashed notes stay here until you remove them permanently.'}</p></div></div>
    {error && <div className="notice error" role="alert">{error}</div>}
    {notes.length ? <section className="notes-grid">{notes.map((note) => <article className="note-card" key={note.id}><Link href={`/notes/${encodeURIComponent(note.id)}`}><h2>{note.title || 'Untitled note'}</h2><p className="note-preview">{textOf(note.document) || 'No text in this note.'}</p></Link><div className="note-meta"><span>{new Date(note.updatedAt).toLocaleDateString()}</span><span>{archived ? <button className="tool-button" onClick={() => void change(note, 'active')}>Restore</button> : <><button className="tool-button" onClick={() => void change(note, 'active')}>Restore</button><button className="tool-button" onClick={() => { setPending(note); setBackupRequested(false); setBackupConfirmed(false); }}>Delete forever</button></>}</span></div></article>)}</section>
      : <div className="empty-state"><h2>{archived ? 'Nothing in the archive' : 'Trash is empty'}</h2><p>{archived ? 'Archived notes will be waiting here.' : 'Deleted notes will appear here before permanent removal.'}</p></div>}
    {pending && <div className="dialog-backdrop" role="presentation"><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="delete-title"><h2 id="delete-title">Delete “{pending.title || 'Untitled note'}” forever?</h2><p>This permanently removes this note from this device. A download request does not prove the backup finished or was saved. noteOS cannot guarantee that a backup copy is available.</p>{!backupRequested ? <button className="btn" onClick={() => void exportBeforeDelete()}>Request full backup download</button> : <><div className="notice">Check your browser’s Downloads and keep a copy somewhere safe before continuing.</div><label className="checkbox-row"><input type="checkbox" checked={backupConfirmed} onChange={(event) => setBackupConfirmed(event.target.checked)} /> I verified that I saved the backup file. I understand noteOS cannot verify or guarantee that copy.</label></>}<div className="dialog-actions"><button className="btn" onClick={() => { setPending(null); setBackupRequested(false); setBackupConfirmed(false); }}>Cancel</button><button className="btn btn-danger" disabled={!backupRequested || !backupConfirmed} onClick={() => void deleteForever()}>Delete forever</button></div></section></div>}
  </>;
}
