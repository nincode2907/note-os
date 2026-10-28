'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createNotesRepository } from '../lib/local-notes.js';
import { discoverAi, getAiConsent, grantAiConsent, createAiAnalysisIntent, revokeAiConsent } from '../lib/ai-sync-client.mjs';

type Consent = { noteId: string; state: string; scopes: string[]; providerBoundary: string | null; consentEpoch: number | null; updatedAt: number | null };
type Intent = { requestId: string; kind: string; status: string; localRevision?: number; jobId?: string };

const stateText: Record<string,string> = {
  WAITING_FOR_SYNC: 'Waiting for Text Sync to acknowledge this exact revision.',
  WAITING_FOR_NETWORK: 'Revocation is saved on this device and will reach the server when it reconnects.',
  QUEUED: 'Request accepted by the paired Mac. Any suggestion waits in the AI inbox for your review; the note is not changed.',
  CANCELED: 'This unsent request was canceled.',
  STALE: 'The note changed before delivery. Nothing was queued for a different revision.',
  NEEDS_CONSENT: 'Server consent changed. Review consent and make a new explicit request.',
  ERROR: 'The request could not be completed. Retry after reviewing the current note and consent.',
  REVOKED: 'Server consent is revoked. No analysis request was run.',
};

export function AiConsentPanel({ noteId, localRevision, privacy, lifecycle, canRequest }: { noteId: string; localRevision: number; privacy?: string; lifecycle: string; canRequest: boolean }) {
  const repository = useMemo(() => createNotesRepository(), []);
  const [available, setAvailable] = useState(false), [paired, setPaired] = useState(true), [consent, setConsent] = useState<Consent | null>(null);
  const [latestIntent, setLatestIntent] = useState<Intent | null>(null), [baselineReady, setBaselineReady] = useState(false);
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [boundary, setBoundary] = useState<'MOCK' | 'STRICT_LOCAL'>('MOCK'), [inferenceAvailable, setInferenceAvailable] = useState(false);
  const busyRef = useRef(false);

  const refresh = useCallback(async () => {
    const cache = await repository.getAiConsentCache(noteId);
    const localIntents: Intent[] = await repository.listAiIntents(noteId);
    const baseline = await repository.getSyncBaseline(noteId);
    setLatestIntent(localIntents.filter(row => row.kind === 'analysis').at(-1) ?? localIntents.at(-1) ?? null);
    setBaselineReady(Boolean(baseline && baseline.localRevision === localRevision && baseline.serverVersion > 0));
    if (cache && cache.state !== 'REVOKE_PENDING') { setAvailable(true); setConsent(cache); }
    try {
      const state = await discoverAi();
      if (!state.enabled) { setAvailable(false); return; }
      setAvailable(true);
      setBoundary(state.executionBoundary === 'STRICT_LOCAL' ? 'STRICT_LOCAL' : 'MOCK'); setInferenceAvailable(state.inferenceAvailable === true);
      if (privacy === 'DEVICE_ONLY' || !['PRIVATE_SERVER','CLOUD_ALLOWED'].includes(privacy ?? '')) return;
      try {
        const fresh = await getAiConsent(noteId);
        await repository.cacheAiConsent(fresh);
        setConsent(fresh); setPaired(true); setMessage('');
      } catch (error: any) {
        if (error.status === 401) { setPaired(false); setMessage('Pair this browser in Sync Setup to manage server consent.'); }
        else if (error.code === 'ai_disabled') setAvailable(false);
        else if (cache) setMessage('Offline. The cached consent is rechecked with the server before any request is queued.');
        else setMessage('Connect to the paired Mac to check AI consent.');
      }
    } catch (error: any) {
      if (error.code === 'ai_disabled') { setAvailable(false); return; }
      if (cache) { setAvailable(true); setConsent(cache); setMessage('Offline. Server consent is rechecked before delivery.'); }
      else setAvailable(false);
    }
  }, [noteId, localRevision, privacy, repository]);

  useEffect(() => {
    void refresh();
    const changed = () => { void refresh(); };
    window.addEventListener('noteos:sync-state-changed', changed);
    window.addEventListener('online', changed);
    return () => { window.removeEventListener('noteos:sync-state-changed', changed); window.removeEventListener('online', changed); };
  }, [refresh]);

  async function perform(action: () => Promise<any>, success: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setMessage('');
    try { const value = await action(); if (value && ['APPROVED_LOCAL_ONLY','APPROVED_CLOUD_ALLOWED','NONE','REVOKED'].includes(value.state)) { await repository.cacheAiConsent(value); setConsent(value); } await refresh(); setMessage(success); }
    catch (error: any) {
      if (error.status === 401) setPaired(false);
      setMessage(error.code === 'DEVICE_ONLY' ? 'This note is DEVICE_ONLY. Its privacy was not changed.' : error.code === 'SYNC_REQUIRED' ? 'Sync this exact note revision to the paired Mac first.' : error.code === 'STALE_REVISION' ? 'This revision changed on the server. Sync and review it before retrying.' : error.code === 'ai_disabled' ? 'AI requests are disabled on this server.' : error.message || 'The AI request could not be completed.');
      await refresh();
    } finally { busyRef.current = false; setBusy(false); }
  }

  if (!available) return null;
  const eligiblePrivacy = ['PRIVATE_SERVER','CLOUD_ALLOWED'].includes(privacy ?? '');
  const hasConsent = consent?.state === 'APPROVED_LOCAL_ONLY' && consent.providerBoundary === boundary && consent.scopes?.includes('organize');
  const local = boundary === 'STRICT_LOCAL';
  const boundaryLabel = local ? 'local model on the paired Mac' : 'MOCK test boundary';

  return <section className="ai-consent-panel" aria-labelledby={`ai-title-${noteId}`}>
    <h2 id={`ai-title-${noteId}`}>AI request controls</h2>
    <p>Consent and an analysis request are separate actions. {local
      ? `Analysis runs only on a local model on your paired Mac through the local AI Gateway${inferenceAvailable ? '' : ' (currently paused)'}. Note content is never sent to a cloud provider, and suggestions never change the note until you approve them.`
      : 'This server only accepts the MOCK test boundary: it will queue metadata and will not run a model or send content to an external provider.'}</p>
    {privacy === 'DEVICE_ONLY' ? <div className="notice">This note is DEVICE_ONLY. AI requests are unavailable, and noteOS will not change its privacy setting.</div>
      : !eligiblePrivacy ? <div className="notice">This note has no eligible server privacy classification. AI consent is unavailable.</div>
        : <>
          {!paired && <div className="notice">{message || 'Pair this browser in Sync Setup before using AI requests.'}</div>}
          {paired && <>
            <p className="ai-consent-state" aria-live="polite">Server consent: <strong>{hasConsent ? `Granted for organize · ${local ? 'local model only' : 'MOCK only'}` : consent?.state === 'REVOKED' ? 'Revoked' : 'None'}</strong></p>
            {!hasConsent && <div className="ai-consent-confirm">
              <label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={busy || !baselineReady || !canRequest} /> I allow explicit organize requests for this note using the {boundaryLabel}. This does not authorize an external provider.</label>
              <p>Sending content to an external provider is unavailable in this phase.</p>
              <button className="btn" type="button" disabled={busy || !confirmed || !baselineReady || !canRequest || typeof navigator === 'undefined' || !navigator.onLine || lifecycle !== 'active'} onClick={() => void perform(async () => {
                const baseline = await repository.getSyncBaseline(noteId), sync = await repository.getSyncState();
                if (!baseline || baseline.localRevision !== localRevision || !sync.state.history?.serverEpoch) throw Object.assign(new Error('Sync this exact note revision to the paired Mac first.'), { code: 'SYNC_REQUIRED' });
                return grantAiConsent(noteId, { serverEpoch: sync.state.history.serverEpoch, serverVersion: baseline.serverVersion, contentHash: baseline.contentHash }, { executionBoundary: boundary });
              }, local ? 'Consent recorded for organize requests on the local model. Nothing is analyzed until you request it.' : 'Consent recorded for organize requests at the MOCK boundary. No model is enabled.')}>Grant consent</button>
              {!baselineReady && <span className="save-state">Sync this exact revision before granting.</span>}
            </div>}
            {hasConsent && <div className="ai-request-actions">
              <button className="btn btn-primary" type="button" disabled={busy || !canRequest || lifecycle !== 'active'} onClick={() => void perform(async () => {
                const row = await createAiAnalysisIntent({ repository, noteId, localRevision }); setLatestIntent(row); return null;
              }, 'Request saved. It will be sent only for this exact acknowledged revision; no analysis was run.')}>Request analysis for this revision</button>
              <button className="btn btn-quiet" type="button" disabled={busy} onClick={() => void perform(async () => {
                const row = await revokeAiConsent({ repository, noteId }); setLatestIntent(row); return null;
              }, 'Local pending requests were canceled. Server revocation is confirmed only after the paired Mac accepts it.')}>Revoke consent</button>
            </div>}
            {latestIntent && <div className="ai-request-status" role="status"><p>{stateText[latestIntent.status] ?? `Request state: ${latestIntent.status}`}</p>{latestIntent.kind === 'analysis' && latestIntent.status === 'WAITING_FOR_SYNC' && <button className="btn btn-quiet" type="button" disabled={busy} onClick={() => void perform(async () => repository.updateAiIntent(latestIntent.requestId, 'CANCELED'), 'Unsent analysis intent canceled.')}>Cancel unsent request</button>}</div>}
          </>}
        </>}
    {message && paired && <p className="ai-consent-feedback" role="status">{message}</p>}
  </section>;
}
