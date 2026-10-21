'use client';

import { useState } from 'react';
import { createNotesRepository } from '../lib/local-notes.js';
import { makeBackup, parseBackup } from '../lib/mvp-utils.mjs';

function download(filename: string, content: string, type: string) { const blob = new Blob([content], { type }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 60_000); }

export default function BackupPage() {
  const [message, setMessage] = useState(''); const [error, setError] = useState(''); const [file, setFile] = useState<File | null>(null); const [mode, setMode] = useState<'merge' | 'skip'>('merge'); const [busy, setBusy] = useState(false); const repo = createNotesRepository();
  async function exportAll() {
    try { setError(''); const notes = await repo.list(); const backup = makeBackup(notes); download(`noteos-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(backup, null, 2), 'application/json'); setMessage(`Download requested for ${notes.length} notes. Check your Downloads to verify the browser saved the file. It contains private writing.`); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not export local notes.'); }
  }
  async function importFile() {
    if (!file) return; setBusy(true); setError(''); setMessage('');
    try { const bundle = parseBackup(await file.text()); const result = await repo.importNotes(bundle.notes, mode); setMessage(`Imported ${result.imported} notes. Kept ${result.skipped} existing notes with matching IDs unchanged.`); setFile(null); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not import this backup.'); }
    finally { setBusy(false); }
  }
  return <>
    <div className="page-heading"><div><p className="eyebrow">Your data, in your hands</p><h1 className="page-title">Backup & restore</h1><p className="page-lede">Move a copy of your notes between browsers or keep an offline archive.</p></div></div>
    <div className="notice"><strong>Private file:</strong> a backup contains your note titles and full note contents. Store it somewhere you trust.</div>
    {error && <div role="alert" className="notice error">{error}</div>}{message && <div role="status" className="notice">{message}</div>}
    <section className="backup-panel"><h2 className="section-title">Export a full backup</h2><p>Download all notes from this device, including archived and trashed notes. This file is a JSON snapshot; exporting does not upload anything.</p><button className="btn btn-primary" onClick={() => void exportAll()}>Download backup</button></section>
    <section className="backup-panel"><h2 className="section-title">Restore from a backup</h2><p>noteOS validates the complete file before writing. Existing note IDs are never overwritten. Unsupported future document schemas are kept as read-only data.</p><label className="file-input">Choose a noteOS backup (.json)<input type="file" accept="application/json,.json" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setError(''); setMessage(''); }} /></label><fieldset style={{ border: 0, padding: 0, margin: '18px 0' }}><legend className="toolbar-label">If an ID already exists</legend><label className="checkbox-row"><input type="radio" name="import-mode" checked={mode === 'merge'} onChange={() => setMode('merge')} /> Merge new notes and leave existing notes unchanged</label><label className="checkbox-row"><input type="radio" name="import-mode" checked={mode === 'skip'} onChange={() => setMode('skip')} /> Skip the entire import if any IDs conflict</label></fieldset><button className="btn btn-primary" disabled={!file || busy} onClick={() => void importFile()}>{busy ? 'Validating and importing…' : 'Validate and import'}</button></section>
  </>;
}
