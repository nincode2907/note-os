const MAX_TAGS_PER_NOTE = 20;
const MAX_TAG_LENGTH = 32;

export function tagKey(value) {
  return String(value ?? '').normalize('NFC').toLowerCase();
}

export function normalizeTagLabel(value) {
  if (typeof value !== 'string') throw new TypeError('Tags must be text.');
  const label = value.trim();
  if (!label) throw new TypeError('Enter a tag name.');
  if (Array.from(label).length > MAX_TAG_LENGTH) throw new TypeError(`Tags can contain up to ${MAX_TAG_LENGTH} characters.`);
  if (/[\u0000-\u001f\u007f]/u.test(label)) throw new TypeError('Tags cannot contain control characters.');
  return label;
}

export function normalizeTagList(values) {
  if (!Array.isArray(values)) throw new TypeError('Note tags must be a list.');
  if (values.length > MAX_TAGS_PER_NOTE) throw new TypeError(`A note can have up to ${MAX_TAGS_PER_NOTE} tags.`);
  const tags = [], seen = new Set();
  for (const value of values) {
    const label = normalizeTagLabel(value), key = tagKey(label);
    if (seen.has(key)) throw new TypeError('A note cannot contain duplicate tags.');
    seen.add(key); tags.push(label);
  }
  return tags;
}

export function safeTagsForNoteCopy(note) {
  if (!note || note.schemaVersion !== 1 || !Array.isArray(note.tags)) return [];
  try { return normalizeTagList(note.tags); }
  catch { return []; }
}

export function validateOrganizationMetadata(note) {
  if (note.schemaVersion !== 1) return;
  if (note.pinned !== undefined && typeof note.pinned !== 'boolean') throw new TypeError(`Backup note “${note.id}” has invalid pin metadata.`);
  if (note.tags !== undefined) normalizeTagList(note.tags);
}
