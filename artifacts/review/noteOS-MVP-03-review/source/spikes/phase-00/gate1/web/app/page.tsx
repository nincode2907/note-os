'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createNotesRepository, makeEmptyNote } from './lib/local-notes.js';
import { filterNotes, filterNotesByTags, sortNotes } from './lib/mvp-utils.mjs';
import { tagKey } from './lib/note-organization.mjs';

type SortMode = 'updated' | 'created' | 'title';
const HOME_PREFERENCES_KEY = 'noteos:mvp03:home-preferences';

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

  const refresh = useCallback(async (clearError = true) => {
    try { setNotes(await createNotesRepository().list()); if (clearError) setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not open local notes.'); }
    finally { setReady(true); }
  }, []);

  useEffect(() => {
    const preferences = preferencesFromStorage();
    setQuery(preferences.query); setSort(preferences.sort); setSelectedTags(preferences.tags); setPreferencesReady(true);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!preferencesReady) return;
    localStorage.setItem(HOME_PREFERENCES_KEY, JSON.stringify({ query, sort, tags: selectedTags }));
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

  async function togglePin(note: any) {
    try {
      const updated = await createNotesRepository().updateOrganization(note.id, { pinned: !note.pinned }, note.revision);
      setNotes((current) => current.map((row) => row.id === updated.id ? updated : row)); setError('');
    } catch (cause) {
      await refresh(false);
      setError(cause instanceof Error ? cause.message : 'Could not update this note. Refresh and try again.');
    }
  }

  function toggleTag(tag: string) {
    const key = tagKey(tag);
    setSelectedTags((current) => current.some((item) => tagKey(item) === key)
      ? current.filter((item) => tagKey(item) !== key)
      : [...current, tag]);
  }

  const hasFilters = Boolean(query || selectedTags.length);
  return <>
    <div className="page-heading"><div><p className="eyebrow">A quiet place to think</p><h1 className="page-title">Your notes</h1><p className="page-lede">A little space for what you want to remember.</p></div><div className="actions"><button className="btn btn-primary" onClick={createNote}>＋ New note</button></div></div>
    {error && <div className="notice error" role="alert">{error} Your notes stay stored locally.</div>}
    <div className="notes-controls">
      <div className="search-row"><label className="screen-reader" htmlFor="note-search">Search notes</label><input id="note-search" className="searchbox" type="search" placeholder="Search titles, notes and tags…" value={query} onChange={(event) => setQuery(event.target.value)} /><span className="toolbar-label">{visibleNotes.length} {visibleNotes.length === 1 ? 'note' : 'notes'}</span></div>
      <label className="sort-control"><span>Sort</span><select aria-label="Sort notes" value={sort} onChange={(event) => setSort(event.target.value as SortMode)}><option value="updated">Recently updated</option><option value="created">Recently created</option><option value="title">Title A–Z</option></select></label>
    </div>
    {availableTags.length > 0 && <div className="tag-filter-row" aria-label="Filter notes by tag"><span className="toolbar-label">Tags</span>{availableTags.map((tag) => <button key={tagKey(tag)} type="button" className={`tag-chip tag-filter ${selectedTags.some((item) => tagKey(item) === tagKey(tag)) ? 'is-selected' : ''}`} aria-pressed={selectedTags.some((item) => tagKey(item) === tagKey(tag))} onClick={() => toggleTag(tag)}>{tag}</button>)}{selectedTags.length > 0 && <button className="text-button" onClick={() => setSelectedTags([])}>Clear tags</button>}</div>}
    {visibleNotes.length ? <section className="notes-grid" aria-label="Active notes">{visibleNotes.map((note: any) => <article className="note-card" key={note.id}>
      <div className="note-card-top"><span className="note-pin-state">{note.pinned ? 'Pinned' : ''}</span>{note.schemaVersion === 1 && <button className="pin-button" type="button" aria-label={note.pinned ? `Unpin ${note.title || 'Untitled note'}` : `Pin ${note.title || 'Untitled note'}`} aria-pressed={Boolean(note.pinned)} onClick={() => void togglePin(note)}>{note.pinned ? '★ Pinned' : '☆ Pin'}</button>}</div>
      <Link className="note-card-link" href={`/notes/${encodeURIComponent(note.id)}`}><h2>{note.title || 'Untitled note'}</h2><p className="note-preview">{textOf(note.document) || 'Start with a thought…'}</p><span className="note-open-label">Open note ↗</span></Link>
      {Array.isArray(note.tags) && note.tags.length > 0 && <div className="note-card-tags" aria-label={`Tags for ${note.title || 'Untitled note'}`}>{note.tags.map((tag: string) => <button key={tagKey(tag)} type="button" className="tag-chip" aria-label={`Filter by ${tag}`} onClick={() => toggleTag(tag)}>{tag}</button>)}</div>}
      <div className="note-meta"><span>{new Date(note.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span><span>{note.pinned ? 'Pinned first' : 'On this device'}</span></div>
    </article>)}</section>
      : <div className="empty-state"><h2>{ready ? (hasFilters ? 'No notes match these filters' : 'A fresh page') : 'Opening your notes…'}</h2><p>{ready ? (hasFilters ? 'Clear a tag or try another search to see more notes.' : 'Create a note to get your thoughts started.') : 'Everything is stored on this device.'}</p>{ready && hasFilters && <button className="btn" onClick={() => { setQuery(''); setSelectedTags([]); }}>Clear search and filters</button>}{ready && !hasFilters && <button className="btn btn-primary" onClick={createNote}>Create your first note</button>}</div>}
  </>;
}
