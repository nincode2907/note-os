'use client';

import { useRef, useState } from 'react';
import { createNotesRepository } from '../lib/local-notes.js';
import { makeBackup } from '../lib/mvp-utils.mjs';
import { exportArchive, restoreBackup } from '../lib/archive-v2.mjs';

function download(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export default function BackupPage() {
  const [message, setMessage] = useState(''), [error, setError] = useState(''), [stage, setStage] = useState('');
  const [file, setFile] = useState<File | null>(null), [mode, setMode] = useState<'merge' | 'skip'>('merge'), [busy, setBusy] = useState(false);
  const running = useRef(false), input = useRef<HTMLInputElement>(null);
  const repo = createNotesRepository();
  async function job(run: () => Promise<void>) {
    if (running.current) return;
    running.current = true; setBusy(true); setError(''); setMessage('');
    try { await run(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The backup job failed. Existing data was kept.'); }
    finally { running.current = false; setBusy(false); setStage(''); }
  }
  async function exportFull() {
    await job(async () => {
      const { blob, manifest } = await exportArchive(repo, { onProgress: setStage });
      download(`noteos-archive-${new Date().toISOString().slice(0, 10)}.tar`, blob);
      setMessage(`Download requested for ${manifest.counts.notes} notes and ${manifest.counts.recordings} recordings. ${manifest.warnings.length ? `${manifest.warnings.length} partial/empty recordings are identified in the manifest. ` : ''}Check Downloads to verify the browser saved the archive.`);
    });
  }
  async function exportLegacy() {
    await job(async () => {
      setStage('Preparing notes-only JSON…');
      const notes = await repo.list();
      download(`noteos-backup-${new Date().toISOString().slice(0, 10)}.json`, new Blob([JSON.stringify(makeBackup(notes), null, 2)], { type: 'application/json' }));
      setMessage(`Download requested for ${notes.length} notes. Audio is NOT included in Legacy JSON V1. Check your Downloads to verify the browser saved the file.`);
    });
  }
  async function importFile() {
    if (!file) return;
    await job(async () => {
      const result = await restoreBackup(file, repo, mode, { onProgress: setStage });
      setMessage(`Imported ${result.importedNotes} notes and ${result.importedRecordings} recordings. Skipped ${result.skippedNotes} notes and ${result.skippedRecordings} recordings; existing data was kept unchanged.${result.version === 1 ? ' Legacy JSON V1 contains no audio.' : ''}${result.warnings.length ? ' The archive contains partial/empty recordings; playback may be incomplete.' : ''}`);
      setFile(null); if (input.current) input.current.value = '';
    });
  }
  return <>
    <div className="page-heading"><div><p className="eyebrow">Your data, in your hands</p><h1 className="page-title">Backup & restore</h1><p className="page-lede">Keep an offline copy of your notes and original voice recordings.</p></div></div>
    <div className="notice"><strong>Private, unencrypted files.</strong> Archives contain private notes and voice recordings in unencrypted form. Store them securely.</div>
    {error && <div role="alert" className="notice error">{error}</div>}
    <div aria-live="polite" aria-atomic="true">{busy && <div role="status" className="notice">{stage || 'Preparing backup job…'}</div>}{message && <div role="status" className="notice">{message}</div>}</div>
    <section className="backup-panel archive-recommended" aria-labelledby="full-archive-title" aria-busy={busy}>
      <p className="eyebrow">Recommended · disaster recovery & migration</p><h2 id="full-archive-title" className="section-title">Full Archive V2</h2>
      <p>All active, archived and trashed notes, canonical documents, metadata, and original audio bytes in one checksum-validated TAR archive. Interrupted or failed recordings retain their saved chunks and partial status.</p>
      <p><strong>Stop and finalize active recordings in every tab before exporting.</strong> Export is blocked while any session is recording or paused. An empty or damaged recording is never silently treated as complete.</p>
      <button className="btn btn-primary" disabled={busy} onClick={() => void exportFull()}>Download Full Archive V2</button>
      <p className="backup-limit">Up to 1 GiB per archive and 512 MiB per audio file. Large archives may need substantial browser memory. Everything stays on this device.</p>
    </section>
    <section className="backup-panel" aria-labelledby="legacy-title">
      <h2 id="legacy-title" className="section-title">Legacy JSON V1 · notes only</h2><p>Includes all notes and note metadata for compatibility with earlier noteOS versions. <strong>Does NOT include audio.</strong> Use Full Archive V2 for notes and voice recordings together.</p>
      <button className="btn" disabled={busy} onClick={() => void exportLegacy()}>Download backup</button>
    </section>
    <section className="backup-panel" aria-labelledby="restore-title">
      <h2 id="restore-title" className="section-title">Restore from a backup</h2><p>All archive checks finish before any data is written. Future document schemas are preserved read-only. Restoring never overwrites existing notes or audio.</p>
      <label className="file-input">Choose a noteOS archive (.tar) or legacy backup (.json)<input ref={input} type="file" disabled={busy} accept="application/x-tar,.tar,application/json,.json" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setError(''); setMessage(''); }} /></label>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: '18px 0' }}><legend className="toolbar-label">If an ID already exists</legend>
        <label className="checkbox-row"><input type="radio" name="import-mode" checked={mode === 'merge'} onChange={() => setMode('merge')} /> Merge new notes and leave existing notes unchanged</label>
        <p className="backup-limit">A note with a conflicting note, recording or chunk ID is skipped together with all its recordings.</p>
        <label className="checkbox-row"><input type="radio" name="import-mode" checked={mode === 'skip'} onChange={() => setMode('skip')} /> Skip the entire import if any IDs conflict</label>
      </fieldset>
      <button className="btn btn-primary" disabled={!file || busy} onClick={() => void importFile()}>{busy ? 'Validating and importing…' : 'Validate and import'}</button>
    </section>
  </>;
}
