export const CANONICAL_SCHEMA_VERSION = 1;
export const CANONICAL_DOCUMENT_TYPE = 'doc';

export function createEmptyCanonicalDocument() {
  return { schemaVersion: CANONICAL_SCHEMA_VERSION, type: CANONICAL_DOCUMENT_TYPE, content: [] };
}

export function plainTextToCanonicalDocument(text) {
  if (typeof text !== 'string') {
    throw new TypeError('Plain text input must be a string.');
  }

  if (text.length === 0) return createEmptyCanonicalDocument();

  return {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    type: CANONICAL_DOCUMENT_TYPE,
    content: text.split('\n').map((line) => ({
      type: 'paragraph',
      ...(line.length === 0 ? {} : { content: [{ type: 'text', text: line }] }),
    })),
  };
}
