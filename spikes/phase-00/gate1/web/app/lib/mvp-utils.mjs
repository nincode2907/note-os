export const BACKUP_FORMAT = 'noteos.local-backup';
export const BACKUP_VERSION = 1;

export function searchableText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, (character) => character === 'Đ' ? 'D' : 'd')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function collectNodeText(node, output) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'text' && typeof node.text === 'string') output.push(node.text);
  for (const child of Array.isArray(node.content) ? node.content : []) collectNodeText(child, output);
}

export function noteSearchText(note) {
  const pieces = [note?.title];
  collectNodeText(note?.document, pieces);
  return searchableText(pieces.join(' '));
}

export function filterNotes(notes, query, lifecycle) {
  const normalized = searchableText(query);
  return notes.filter((note) => note.lifecycle === lifecycle && (!normalized || noteSearchText(note).includes(normalized)));
}

export function makeBackup(notes, exportedAt = new Date().toISOString()) {
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt, notes };
}

export function parseBackup(input) {
  let bundle;
  try { bundle = typeof input === 'string' ? JSON.parse(input) : input; }
  catch { throw new TypeError('Backup file is not valid JSON.'); }
  if (!bundle || bundle.format !== BACKUP_FORMAT || bundle.version !== BACKUP_VERSION || !Array.isArray(bundle.notes)) {
    throw new TypeError('This file is not a supported noteOS backup (version 1).');
  }
  const ids = new Set();
  for (const note of bundle.notes) {
    if (!note || typeof note.id !== 'string' || !note.id.trim() || ids.has(note.id)) throw new TypeError('Backup contains a missing or duplicate note ID.');
    if (typeof note.title !== 'string' || !note.document || typeof note.document !== 'object' || note.document.type !== 'doc' || !Array.isArray(note.document.content) || !Number.isFinite(note.createdAt) || !Number.isFinite(note.updatedAt) || !['active', 'archived', 'trashed'].includes(note.lifecycle) || !Number.isInteger(note.revision) || note.revision < 0) {
      throw new TypeError(`Backup note “${note.id}” has invalid metadata.`);
    }
    if (!Number.isInteger(note.schemaVersion) || note.schemaVersion < 1 || !Number.isInteger(note.document.schemaVersion) || note.document.schemaVersion < 1) {
      throw new TypeError(`Backup note “${note.id}” has invalid schema metadata.`);
    }
    ids.add(note.id);
  }
  return bundle;
}

export function titleFromDocument(document) {
  const text = [];
  collectNodeText(document, text);
  return text.join('').split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 80) || 'Untitled note';
}

export function formatSavedAt(timestamp) {
  if (!timestamp) return '';
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(timestamp));
}
