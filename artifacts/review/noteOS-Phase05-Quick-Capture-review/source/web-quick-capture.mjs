import { createEmptyCanonicalDocument, plainTextToCanonicalDocument } from '../../packages/document-engine/src/plain-text.js';

export const QUICK_CAPTURE_DRAFT_ID = 'home';

export class QuickCaptureSaveGate {
  constructor() { this.active = false; }
  begin() { if (this.active) return false; this.active = true; return true; }
  finish() { this.active = false; }
}

/** Keep all meaningful interior whitespace and Unicode; discard only the outside boundary. */
export function normalizeQuickCaptureInput(value) {
  if (typeof value !== 'string') throw new TypeError('Quick Capture text must be a string.');
  return value.trim();
}

export function deriveQuickCaptureTitle(value, fallback = 'Untitled note') {
  const line = normalizeQuickCaptureInput(value).split('\n').find((candidate) => candidate.trim().length > 0);
  return line ? line.trim().replace(/\s+/gu, ' ') : fallback;
}

/** @param {string} value @param {{id?: string, now?: number}} [options] */
export function makeQuickCaptureNote(value, { id = crypto.randomUUID(), now = Date.now() } = {}) {
  const body = normalizeQuickCaptureInput(value);
  if (!body) return null;
  return {
    id,
    title: deriveQuickCaptureTitle(body),
    document: plainTextToCanonicalDocument(body),
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    lifecycle: 'active',
    revision: 0,
    pinned: false,
    tags: [],
  };
}

/** @param {{id?: string, now?: number}} [options] */
export function makeQuickVoiceNote({ id = crypto.randomUUID(), now = Date.now() } = {}) {
  return {
    id,
    title: 'Voice note',
    document: createEmptyCanonicalDocument(),
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    lifecycle: 'active',
    revision: 0,
    pinned: false,
    tags: [],
  };
}

export function captureSnapshotIsCurrent(currentText, currentSequence, snapshot) {
  return currentSequence === snapshot.sequence && currentText === snapshot.text;
}

/** Persist the recovery checkpoint before commit; clear it only if the user has not typed over it. */
/** @template T, R @param {{snapshot: {text: string, sequence: number, note: T}, persist: (snapshot: {text: string, sequence: number, note: T}) => Promise<unknown>, commit: (snapshot: {text: string, sequence: number, note: T}) => Promise<R>, clear: (snapshot: {text: string, sequence: number, note: T}) => Promise<unknown>, isCurrent: (snapshot: {text: string, sequence: number, note: T}) => boolean}} input @returns {Promise<{note: R, cleared: boolean}>} */
export async function commitQuickCaptureSnapshot({ snapshot, persist, commit, clear, isCurrent }) {
  await persist(snapshot);
  const note = await commit(snapshot);
  let cleared = false;
  if (isCurrent(snapshot)) {
    try { await clear(snapshot); cleared = true; }
    catch { /* The persisted note remains authoritative; its stable ID makes draft retry idempotent. */ }
  }
  return { note, cleared };
}
