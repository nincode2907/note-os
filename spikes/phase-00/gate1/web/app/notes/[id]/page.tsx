'use client';

import { GuardedLink as Link, useNavigationGuard } from '../../ui/navigation-guard';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createNotesRepository, NoteConflictError } from '../../lib/local-notes.js';
import { createSaveCoordinator } from '../../lib/save-coordinator.mjs';
import { createRecoveryJournal, recoveryCandidates, clearRecoveryEntry, recoveryStorage } from '../../lib/recovery-journal.mjs';
import { formatSavedAt } from '../../lib/mvp-utils.mjs';
import { canonicalToMarkdown, createTiptapEditor, validateCanonicalDocument, toTiptapJSON } from '../../../packages/document-engine/src/index.js';

type Note = { id: string; title: string; document: any; schemaVersion: number; createdAt: number; updatedAt: number; lifecycle: 'active' | 'archived' | 'trashed'; revision: number };

export default function NoteEditorPage() {
  const params = useParams<{ id: string }>(); const id = params.id; const router = useRouter();
  const [note, setNote] = useState<Note | null>(null), [title, setTitle] = useState(''), [doc, setDoc] = useState<any>(null);
  const [state, setState] = useState('Loading…'), [error, setError] = useState(''), [conflict, setConflict] = useState(false), [ready, setReady] = useState(false);
  const [recovery, setRecovery] = useState<any>(null), [markdown, setMarkdown] = useState<any>(null), [busy, setBusy] = useState(false);
  const elementRef = useRef<HTMLDivElement>(null), editorRef = useRef<any>(null), timerRef = useRef<any>(null), coordinatorRef = useRef<any>(null);
  const operationRef = useRef(false), recoveryRef = useRef<any>(null), aliveRef = useRef(false);
  const validation = doc ? validateCanonicalDocument(doc) : null;
  const editable = validation?.status === 'supported' && note?.lifecycle === 'active';
  const editableRef = useRef(false); editableRef.current = editable;
  const selectRecovery = (next: any) => { recoveryRef.current = next; setRecovery(next); };

  function showFailure(cause: any) {
    const stale = cause instanceof NoteConflictError || cause?.name === 'NoteConflictError';
    setConflict(stale);
    setError(stale ? 'This note changed in another tab. Your draft is kept here. Save it as a new note before leaving.' : 'Could not save locally. Stay here and retry, or save your draft as a new note. Browser recovery is best effort.');
  }

  useEffect(() => {
    let alive = true; aliveRef.current = true;
    setReady(false);
    const repo = createNotesRepository();
    void (async () => {
      try {
        const loaded = await repo.get(id);
        if (!loaded) throw new Error('This note no longer exists. Return to Notes or import a backup.');
        if (!alive) return;
        const coordinator = createSaveCoordinator({ note: loaded, repository: repo, journal: createRecoveryJournal(recoveryStorage(), loaded), onChange: (snapshot: any) => {
          if (!alive) return;
          setNote(snapshot.note);
          setState(snapshot.error ? 'Not saved' : snapshot.inFlight ? 'Saving…' : snapshot.dirty ? 'Unsaved changes' : `Saved ${formatSavedAt(snapshot.note.updatedAt)}`);
          if (snapshot.error) showFailure(snapshot.error); else { setError(''); setConflict(false); }
        } });
        coordinatorRef.current = coordinator;
        setNote(loaded); setTitle(loaded.title); setDoc(loaded.document);
        selectRecovery(recoveryCandidates(recoveryStorage(), loaded)[0] ?? null);
        setState(`Saved ${formatSavedAt(loaded.updatedAt)}`); setReady(true);
      } catch (cause) { if (alive) { setError(cause instanceof Error ? cause.message : 'Could not open this note.'); setReady(true); } }
    })();
    const beforeUnload = (event: BeforeUnloadEvent) => { const snapshot = coordinatorRef.current?.snapshot(); if (snapshot?.dirty || snapshot?.inFlight) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { alive = false; aliveRef.current = false; clearTimeout(timerRef.current); window.removeEventListener('beforeunload', beforeUnload); editorRef.current?.destroy?.(); editorRef.current = null; coordinatorRef.current = null; };
  }, [id]);

  function scheduleSave() {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => { const result = await coordinatorRef.current?.flush(); if (result?.pending && aliveRef.current) scheduleSave(); }, 650);
  }
  function changeDraft(next: any) {
    if (operationRef.current || recoveryRef.current) return;
    coordinatorRef.current?.edit(next); scheduleSave();
  }
  useEffect(() => {
    if (!ready || !doc || !elementRef.current || !editable) return;
    try {
      editorRef.current = createTiptapEditor({ element: elementRef.current, document: doc, onUpdate: (next: any) => {
        if (operationRef.current || recoveryRef.current) return;
        setDoc(next); changeDraft({ ...coordinatorRef.current.snapshot().draft, document: next });
      } });
      editorRef.current.view.dom.setAttribute('aria-label', 'Note content');
      editorRef.current.setEditable(!operationRef.current && !recoveryRef.current);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not open editor safely.'); }
    return () => { editorRef.current?.destroy?.(); editorRef.current = null; elementRef.current?.replaceChildren(); };
  // Content updates use the mounted instance; recovery calls setContent explicitly.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, editable, id]);

  async function operation(action: () => Promise<boolean>) {
    if (operationRef.current) return false;
    operationRef.current = true; setBusy(true); editorRef.current?.setEditable(false); clearTimeout(timerRef.current);
    try { return await action(); }
    catch (cause) { showFailure(cause); return false; }
    finally { operationRef.current = false; if (aliveRef.current) { setBusy(false); editorRef.current?.setEditable(editableRef.current && !recoveryRef.current); } }
  }
  const flushBeforeNavigation = useCallback(async () => {
    if (recoveryRef.current) { setError('Choose how to handle the recovery draft before leaving.'); return false; }
    return operation(async () => { const result = await coordinatorRef.current?.flush(); return result?.ok ?? true; });
  // Refs contain the current note operation and draft, independent of render timing.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useNavigationGuard(flushBeforeNavigation);

  function updateTitle(value: string) {
    if (operationRef.current || recoveryRef.current) return;
    setTitle(value); changeDraft({ ...coordinatorRef.current.snapshot().draft, title: value });
  }
  async function saveDraftAsCopy() {
    await operation(async () => {
      const coordinator = coordinatorRef.current;
      await coordinator.flush();
      // A failed flush keeps the original safe; a separate ID preserves this draft.
      const draft = coordinator.snapshot().draft;
      const copy = { ...coordinator.snapshot().note, id: crypto.randomUUID(), title: `${draft.title || 'Untitled note'} (copy)`, document: draft.document, schemaVersion: draft.document.schemaVersion, createdAt: Date.now(), updatedAt: Date.now(), lifecycle: 'active', revision: 0 };
      await createNotesRepository().create(copy); coordinator.clearJournal(); router.replace(`/notes/${copy.id}`); return true;
    });
  }
  async function useRecovery(asCopy: boolean) {
    const candidate = recoveryRef.current;
    if (!candidate) return;
    await operation(async () => {
      const converted = toTiptapJSON(candidate.document);
      if (!candidate.valid || converted.status !== 'ready' || !converted.json) { setError('Recovery document is not safe to edit. Its journal has been retained.'); return false; }
      if (asCopy) {
        const now = Date.now();
        const copy = { id: crypto.randomUUID(), title: `${candidate.title || 'Untitled note'} (recovered)`, document: candidate.document, schemaVersion: candidate.document.schemaVersion, createdAt: now, updatedAt: now, lifecycle: 'active', revision: 0 };
        await createNotesRepository().create(copy); coordinatorRef.current.clearJournal(); clearRecoveryEntry(recoveryStorage(), candidate); router.replace(`/notes/${copy.id}`); return true;
      }
      try {
        if (!editorRef.current || !editorRef.current.commands.setContent(converted.json, { emitUpdate: false, errorOnInvalidContent: true })) throw new Error('Recovery apply failed');
      } catch { setError('Could not safely apply the recovery draft. Its journal has been retained.'); return false; }
      setTitle(candidate.title); setDoc(candidate.document);
      coordinatorRef.current.edit({ title: candidate.title, document: candidate.document });
      const result = await coordinatorRef.current.flush();
      if (!result.ok) { if (result.error?.name === 'NoteConflictError') selectRecovery({ ...candidate, sameRevision: false }); return false; }
      clearRecoveryEntry(recoveryStorage(), candidate);
      selectRecovery(recoveryCandidates(recoveryStorage(), result.note)[0] ?? null); return true;
    });
  }
  async function discardRecovery() {
    await operation(async () => {
      const saved = coordinatorRef.current.snapshot().note;
      const converted = toTiptapJSON(saved.document);
      try {
        if (editorRef.current && converted.json && !editorRef.current.commands.setContent(converted.json, { emitUpdate: false, errorOnInvalidContent: true })) throw new Error('Could not reset editor');
      } catch { setError('Could not return to the saved content. The recovery journal has been retained.'); return false; }
      coordinatorRef.current.edit({ title: saved.title, document: saved.document }); setTitle(saved.title); setDoc(saved.document);
      clearRecoveryEntry(recoveryStorage(), recoveryRef.current);
      selectRecovery(recoveryCandidates(recoveryStorage(), saved)[0] ?? null); return true;
    });
  }
  async function changeLifecycle(next: 'active' | 'archived' | 'trashed') {
    if (recoveryRef.current) { setError('Handle the recovery draft before changing this note.'); return; }
    await operation(async () => {
      const result = await coordinatorRef.current.transition(next);
      if (!result.ok) return false;
      router.push(next === 'archived' ? '/archive' : next === 'trashed' ? '/trash' : '/'); return true;
    });
  }
  function exportMarkdown() { if (doc && validation?.status === 'supported') setMarkdown(canonicalToMarkdown(doc)); }

  if (!ready) return <div className="empty-state"><h2>Opening note…</h2><p>Reading from this device.</p></div>;
  if (error && !note) return <div className="notice error" role="alert">{error}<p><Link href="/">Back to notes</Link></p></div>;
  return <>
    <div className="editor-top"><Link href={note?.lifecycle === 'archived' ? '/archive' : note?.lifecycle === 'trashed' ? '/trash' : '/'} className="back-link">← Back to notes</Link><div className="actions"><span className="save-state" aria-live="polite">{state}</span>{note?.lifecycle === 'active' ? <button className="btn" disabled={busy} onClick={() => void changeLifecycle('archived')}>Archive</button> : note?.lifecycle === 'archived' ? <button className="btn" disabled={busy} onClick={() => void changeLifecycle('active')}>Restore</button> : <button className="btn" disabled={busy} onClick={() => void changeLifecycle('active')}>Restore</button>}<button className="btn" disabled={busy} onClick={() => void changeLifecycle('trashed')}>Move to trash</button><button className="btn" onClick={exportMarkdown} disabled={!editable || busy || Boolean(recovery)}>Export Markdown</button></div></div>
    {error && <div className="notice error" role="alert">{error}{editable && <p>{!conflict && <button className="btn" disabled={busy} onClick={() => void operation(async () => (await coordinatorRef.current.flush()).ok)}>Retry save</button>} <button className="btn" disabled={busy} onClick={() => void saveDraftAsCopy()}>Save this draft as a new note</button></p>}</div>}
    {note?.lifecycle !== 'active' && <div className="notice">This note is in {note?.lifecycle}. Restore it before editing.</div>}
    <label className="screen-reader" htmlFor="note-title">Note title</label><input id="note-title" className="editor-title" value={title} onChange={(event) => updateTitle(event.target.value)} disabled={!editable || busy || Boolean(recovery)} placeholder="Untitled note" />
    {validation?.status === 'supported' && note?.lifecycle === 'trashed' && <div className="notice">Restore this note to edit it. Its content is preserved below.</div>}
    {validation?.status === 'supported' && editable ? <><div className="editor-toolbar" aria-label="Text formatting">
      <button className="tool-button" aria-label="Bold" title="Bold" onClick={() => editorRef.current?.chain().focus().toggleBold().run()}><strong>B</strong></button><button className="tool-button" aria-label="Italic" title="Italic" onClick={() => editorRef.current?.chain().focus().toggleItalic().run()}><em>I</em></button><button className="tool-button" aria-label="Strike" title="Strike" onClick={() => editorRef.current?.chain().focus().toggleStrike().run()}><s>S</s></button><button className="tool-button" aria-label="Heading 2" title="Heading" onClick={() => editorRef.current?.chain().focus().toggleHeading({ level: 2 }).run()}>H₂</button><button className="tool-button" aria-label="Bullet list" title="Bullet list" onClick={() => editorRef.current?.chain().focus().toggleBulletList().run()}>• List</button><button className="tool-button" aria-label="Ordered list" title="Numbered list" onClick={() => editorRef.current?.chain().focus().toggleOrderedList().run()}>1. List</button><button className="tool-button" aria-label="Checklist" title="Checklist" onClick={() => editorRef.current?.chain().focus().toggleTaskList().run()}>☑</button><button className="tool-button" aria-label="Quote" title="Quote" onClick={() => editorRef.current?.chain().focus().toggleBlockquote().run()}>“</button><button className="tool-button" aria-label="Code block" title="Code block" onClick={() => editorRef.current?.chain().focus().toggleCodeBlock().run()}>&lt;/&gt;</button>
    </div><div ref={elementRef} className="editor-content" aria-label="Note content" /></>
      : <section>{validation?.status !== 'supported' && <div className="notice">This document uses a schema this editor cannot safely modify. It is open read-only so its original data stays intact.</div>}<pre className="readonly-panel">{JSON.stringify(doc, null, 2)}</pre></section>}
    {markdown && <div className="backup-panel"><h2 className="section-title">Markdown export</h2>{markdown.warnings.length > 0 && <div className="notice">Some formatting is simplified in Markdown: {markdown.warnings.map((warning: any) => warning.message).join(' ')}</div>}<textarea className="searchbox" aria-label="Markdown output" readOnly value={markdown.markdown ?? ''} rows={12} /><button className="btn" onClick={() => { const blob = new Blob([markdown.markdown ?? ''], { type: 'text/markdown' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `${title || 'note'}.md`; a.click(); URL.revokeObjectURL(url); }}>Download .md</button></div>}
    {recovery && <div className="dialog-backdrop"><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="recovery-title"><h2 id="recovery-title">A recovery draft was found</h2><p>{!recovery.valid ? 'This recovery document cannot be applied safely. Its original journal is retained until you explicitly discard it.' : recovery.sameRevision ? 'An uncommitted recovery draft was found for this note.' : 'The saved note has changed since this draft was made. To avoid overwriting either version, recover the draft as a separate note.'}</p>{error && <p role="alert">{error}</p>}<div className="dialog-actions"><button className="btn" disabled={busy} onClick={discardRecovery}>Keep saved version</button><button className="btn btn-primary" disabled={busy || !recovery.valid} onClick={() => void useRecovery(!recovery.sameRevision)}>{recovery.sameRevision ? 'Restore draft' : 'Recover as new note'}</button></div></section></div>}
  </>;
}
