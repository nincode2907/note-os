import { validateCanonicalDocument } from '../web/packages/document-engine/src/index.js';

export const EDITOR_BRIDGE_VERSION = 1;
export const MAX_EDITOR_MESSAGE_CHARS = 2 * 1024 * 1024;
const MAX_GENERATION = Number.MAX_SAFE_INTEGER;
const envelopeKeys = ['v', 'sessionId', 'generation', 'type', 'payload'];
const knownTypes = new Set(['EDITOR_READY', 'DOCUMENT_CHANGED', 'DOCUMENT_SNAPSHOT', 'EDITOR_ERROR', 'EDITOR_FOCUS_CHANGED', 'EDITOR_LAYOUT']);

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value, expected) { return Object.keys(value).every(key => expected.includes(key)) && expected.every(key => Object.hasOwn(value, key)); }

/** @param {string} raw @param {{sessionId: string, afterGeneration?: number}} options */
export function validateEditorEnvelope(raw, { sessionId, afterGeneration = 0 }) {
  if (typeof raw !== 'string' || raw.length > MAX_EDITOR_MESSAGE_CHARS) return { ok: false, error: 'Editor message is missing or exceeds the size limit.' };
  let message;
  try { message = JSON.parse(raw); } catch { return { ok: false, error: 'Editor message is not valid JSON.' }; }
  if (!isRecord(message) || !exactKeys(message, envelopeKeys) || message.v !== EDITOR_BRIDGE_VERSION || message.sessionId !== sessionId || typeof message.sessionId !== 'string' || message.sessionId.length > 160) return { ok: false, error: 'Editor message version or session is invalid.' };
  if (!Number.isSafeInteger(message.generation) || message.generation < 1 || message.generation > MAX_GENERATION || message.generation <= afterGeneration) return { ok: false, error: 'Editor message generation is stale or invalid.' };
  if (!knownTypes.has(message.type) || !isRecord(message.payload)) return { ok: false, error: 'Editor message type or payload is invalid.' };
  const { payload } = message;
  if (message.type === 'EDITOR_READY' && !exactKeys(payload, ['editable'])) return { ok: false, error: 'Editor readiness payload is invalid.' };
  if (message.type === 'EDITOR_READY' && typeof payload.editable !== 'boolean') return { ok: false, error: 'Editor readiness state is invalid.' };
  if (message.type === 'EDITOR_FOCUS_CHANGED' && (!exactKeys(payload, ['focused']) || typeof payload.focused !== 'boolean')) return { ok: false, error: 'Editor focus payload is invalid.' };
  if (message.type === 'EDITOR_LAYOUT' && (!exactKeys(payload, ['height']) || !Number.isInteger(payload.height) || payload.height < 240 || payload.height > 16000)) return { ok: false, error: 'Editor layout payload is invalid.' };
  if (message.type === 'EDITOR_ERROR' && (!exactKeys(payload, ['code', 'message']) || typeof payload.code !== 'string' || payload.code.length > 80 || typeof payload.message !== 'string' || payload.message.length > 1000)) return { ok: false, error: 'Editor error payload is invalid.' };
  if (message.type === 'DOCUMENT_CHANGED' || message.type === 'DOCUMENT_SNAPSHOT') {
    const allowed = message.type === 'DOCUMENT_SNAPSHOT' ? ['document', 'requestId'] : ['document'];
    if (!exactKeys(payload, allowed)) return { ok: false, error: 'Editor document payload is invalid.' };
    if (message.type === 'DOCUMENT_SNAPSHOT' && (typeof payload.requestId !== 'string' || payload.requestId.length > 100)) return { ok: false, error: 'Editor snapshot request ID is invalid.' };
    let size;
    try { size = JSON.stringify(payload.document).length; } catch { return { ok: false, error: 'Editor document could not be serialized.' }; }
    if (size > MAX_EDITOR_MESSAGE_CHARS) return { ok: false, error: 'Editor document exceeds the size limit.' };
    const validation = validateCanonicalDocument(payload.document);
    if (validation.status !== 'supported') return { ok: false, error: validation.issues?.[0]?.message ?? 'Editor document is not supported.' };
    return { ok: true, message, document: validation.document };
  }
  return { ok: true, message };
}

export function createEditorSession(noteId, nonce) {
  if (typeof noteId !== 'string' || !noteId || typeof nonce !== 'string' || !nonce) throw new TypeError('An editor session requires a note ID and nonce.');
  return `${noteId}:${nonce}`.slice(0, 160);
}
