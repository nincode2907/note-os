import { validateNoteDocument } from './note-validation.mjs';

export const JOURNAL_PREFIX = 'noteos:mvp01:recovery:';
export function recoveryStorage() { try { return globalThis.localStorage; } catch { return undefined; } }
const EPOCH_PREFIX = 'noteos:mvp01:deletion:';
export const sameContent = (left, right) => left?.title === right?.title && JSON.stringify(left?.document) === JSON.stringify(right?.document);
const epoch = (storage, id) => { try { return storage?.getItem(`${EPOCH_PREFIX}${encodeURIComponent(id)}`) ?? ''; } catch { return ''; } };

export function recoveryEntries(storage, id) {
  const result = [];
  try {
    const legacy = `${JOURNAL_PREFIX}${id}`;
    const prefix = `${JOURNAL_PREFIX}${encodeURIComponent(id)}:`;
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== legacy && !key?.startsWith(prefix)) continue;
      const raw = storage.getItem(key);
      try { result.push({ key, raw, value: JSON.parse(raw) }); } catch { result.push({ key, raw, value: null }); }
    }
  } catch { /* Journal storage is best effort; IndexedDB remains authoritative. */ }
  return result;
}

export function clearRecoveryEntry(storage, entry) {
  try { if (storage.getItem(entry.key) === entry.raw) storage.removeItem(entry.key); } catch { /* Preserve on failure. */ }
}

export function recoveryCandidates(storage, note) {
  const candidates = [];
  for (const entry of recoveryEntries(storage, note.id)) {
    const draft = entry.value;
    let valid = false;
    try { valid = typeof draft?.title === 'string' && Number.isSafeInteger(draft.baseRevision) && draft.baseRevision >= 0 && validateNoteDocument(draft.document).status === 'supported'; } catch { /* Expose invalid recovery data without applying it. */ }
    if (valid && sameContent(draft, note)) { clearRecoveryEntry(storage, entry); continue; }
    const sameEpoch = (draft?.deletionEpoch ?? '') === epoch(storage, note.id);
    const sameInstance = draft?.recordCreatedAt === undefined || draft.recordCreatedAt === note.createdAt;
    const ownEarlierCommit = draft?.inFlight && note.revision === draft.inFlight.expectedRevision + 1 && sameContent(note, draft.inFlight);
    candidates.push({ ...entry, ...draft, valid, sameRevision: Boolean(valid && note.lifecycle === 'active' && sameEpoch && sameInstance && (draft.baseRevision === note.revision || ownEarlierCommit)) });
  }
  return candidates;
}

export function createRecoveryJournal(storage, note, writerId = crypto.randomUUID()) {
  const key = `${JOURNAL_PREFIX}${encodeURIComponent(note.id)}:${writerId}`;
  const deletionEpoch = epoch(storage, note.id);
  let lastRaw;
  return {
    isCurrent: () => epoch(storage, note.id) === deletionEpoch,
    write(draft, generation, baseRevision, inFlight = null) {
      try {
        lastRaw = JSON.stringify({ version: 2, writerId, generation, baseRevision, recordCreatedAt: note.createdAt, deletionEpoch, title: draft.title, document: draft.document, inFlight, updatedAt: Date.now() });
        storage.setItem(key, lastRaw);
        return true;
      } catch { return false; }
    },
    clear() { if (lastRaw !== undefined) clearRecoveryEntry(storage, { key, raw: lastRaw }); },
  };
}

// Call only after the IndexedDB delete committed. A changed or unsaved journal is retained.
export function finishDeletedNote(storage, note, capturedEntries) {
  try { storage.setItem(`${EPOCH_PREFIX}${encodeURIComponent(note.id)}`, crypto.randomUUID()); } catch { /* Best effort marker. */ }
  for (const entry of capturedEntries) {
    if (entry.value?.baseRevision <= note.revision && sameContent(entry.value, note)) clearRecoveryEntry(storage, entry);
  }
}
