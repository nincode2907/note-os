export class RecordingSessionGate {
  phase = 'idle';
  backgroundRequested = false;
  beginStart() { if (this.phase !== 'idle') return false; this.phase = 'requesting'; this.backgroundRequested = false; return true; }
  move(expected, next) { if (this.phase !== expected) return false; this.phase = next; return true; }
  pause() { if (this.phase !== 'recording') return false; this.phase = 'paused'; return true; }
  resume() { if (this.phase !== 'paused') return false; this.phase = 'recording'; return true; }
  beginStop() { if (!['recording', 'paused', 'starting'].includes(this.phase)) return false; this.phase = 'stopping'; return true; }
  requestBackgroundStop() { this.backgroundRequested = true; return ['recording', 'paused'].includes(this.phase); }
  canNavigate() { return this.phase === 'idle'; }
  finish() { this.phase = 'idle'; this.backgroundRequested = false; }
}

let nativeRecordingOwner = null;
export function acquireNativeRecordingSession(owner) {
  if (typeof owner !== 'string' || !owner || nativeRecordingOwner !== null) return null;
  nativeRecordingOwner = owner;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (nativeRecordingOwner === owner) nativeRecordingOwner = null;
  };
}

export class SingleSaveGate {
  active = false;
  begin() { if (this.active) return false; this.active = true; return true; }
  finish() { this.active = false; }
}

export class ArchiveOperationGate {
  constructor() { this.exporting = false; this.finalizations = 0; }
  beginExport() {
    if (this.exporting || this.finalizations > 0) throw new Error('A recording is being finalized. Wait for it to finish before exporting a Full Archive.');
    this.exporting = true; let released = false;
    return () => { if (!released) { released = true; this.exporting = false; } };
  }
  beginFinalization() {
    if (this.exporting) throw new Error('A Full Archive is being prepared. Wait for it to finish before finalizing a recording.');
    this.finalizations++; let released = false;
    return () => { if (!released) { released = true; this.finalizations = Math.max(0, this.finalizations - 1); } };
  }
}

export class LatestDraftWriter {
  constructor(write) { this.write = write; this.pending = null; this.running = null; this.closed = false; }
  enqueue(value) { if (!this.closed) this.pending = value; }
  clearPending() { this.pending = null; }
  async closeAndSettle() {
    this.closed = true;
    this.pending = null;
    if (this.running) await this.running.catch(() => {});
    this.pending = null;
  }
  resume() { this.closed = false; }
  async flush() {
    if (this.closed) return;
    if (this.running) await this.running;
    if (this.closed || !this.pending) return;
    const value = this.pending; this.pending = null;
    this.running = Promise.resolve().then(() => this.write(value));
    try { await this.running; } catch (error) { if (!this.closed && this.pending === null) this.pending = value; throw error; }
    finally { this.running = null; }
    if (!this.closed && this.pending) return this.flush();
  }
}

export async function discardDraftSafely({ cancelDebounce, writer, noteId, expectedRevision, deleteJournal }) {
  cancelDebounce();
  await writer.closeAndSettle();
  try { await deleteJournal(noteId, expectedRevision); }
  catch (error) { writer.resume(); throw error; }
}

export async function commitThenClearDraft(commitNote, clearMatchingDraft) {
  const result = await commitNote();
  try { await clearMatchingDraft(); return { result, cleared: true }; }
  catch (error) { return { result, cleared: false, error }; }
}

export function recoveryDecision(note, journal) {
  if (!journal) return 'none';
  if (note?.revision === journal.baseRevision && note.lifecycle === 'active' && note.schemaVersion === 1) return 'offer-restore';
  return 'preserve-only';
}

export function normalizeNoteView(note) {
  return { ...note, pinned: note.pinned === true, tags: Array.isArray(note.tags) ? note.tags : [] };
}

export function canTransitionLifecycle(current, next) { return current !== 'trashed' || next !== 'archived'; }

export function canEditNativeNote(note, contentEditable) {
  return Boolean(note?.lifecycle === 'active' && note?.schemaVersion === 1 && contentEditable);
}
