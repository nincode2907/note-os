import { NoteConflictError } from './local-notes.js';
import { sameContent } from './recovery-journal.mjs';

/** @param {{note: any, repository: any, journal: any, onChange?: (state: any) => void}} options */
export function createSaveCoordinator({ note, repository, journal, onChange = () => {} }) {
  let saved = structuredClone(note);
  let draft = { title: note.title, document: structuredClone(note.document) };
  let generation = 0;
  let running = null;
  let pending = null;
  let error = null;
  const dirty = () => !sameContent(draft, saved);
  const snapshot = () => ({ note: saved, draft, generation, dirty: dirty(), inFlight: Boolean(pending), error });
  const notify = () => onChange(snapshot());
  const persist = () => journal.write(draft, generation, saved.revision, pending);
  function edit(next) {
    if (sameContent(next, draft)) return;
    draft = structuredClone(next); generation += 1; error = null;
    if (dirty() || pending) persist(); else journal.clear();
    notify();
  }
  function flush() {
    if (running) return running;
    if (!dirty()) return Promise.resolve({ ok: true, note: saved });
    running = (async () => {
      // Bound each drain. New edits continue through the existing debounce, never an error retry loop.
      for (let writes = 0; writes < 10 && dirty(); writes += 1) {
        if (!journal.isCurrent()) { error = new NoteConflictError(); notify(); return { ok: false, error }; }
        const target = structuredClone(draft);
        pending = { ...target, generation, expectedRevision: saved.revision };
        persist(); error = null; notify();
        try {
          saved = await repository.save(saved.id, target, saved.revision);
          pending = null;
          if (dirty()) persist(); else journal.clear();
          notify();
        } catch (cause) {
          pending = null; error = cause; persist(); notify();
          return { ok: false, error: cause };
        }
      }
      return dirty() ? { ok: false, pending: true } : { ok: true, note: saved };
    })().finally(() => { running = null; });
    return running;
  }
  async function transition(lifecycle) {
    const result = await flush();
    if (!result.ok) return result;
    try {
      if (!journal.isCurrent()) throw new NoteConflictError();
      if (saved.lifecycle !== lifecycle) saved = await repository.setLifecycle(saved.id, lifecycle, saved.revision);
      notify(); return { ok: true, note: saved };
    } catch (cause) { error = cause; notify(); return { ok: false, error: cause }; }
  }
  async function updateMetadata(changes) {
    const result = await flush();
    if (!result.ok) return result;
    try {
      if (!journal.isCurrent()) throw new NoteConflictError();
      saved = await repository.updateOrganization(saved.id, changes, saved.revision);
      error = null; notify();
      return { ok: true, note: saved };
    } catch (cause) {
      error = cause; notify();
      return { ok: false, error: cause };
    }
  }
  return { edit, flush, transition, updateMetadata, snapshot, clearJournal: () => journal.clear() };
}
