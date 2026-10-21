'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createNotesRepository, NoteConflictError } from '../../lib/local-notes.js';
import { formatSavedAt } from '../../lib/mvp-utils.mjs';
import { canonicalToMarkdown, createTiptapEditor, validateCanonicalDocument } from '../../../packages/document-engine/src/index.js';

const JOURNAL_PREFIX = 'noteos:mvp01:recovery:';
type Note = { id: string; title: string; document: any; schemaVersion: number; createdAt: number; updatedAt: number; lifecycle: 'active' | 'archived' | 'trashed'; revision: number };
function clearJournal(id: string) { try { localStorage.removeItem(`${JOURNAL_PREFIX}${id}`); } catch { /* Recovery storage may be unavailable. */ } }

export default function NoteEditorPage() {
  const params = useParams<{ id: string }>(); const id = decodeURIComponent(params.id); const router = useRouter();
  const [note, setNote] = useState<Note | null>(null); const [title, setTitle] = useState(''); const [doc, setDoc] = useState<any>(null); const [state, setState] = useState('Loading…'); const [error, setError] = useState(''); const [conflict, setConflict] = useState(false); const [ready, setReady] = useState(false); const [recovery, setRecovery] = useState<any>(null); const [markdown, setMarkdown] = useState<any>(null);
  const elementRef = useRef<HTMLDivElement>(null); const editorRef = useRef<any>(null); const timerRef = useRef<any>(null); const latestRef = useRef({ title: '', doc: null as any }); const repo = createNotesRepository();
  const noteRef = useRef<Note | null>(null);
  const validation = doc ? validateCanonicalDocument(doc) : null; const editable = validation?.status === 'supported' && note?.lifecycle !== 'trashed';

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        let loaded = await repo.get(id);
        if (!loaded) { loaded = await repo.create({ id, title: 'Untitled note', document: { schemaVersion: 1, type: 'doc', content: [] }, schemaVersion: 1, createdAt: Date.now(), updatedAt: Date.now(), lifecycle: 'active', revision: 0 }); }
        if (!alive) return;
        noteRef.current = loaded; setNote(loaded); setTitle(loaded.title); setDoc(loaded.document); latestRef.current = { title: loaded.title, doc: loaded.document };
        try {
          const journal = localStorage.getItem(`${JOURNAL_PREFIX}${id}`);
          if (journal) { const draft = JSON.parse(journal); if (draft.updatedAt > loaded.updatedAt) setRecovery({ ...draft, sameRevision: draft.baseRevision === loaded.revision }); else localStorage.removeItem(`${JOURNAL_PREFIX}${id}`); }
        } catch { /* Invalid recovery data is ignored; the IndexedDB copy remains authoritative. */ }
        setState(`Saved ${formatSavedAt(loaded.updatedAt)}`); setReady(true);
      } catch (e) { setError(e instanceof Error ? e.message : 'Could not open this note.'); setReady(true); }
    })();
    return () => { alive = false; clearTimeout(timerRef.current); editorRef.current?.destroy?.(); editorRef.current = null; elementRef.current?.replaceChildren(); };
  }, [id]);

  useEffect(() => {
    if (!ready || !doc || !elementRef.current || !editable) return;
    try {
      editorRef.current = createTiptapEditor({ element: elementRef.current, document: doc, onUpdate: (next: any) => { latestRef.current = { ...latestRef.current, doc: next }; setDoc(next); scheduleSave(); } });
      editorRef.current?.view?.dom?.setAttribute('aria-label', 'Note content');
    } catch (e) { setError(e instanceof Error ? e.message : 'The editor could not open this note safely.'); }
    return () => { editorRef.current?.destroy?.(); editorRef.current = null; elementRef.current?.replaceChildren(); };
  // The editor is created once per loaded document. Content changes are sent through onUpdate.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, Boolean(note), editable]);

  const saveLatest = useCallback(async () => {
    const current = noteRef.current;
    if (!current || !editable) return;
    const draft = latestRef.current;
    const journalKey = `${JOURNAL_PREFIX}${id}`;
    const journal = { title: draft.title, document: draft.doc, baseRevision: current.revision, updatedAt: Date.now() };
    try { localStorage.setItem(journalKey, JSON.stringify(journal)); } catch { /* Storage can be disabled or full; the in-memory draft is retained. */ }
    setState('Saving…'); setError('');
    try {
      const saved = await repo.save(id, { title: draft.title, document: draft.doc }, current.revision);
      noteRef.current = saved; setNote(saved); setConflict(false); clearJournal(id); setState(`Saved ${formatSavedAt(saved.updatedAt)}`);
    } catch (e) {
      if (e instanceof NoteConflictError) { setConflict(true); setError('This note changed in another tab. Your draft remains on this screen and in recovery storage.'); }
      else setError('Could not save locally. Your current draft remains open; browser recovery is best effort.');
      setState('Not saved');
    }
  }, [id, editable]);

  const scheduleSave = useCallback(() => {
    clearTimeout(timerRef.current); setState('Unsaved changes');
    const current = noteRef.current;
    if (current) {
      const draft = latestRef.current;
      try { localStorage.setItem(`${JOURNAL_PREFIX}${id}`, JSON.stringify({ title: draft.title, document: draft.doc, baseRevision: current.revision, updatedAt: Date.now() })); }
      catch { /* IndexedDB remains primary; the journal is a best-effort recovery copy. */ }
    }
    timerRef.current = setTimeout(() => { void saveLatest(); }, 650);
  }, [id, saveLatest]);

  function updateTitle(value: string) { setTitle(value); latestRef.current = { ...latestRef.current, title: value }; scheduleSave(); }
  async function saveDraftAsCopy() {
    try { const draft = latestRef.current; const copy = { id: crypto.randomUUID(), title: `${draft.title || 'Untitled note'} (copy)`, document: draft.doc, schemaVersion: 1, createdAt: Date.now(), updatedAt: Date.now(), lifecycle: 'active', revision: 0 }; await repo.create(copy); clearJournal(id); router.replace(`/notes/${copy.id}`); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save this draft as a new note.'); }
  }
  async function useRecovery(asCopy: boolean) {
    if (!recovery) return;
    try {
      if (asCopy) {
        const copy = { id: crypto.randomUUID(), title: `${recovery.title || 'Untitled note'} (recovered)`, document: recovery.document, schemaVersion: 1, createdAt: Date.now(), updatedAt: Date.now(), lifecycle: 'active', revision: 0 };
        await repo.create(copy); clearJournal(id); router.replace(`/notes/${copy.id}`); return;
      }
      setTitle(recovery.title); setDoc(recovery.document); latestRef.current = { title: recovery.title, doc: recovery.document }; setRecovery(null); scheduleSave();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not recover this draft.'); }
    setRecovery(null);
  }

  async function changeLifecycle(next: 'active' | 'archived' | 'trashed') {
    if (!note) return; try { await saveLatest(); const current = await repo.get(id); if (current) await repo.setLifecycle(id, next, current.revision); router.push(next === 'archived' ? '/archive' : next === 'trashed' ? '/trash' : '/'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not update this note.'); }
  }
  function exportMarkdown() { if (!doc || validation?.status !== 'supported') return; setMarkdown(canonicalToMarkdown(doc)); }

  if (!ready) return <div className="empty-state"><h2>Opening note…</h2><p>Reading from this device.</p></div>;
  if (error && !note) return <div className="notice error" role="alert">{error}<p><Link href="/">Back to notes</Link></p></div>;
  return <>
    <div className="editor-top"><Link href={note?.lifecycle === 'archived' ? '/archive' : note?.lifecycle === 'trashed' ? '/trash' : '/'} className="back-link">← Back to notes</Link><div className="actions"><span className="save-state" aria-live="polite">{state}</span>{note?.lifecycle === 'active' ? <button className="btn" onClick={() => void changeLifecycle('archived')}>Archive</button> : note?.lifecycle === 'archived' ? <button className="btn" onClick={() => void changeLifecycle('active')}>Restore</button> : <button className="btn" onClick={() => void changeLifecycle('active')}>Restore</button>}<button className="btn" onClick={() => void changeLifecycle('trashed')}>Move to trash</button><button className="btn" onClick={exportMarkdown} disabled={!editable}>Export Markdown</button></div></div>
    {error && <div className="notice error" role="alert">{error}{conflict && <p><button className="btn" onClick={() => void saveDraftAsCopy()}>Save this draft as a new note</button></p>}</div>}
    {note?.lifecycle !== 'active' && <div className="notice">This note is in {note?.lifecycle}. Restore it before editing.</div>}
    <label className="screen-reader" htmlFor="note-title">Note title</label><input id="note-title" className="editor-title" value={title} onChange={(event) => updateTitle(event.target.value)} disabled={!editable} placeholder="Untitled note" />
    {validation?.status === 'supported' && note?.lifecycle === 'trashed' && <div className="notice">Restore this note to edit it. Its content is preserved below.</div>}
    {validation?.status === 'supported' && editable ? <><div className="editor-toolbar" aria-label="Text formatting">
      <button className="tool-button" aria-label="Bold" title="Bold" onClick={() => editorRef.current?.chain().focus().toggleBold().run()}><strong>B</strong></button><button className="tool-button" aria-label="Italic" title="Italic" onClick={() => editorRef.current?.chain().focus().toggleItalic().run()}><em>I</em></button><button className="tool-button" aria-label="Strike" title="Strike" onClick={() => editorRef.current?.chain().focus().toggleStrike().run()}><s>S</s></button><button className="tool-button" aria-label="Heading 2" title="Heading" onClick={() => editorRef.current?.chain().focus().toggleHeading({ level: 2 }).run()}>H₂</button><button className="tool-button" aria-label="Bullet list" title="Bullet list" onClick={() => editorRef.current?.chain().focus().toggleBulletList().run()}>• List</button><button className="tool-button" aria-label="Ordered list" title="Numbered list" onClick={() => editorRef.current?.chain().focus().toggleOrderedList().run()}>1. List</button><button className="tool-button" aria-label="Checklist" title="Checklist" onClick={() => editorRef.current?.chain().focus().toggleTaskList().run()}>☑</button><button className="tool-button" aria-label="Quote" title="Quote" onClick={() => editorRef.current?.chain().focus().toggleBlockquote().run()}>“</button><button className="tool-button" aria-label="Code block" title="Code block" onClick={() => editorRef.current?.chain().focus().toggleCodeBlock().run()}>&lt;/&gt;</button>
    </div><div ref={elementRef} className="editor-content" aria-label="Note content" /></>
      : <section>{validation?.status !== 'supported' && <div className="notice">This document uses a schema this editor cannot safely modify. It is open read-only so its original data stays intact.</div>}<pre className="readonly-panel">{JSON.stringify(doc, null, 2)}</pre></section>}
    {markdown && <div className="backup-panel"><h2 className="section-title">Markdown export</h2>{markdown.warnings.length > 0 && <div className="notice">Some formatting is simplified in Markdown: {markdown.warnings.map((warning: any) => warning.message).join(' ')}</div>}<textarea className="searchbox" aria-label="Markdown output" readOnly value={markdown.markdown ?? ''} rows={12} /><button className="btn" onClick={() => { const blob = new Blob([markdown.markdown ?? ''], { type: 'text/markdown' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `${title || 'note'}.md`; a.click(); URL.revokeObjectURL(url); }}>Download .md</button></div>}
    {recovery && <div className="dialog-backdrop"><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="recovery-title"><h2 id="recovery-title">A recovery draft was found</h2><p>{recovery.sameRevision ? 'This draft is newer than the saved note on this device.' : 'The saved note has changed since this draft was made. To avoid overwriting either version, recover the draft as a separate note.'}</p><div className="dialog-actions"><button className="btn" onClick={() => { clearJournal(id); setRecovery(null); }}>Keep saved version</button><button className="btn btn-primary" onClick={() => void useRecovery(!recovery.sameRevision)}>{recovery.sameRevision ? 'Restore draft' : 'Recover as new note'}</button></div></section></div>}
  </>;
}
