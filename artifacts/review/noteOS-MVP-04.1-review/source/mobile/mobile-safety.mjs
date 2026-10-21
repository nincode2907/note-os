export class RecordingSessionGate {
  phase = 'idle';
  backgroundRequested = false;
  beginStart() { if (this.phase !== 'idle') return false; this.phase = 'requesting'; this.backgroundRequested = false; return true; }
  move(expected, next) { if (this.phase !== expected) return false; this.phase = next; return true; }
  beginStop() { if (!['recording', 'starting'].includes(this.phase)) return false; this.phase = 'stopping'; return true; }
  requestBackgroundStop() { this.backgroundRequested = true; return this.phase === 'recording'; }
  canNavigate() { return this.phase === 'idle'; }
  finish() { this.phase = 'idle'; this.backgroundRequested = false; }
}

export class LatestDraftWriter {
  constructor(write) { this.write = write; this.pending = null; this.running = null; }
  enqueue(value) { this.pending = value; }
  clearPending() { this.pending = null; }
  async flush() {
    if (this.running) await this.running;
    if (!this.pending) return;
    const value = this.pending; this.pending = null;
    this.running = Promise.resolve().then(() => this.write(value));
    try { await this.running; } catch (error) { if (this.pending === null) this.pending = value; throw error; }
    finally { this.running = null; }
    if (this.pending) return this.flush();
  }
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
