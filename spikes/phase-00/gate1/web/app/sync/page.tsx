'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { discoverLocal } from '../lib/sync-discovery.mjs';
import { assertHistoryContinuity } from '../lib/sync-protocol.mjs';
import { createNotesRepository } from '../lib/local-notes.js';
import { synchronize } from '../lib/sync-client.mjs';

export default function SyncSetup() {
  const [origin, setOrigin] = useState('This browser');
  const [state, setState] = useState('Checking server…');
  const [enabled, setEnabled] = useState(false);
  const [server, setServer] = useState<any>(null);
  const [local, setLocal] = useState<any>(null);
  const [preview, setPreview] = useState<any>(null);
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [defaultEnrollment, setDefaultEnrollment] = useState(false);
  const [overview, setOverview] = useState<any>(null);
  const [syncStatus, setSyncStatus] = useState('Saved on device');
  const [enrollmentSummary, setEnrollmentSummary] = useState('');
  const repository = createNotesRepository();

  async function api(action: string, data?: any) {
    const result = await fetch(`/api/v1/sync/${action}`, { method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: data === undefined ? {} : { 'Content-Type': 'application/json', 'X-NoteOS-Sync': '1' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const body = await result.json();
    const messages: Record<string,string> = {
      pairing_invalid_or_expired: 'The pairing code expired or was already used. Request a new code.',
      pairing_rate_limited: 'Too many pairing attempts. Wait two minutes before trying again.',
      invalid_pairing_request: 'Enter a device label and the complete pairing code.',
      invalid_bootstrap_summaries: 'Some record summaries cannot be previewed safely. No notes were changed.',
      payload_too_large: 'This library exceeds the preview size limit. No notes were changed.',
      preview_capacity_exceeded: 'The server library exceeds this milestone’s preview capacity.',
      origin_denied: 'This browser address is not approved for the private server.',
      csrf_denied: 'This request could not be verified. Reload the page and try again.',
      authentication_required: 'This browser needs to be paired again.',
      sync_disabled: 'The private API is disabled.',
      sync_storage_unavailable: 'The private server storage is unavailable. Local notes remain available.',
    };
    if (!result.ok) throw Object.assign(new Error(messages[body.error] ?? 'The private server request could not be completed.'), { status: result.status });
    return body;
  }
  async function checkHistory(next: any) {
    try {
      const saved = await repository.getSyncState();
      assertHistoryContinuity(saved.state.history ?? null, next);
    } catch {
      await repository.saveSyncRecovery('Server history changed or cannot be verified.', next);
      setRecovery(true); throw new Error('Server history changed or cannot be verified. Preview stopped; request recovery review.');
    }
  }
  async function connection() {
    try { const next = await api('status'); await checkHistory(next); await repository.setSyncPaired(true); setServer(next); setEnabled(true); setState('This browser is paired. Sync is available after you approve notes.'); }
    catch (cause: any) {
      if (cause.status === 401) { if (await repository.hasExistingDatabase()) await repository.setSyncPaired(false); setEnabled(true); setServer(null); setState('This browser is not paired.'); }
      else if (cause.status === 503) { setEnabled(false); setServer(null); setState('Private API is disabled or unavailable. Local notes remain available.'); }
      else { setError(cause.message); setState('Connection needs review.'); }
    }
  }
  async function refreshOverview() { try { setOverview(await repository.getSyncOverview()); } catch { setOverview(null); } }
  useEffect(() => { setOrigin(location.origin); void connection(); void refreshOverview(); }, []);
  async function run(action: () => Promise<void>) {
    if (busy) return; setBusy(true); setError('');
    try { await action(); } catch (cause: any) { setError(cause.message); } finally { setBusy(false); }
  }
  async function inspect() {
    setPreview(null); const next = await discoverLocal(); setLocal(next);
    setSelectedIds(next.candidates.filter((row: any) => !row.enrolled).map((row: any) => row.id));
    const saved = await repository.getSyncState(); setDefaultEnrollment(saved.state.defaultEnrollment === true);
    await refreshOverview();
  }
  async function enrollSelected() {
    const before = local?.candidates.filter((row: any) => row.enrolled).length ?? 0, count = selectedIds.length;
    await repository.setSyncEnrollment(selectedIds, true);
    setEnrollmentSummary(`Enrollment count: ${before} before · ${before + count} after. ${count} notes were added to this browser’s approved sync scope.`);
    setLocal(await discoverLocal()); setSelectedIds([]);
  }
  async function syncNow() {
    const result = await synchronize({ repository, initialize: true, onState: value => setSyncStatus(value) });
    setSyncStatus(({ 'needs-review': 'Needs review', synced: 'Text synced', pending: 'Pending', 'media-local-only': 'Audio stays on this device', 'saved-device': 'Saved on device' } as Record<string,string>)[result.status] ?? 'Saved on device');
    setLocal(await discoverLocal()); await refreshOverview(); await connection();
  }
  return <div className="sync-setup">
    <header className="page-heading"><div><p className="eyebrow">Private connection</p><h1 className="page-title">Sync Setup</h1><p className="page-lede">Prepare a connection at your own pace.</p></div></header>
    <div className="notice" role="status"><strong>Text sync only.</strong> Audio bytes are never transferred, Delete Forever stays local, and no note is enrolled until you approve its scope here.</div>
    <section className="backup-panel"><h2 className="section-title">Saved locally</h2>
      <p>Current origin: <code className="sync-origin">{origin}</code></p><p>Localhost, the private HTTPS address, and each browser on each device have separate storage. Saved locally does not mean synced.</p>
      <button className="btn btn-secondary" disabled={busy} onClick={() => run(inspect)}>Inspect this browser</button>
      {local && <div className="sync-inventory"><p>{local.noteCount} local notes · {local.recordingCount} local recordings · {local.candidates.filter((row: any) => row.enrolled).length} enrolled</p><p>{local.excludedCount} notes are currently excluded. Notes with explicit DEVICE_ONLY privacy or recordings are never offered for this text-only sync.</p>
        {enrollmentSummary && <p role="status">{enrollmentSummary}</p>}
        {local.candidates.length > 0 && <><h3>Approve existing notes</h3><p>Select the notes to include. This does not change Canonical Document v1 or your existing privacy field.</p><div className="sync-candidate-list">{local.candidates.map((row: any) => <label key={row.id}><input type="checkbox" checked={row.enrolled || selectedIds.includes(row.id)} disabled={row.enrolled} onChange={event => setSelectedIds(current => event.target.checked ? [...current,row.id] : current.filter(id => id !== row.id))} /> {row.title} <span>· {row.lifecycle}{row.hasPrivacy ? '' : ' · no privacy permission set'}</span></label>)}</div><button className="btn btn-secondary" disabled={busy || selectedIds.length === 0} onClick={() => run(enrollSelected)}>Approve {selectedIds.length} selected notes</button></>}
        <label className="sync-default-enrollment"><input type="checkbox" checked={defaultEnrollment} onChange={event => { const value=event.target.checked; void repository.setDefaultSyncEnrollment(value).then(() => setDefaultEnrollment(value)).catch(() => setError('Could not save this browser’s new-note sync preference.')); }} /> Include new notes created on this browser after enrollment</label>
      </div>}
      <p><Link href="/backup">Export a fresh Full Archive V2</Link> from every origin with important data before activation. Verify native Expo notes and recordings separately. An old archive or Legacy JSON is not a current full backup.</p>
    </section>
    <section className="backup-panel"><h2 className="section-title">Private server</h2><p>{state}</p>
      <button className="btn btn-secondary" disabled={busy || recovery} onClick={() => run(connection)}>Check connection</button>
      {enabled && !server && !recovery && <form className="sync-pair-form" onSubmit={event => { event.preventDefault(); void run(async () => { try { await api('pair', { code, label }); } finally { setCode(''); } await connection(); }); }}>
        <p>Get a fresh 120-second pairing code from the owner’s local terminal. Keep it private.</p>
        <label>Device label<input className="searchbox" aria-label="Device label" value={label} maxLength={80} required autoComplete="off" onChange={e => setLabel(e.target.value)} /></label>
        <label>Pairing code<input className="searchbox" aria-label="Pairing code" type="password" value={code} minLength={12} maxLength={12} required autoComplete="off" autoCapitalize="none" spellCheck={false} onChange={e => setCode(e.target.value)} /></label>
        <button className="btn btn-primary" disabled={busy}>Pair this browser</button>
      </form>}
      {server && <><p>Paired as {server.device.label}. Server contains {server.noteCount} note records.</p><button className="text-button" disabled={busy} onClick={() => run(async () => { await api('revoke', {}); setPreview(null); await connection(); })}>Revoke this browser</button></>}
    </section>
    <section className="backup-panel"><h2 className="section-title">Bootstrap preview</h2><p>With your request, send IDs, content hashes, lifecycle, local revision and recording counts for notes already marked PRIVATE_SERVER or CLOUD_ALLOWED. No titles, note text or audio bytes are sent. DEVICE_ONLY notes and notes with missing privacy remain excluded.</p>
      <button className="btn btn-secondary" disabled={busy || !server || !local || recovery} onClick={() => run(async () => { setPreview(null); const next = await api('bootstrap/dry-run', { protocolVersion: 1, records: local.records }); await checkHistory(next); setPreview(next); })}>Send summaries for preview</button>
      {preview && <div className="sync-preview" aria-label="Bootstrap comparison"><p>{preview.serverEmpty ? 'The server has no user data. This cannot establish conflicts between your populated devices.' : 'Compared against the server’s current records. Matching IDs alone do not mean matching content.'}</p><dl>{[['toUpload','Would upload'],['toDownload','Would download'],['identical','Identical text-only'],['collidingIds','IDs needing review'],['audioRequiresReview','Audio requires review']].map(([key,title]) => <div key={key}><dt>{title}</dt><dd>{preview[key].length}</dd></div>)}</dl><p>Preview only. No note records were changed. Notes with recordings are ineligible for a future text-only pilot until media-presence safety is implemented. Delete Forever across devices is unavailable.</p></div>}
    </section>
    <section className="backup-panel"><h2 className="section-title">Sync now</h2><p>{syncStatus}. Local edits are saved first. Unpaired browsers and unavailable servers keep working offline.</p><button className="btn btn-primary" disabled={busy || !server || recovery} onClick={() => run(syncNow)}>Sync now</button></section>
    {overview && <section className="backup-panel" aria-label="Local sync status"><h2 className="section-title">Local sync status</h2>
      <p>{overview.eligiblePending} pending text changes · {overview.blockedPending} blocked changes · {overview.quarantined} quarantined · {overview.recordings} local recordings.</p>
      {overview.mediaLocalOnly > 0 && <p role="status">{overview.mediaLocalOnly} notes have audio that stays on this device; {overview.textSyncedWithMedia} of those notes also have acknowledged text. This is not a full-data backup.</p>}
      {overview.conflictRecords.length > 0 && <div role="status"><h3>Needs review · local copies</h3>{overview.conflictRecords.map((conflict: any) => <p key={conflict.id}>{conflict.kind}: {conflict.conflictNoteId ? 'a conflict copy is saved on this device and was not uploaded' : 'local and remote versions are preserved on this device'}.</p>)}<p>To retain a conflict copy as a separate note, inspect this browser’s notes and explicitly approve that copy.</p></div>}
      {overview.recovery && <p role="alert">Sync is paused for recovery review: {overview.recovery.reason}</p>}
    </section>}
    {error && <p className="notice error" role="alert">{error}</p>}
    <p className="storage-caption">Tailnet access and device authentication do not provide application-level E2EE. <Link href="/">Continue with local notes</Link>.</p>
  </div>;
}
