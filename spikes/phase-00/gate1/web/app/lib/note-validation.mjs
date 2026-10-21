import { validateCanonicalDocument } from '../../packages/document-engine/src/index.js';

export class NoteDocumentError extends Error {
  constructor(message, issues = []) { super(message); this.name = 'NoteDocumentError'; this.issues = issues; }
}

export function validateNoteDocument(document, allowUnsupported = false) {
  if (!document || Array.isArray(document) || document.type !== 'doc' || !Array.isArray(document.content) || !Number.isSafeInteger(document.schemaVersion) || document.schemaVersion < 1) {
    throw new NoteDocumentError('A canonical document requires a version, doc root and content array.');
  }
  const result = validateCanonicalDocument(document);
  if (result.status === 'invalid' || (!allowUnsupported && result.status !== 'supported')) {
    throw new NoteDocumentError(result.issues?.[0]?.message ?? 'The note document cannot be safely written.', result.issues ?? []);
  }
  return result;
}

export function assertNoteRecord(note, { allowUnsupported = false } = {}) {
  if (!note || typeof note.id !== 'string' || !note.id.trim()) throw new TypeError('A note requires a stable ID.');
  if (typeof note.title !== 'string' || !Number.isSafeInteger(note.schemaVersion) || note.schemaVersion < 1 || !Number.isSafeInteger(note.createdAt) || note.createdAt < 0 || !Number.isSafeInteger(note.updatedAt) || note.updatedAt < 0 || !['active', 'archived', 'trashed'].includes(note.lifecycle) || !Number.isSafeInteger(note.revision) || note.revision < 0) {
    throw new TypeError(`Backup note “${note.id}” has invalid metadata.`);
  }
  validateNoteDocument(note.document, allowUnsupported);
}
