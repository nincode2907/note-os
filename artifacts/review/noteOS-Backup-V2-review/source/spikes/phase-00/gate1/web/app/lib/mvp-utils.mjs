import { assertNoteRecord } from './note-validation.mjs';
import { normalizeTagList, tagKey } from './note-organization.mjs';

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
  const pieces = [note?.title, ...(Array.isArray(note?.tags) ? note.tags : [])];
  collectNodeText(note?.document, pieces);
  return searchableText(pieces.join(' '));
}

export function filterNotesByTags(notes, selectedTags = []) {
  const required = selectedTags.map(tagKey);
  if (!required.length) return [...notes];
  return notes.filter((note) => {
    const tags = new Set((Array.isArray(note.tags) ? note.tags : []).map(tagKey));
    return required.every((tag) => tags.has(tag));
  });
}

export function sortNotes(notes, mode = 'updated') {
  const compareDate = (left, right) => Number(right.updatedAt) - Number(left.updatedAt) || String(left.id).localeCompare(String(right.id));
  const compareOther = (left, right) => {
    if (mode === 'created') return Number(right.createdAt) - Number(left.createdAt) || compareDate(left, right);
    if (mode === 'title') return String(left.title ?? '').localeCompare(String(right.title ?? ''), undefined, { sensitivity: 'base', numeric: true }) || compareDate(left, right);
    return compareDate(left, right);
  };
  return [...notes].sort((left, right) => {
    const pinOrder = Number(Boolean(right.pinned)) - Number(Boolean(left.pinned));
    if (pinOrder) return pinOrder;
    if (left.pinned && right.pinned) return compareDate(left, right);
    return compareOther(left, right);
  });
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
    assertNoteRecord(note, { allowUnsupported: true });
    ids.add(note.id);
  }
  return bundle;
}

export { normalizeTagList };

export function titleFromDocument(document) {
  const text = [];
  collectNodeText(document, text);
  return text.join('').split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 80) || 'Untitled note';
}

export function formatSavedAt(timestamp) {
  if (!timestamp) return '';
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(timestamp));
}
