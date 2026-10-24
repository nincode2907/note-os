'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createAudioRepository } from '../lib/local-notes.js';
import { acquireRecordingLock } from '../lib/recording-lock.mjs';
import { ActiveMediaClock, createAudioAnchor, formatAudioTimestamp } from '../lib/audio-anchors.mjs';

type AudioAnchor = { id: string; recordingId: string; offsetMs: number; label: string; createdAt: number };
type Recording = { id: string; noteId: string; title: string; mimeType: string; status: 'recording' | 'paused' | 'complete' | 'interrupted' | 'failed'; createdAt: number; durationMs: number; chunkCount: number; audioAnchors?: { version: 1; items: AudioAnchor[] } };
const repo = createAudioRepository();

function formatDuration(durationMs: number) {
  const total = Math.floor(durationMs / 1000), hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60), seconds = total % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : `${minutes}:${String(seconds).padStart(2, '0')}`;
}
function recordingStatus(status: Recording['status']) {
  return ({ recording: 'Unfinished session — keep this noteOS tab open', paused: 'Paused session — resume in its original tab', complete: 'Saved', interrupted: 'Partial recording recovered', failed: 'Partially saved — storage failed' })[status];
}
function supportedMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}
function extension(mimeType: string) {
  const base = mimeType.split(';')[0].toLowerCase();
  if (base === 'audio/mp4' || base === 'audio/x-m4a') return 'm4a';
  if (base === 'audio/ogg') return 'ogg';
  if (base === 'audio/wav' || base === 'audio/wave') return 'wav';
  return 'webm';
}

export function AudioRecorder({ noteId, disabled = false, openSignal = 0, onActivityChange }: { noteId: string; disabled?: boolean; openSignal?: number; onActivityChange?: (active: boolean) => void }) {
  const [recordings, setRecordings] = useState<Recording[]>([]), [active, setActive] = useState<Recording | null>(null);
  const [statusText, setStatusText] = useState('Ready to record on this device.'), [error, setError] = useState(''), [starting, setStarting] = useState(false), [audioReady, setAudioReady] = useState(false), [pauseSupported, setPauseSupported] = useState(true);
  const [elapsed, setElapsed] = useState(0), [editId, setEditId] = useState(''), [editTitle, setEditTitle] = useState(''), [expanded, setExpanded] = useState(true);
  const [players, setPlayers] = useState<Record<string, string>>({}), [anchorEditId, setAnchorEditId] = useState(''), [anchorEditLabel, setAnchorEditLabel] = useState('');
  const [audioApproved, setAudioApproved] = useState(false), [audioStates, setAudioStates] = useState<Record<string, any>>({});
  const playerElementsRef = useRef<Record<string, HTMLAudioElement | null>>({}), pendingSeekRef = useRef<Record<string, { offsetMs: number; play: boolean }>>({});
  const recorderRef = useRef<MediaRecorder | null>(null), streamRef = useRef<MediaStream | null>(null), sessionRef = useRef<Recording | null>(null);
  const lockReleaseRef = useRef<(() => Promise<void>) | null>(null), writerRef = useRef<Promise<unknown>>(Promise.resolve()), sequenceRef = useRef(0), mediaClockRef = useRef(new ActiveMediaClock());
  const stopReasonRef = useRef<'complete' | 'interrupted' | 'failed'>('complete'), writeFailedRef = useRef(false), startingRef = useRef(false), mountedRef = useRef(true), objectUrlsRef = useRef(new Set<string>());
  const refresh = useCallback(async () => { try { const next = await repo.list(noteId) as Recording[]; const approval = await repo.getSyncApproval(noteId); const states = Object.fromEntries(await Promise.all(next.map(async (item: Recording) => [item.id, await repo.getSyncStateForRecording(item.id)]))); if (mountedRef.current) { setRecordings(next); setAudioApproved(Boolean(approval?.approved)); setAudioStates(states); } } catch (cause) { if (mountedRef.current) setError(cause instanceof Error ? cause.message : 'Could not read local recordings.'); } }, [noteId]);

  useEffect(() => { if (openSignal > 0) setExpanded(true); }, [openSignal]);
  useEffect(() => { if (active || starting) setExpanded(true); }, [active, starting]);
  useEffect(() => { window.addEventListener('noteos:sync-state-changed', refresh); return () => window.removeEventListener('noteos:sync-state-changed', refresh); }, [refresh]);

  useEffect(() => {
    mountedRef.current = true;
    void (async () => {
      try {
        const unfinished = await repo.listUnfinished();
        let recoveredCount = 0;
        if (typeof (navigator as any).locks?.request === 'function') {
          for (const recording of unfinished) {
            const claim = await acquireRecordingLock(navigator.locks, recording.noteId);
            if (!claim.release) continue;
            try { if (await repo.recover(recording.id)) recoveredCount += 1; }
            finally { await claim.release(); }
          }
        } else if (unfinished.length) {
          setStatusText('Unfinished audio is preserved. This browser cannot verify ownership for automatic recovery.');
        }
        if (recoveredCount) setStatusText(`${recoveredCount} unfinished recording${recoveredCount === 1 ? '' : 's'} recovered as partial audio.`);
        await refresh();
        if (mountedRef.current) setAudioReady(true);
      } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not open local audio storage.'); }
    })();
    return () => {
      mountedRef.current = false;
      const recorder = recorderRef.current;
      onActivityChange?.(false);
      if (recorder && recorder.state !== 'inactive') {
        stopReasonRef.current = 'interrupted';
        mediaClockRef.current.pause();
        try { recorder.stop(); } catch { /* The browser may already have stopped it. */ }
      } else {
        for (const track of streamRef.current?.getTracks() ?? []) track.stop();
        streamRef.current = null;
      }
      for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
      objectUrlsRef.current.clear();
    };
  }, [refresh]);

  useEffect(() => {
    if (!active || active.status !== 'recording') return;
    const timer = window.setInterval(() => setElapsed(mediaClockRef.current.read()), 100);
    return () => window.clearInterval(timer);
  }, [active?.id, active?.status]);

  async function startRecording() {
    if (startingRef.current) return;
    startingRef.current = true; setStarting(true);
    setError('');
    if (disabled) { startingRef.current = false; setStarting(false); return; }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { setError('Audio recording is not supported by this browser.'); setStatusText('Unsupported browser'); startingRef.current = false; setStarting(false); return; }
    const mimeType = supportedMimeType();
    if (!mimeType) { setError('This browser does not report a supported audio format.'); setStatusText('Unsupported audio format'); startingRef.current = false; setStarting(false); return; }
    let claim;
    try { claim = await acquireRecordingLock(navigator.locks, noteId); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not verify recording ownership.'); setStatusText('Safe recording ownership is unavailable'); startingRef.current = false; setStarting(false); return; }
    if (!claim.supported) {
      setError('This browser cannot safely coordinate recording across tabs. Audio recording is unavailable here.');
      setStatusText('Safe recording ownership is unavailable'); startingRef.current = false; setStarting(false); return;
    }
    if (!claim.release) {
      setError('Another tab or recorder already owns audio for this note. Stop it there before starting another recording.');
      startingRef.current = false; setStarting(false); return;
    }
    lockReleaseRef.current = claim.release;
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (cause: any) {
      const message = cause?.name === 'NotAllowedError' || cause?.name === 'SecurityError' ? 'Microphone permission was denied. Allow microphone access in browser settings and try again.' : cause?.name === 'NotFoundError' || cause?.name === 'DevicesNotFoundError' ? 'No microphone is available on this device.' : 'Could not start the microphone. Check browser permission and device settings.';
      await claim.release(); lockReleaseRef.current = null;
      if (mountedRef.current) { setError(message); setStatusText('Recording did not start'); setStarting(false); }
      startingRef.current = false; return;
    }
    if (!mountedRef.current) { for (const track of stream.getTracks()) track.stop(); await claim.release(); lockReleaseRef.current = null; startingRef.current = false; return; }
    let session: Recording | null = null;
    try {
      const createdSession = await repo.create(noteId, { mimeType, ownerId: crypto.randomUUID() }) as Recording;
      session = createdSession;
      if (!mountedRef.current) { await repo.setStatus(createdSession.id, 'interrupted'); for (const track of stream.getTracks()) track.stop(); await claim.release(); lockReleaseRef.current = null; startingRef.current = false; return; }
      const recorder = new MediaRecorder(stream, { mimeType });
      setPauseSupported(typeof recorder.pause === 'function' && typeof recorder.resume === 'function');
      streamRef.current = stream; recorderRef.current = recorder; sessionRef.current = createdSession;
      sequenceRef.current = 0; mediaClockRef.current.start(); writeFailedRef.current = false; stopReasonRef.current = 'complete'; writerRef.current = Promise.resolve();
      setElapsed(0); setActive(createdSession); onActivityChange?.(true); setStatusText('Recording — audio chunks are being saved on this device.'); void refresh();
      recorder.ondataavailable = (event) => {
        if (!event.data.size || writeFailedRef.current) return;
        const sequence = sequenceRef.current++, duration = mediaClockRef.current.read();
        writerRef.current = writerRef.current.then(() => repo.appendChunk(createdSession.id, sequence, event.data, duration)).catch(async (cause) => {
          writeFailedRef.current = true; stopReasonRef.current = 'failed';
          if (mountedRef.current) { setError(`Audio could not be saved locally: ${cause instanceof Error ? cause.message : 'storage error'}. The saved chunks remain available as a partial recording.`); setStatusText('Storage write failed'); }
          try { if (recorder.state !== 'inactive') { mediaClockRef.current.pause(); recorder.stop(); } } catch { /* Stop event cleanup handles the stream. */ }
        });
      };
      recorder.onerror = () => { stopReasonRef.current = 'failed'; mediaClockRef.current.pause(); if (mountedRef.current) { setError('The browser recorder failed. Any stored chunks are kept as a partial recording.'); setStatusText('Recorder failed'); } try { if (recorder.state !== 'inactive') recorder.stop(); } catch { /* Stop event cleanup handles the stream. */ } };
      recorder.onstop = () => {
        void (async () => {
          await writerRef.current;
          const reason = writeFailedRef.current ? 'failed' : stopReasonRef.current;
          try {
            const finalStatus = reason === 'complete' && sequenceRef.current === 0 ? 'failed' : reason;
            const saved = await repo.setStatus(createdSession.id, finalStatus, { durationMs: mediaClockRef.current.stop() });
            if (mountedRef.current) { setActive(null); onActivityChange?.(false); setStatusText(finalStatus === 'complete' ? 'Recording saved on this device.' : reason === 'complete' ? 'No audio was captured. The empty recording was not marked saved.' : 'Recording stopped unexpectedly. Any saved audio is available as a partial recording.'); }
          } catch (cause) { if (mountedRef.current) setError(cause instanceof Error ? cause.message : 'Could not finalize recording.'); }
          finally { await lockReleaseRef.current?.(); lockReleaseRef.current = null; }
          for (const track of stream.getTracks()) track.stop();
          if (streamRef.current === stream) streamRef.current = null;
          if (recorderRef.current === recorder) recorderRef.current = null;
          if (sessionRef.current?.id === createdSession.id) sessionRef.current = null;
          if (mountedRef.current) { setActive(null); onActivityChange?.(false); await refresh(); }
        })();
      };
      for (const track of stream.getAudioTracks()) track.addEventListener('ended', () => {
        if (recorder.state !== 'inactive') { stopReasonRef.current = 'interrupted'; mediaClockRef.current.pause(); try { recorder.stop(); } catch { /* Already stopped. */ } }
      }, { once: true });
      recorder.start(1000);
      startingRef.current = false; setStarting(false);
    } catch (cause: any) {
      if (session) await repo.setStatus(session.id, 'failed').catch(() => {});
      await claim.release(); lockReleaseRef.current = null;
      for (const track of stream.getTracks()) track.stop(); streamRef.current = null;
      recorderRef.current = null; sessionRef.current = null;
      if (mountedRef.current) {
        setError(cause?.name === 'QuotaExceededError' ? 'Local storage is full. Free space before recording.' : cause instanceof Error ? cause.message : 'Could not save this recording locally.');
        onActivityChange?.(false); setStatusText('Recording did not start'); await refresh();
      }
      startingRef.current = false; if (mountedRef.current) setStarting(false);
    }
  }

  function stopRecording() {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    mediaClockRef.current.stop();
    stopReasonRef.current = 'complete'; setStatusText('Finishing and saving audio chunks…');
    try { recorder.stop(); } catch (cause) { stopReasonRef.current = 'failed'; setError(cause instanceof Error ? cause.message : 'Could not stop recording.'); }
  }
  async function pauseRecording() {
    const recorder = recorderRef.current, session = sessionRef.current;
    if (!recorder || !session) return;
    if (recorder.state === 'recording') {
      try { recorder.pause(); const durationMs = mediaClockRef.current.pause(); const saved = await repo.setStatus(session.id, 'paused', { durationMs }); setActive(saved); setElapsed(durationMs); setStatusText('Paused — saved chunks are retained locally.'); }
      catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not pause recording.'); }
    } else if (recorder.state === 'paused') {
      try { recorder.resume(); mediaClockRef.current.resume(); const saved = await repo.setStatus(session.id, 'recording'); setActive(saved); setStatusText('Recording — audio chunks are being saved on this device.'); }
      catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not resume recording.'); }
    }
  }
  async function saveAnchor(recordingId: string, offsetMs: number) {
    try {
      const anchor = createAudioAnchor(recordingId, Math.round(offsetMs));
      const updated = await repo.addAnchor(recordingId, anchor);
      if (sessionRef.current?.id === recordingId) { sessionRef.current = updated; setActive(updated); }
      await refresh(); setStatusText(`Bookmark saved at ${formatDuration(anchor.offsetMs)}.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save this bookmark.'); }
  }
  async function addRecordingBookmark() {
    const activeSession = sessionRef.current;
    if (activeSession) await saveAnchor(activeSession.id, mediaClockRef.current.read());
  }
  function playerLoaded(recordingId: string, audio: HTMLAudioElement) {
    const pending = pendingSeekRef.current[recordingId];
    if (!pending || audio.readyState < 1) return;
    audio.currentTime = Number.isFinite(audio.duration) ? Math.min(pending.offsetMs / 1000, Math.max(0, audio.duration)) : pending.offsetMs / 1000;
    delete pendingSeekRef.current[recordingId];
    if (pending.play) void audio.play().catch(() => setError('The browser could not start playback. Use the audio controls and try again.'));
  }
  async function playRecording(recording: Recording, offsetMs = 0, play = false) {
    try {
      const existing = playerElementsRef.current[recording.id];
      if (players[recording.id] && existing?.readyState && existing.readyState >= 1 && Number.isFinite(existing.duration)) {
        existing.currentTime = Math.min(offsetMs / 1000, Math.max(0, existing.duration));
        if (play) await existing.play();
        return;
      }
      pendingSeekRef.current[recording.id] = { offsetMs, play };
      if (players[recording.id]) return;
      const rows = await repo.chunks(recording.id);
      if (!rows.length) throw new Error('No saved audio chunks are available.');
      const blob = new Blob(rows.map((row: any) => row.blob), { type: recording.mimeType });
      const url = URL.createObjectURL(blob); objectUrlsRef.current.add(url);
      setPlayers((current) => { const old = current[recording.id]; if (old) { URL.revokeObjectURL(old); objectUrlsRef.current.delete(old); } return { ...current, [recording.id]: url }; });
    } catch (cause) { if (!(cause instanceof DOMException && cause.name === 'AbortError')) setError(cause instanceof Error ? cause.message : 'Could not load audio for playback.'); }
  }
  async function addPlaybackBookmark(recording: Recording) {
    const audio = playerElementsRef.current[recording.id];
    if (!audio || !Number.isFinite(audio.currentTime)) { setError('Wait for audio playback to load before bookmarking its position.'); return; }
    await saveAnchor(recording.id, Math.round(audio.currentTime * 1000));
  }
  async function renameAudioAnchor(recordingId: string, anchorId: string) {
    try { await repo.renameAnchor(recordingId, anchorId, anchorEditLabel); setAnchorEditId(''); setAnchorEditLabel(''); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not rename bookmark.'); }
  }
  async function removeAudioAnchor(recordingId: string, anchorId: string) {
    try { await repo.removeAnchor(recordingId, anchorId); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not delete bookmark.'); }
  }
  async function downloadRecording(recording: Recording) {
    try {
      const rows = await repo.chunks(recording.id);
      if (!rows.length) throw new Error('No saved audio chunks are available.');
      const blob = new Blob(rows.map((row: any) => row.blob), { type: recording.mimeType });
      const url = URL.createObjectURL(blob); objectUrlsRef.current.add(url);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${recording.title.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'noteOS-recording'}.${extension(recording.mimeType)}`; anchor.click();
      window.setTimeout(() => { URL.revokeObjectURL(url); objectUrlsRef.current.delete(url); }, 60_000);
      setStatusText('Audio export requested. Check your Downloads; noteOS cannot verify the browser saved the file.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not export audio.'); }
  }
  async function removeRecording(recording: Recording) {
    if (!window.confirm(`Delete “${recording.title}” and its local audio from this device? This cannot be undone.`)) return;
    try { await repo.remove(recording.id); const url = players[recording.id]; if (url) { URL.revokeObjectURL(url); objectUrlsRef.current.delete(url); setPlayers((current) => { const next = { ...current }; delete next[recording.id]; return next; }); } setStatusText('Recording deleted from this device.'); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not delete recording.'); }
  }
  async function saveRename(recording: Recording) {
    try { await repo.rename(recording.id, editTitle); setEditId(''); setEditTitle(''); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not rename recording.'); }
  }
  async function recoverRecording(recording: Recording) {
    try {
      if (typeof (navigator as any).locks?.request === 'function') {
        const claim = await acquireRecordingLock(navigator.locks, recording.noteId);
        if (!claim.release) { setError('This recording still has a live owner. Stop it in its original tab first.'); return; }
        try { await repo.recover(recording.id); }
        finally { await claim.release(); }
      } else {
        const confirmed = window.confirm('Confirm every noteOS tab with this note is closed and no recording is active. Recover the saved chunks as a partial recording?');
        if (!confirmed) return;
        await repo.recover(recording.id);
      }
      setStatusText('Saved audio chunks were recovered as a partial recording.'); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not recover the partial recording.'); }
  }
  async function setAudioSyncApproval(approved: boolean) {
    try { await repo.setSyncApproval(noteId, approved); setAudioApproved(approved); setStatusText(approved ? 'Audio sync approved for this note. Transfer will resume while noteOS is open.' : 'Audio sync approval removed for this device.'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update audio sync approval.'); }
  }
  function retryAudioSync() { window.dispatchEvent(new Event('noteos:sync-state-changed')); setStatusText('Audio sync retry requested.'); }
  async function resolveAudioConflict(recordingId: string, keepRemote: boolean) {
    try {
      const state = await repo.getSyncStateForRecording(recordingId), remote = state?.conflict?.remote;
      if (!state || !remote?.recording || !Number.isSafeInteger(state.conflict.serverVersion)) throw new Error('The saved conflict details are incomplete. Keep the local recording for review.');
      if (keepRemote) await repo.applyRemoteAudioMetadata(recordingId, remote);
      await repo.putSyncState({ ...state, status: keepRemote ? 'stored-elsewhere' : 'saved-local', conflict: null, serverVersion: state.conflict.serverVersion, transferId: crypto.randomUUID(), ...(keepRemote ? { lastMetadataHash: undefined } : {}) });
      setStatusText(keepRemote ? 'Remote recording title and bookmarks kept. Local audio bytes remain on this device.' : 'Local recording metadata kept; retrying against the latest server version.');
      await refresh(); retryAudioSync();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not resolve audio metadata conflict.'); }
  }

  return <section className={`audio-panel ${active ? 'is-recording' : ''}`} aria-labelledby="audio-title">
    <header className="audio-heading"><div className="audio-title-row"><div><p className="eyebrow">On this device</p><h2 id="audio-title" className="section-title">Audio</h2></div><span className="audio-count">{recordings.length} {recordings.length === 1 ? 'recording' : 'recordings'}</span></div><button className="audio-toggle" type="button" aria-expanded={expanded || Boolean(active)} aria-controls="audio-panel-content" disabled={Boolean(active) || starting} onClick={() => setExpanded((value) => !value)}>{expanded ? 'Hide' : 'Show'} recordings <span aria-hidden="true">{expanded ? '−' : '+'}</span></button></header>
    <div id="audio-panel-content" className="audio-panel-content" hidden={!expanded && !active}>
    <p className="audio-copy">Audio stays on this device until you approve sync for this note. Text sync and audio transfer have separate status. Full Archive V2 includes recordings; Legacy JSON V1 does not.</p>
    <div className="audio-controls"><button type="button" className="btn" onClick={() => void setAudioSyncApproval(!audioApproved)}>{audioApproved ? 'Disable audio sync for this note' : 'Allow audio sync for this note'}</button><span className="save-state">{audioApproved ? 'Approved on this device' : 'Local only'}</span></div>
    <div className="audio-controls">
      {!active ? <button className="btn btn-primary" disabled={disabled || starting || !audioReady} onClick={() => void startRecording()}>{starting ? 'Starting…' : '● Record audio'}</button> : <><span className="recording-indicator" aria-live="polite">● {active.status === 'paused' ? 'Paused' : 'Recording'} · {formatDuration(elapsed)}</span><button className="tool-button" onClick={() => void addRecordingBookmark()}>⚑ Bookmark</button>{pauseSupported && <button className="btn" onClick={() => void pauseRecording()}>{active.status === 'paused' ? 'Resume' : 'Pause'}</button>}<button className="btn btn-danger" onClick={stopRecording}>Stop and save</button></>}
      <span className="save-state" aria-live="polite">{statusText}</span>
    </div>
    {error && <div className="notice error" role="alert">{error}</div>}
    {active && <p className="audio-warning">Keep noteOS open while recording. A reload or interruption leaves a partial recording; background recording is not supported.</p>}
    {recordings.length === 0 ? <p className="audio-empty">No recordings for this note yet.</p> : <ul className="recording-list">{recordings.map((recording) => <li className="recording-item" key={recording.id}>
      <div className="recording-main"><div className="recording-title-row">{editId === recording.id ? <><label className="screen-reader" htmlFor={`recording-title-${recording.id}`}>Recording title</label><input id={`recording-title-${recording.id}`} className="searchbox recording-title-input" maxLength={120} value={editTitle} onChange={(event) => setEditTitle(event.target.value)} /><button className="tool-button" disabled={!editTitle.trim()} onClick={() => void saveRename(recording)}>Save name</button><button className="tool-button" onClick={() => setEditId('')}>Cancel</button></> : <><strong>{recording.title}</strong><span className={`recording-state recording-state-${recording.status}`}>{recordingStatus(recording.status)}</span></>}</div>
        <div className="recording-meta"><span>{formatDuration(recording.durationMs)}</span><span>{new Date(recording.createdAt).toLocaleString()}</span><span>{recording.mimeType}</span></div>
        <div className="recording-meta" aria-live="polite"><span>{audioStates[recording.id]?.status === 'verified-here' ? 'Audio verified on this device' : audioStates[recording.id]?.status === 'stored-elsewhere' ? 'Audio stored on another device' : audioStates[recording.id]?.status === 'downloading' ? `Downloading audio · ${audioStates[recording.id].verifiedBytes ?? 0}/${audioStates[recording.id].totalBytes ?? 0} bytes` : audioStates[recording.id]?.status === 'uploading' ? `Uploading audio · ${audioStates[recording.id].verifiedBytes ?? 0}/${audioStates[recording.id].totalBytes ?? 0} bytes` : audioStates[recording.id]?.status === 'needs-review' ? 'Audio needs review' : audioStates[recording.id]?.status === 'transfer-unavailable' ? 'Audio transfer unavailable' : audioApproved ? 'Waiting to upload' : 'Audio saved on this device'}</span>{audioApproved && <button type="button" className="tool-button" onClick={retryAudioSync}>Retry audio sync</button>}</div>
        {audioStates[recording.id]?.status === 'needs-review' && <div className="notice" role="status"><p>Audio or its title and bookmarks changed on more than one device. Both versions are preserved.</p>{audioStates[recording.id]?.sha256 && audioStates[recording.id]?.sha256 === audioStates[recording.id]?.conflict?.remote?.sha256 ? <><button type="button" className="tool-button" onClick={() => void resolveAudioConflict(recording.id, true)}>Keep remote title and bookmarks</button><button type="button" className="tool-button" onClick={() => void resolveAudioConflict(recording.id, false)}>Keep mine and retry</button></> : <p>The audio bytes differ. The local file and remote object are retained for separate review.</p>}</div>}
        {players[recording.id] && <><audio ref={audio => { playerElementsRef.current[recording.id] = audio; }} onLoadedMetadata={event => playerLoaded(recording.id, event.currentTarget)} className="recording-player" controls preload="metadata" src={players[recording.id]} aria-label={`Play ${recording.title}`} /><button className="tool-button" onClick={() => void addPlaybackBookmark(recording)}>⚑ Bookmark this moment</button></>}
        {(recording.audioAnchors?.items ?? []).length > 0 && <ol className="audio-anchor-list" aria-label={`Bookmarks for ${recording.title}`}>{recording.audioAnchors!.items.map(anchor => <li key={anchor.id} className="audio-anchor-row">{anchorEditId === anchor.id ? <><input aria-label="Bookmark label" maxLength={120} value={anchorEditLabel} onChange={event => setAnchorEditLabel(event.target.value)} /><button className="tool-button" onClick={() => void renameAudioAnchor(recording.id, anchor.id)}>Save label</button><button className="tool-button" onClick={() => setAnchorEditId('')}>Cancel</button></> : <><button className="audio-anchor-seek" onClick={() => void playRecording(recording, anchor.offsetMs, true)}><span>{formatDuration(anchor.offsetMs)}</span><span>{anchor.label || 'Bookmark'}</span></button><button className="tool-button" aria-label={`Rename bookmark at ${formatDuration(anchor.offsetMs)}`} onClick={() => { setAnchorEditId(anchor.id); setAnchorEditLabel(anchor.label); }}>Rename</button><button className="tool-button" aria-label={`Delete bookmark at ${formatDuration(anchor.offsetMs)}`} onClick={() => void removeAudioAnchor(recording.id, anchor.id)}>Delete</button></>}</li>)}</ol>}
      </div>
      <div className="recording-actions">{['recording', 'paused'].includes(recording.status) && <button className="tool-button" onClick={() => void recoverRecording(recording)}>Recover partial</button>}{recording.chunkCount > 0 && <><button className="tool-button" onClick={() => void playRecording(recording)}>{players[recording.id] ? 'Reload audio' : 'Play'}</button><button className="tool-button" onClick={() => void downloadRecording(recording)}>Export</button></>}<button className="tool-button" onClick={() => { setEditId(recording.id); setEditTitle(recording.title); }}>Rename</button><button className="tool-button" onClick={() => void removeRecording(recording)}>Delete</button></div>
    </li>)}</ul>}
    </div>
  </section>;
}
