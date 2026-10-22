'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createNotesRepository, makeEmptyNote } from './lib/local-notes.js';
import { filterNotes, filterNotesByTags, sortNotes } from './lib/mvp-utils.mjs';
import { tagKey } from './lib/note-organization.mjs';
import { captureSnapshotIsCurrent, commitQuickCaptureSnapshot, makeQuickCaptureNote, normalizeQuickCaptureInput, QuickCaptureSaveGate } from './lib/quick-capture.mjs';

type SortMode = 'updated' | 'created' | 'title';
const HOME_PREFERENCES_KEY = 'noteos:mvp03:home-preferences';
const QUICK_CAPTURE_KEY = 'noteos:mvp05:quick-capture';

function textOf(document: any) {
  const text: string[] = [];
  const walk = (node: any) => { if (node?.type === 'text') text.push(node.text); else if (node?.type === 'hardBreak') text.push(' '); (node?.content ?? []).forEach(walk); };
  walk(document);
  return text.join(' ').replace(/\s+/g, ' ').trim();
}

function preferencesFromStorage() {
  try {
    const value = JSON.parse(localStorage.getItem(HOME_PREFERENCES_KEY) ?? '{}');
    return {
      query: typeof value.query === 'string' ? value.query : '',
      sort: ['updated', 'created', 'title'].includes(value.sort) ? value.sort as SortMode : 'updated',
      tags: Array.isArray(value.tags) ? value.tags.filter((tag: unknown) => typeof tag === 'string') : [],
    };
  } catch { return { query: '', sort: 'updated' as SortMode, tags: [] as string[] }; }
}

export default function Home() {
  const [notes, setNotes] = useState<any[]>([]);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortMode>('updated');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [busyPinIds, setBusyPinIds] = useState<string[]>([]);
  const busyPinIdsRef = useRef(new Set<string>());
  const [captureText, setCaptureText] = useState('');
  const [captureStatus, setCaptureStatus] = useState('');
  const [captureBusy, setCaptureBusy] = useState(false);
  const captureTextRef = useRef('');
  const captureSequenceRef = useRef(0);
  const captureNoteRef = useRef<any>(null);
  const captureGate = useRef(new QuickCaptureSaveGate());

  const refresh = useCallback(async (clearError = true) => {
    try { setNotes(await createNotesRepository().list()); if (clearError) setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not open local notes.'); }
    finally { setReady(true); }
  }, []);

  useEffect(() => {
    const preferences = preferencesFromStorage();
    setQuery(preferences.query); setSort(preferences.sort); setSelectedTags(preferences.tags); setPreferencesReady(true);
    try {
      const savedCapture = JSON.parse(localStorage.getItem(QUICK_CAPTURE_KEY) ?? 'null');
      if (savedCapture && typeof savedCapture.body === 'string' && Number.isSafeInteger(savedCapture.sequence) && savedCapture.sequence >= 0) {
        captureTextRef.current = savedCapture.body; setCaptureText(savedCapture.body);
        captureSequenceRef.current = savedCapture.sequence;
        captureNoteRef.current = savedCapture.note && typeof savedCapture.note.id === 'string' ? savedCapture.note : null;
      }
    } catch { setCaptureStatus('The previous unsaved capture could not be read. Its text may still be available in browser storage.'); }
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!preferencesReady) return;
    try { localStorage.setItem(HOME_PREFERENCES_KEY, JSON.stringify({ query, sort, tags: selectedTags })); }
    catch { /* Preferences are best effort; current-session controls remain usable. */ }
  }, [preferencesReady, query, sort, selectedTags]);

  const availableTags = useMemo(() => {
    const labels = new Map<string, string>();
    for (const note of notes.filter((row) => row.lifecycle === 'active')) {
      for (const tag of Array.isArray(note.tags) ? note.tags : []) if (!labels.has(tagKey(tag))) labels.set(tagKey(tag), tag);
    }
    return [...labels.values()].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
  }, [notes]);

  const visibleNotes = useMemo(() => {
    const matched = filterNotes(notes, query, 'active');
    return sortNotes(filterNotesByTags(matched, selectedTags), sort);
  }, [notes, query, selectedTags, sort]);

  async function createNote() {
    try { const note = await createNotesRepository().create(makeEmptyNote()); location.assign(`/notes/${encodeURIComponent(note.id)}`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create a note.'); }
  }

  function updateCapture(value: string) {
    captureTextRef.current = value; captureSequenceRef.current += 1; captureNoteRef.current = null; setCaptureText(value);
    setCaptureStatus('');
    try {
      if (value) localStorage.setItem(QUICK_CAPTURE_KEY, JSON.stringify({ body: value, sequence: captureSequenceRef.current, note: null }));
      else localStorage.removeItem(QUICK_CAPTURE_KEY);
    } catch { setCaptureStatus('This browser could not save a recovery copy. Keep this page open until the note is saved.'); }
  }

  async function saveQuickCapture() {
    if (!captureGate.current.begin()) return;
    const original = captureTextRef.current;
    const body = normalizeQuickCaptureInput(original);
    if (!body) { captureStatus && setCaptureStatus(''); captureGate.current.finish(); return; }
    const sequence = captureSequenceRef.current;
    const note = captureNoteRef.current ?? makeQuickCaptureNote(body);
    captureNoteRef.current = note;
    setCaptureBusy(true); setCaptureStatus('Saving on this device…');
    try {
      const outcome = await commitQuickCaptureSnapshot({
        snapshot: { text: original, sequence, note },
        persist: async (snapshot: { text: string; sequence: number; note: any }) => { localStorage.setItem(QUICK_CAPTURE_KEY, JSON.stringify({ body: snapshot.text, sequence: snapshot.sequence, note: snapshot.note })); },
        commit: async (snapshot: { text: string; sequence: number; note: any }) => createNotesRepository().createIfMissing(snapshot.note),
        clear: async (snapshot: { text: string; sequence: number; note: any }) => {
          const stored = JSON.parse(localStorage.getItem(QUICK_CAPTURE_KEY) ?? 'null');
          if (stored?.sequence === snapshot.sequence && stored?.note?.id === snapshot.note.id) localStorage.removeItem(QUICK_CAPTURE_KEY);
        },
        isCurrent: (snapshot: { text: string; sequence: number; note: any }) => captureSnapshotIsCurrent(captureTextRef.current, captureSequenceRef.current, snapshot),
      });
      setNotes((current) => [outcome.note, ...current.filter((item) => item.id !== outcome.note.id)]);
      if (captureSnapshotIsCurrent(captureTextRef.current, captureSequenceRef.current, { text: original, sequence })) {
        captureTextRef.current = ''; captureNoteRef.current = null; setCaptureText('');
      }
      setError(''); setCaptureStatus('Saved on this device. Ready for another thought.');
    } catch (cause) {
      setCaptureStatus(cause instanceof Error ? `Could not save. Your text is still here. Retry when ready. ${cause.message}` : 'Could not save. Your text is still here. Retry when ready.');
    } finally { captureGate.current.finish(); setCaptureBusy(false); }
  }

  async function togglePin(note: any) {
    if (busyPinIdsRef.current.has(note.id)) return;
    busyPinIdsRef.current.add(note.id);
    setBusyPinIds((current) => [...current, note.id]);
    try {
      const updated = await createNotesRepository().updateOrganization(note.id, { pinned: !note.pinned }, note.revision);
      setNotes((current) => current.map((row) => row.id === updated.id ? updated : row)); setError('');
    } catch (cause) {
      await refresh(false);
      setError(cause instanceof Error ? cause.message : 'Could not update this note. Refresh and try again.');
    } finally { busyPinIdsRef.current.delete(note.id); setBusyPinIds((current) => current.filter((id) => id !== note.id)); }
  }

  function toggleTag(tag: string) {
    const key = tagKey(tag);
    setSelectedTags((current) => current.some((item) => tagKey(item) === key)
      ? current.filter((item) => tagKey(item) !== key)
      : [...current, tag]);
  }

  const hasFilters = Boolean(query || selectedTags.length);
  return <>
    <div className={`page-heading home-heading ${notes.some((note) => note.lifecycle === 'active') ? 'home-has-notes' : ''}`}><div className="home-intro"><p className="eyebrow">A quiet place to think</p><h1 className="page-title">Your notes</h1><p className="page-lede">A little space for what you want to remember.</p></div><div className="actions"><button className="btn btn-quiet new-note-button" onClick={createNote}>Open full editor</button></div></div>
    {error && <div className="notice error" role="alert">{error} Your notes stay stored locally.</div>}
    <form className="quick-capture" aria-label="Quick Capture" onSubmit={(event) => { event.preventDefault(); void saveQuickCapture(); }}>
      <label className="screen-reader" htmlFor="quick-capture-input">What's on your mind?</label>
      <textarea id="quick-capture-input" className="quick-capture-input" placeholder="What's on your mind?" value={captureText} onChange={(event) => updateCapture(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void saveQuickCapture(); } }} rows={3} />
      <div className="quick-capture-footer"><span className="quick-capture-hint">A thought is enough. You can shape it later.</span><button className="btn btn-primary quick-capture-save" type="submit" disabled={captureBusy || !normalizeQuickCaptureInput(captureText)}>{captureBusy ? 'Saving…' : 'Save note'}</button></div>
      <div className={`quick-capture-status ${captureStatus.startsWith('Could not') ? 'is-error' : ''}`} role="status" aria-live="polite">{captureStatus}</div>
    </form>
    <div className="notes-controls">
      <div className="search-row"><label className="screen-reader" htmlFor="note-search">Search notes</label><input id="note-search" className="searchbox" type="search" placeholder="Search titles, notes and tags…" value={query} onChange={(event) => setQuery(event.target.value)} /><span className="toolbar-label">{visibleNotes.length} {visibleNotes.length === 1 ? 'note' : 'notes'}</span></div>
      <label className="sort-control"><span>Sort</span><select aria-label="Sort notes" value={sort} onChange={(event) => setSort(event.target.value as SortMode)}><option value="updated">Recently updated</option><option value="created">Recently created</option><option value="title">Title A–Z</option></select></label>
    </div>
    {availableTags.length > 0 && <div className="tag-filter-row" aria-label="Filter notes by tag"><span className="toolbar-label">Tags</span>{availableTags.map((tag) => <button key={tagKey(tag)} type="button" className={`tag-chip tag-filter ${selectedTags.some((item) => tagKey(item) === tagKey(tag)) ? 'is-selected' : ''}`} aria-pressed={selectedTags.some((item) => tagKey(item) === tagKey(tag))} onClick={() => toggleTag(tag)}>{tag}</button>)}{selectedTags.length > 0 && <button className="text-button" onClick={() => setSelectedTags([])}>Clear tags</button>}</div>}
    {visibleNotes.length ? <section className="notes-grid" aria-label="Active notes">{visibleNotes.map((note: any) => <article className="note-card" key={note.id}>
      <div className="note-card-top"><span className="note-pin-state">{note.pinned ? 'Pinned' : ''}</span>{note.schemaVersion === 1 && <button className="pin-button" type="button" disabled={busyPinIds.includes(note.id)} aria-label={note.pinned ? `Unpin ${note.title || 'Untitled note'}` : `Pin ${note.title || 'Untitled note'}`} aria-pressed={Boolean(note.pinned)} onClick={() => void togglePin(note)}>{note.pinned ? '★ Pinned' : '☆ Pin'}</button>}</div>
      <Link className="note-card-link" href={`/notes/${encodeURIComponent(note.id)}`}><h2>{note.title || 'Untitled note'}</h2><p className="note-preview">{textOf(note.document) || 'Start with a thought…'}</p><span className="note-open-label">Open note ↗</span></Link>
      {Array.isArray(note.tags) && note.tags.length > 0 && <div className="note-card-tags" aria-label={`Tags for ${note.title || 'Untitled note'}`}>{note.tags.map((tag: string) => <button key={tagKey(tag)} type="button" className="tag-chip" aria-label={`Filter by ${tag}`} onClick={() => toggleTag(tag)}>{tag}</button>)}</div>}
      <div className="note-meta"><span>{new Date(note.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span><span>{note.pinned ? 'Pinned first' : 'On this device'}</span></div>
    </article>)}</section>
      : <div className="empty-state"><h2>{ready ? (hasFilters ? 'No notes match these filters' : 'A fresh page') : 'Opening your notes…'}</h2><p>{ready ? (hasFilters ? 'Clear a tag or try another search to see more notes.' : 'Create a note to get your thoughts started.') : 'Everything is stored on this device.'}</p>{ready && hasFilters && <button className="btn" onClick={() => { setQuery(''); setSelectedTags([]); }}>Clear search and filters</button>}{ready && !hasFilters && <button className="btn btn-primary" onClick={createNote}>Create your first note</button>}</div>}
  </>;
}
