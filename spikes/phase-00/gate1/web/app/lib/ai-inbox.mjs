import { normalizeTagLabel, normalizeTagList, tagKey } from './note-organization.mjs';
import { validateNoteDocument } from './note-validation.mjs';
import { ensureAiSession } from './ai-sync-client.mjs';

// Suggestions Inbox client logic. Nothing here writes a note: it plans an edit that the
// note page applies through its SaveCoordinator (revision CAS) and ordinary Text Sync.

const KINDS = { category: 'category', summary: 'summary', tag: 'tag', task: 'task', related: 'related' };
/** @type {Array<[number, string]>} */
export const CONFIDENCE_LEVELS = [[0.75, 'High'], [0.5, 'Medium'], [0, 'Low']];

export function confidenceOf(payload) {
  const value = typeof payload?.uncertainty === 'number' ? Math.min(1, Math.max(0, 1 - payload.uncertainty)) : null;
  if (value === null) return { value: null, label: 'Unknown' };
  return { value, label: CONFIDENCE_LEVELS.find(([floor]) => value >= floor)[1] };
}

/** Flatten a validated payload into reviewable items with stable server item keys. */
export function suggestionItems(suggestion) {
  const payload = suggestion?.payload ?? {}, states = suggestion?.items ?? {}, items = [];
  const push = (key, kind, value, quote, extra = {}) => items.push({ key, kind, value, quote, state: states[key] ?? null, ...extra });
  if (payload.categorySuggestion) push('category', KINDS.category, payload.categorySuggestion.label, payload.categorySuggestion.sourceQuote);
  if (payload.shortSummary) push('summary', KINDS.summary, payload.shortSummary, null);
  (payload.tagCandidates ?? []).forEach((tag, index) => push(`tag:${index}`, KINDS.tag, tag.label, tag.sourceQuote));
  (payload.taskCandidates ?? []).forEach((task, index) => push(`task:${index}`, KINDS.task, task.text, task.sourceQuote));
  (payload.relatedCandidates ?? []).forEach((related, index) => push(`related:${index}`, KINDS.related, related.id, null, { reason: related.reason }));
  return items;
}

function collectText(node, out) {
  if (!node || typeof node !== 'object') return out;
  if (node.type === 'text' && typeof node.text === 'string') out.push(node.text);
  for (const child of Array.isArray(node.content) ? node.content : []) collectText(child, out);
  return out;
}

export function notePlainText(note) {
  return [note?.title ?? '', ...(Array.isArray(note?.tags) ? note.tags : []), ...collectText(note?.document, [])].join('\n');
}

const blockTexts = (document, type) => {
  const out = [];
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === type) out.push(collectText(node, []).join('').normalize('NFC').trim().toLowerCase());
    for (const child of Array.isArray(node.content) ? node.content : []) walk(child);
  };
  walk(document);
  return out;
};
const relatedLine = title => `Related: ${title}`;
const summaryLine = text => text;

/**
 * Is this item applicable to the note as it is now? Staleness is content-based: the
 * quoted source must still be in the note, so edits on any device invalidate exactly the
 * items they affect. Duplicates (already applied here or on another device) are detected.
 */
/**
 * @param {any} item @param {any} note
 * @param {{ relatedTitle?: string | null, value?: any }} [options]
 * @returns {{ status: string, reason?: string }}
 */
export function itemApplicability(item, note, { relatedTitle = null, value = item.value } = {}) {
  const decision = item.state?.decision;
  if (decision === 'APPROVED' || decision === 'EDITED') return { status: 'applied' };
  if (decision === 'REJECTED') return { status: 'rejected' };
  if (!note || note.lifecycle !== 'active') return { status: 'unavailable', reason: 'note_inactive' };
  if (item.quote && !notePlainText(note).includes(item.quote)) return { status: 'stale', reason: 'quote_missing' };
  const text = String(value ?? '').normalize('NFC').trim().toLowerCase();
  if (item.kind === 'tag' || item.kind === 'category') {
    if ((note.tags ?? []).some(tag => tagKey(tag) === tagKey(String(value ?? '').trim()))) return { status: 'duplicate', reason: 'tag_present' };
    if ((note.tags ?? []).length >= 20) return { status: 'unavailable', reason: 'tag_limit' };
  }
  if (item.kind === 'task' && blockTexts(note.document, 'taskItem').includes(text)) return { status: 'duplicate', reason: 'task_present' };
  if (item.kind === 'summary' && blockTexts(note.document, 'paragraph').includes(summaryLine(text))) return { status: 'duplicate', reason: 'summary_present' };
  if (item.kind === 'related') {
    if (!relatedTitle) return { status: 'unavailable', reason: 'related_note_missing' };
    if (blockTexts(note.document, 'paragraph').includes(relatedLine(relatedTitle).normalize('NFC').toLowerCase())) return { status: 'duplicate', reason: 'related_present' };
  }
  return { status: 'ready' };
}

const paragraph = text => ({ type: 'paragraph', content: [{ type: 'text', text }] });

/**
 * Plan an owner-approved edit. Values become plain text nodes only; the result is validated.
 * @param {any} item @param {any} note
 * @param {{ relatedTitle?: string | null, value?: any }} [options]
 * @returns {{ type: 'tags', label: string, tags: string[] } | { type: 'document', document: any, insertedNode: any }}
 */
export function planApply(item, note, { value = item.value, relatedTitle = null } = {}) {
  const check = itemApplicability(item, note, { relatedTitle, value });
  if (check.status !== 'ready') throw Object.assign(new Error(`Suggestion item is ${check.status}`), { code: check.reason ?? check.status });
  if (item.kind === 'tag' || item.kind === 'category') {
    const label = normalizeTagLabel(String(value));
    return { type: 'tags', label, tags: normalizeTagList([...(note.tags ?? []), label]) };
  }
  const text = String(value ?? '').trim();
  if (!text || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text) || Array.from(text).length > 500) throw Object.assign(new Error('Suggestion text is not valid'), { code: 'invalid_text' });
  const content = structuredClone(note.document.content ?? []);
  let insertedNode;
  if (item.kind === 'task') {
    insertedNode = { type: 'taskItem', attrs: { checked: false }, content: [paragraph(text)] };
    const last = content.at(-1);
    if (last?.type === 'taskList') last.content = [...(last.content ?? []), insertedNode];
    else content.push({ type: 'taskList', content: [insertedNode] });
  } else if (item.kind === 'summary') {
    insertedNode = { type: 'blockquote', content: [paragraph(summaryLine(text))] };
    content.unshift(insertedNode);
  } else if (item.kind === 'related') {
    insertedNode = paragraph(relatedLine(relatedTitle));
    content.push(insertedNode);
  } else throw new TypeError('Unknown suggestion kind');
  const document = { ...note.document, content };
  validateNoteDocument(document, false);
  return { type: 'document', document, insertedNode: structuredClone(insertedNode) };
}

/**
 * Inverse edit. Tags are removed semantically; document edits only while the note is unchanged since apply.
 * @param {any} receipt @param {any} note
 * @returns {{ type: 'noop' } | { type: 'tags', tags: string[] } | { type: 'document', document: any }}
 */
export function planUndo(receipt, note) {
  if (!receipt || receipt.undoneAt) throw Object.assign(new Error('Nothing to undo'), { code: 'nothing_to_undo' });
  if (receipt.type === 'tags') {
    const tags = (note.tags ?? []).filter(tag => tagKey(tag) !== tagKey(receipt.label));
    return tags.length === (note.tags ?? []).length ? { type: 'noop' } : { type: 'tags', tags };
  }
  if (note.revision === receipt.afterRevision && receipt.beforeDocument) return { type: 'document', document: receipt.beforeDocument };
  // Later edits happened: remove exactly the node that was inserted, only if it is still unchanged.
  const without = receipt.insertedNode ? removeInsertedNode(note.document, receipt.insertedNode) : null;
  if (!without) throw Object.assign(new Error('The note changed after this suggestion was applied'), { code: 'note_changed' });
  validateNoteDocument(without, false);
  return { type: 'document', document: without };
}

const sameNode = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function removeInsertedNode(document, inserted) {
  const content = structuredClone(document.content ?? []);
  if (inserted.type === 'taskItem') {
    for (let i = content.length - 1; i >= 0; i--) {
      if (content[i]?.type !== 'taskList') continue;
      const items = content[i].content ?? [], at = items.findLastIndex(child => sameNode(child, inserted));
      if (at < 0) continue;
      const rest = items.filter((_, index) => index !== at);
      if (rest.length) content[i] = { ...content[i], content: rest }; else content.splice(i, 1);
      return { ...document, content };
    }
    return null;
  }
  const at = content.findLastIndex(child => sameNode(child, inserted));
  if (at < 0) return null;
  content.splice(at, 1);
  return { ...document, content };
}

/**
 * Human-readable diff preview lines: what will be added where.
 * @param {any} item @param {any} note
 * @param {{ relatedTitle?: string | null, value?: any }} [options]
 * @returns {{ area: string, add: string[], before?: string[] }}
 */
export function previewItem(item, note, { value = item.value, relatedTitle = null } = {}) {
  if (item.kind === 'tag' || item.kind === 'category') return { area: 'Tags', before: note?.tags ?? [], add: [String(value)] };
  if (item.kind === 'task') return { area: 'End of note · checklist', add: [`☐ ${value}`] };
  if (item.kind === 'summary') return { area: 'Top of note · quote', add: [String(value)] };
  return { area: 'End of note', add: [relatedTitle ? relatedLine(relatedTitle) : 'Related note (not on this device)'] };
}

// ---- API and decision outbox ----

function apiError(code, status, body = {}) { return Object.assign(new Error(code), { code, status, ...body }); }

async function aiJson(path, { method = 'GET', body, fetcher = fetch } = {}) {
  const response = await fetcher(`/api/v1/ai/${path}`, {
    method, credentials: 'same-origin', cache: 'no-store',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-NoteOS-AI': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let value;
  try { value = await response.json(); } catch { throw apiError('invalid_server_response', response.status); }
  if (!response.ok) throw apiError(typeof value?.error === 'string' ? value.error : 'ai_request_failed', response.status, value?.current ? { current: value.current } : {});
  return value;
}

export async function fetchSuggestionInbox({ fetcher = fetch } = {}) {
  await ensureAiSession({ fetcher });
  return (await aiJson('suggestions', { fetcher })).suggestions;
}

export async function fetchNoteSuggestions(noteId, { fetcher = fetch } = {}) {
  await ensureAiSession({ fetcher });
  return (await aiJson(`suggestions/notes/${encodeURIComponent(noteId)}`, { fetcher })).suggestions;
}

const transient = error => !error.status || error.status === 408 || error.status === 429 || error.status >= 500;

/**
 * Deliver queued decisions in order. Conflicts are final and surfaced; transient errors wait.
 * @param {{ repository: any, fetcher?: typeof fetch }} options
 */
export async function deliverAiDecisions({ repository, fetcher = fetch }) {
  const pending = (await repository.listAiDecisions()).filter(row => row.status === 'PENDING');
  if (!pending.length) return { delivered: 0, conflicts: 0, waiting: 0, failed: 0 };
  try { await ensureAiSession({ fetcher }); }
  catch { return { delivered: 0, conflicts: 0, waiting: pending.length, failed: 0 }; }
  let delivered = 0, conflicts = 0, waiting = 0, failed = 0;
  for (const row of pending) {
    try {
      const result = await aiJson(`suggestions/${encodeURIComponent(row.suggestionId)}/decisions`, { method: 'POST', fetcher, body: { protocolVersion: 1, requestId: row.requestId, itemKey: row.itemKey, decision: row.decision, expectedVersion: row.expectedVersion, appliedLocalRevision: row.appliedLocalRevision } });
      await repository.updateAiDecision(row.requestId, 'DELIVERED', { serverVersion: result.version }); delivered++;
    } catch (error) {
      if (['DECISION_CONFLICT', 'DECISION_NOT_ALLOWED'].includes(error.code)) { await repository.updateAiDecision(row.requestId, 'CONFLICT', { error: error.code }); conflicts++; }
      else if (transient(error)) waiting++;
      else { await repository.updateAiDecision(row.requestId, 'FAILED', { error: error.code }); failed++; }
    }
  }
  return { delivered, conflicts, waiting, failed };
}

/** @param {{ repository: any, fetcher?: typeof fetch, suggestion: any, item: any, decision: string, appliedLocalRevision?: number | null, requestId?: string }} options */
export async function recordDecision({ repository, fetcher = fetch, suggestion, item, decision, appliedLocalRevision = null, requestId = crypto.randomUUID() }) {
  await repository.queueAiDecision({ requestId, suggestionId: suggestion.id, noteId: suggestion.noteId, itemKey: item.key, decision, expectedVersion: item.state?.version ?? 0, appliedLocalRevision });
  const outcome = await deliverAiDecisions({ repository, fetcher });
  const row = (await repository.listAiDecisions(suggestion.noteId)).find(entry => entry.requestId === requestId);
  return { outcome, status: row?.status ?? 'PENDING', error: row?.error ?? null };
}
