'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createNotesRepository } from '../lib/local-notes.js';
import { discoverAi } from '../lib/ai-sync-client.mjs';
import { confidenceOf, deliverAiDecisions, fetchNoteSuggestions, itemApplicability, planApply, planUndo, previewItem, recordDecision, suggestionItems } from '../lib/ai-inbox.mjs';

type Note = { id: string; title: string; document: any; revision: number; lifecycle: string; tags?: string[]; privacy?: string };
type Item = { key: string; kind: string; value: string; quote: string | null; reason?: string; state: { decision: string; version: number } | null };
type Suggestion = { id: string; noteId: string; status: string; providerIdentity: string; createdAt: number; revisionChanged: boolean; payload: any; items: Record<string, any> };

const KIND_LABEL: Record<string, string> = { category: 'Category', summary: 'Summary', tag: 'Tag', task: 'Task', related: 'Related note' };
const STATUS_TEXT: Record<string, string> = {
  stale: 'The quoted text is no longer in this note.', duplicate: 'Already in this note.', applied: 'Applied', rejected: 'Rejected',
  note_inactive: 'Restore this note to apply suggestions.', related_note_missing: 'That note is not on this device.', tag_limit: 'This note already has 20 tags.',
};
const providerText = (identity: string) => identity === 'mock-v1' ? 'Synthetic test model' : identity.startsWith('gateway:') ? `Local model · ${identity.split(':').slice(2).join(':')}` : identity;

export function AiSuggestionsPanel({ note, canApply, applyTags, applyDocument }: {
  note: Note; canApply: boolean;
  applyTags: (tags: string[]) => Promise<Note | null>;
  applyDocument: (document: any) => Promise<Note | null>;
}) {
  const repository = useMemo(() => createNotesRepository(), []);
  const [available, setAvailable] = useState(false), [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [receipts, setReceipts] = useState<Record<string, any>>({}), [titles, setTitles] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<{ key: string; value: string } | null>(null);
  const [busyKey, setBusyKey] = useState(''), [message, setMessage] = useState(''), [offline, setOffline] = useState<false | 'offline' | 'busy'>(false);
  const busyRef = useRef(false), retryRef = useRef<any>(null);

  const refresh = useCallback(async () => {
    try { const status = await discoverAi(); if (!status.enabled) { setAvailable(false); return; } }
    catch { setAvailable(false); return; }
    try {
      await deliverAiDecisions({ repository });
      const rows: Suggestion[] = await fetchNoteSuggestions(note.id);
      setSuggestions(rows); setOffline(false); setAvailable(true);
      const relatedIds = rows.flatMap(row => (row.payload.relatedCandidates ?? []).map((item: any) => item.id));
      const found: Record<string, string> = {};
      for (const id of relatedIds) { const other = await repository.get(id); if (other && other.lifecycle === 'active') found[id] = other.title || 'Untitled note'; }
      setTitles(found);
    } catch (error: any) {
      if (error.status === 401) { setAvailable(false); return; }
      setOffline(error.status === 429 ? 'busy' : 'offline'); setAvailable(true);
      if (error.status === 429) { clearTimeout(retryRef.current); retryRef.current = setTimeout(() => { void refresh(); }, 20000); }
    }
    setReceipts(Object.fromEntries((await repository.listAiApplyReceipts(note.id)).map((row: any) => [row.id, row])));
  }, [note.id, repository]);

  useEffect(() => {
    void refresh();
    const online = () => { void refresh(); };
    window.addEventListener('online', online);
    return () => { window.removeEventListener('online', online); clearTimeout(retryRef.current); };
  }, [refresh]);

  async function act(key: string, action: () => Promise<string>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusyKey(key); setMessage('');
    try { setMessage(await action()); }
    catch (error: any) { setMessage(error?.code === 'note_changed' ? 'This note changed after the suggestion was applied, so it cannot be undone automatically.' : error?.message || 'The suggestion could not be applied.'); }
    finally { busyRef.current = false; setBusyKey(''); setEditing(null); await refresh(); }
  }

  const decisionOutcome = (status: string) => status === 'DELIVERED' ? '' : status === 'PENDING' ? ' It will be recorded on the paired Mac when it reconnects.' : status === 'CONFLICT' ? ' Another device already decided this item; the latest state is shown.' : ' The paired Mac did not accept this decision.';

  async function approve(suggestion: Suggestion, item: Item, value: string) {
    await act(`${suggestion.id}:${item.key}`, async () => {
      const plan = planApply(item, note, { value, relatedTitle: titles[item.value] ?? null });
      const saved = plan.type === 'tags' ? await applyTags(plan.tags) : await applyDocument(plan.document);
      if (!saved) throw new Error('The note was not saved, so the suggestion was not applied. Your note is unchanged.');
      await repository.recordAiApplyReceipt({ suggestionId: suggestion.id, itemKey: item.key, noteId: note.id, type: plan.type, label: plan.type === 'tags' ? plan.label : null, beforeRevision: note.revision, afterRevision: saved.revision, beforeDocument: plan.type === 'document' ? note.document : null, insertedNode: plan.type === 'document' ? plan.insertedNode : null });
      const edited = value.trim() !== item.value;
      const result = await recordDecision({ repository, suggestion, item, decision: edited ? 'EDITED' : 'APPROVED', appliedLocalRevision: saved.revision });
      return `${edited ? 'Edited and applied' : 'Applied'}. It syncs like any other edit.${decisionOutcome(result.status)}`;
    });
  }

  async function decide(suggestion: Suggestion, item: Item, decision: 'REJECTED' | 'DEFERRED') {
    await act(`${suggestion.id}:${item.key}`, async () => {
      const result = await recordDecision({ repository, suggestion, item, decision });
      return `${decision === 'REJECTED' ? 'Rejected' : 'Saved for later'}.${decisionOutcome(result.status)}`;
    });
  }

  async function undo(suggestion: Suggestion, item: Item) {
    await act(`${suggestion.id}:${item.key}`, async () => {
      const receipt = receipts[`${suggestion.id}:${item.key}`];
      if (item.state?.decision !== 'REJECTED') {
        if (!receipt) throw new Error('This item was applied on another device. Undo it there, or edit the note directly.');
        const plan = planUndo(receipt, note);
        if (plan.type === 'tags' && !(await applyTags(plan.tags))) throw new Error('The undo could not be saved. Your note is unchanged.');
        if (plan.type === 'document' && !(await applyDocument(plan.document))) throw new Error('The undo could not be saved. Your note is unchanged.');
        await repository.markAiApplyReceiptUndone(receipt.id);
      }
      const result = await recordDecision({ repository, suggestion, item, decision: 'UNDONE' });
      return `Undone.${decisionOutcome(result.status)}`;
    });
  }

  const visible = suggestions.filter(row => row.status === 'PENDING_REVIEW' || Object.values(row.items).some((state: any) => ['APPROVED', 'EDITED'].includes(state.decision)));
  if (!available || (!visible.length && !offline)) return null;

  return <section className="ai-inbox" id="ai-suggestions" aria-labelledby={`ai-inbox-${note.id}`}>
    <header className="ai-inbox-head">
      <div><p className="ai-eyebrow">AI suggestions</p><h2 id={`ai-inbox-${note.id}`}>Review before anything changes</h2></div>
      <p className="ai-inbox-lede">Nothing is applied until you choose. Approved items are saved like your own edits and can be undone.</p>
    </header>
    {offline === 'offline' && <div className="ai-note" role="status">Offline. Suggestions are shown from the paired Mac when it is reachable; decisions you make are queued.</div>}
    {offline === 'busy' && <div className="ai-note" role="status">The paired Mac is busy. Retrying in a moment; nothing was lost.</div>}
    {!canApply && visible.length > 0 && <div className="ai-note" role="status">Finish saving this note before applying a suggestion.</div>}
    {visible.map(suggestion => {
      const confidence = confidenceOf(suggestion.payload), items: Item[] = suggestionItems(suggestion);
      return <article className="ai-suggestion" key={suggestion.id}>
        <div className="ai-suggestion-meta">
          <span className={`ai-confidence is-${confidence.label.toLowerCase()}`} title="Model-reported confidence; it is not a guarantee.">{confidence.label} confidence{confidence.value !== null ? ` · ${Math.round(confidence.value * 100)}%` : ''}</span>
          <span>{providerText(suggestion.providerIdentity)}</span>
          <span>{new Date(suggestion.createdAt).toLocaleString()}</span>
        </div>
        {suggestion.revisionChanged && <p className="ai-note">Based on an earlier version of this note. Items whose quoted text changed are marked stale.</p>}
        <ul className="ai-items">
          {items.map(item => {
            const id = `${suggestion.id}:${item.key}`, relatedTitle = titles[item.value] ?? null;
            const applicability = itemApplicability(item, note, { relatedTitle });
            const label = item.kind === 'related' ? relatedTitle ?? 'Note not on this device' : item.value;
            const preview = previewItem(item, note, { value: editing?.key === id ? editing.value : item.value, relatedTitle });
            const decided = applicability.status === 'applied' || applicability.status === 'rejected';
            const deferred = item.state?.decision === 'DEFERRED';
            return <li key={item.key} className={`ai-item is-${applicability.status}${deferred ? ' is-deferred' : ''}`}>
              <div className="ai-item-main">
                <span className="ai-kind">{KIND_LABEL[item.kind]}</span>
                {editing?.key === id
                  ? <label className="ai-edit"><span className="screen-reader">Edit suggested {KIND_LABEL[item.kind]}</span><input value={editing.value} maxLength={item.kind === 'tag' || item.kind === 'category' ? 32 : 240} onChange={event => setEditing({ key: id, value: event.target.value })} autoFocus /></label>
                  : <p className="ai-value">{label}</p>}
              </div>
              {item.quote && <p className="ai-quote"><span>From your note</span> “{item.quote}”</p>}
              {item.kind === 'related' && <p className="ai-quote"><span>Why</span> {item.reason === 'title_match' ? 'Same title' : 'Shares tags'} with another note you allowed AI to organize.</p>}
              {!decided && applicability.status === 'ready' && <div className="ai-diff" aria-label="Change preview"><span>{preview.area}</span>{preview.add.map(line => <ins key={line}>+ {line}</ins>)}</div>}
              {(applicability.status !== 'ready' || deferred) && <p className="ai-item-status">{deferred && applicability.status === 'ready' ? 'Saved for later.' : STATUS_TEXT[applicability.reason ?? applicability.status] ?? STATUS_TEXT[applicability.status]}{item.state?.decision === 'EDITED' ? ' (edited)' : ''}</p>}
              <div className="ai-actions">
                {applicability.status === 'ready' && (editing?.key === id
                  ? <><button className="btn btn-primary" type="button" disabled={!canApply || Boolean(busyKey) || !editing.value.trim()} onClick={() => void approve(suggestion, item, editing.value)}>Apply edit</button><button className="btn btn-quiet" type="button" onClick={() => setEditing(null)}>Cancel</button></>
                  : <><button className="btn btn-primary" type="button" disabled={!canApply || Boolean(busyKey)} onClick={() => void approve(suggestion, item, item.value)}>Approve</button>
                    {item.kind !== 'related' && <button className="btn btn-quiet" type="button" disabled={!canApply || Boolean(busyKey)} onClick={() => setEditing({ key: id, value: item.value })}>Edit</button>}
                    <button className="btn btn-quiet" type="button" disabled={Boolean(busyKey)} onClick={() => void decide(suggestion, item, 'REJECTED')}>Reject</button>
                    {!deferred && <button className="btn btn-quiet" type="button" disabled={Boolean(busyKey)} onClick={() => void decide(suggestion, item, 'DEFERRED')}>Later</button>}</>)}
                {!decided && applicability.status !== 'ready' && <button className="btn btn-quiet" type="button" disabled={Boolean(busyKey)} onClick={() => void decide(suggestion, item, 'REJECTED')}>Dismiss</button>}
                {decided && <button className="btn btn-quiet" type="button" disabled={Boolean(busyKey) || (!canApply && applicability.status === 'applied')} onClick={() => void undo(suggestion, item)}>Undo</button>}
              </div>
            </li>;
          })}
        </ul>
      </article>;
    })}
    {message && <p className="ai-feedback" role="status">{message}</p>}
  </section>;
}
