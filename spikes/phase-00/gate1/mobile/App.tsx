import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, Button, FlatList, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { NavigationContainer, usePreventRemove } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus, useAudioRecorder } from 'expo-audio';
import { File, Paths } from 'expo-file-system';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { makeBackup, parseBackup, filterNotes, sortNotes } from '../web/app/lib/mvp-utils.mjs';
import { normalizeTagList } from '../web/app/lib/note-organization.mjs';
import { canonicalToPlainText, createEmptyCanonicalDocument, validateCanonicalDocument } from '../web/packages/document-engine/src/index.js';
import { addRecordingAnchor, addRecordingSessionAnchor, beginAudioAnchorSession, beginRecordingFinalization, clearQuickCaptureDraft, commitAudioAnchorSession, commitQuickVoiceCapture, createNote, createQuickCaptureNote as createQuickCaptureRecord, deleteRecordingAnchor, discardRecoveryDraft, exportNotes, getNote, getQuickCaptureDraft, getRecoveryDraft, importNotes, listAudioAnchorSessions, listNotes, listPendingFileCleanups, listPendingQuickVoiceCaptures, listRecordings, markFileCleanupDone, Note, permanentlyDeleteNote, persistQuickCaptureDraft, RecordingArchiveMetadata, RecoveryDraft, Recording, recordingArchiveMetadata, removeAudioAnchorSession, removeRecording, renameRecording, renameRecordingAnchor, RevisionConflictError, saveNote, saveRecoveryDraft, setLifecycle, setPinned } from './store';
import { createAudioAnchor, formatAudioTimestamp } from '../web/app/lib/audio-anchors.mjs';
import { canEditNativeNote, discardDraftSafely, LatestDraftWriter, recoveryDecision, RecordingSessionGate, SingleSaveGate, acquireNativeRecordingSession } from './mobile-safety.mjs';
import { documentToNativeModel, nativeModelToDocument } from './document-subset';
import { CanonicalEditor, CanonicalEditorHandle } from './CanonicalEditor';
import { createEditorSession, validateEditorEnvelope } from './editor-bridge.mjs';
import { createFullArchive, reconcileArchiveImports, restoreFullArchive } from './full-archive';
import { captureSnapshotIsCurrent, commitQuickCaptureSnapshot, makeQuickCaptureNote, makeQuickVoiceNote, normalizeQuickCaptureInput, QuickCaptureSaveGate } from '../web/app/lib/quick-capture.mjs';

type RootStack = { Home: undefined; Editor: { id: string } };
const Stack = createNativeStackNavigator<RootStack>();
const makeId = () => `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
const timeNow = () => Date.now();

function HomeScreen({ navigation }: any) {
  const [notes, setNotes] = useState<Note[]>([]); const [query, setQuery] = useState('');
  const [lifecycle, setLifecycleFilter] = useState<'active' | 'archived' | 'trashed'>('active'); const [status, setStatus] = useState(''); const [backupBusy, setBackupBusy] = useState(false); const [backupStatus, setBackupStatus] = useState('');
  const [captureText, setCaptureText] = useState(''); const [captureReady, setCaptureReady] = useState(false); const [captureBusy, setCaptureBusy] = useState(false); const [captureFocused, setCaptureFocused] = useState(false); const [captureStatus, setCaptureStatus] = useState('');
  const captureTextRef = useRef(''); const captureSequenceRef = useRef(0); const captureNoteRef = useRef<Note | null>(null); const captureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); const captureSaveGate = useRef(new QuickCaptureSaveGate());
  const [voicePhase, setVoicePhase] = useState<'idle'|'requesting'|'starting'|'recording'|'paused'|'stopping'|'saving'|'saved'|'interrupted'|'failed'>('idle'); const [voiceStatus, setVoiceStatus] = useState(''); const [voiceAnchors, setVoiceAnchors] = useState<any[]>([]);
  const quickRecorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, directory: 'document' });
  const quickVoiceGate = useRef(new RecordingSessionGate()); const quickVoiceRelease = useRef<null | (() => void)>(null); const quickVoicePending = useRef<null | { note: Note; recording: Recording; metadata: RecordingArchiveMetadata }>(null); const quickVoiceSession = useRef<null | { note: Note; recording: any; metadata: RecordingArchiveMetadata }>(null); const quickVoiceSaveGate = useRef(new QuickCaptureSaveGate()); const finishQuickVoiceRef = useRef<(interrupted?: boolean) => Promise<void>>(async () => {});
  const pendingPins = useRef(new Set<string>());
  const refresh = useCallback(async () => { setNotes(await listNotes()); const pending = await listPendingFileCleanups(); for (const uri of pending) { try { const file = new File(uri); if (file.exists) file.delete(); await markFileCleanupDone(uri); } catch (error) { setStatus(`File cleanup is pending retry: ${String(error)}`); } } }, []);
  async function togglePin(item: Note) { if (backupBusy || pendingPins.current.has(item.id)) return; pendingPins.current.add(item.id); try { await setPinned(item.id, !item.pinned, item.revision); await refresh(); } catch (error) { setStatus(String(error)); } finally { pendingPins.current.delete(item.id); } }
  useEffect(() => { let mounted = true; void (async () => {
    const draft = await getQuickCaptureDraft();
    if (draft && mounted) { captureTextRef.current = draft.body; captureSequenceRef.current = draft.sequence; captureNoteRef.current = draft.note; setCaptureText(draft.body); }
    const pendingVoices = await listPendingQuickVoiceCaptures();
    for (const pending of pendingVoices) {
      try {
        const recording = JSON.parse(pending.recording_json) as Recording; const note = JSON.parse(pending.note_json) as Note; const metadata = JSON.parse(pending.metadata_json) as RecordingArchiveMetadata;
        const file = recording.file_uri ? new File(recording.file_uri) : null;
        if (file?.exists && file.size > 0) {
          try {
            await commitQuickVoiceCapture(recording.id);
            if (mounted) setVoiceStatus('Recovered a finalized voice note after restart. Open it from Recent notes to play it.');
          } catch (error) {
            if (mounted) { quickVoicePending.current = { note, recording, metadata }; setVoicePhase('failed'); setVoiceStatus(`A finalized voice note is ready for retry. ${String(error)}`); }
          }
        } else if (mounted) {
          setVoicePhase('failed'); setVoiceStatus('A voice recording needs attention. Its recovery journal is preserved because the audio file is unavailable.');
        }
      } catch (error) { if (mounted) { setVoicePhase('failed'); setVoiceStatus(`A voice recovery journal needs attention and has been preserved. ${String(error)}`); } }
    }
    // Recover Phase 06 provisional sessions without treating an unfinished file as a saved recording.
    for (const row of await listAudioAnchorSessions()) {
      try {
        const note = row.note_json ? JSON.parse(row.note_json) as Note : null;
        const recording = JSON.parse(row.recording_json) as any;
        const metadata = JSON.parse(row.metadata_json) as RecordingArchiveMetadata;
        const file = recording.file_uri ? new File(recording.file_uri) : null;
        if (!file?.exists || file.size <= 0) { if (mounted) setVoiceStatus('An interrupted recording journal is preserved because its audio file is unavailable.'); continue; }
        recording.status = 'interrupted'; recording.title = `${note ? 'Interrupted voice note' : 'Interrupted recording'} · ${new Date(recording.created_at).toLocaleString()}`;
        await commitAudioAnchorSession(recording.id, note, recording, { ...metadata, durationMs: Math.max(metadata.durationMs || 0, 0), durationKnown: false, updatedAt: Date.now() });
        if (mounted && note) setVoiceStatus('Recovered an interrupted voice note with its bookmarks. Open it from Recent notes.');
      } catch (error) { if (mounted) setVoiceStatus(`An audio bookmark recovery journal is preserved for retry. ${String(error)}`); }
    }
    const unresolved = await reconcileArchiveImports(); if (unresolved.length && mounted) setStatus(`Archive recovery needs attention: ${unresolved.join(' ')}`);
    await refresh(); if (mounted) setCaptureReady(true);
  })().catch(error => { if (mounted) { setStatus(String(error)); setCaptureReady(true); } }); return () => { mounted = false; if (captureTimerRef.current) clearTimeout(captureTimerRef.current); }; }, [refresh]);
  useEffect(() => { const unsubscribe = navigation.addListener('focus', () => { void refresh(); }); return unsubscribe; }, [navigation, refresh]);
  const quickVoiceActive = ['requesting','starting','recording','paused','stopping','saving'].includes(voicePhase) || Boolean(quickVoicePending.current);
  usePreventRemove(quickVoiceActive, () => setVoiceStatus('Finish saving the voice note before leaving Quick Capture.'));
  const visible = useMemo(() => sortNotes(filterNotes(notes, query, lifecycle) as Note[]), [notes, query, lifecycle]);
  function updateCapture(value: string) {
    captureTextRef.current = value; captureSequenceRef.current += 1; captureNoteRef.current = null; setCaptureText(value); setCaptureStatus('');
    const sequence = captureSequenceRef.current;
    if (captureTimerRef.current) clearTimeout(captureTimerRef.current);
    captureTimerRef.current = setTimeout(() => {
      void persistQuickCaptureDraft(value, sequence, null).then(async () => {
        if (!normalizeQuickCaptureInput(value) && captureSequenceRef.current === sequence) await clearQuickCaptureDraft(sequence);
      }).catch(error => setCaptureStatus(`Recovery copy could not be saved. Keep the app open until your note is committed. ${String(error)}`));
    }, 250);
  }
  async function saveCapture() {
    if (backupBusy || !captureReady || !captureSaveGate.current.begin()) return;
    const original = captureTextRef.current, body = normalizeQuickCaptureInput(original), sequence = captureSequenceRef.current;
    if (!body) { setCaptureStatus(''); captureSaveGate.current.finish(); return; }
    const note = captureNoteRef.current ?? makeQuickCaptureNote(body, { id: makeId(), now: timeNow() }) as Note;
    captureNoteRef.current = note; setCaptureBusy(true); setCaptureStatus('Saving on this device…');
    try {
      if (captureTimerRef.current) { clearTimeout(captureTimerRef.current); captureTimerRef.current = null; }
      const outcome = await commitQuickCaptureSnapshot({
        snapshot: { text: original, sequence, note },
        persist: (snapshot: { text: string; sequence: number; note: Note }) => persistQuickCaptureDraft(snapshot.text, snapshot.sequence, snapshot.note),
        commit: async (snapshot: { text: string; sequence: number; note: Note }) => (await createQuickCaptureRecord(snapshot.note)).note,
        clear: (snapshot: { text: string; sequence: number; note: Note }) => clearQuickCaptureDraft(snapshot.sequence),
        isCurrent: (snapshot: { text: string; sequence: number; note: Note }) => captureSnapshotIsCurrent(captureTextRef.current, captureSequenceRef.current, snapshot),
      });
      setNotes(current => [outcome.note, ...current.filter(item => item.id !== outcome.note.id)]);
      if (captureSnapshotIsCurrent(captureTextRef.current, captureSequenceRef.current, { text: original, sequence })) {
        captureTextRef.current = ''; captureNoteRef.current = null; setCaptureText('');
      }
      setCaptureStatus('Saved on this device. Ready for another thought.');
    } catch (error) { setCaptureStatus(`Could not save. Your text is still here. Retry when ready. ${String(error)}`); }
    finally { captureSaveGate.current.finish(); setCaptureBusy(false); }
  }
  async function retryQuickVoiceSave() {
    const pending = quickVoicePending.current as { note: Note; recording: Recording; metadata: RecordingArchiveMetadata } | null;
    if (!pending || !quickVoiceSaveGate.current.begin()) return;
    setVoicePhase('saving'); setVoiceStatus('Saving the finalized voice note…');
    try {
      await commitAudioAnchorSession(pending.recording.id, pending.note, pending.recording, pending.metadata);
      quickVoicePending.current = null;
      setNotes(current => [pending.note, ...current.filter(item => item.id !== pending.note.id)]);
      setVoicePhase(pending.recording.status === 'interrupted' ? 'interrupted' : 'saved');
      setVoiceStatus(pending.recording.status === 'interrupted' ? 'Interrupted recording saved. Open its note to play it.' : 'Voice note saved. Open it from Recent notes to play it.');
    } catch (error) { setVoicePhase('failed'); setVoiceStatus(`Audio is finalized and held for retry. ${String(error)}`); }
    finally { quickVoiceSaveGate.current.finish(); }
  }
  async function startQuickVoice() {
    const gate = quickVoiceGate.current;
    if (backupBusy || quickVoicePending.current || !gate.beginStart()) return;
    const release = acquireNativeRecordingSession('quick-voice-home');
    if (!release) { gate.finish(); setVoicePhase('failed'); setVoiceStatus('Another recording session is already active. Stop and save it first.'); return; }
    quickVoiceRelease.current = release; setVoicePhase('requesting'); setVoiceStatus('Requesting microphone access…');
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) { gate.finish(); quickVoiceRelease.current?.(); quickVoiceRelease.current = null; setVoicePhase('failed'); setVoiceStatus('Microphone access was denied. No note was created; enable access in iOS Settings to record.'); return; }
      gate.move('requesting', 'starting'); setVoicePhase('starting');
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, allowsBackgroundRecording: false });
      await quickRecorder.prepareToRecordAsync();
      if (gate.backgroundRequested) { await quickRecorder.stop(); gate.finish(); quickVoiceRelease.current?.(); quickVoiceRelease.current = null; setVoicePhase('interrupted'); setVoiceStatus('Recording start was interrupted before audio began. No note was created.'); return; }
      const createdAt = timeNow(), note = makeQuickVoiceNote({ id: makeId(), now: createdAt }) as Note;
      const recording = { id: `recording-${makeId()}`, note_id: note.id, title: `Voice note · ${new Date(createdAt).toLocaleString()}`, file_uri: quickRecorder.uri ?? '', status: 'recording', created_at: createdAt };
      const metadata = recordingArchiveMetadata({ ...recording, status: 'interrupted' });
      await beginAudioAnchorSession(null, note, recording, metadata);
      quickVoiceSession.current = { note, recording, metadata }; setVoiceAnchors([]);
      quickRecorder.record(); gate.move('starting', 'recording'); setVoicePhase('recording'); setVoiceStatus('Recording locally. It will stop when the app leaves the foreground.');
    } catch (error) { const session = quickVoiceSession.current; if (session) { await removeAudioAnchorSession(session.recording.id).catch(() => {}); quickVoiceSession.current = null; } gate.finish(); quickVoiceRelease.current?.(); quickVoiceRelease.current = null; setVoicePhase('failed'); setVoiceStatus(`Recording could not start. No note was created. ${String(error)}`); }
  }
  async function addQuickVoiceBookmark() {
    const session = quickVoiceSession.current; if (!session) return;
    try { const offsetMs = Math.max(0, Math.round(quickRecorder.currentTime * 1000)); const set = await addRecordingSessionAnchor(session.recording.id, createAudioAnchor(session.recording.id, offsetMs, '', { id: `bookmark-${makeId()}`, createdAt: timeNow() } as any)); session.metadata = { ...session.metadata, audioAnchors: set }; quickVoiceSession.current = session; setVoiceAnchors(set.items); setVoiceStatus(`Bookmark saved at ${formatAudioTimestamp(offsetMs)}.`); }
    catch (error) { setVoiceStatus(`Could not save bookmark. The recording journal remains safe. ${String(error)}`); }
  }
  async function toggleQuickVoicePause() {
    const gate = quickVoiceGate.current;
    try { if (gate.phase === 'recording' && gate.pause()) { await quickRecorder.pause(); setVoicePhase('paused'); setVoiceStatus('Recording paused. Bookmarks keep the current media time.'); } else if (gate.phase === 'paused' && gate.resume()) { quickRecorder.record(); setVoicePhase('recording'); setVoiceStatus('Recording resumed.'); } }
    catch (error) { setVoiceStatus(`Could not change recording state. ${String(error)}`); }
  }
  async function finishQuickVoice(interrupted = false) {
    const gate = quickVoiceGate.current;
    let releaseFinalization: (() => void) | null = null;
    try { releaseFinalization = beginRecordingFinalization(); }
    catch (error) { setVoiceStatus(`Recording is still active. Wait for Full Archive to finish, then stop and save. ${String(error)}`); return; }
    if (!gate.beginStop()) { releaseFinalization(); return; }
    setVoicePhase('stopping'); setVoiceStatus('Stopping and verifying the audio file…');
    try {
      const durationMs = Math.max(0, Math.round(quickRecorder.currentTime * 1000));
      await quickRecorder.stop();
      const uri = quickRecorder.uri;
      if (!uri) throw new Error('Recorder did not provide a finalized audio file.');
      const file = new File(uri);
      if (!file.exists || file.size <= 0) throw new Error('Finalized audio is missing or empty.');
      const session = quickVoiceSession.current; if (!session) throw new Error('The provisional bookmark journal is missing; finalized audio was kept.');
      const recording: Recording = { ...session.recording, file_uri: uri, status: interrupted ? 'interrupted' : 'complete' };
      const metadata = { ...session.metadata, durationMs, durationKnown: false, updatedAt: timeNow() };
      quickVoicePending.current = { note: session.note, recording, metadata };
      setVoicePhase('saving'); setVoiceStatus('Audio finalized. Saving its note and recording together…');
      await retryQuickVoiceSave(); if (!quickVoicePending.current) quickVoiceSession.current = null;
    } catch (error) {
      const uri = quickRecorder.uri;
      const file = uri ? new File(uri) : null;
      if (file?.exists && file.size > 0 && !quickVoicePending.current && quickVoiceSession.current) {
        const session = quickVoiceSession.current;
        const recording: Recording = { ...session.recording, file_uri: uri!, status: 'interrupted', title: `Interrupted voice note · ${new Date(session.recording.created_at).toLocaleString()}` };
        quickVoicePending.current = { note: session.note, recording, metadata: { ...session.metadata, durationMs: Math.round(quickRecorder.currentTime * 1000), durationKnown: false, updatedAt: timeNow() } };
        setVoicePhase('failed'); setVoiceStatus(`The recording stopped unexpectedly. Its audio is preserved for retry. ${String(error)}`);
      } else { setVoicePhase('failed'); setVoiceStatus(`Recording could not be saved. Its provisional journal is preserved when available. ${String(error)}`); }
    } finally { gate.finish(); releaseFinalization?.(); quickVoiceRelease.current?.(); quickVoiceRelease.current = null; }
  }
  finishQuickVoiceRef.current = finishQuickVoice;
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') return;
      if (captureTimerRef.current) { clearTimeout(captureTimerRef.current); captureTimerRef.current = null; }
      const text = captureTextRef.current, sequence = captureSequenceRef.current;
      void persistQuickCaptureDraft(text, sequence, captureNoteRef.current).then(async () => { if (!normalizeQuickCaptureInput(text)) await clearQuickCaptureDraft(sequence); }).catch(error => setCaptureStatus(`Background capture checkpoint failed. Your on-screen text remains available. ${String(error)}`));
      if (quickVoiceGate.current.requestBackgroundStop()) void finishQuickVoiceRef.current(true);
    });
    return () => subscription.remove();
  }, []);
  async function create() {
    if (backupBusy) return;
    const now = timeNow();
    const note: Note = { id: makeId(), title: 'Untitled note', document: createEmptyCanonicalDocument(), schemaVersion: 1, createdAt: now, updatedAt: now, lifecycle: 'active', revision: 0, pinned: false, tags: [] };
    try { await createNote(note); navigation.navigate('Editor', { id: note.id }); } catch (error) { setStatus(String(error)); }
  }
  async function backupExportLegacy() {
    try {
      const data = makeBackup(await exportNotes());
      const file = new File(Paths.cache, `noteos-backup-${new Date().toISOString().slice(0, 10)}.json`);
      if (file.exists) file.delete(); file.create(); await file.write(JSON.stringify(data, null, 2));
      if (await Sharing.isAvailableAsync()) { await Sharing.shareAsync(file.uri, { mimeType: 'application/json', dialogTitle: 'Export noteOS Legacy JSON V1' }); setBackupStatus('Share sheet closed. noteOS cannot confirm whether the file was saved.'); try { if (file.exists) file.delete(); } catch {} }
      else setStatus(`Backup prepared at ${file.uri}; sharing is unavailable on this device.`);
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Could not export notes.'); }
  }
  async function backupImport() {
    try {
      const picked = await DocumentPicker.getDocumentAsync({ type: ['application/json', 'text/json'], copyToCacheDirectory: true });
      if (picked.canceled) return;
      const text = new File(picked.assets[0].uri).textSync();
      const bundle = parseBackup(text);
      await importNotes(bundle.notes as Note[]); await refresh(); setBackupStatus(`Imported ${bundle.notes.length} notes. Legacy JSON V1 does not contain audio.`);
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Could not import this backup.'); }
  }
  async function backupExportFull() {
    if (backupBusy) return; setBackupBusy(true); setBackupStatus('Preparing Full Archive V2…');
    let archiveFile: File | null = null;
    try {
      const result = await createFullArchive(setBackupStatus);
      archiveFile = result.file;
      if (!(await Sharing.isAvailableAsync())) { setBackupStatus(`Archive was generated at ${result.file.uri}; sharing is unavailable and noteOS cannot confirm a Files save.`); return; }
      setBackupStatus('Archive is ready. Choose Save to Files or another destination in the iOS share sheet.');
      await Sharing.shareAsync(result.file.uri, { mimeType: 'application/x-tar', dialogTitle: 'Export noteOS Full Archive V2' });
      setBackupStatus('Share sheet closed. noteOS cannot confirm whether the archive was saved.');
      try { if (result.file.exists) result.file.delete(); } catch {}
    } catch (error) { setBackupStatus(`${archiveFile ? 'Archive was generated but sharing failed; no Files save is confirmed.' : 'Could not create the Full Archive V2.'} ${error instanceof Error ? error.message : ''}`.trim()); }
    finally { setBackupBusy(false); }
  }
  function chooseArchiveMode() {
    Alert.alert('Restore Full Archive V2', 'Merge adds only non-conflicting note groups. Skip stops the entire import if any note or recording ID already exists.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Skip on collisions', onPress: () => void backupImportFull('skip') },
      { text: 'Merge', onPress: () => void backupImportFull('merge') },
    ]);
  }
  async function backupImportFull(mode: 'merge'|'skip') {
    if (backupBusy) return; setBackupBusy(true); setBackupStatus('Choose a TAR archive in Files…');
    let pickedUri = '';
    try {
      const picked = await DocumentPicker.getDocumentAsync({ type: ['application/x-tar', 'application/octet-stream', '*/*'], copyToCacheDirectory: true });
      if (picked.canceled) { setBackupStatus('Import cancelled. No note or recording data changed.'); return; }
      pickedUri = picked.assets[0].uri;
      const result = await restoreFullArchive(new File(pickedUri), mode, setBackupStatus);
      await refresh();
      setBackupStatus(`Restore complete: ${result.importedNotes} notes and ${result.importedRecordings} recordings imported; ${result.skippedNotes} notes and ${result.skippedRecordings} recordings skipped.${result.warnings.length ? ` ${result.warnings.length} interrupted or partial recording warning(s).` : ''}`);
    } catch (error) { setBackupStatus(error instanceof Error ? error.message : 'Could not restore this archive. Existing data was preserved.'); }
    finally { if (pickedUri) { try { const selected = new File(pickedUri); if (selected.exists) selected.delete(); } catch {} } setBackupBusy(false); }
  }
  async function changeLifecycle(note: Note, next: 'active' | 'archived' | 'trashed') {
    if (backupBusy) return;
    try { await setLifecycle(note.id, next, note.revision); await refresh(); }
    catch (error) { setStatus(error instanceof Error ? error.message : 'Could not update note.'); }
  }
  function deleteForever(note: Note) {
    if (backupBusy) return;
    Alert.alert('Delete permanently?', `“${note.title || 'Untitled note'}” and its local recordings will be removed from this device. Legacy JSON V1 excludes audio; Full Archive V2 includes local recordings.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => { void (async () => {
        if (backupBusy) return;
        try {
          const uris = await permanentlyDeleteNote(note.id, note.revision); await refresh();
          for (const uri of uris) { const file = new File(uri); if (file.exists) file.delete(); await markFileCleanupDone(uri); }
        } catch (error) { setStatus(`Metadata is preserved if the database operation failed; file cleanup will retry where queued: ${String(error)}`); }
      })(); } },
    ]);
  }
  const pendingVoiceForUi = quickVoicePending.current as { note: Note; recording: Recording; metadata: RecordingArchiveMetadata } | null;
  const voiceButtonLabel = pendingVoiceForUi && voicePhase === 'failed' ? 'Retry save' : ['recording','paused'].includes(voicePhase) ? `Stop · ${Math.round(quickRecorder.currentTime)}s` : ['requesting','starting','stopping','saving'].includes(voicePhase) ? ({ requesting: 'Requesting…', starting: 'Starting…', stopping: 'Stopping…', saving: 'Saving…' } as Record<string,string>)[voicePhase] : 'Voice';
  return <SafeAreaView style={styles.screen} edges={['top', 'left', 'right', 'bottom']}><KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <View style={styles.homeHeader}><View><Text style={styles.eyebrow}>PRIVATE · ON THIS DEVICE</Text><Text style={styles.heading}>Your notes</Text></View><Pressable disabled={backupBusy || quickVoiceActive} style={styles.primary} onPress={() => void create()}><Text style={styles.primaryText}>＋ Full editor</Text></Pressable></View>
    <View style={[styles.captureCard, captureFocused && styles.captureFocused]}>
      <TextInput accessibilityLabel="What's on your mind?" style={styles.captureInput} placeholder="What's on your mind?" placeholderTextColor="#99978E" value={captureText} onChangeText={updateCapture} onFocus={() => setCaptureFocused(true)} onBlur={() => setCaptureFocused(false)} editable={captureReady} multiline textAlignVertical="top" blurOnSubmit={false} returnKeyType="default" />
      <View style={styles.captureActions}>
        <Pressable accessibilityRole="button" accessibilityLabel={voiceButtonLabel} disabled={backupBusy || !['idle','saved','interrupted','failed','recording','paused'].includes(voicePhase) || Boolean(pendingVoiceForUi && voicePhase !== 'failed')} style={[styles.voiceButton, ['recording','paused'].includes(voicePhase) && styles.voiceButtonRecording]} onPress={() => { if (pendingVoiceForUi && voicePhase === 'failed') void retryQuickVoiceSave(); else if (['recording','paused'].includes(voicePhase)) void finishQuickVoice(false); else { setVoiceStatus(''); void startQuickVoice(); } }}><Text style={[styles.voiceButtonText, ['recording','paused'].includes(voicePhase) && styles.voiceButtonRecordingText]}>{voiceButtonLabel}</Text></Pressable>
        {['recording','paused'].includes(voicePhase) ? <Pressable accessibilityRole="button" style={styles.action} onPress={() => void toggleQuickVoicePause()}><Text style={styles.action}>{voicePhase === 'paused' ? 'Resume' : 'Pause'}</Text></Pressable> : null}
        {['recording','paused'].includes(voicePhase) ? <Pressable accessibilityRole="button" style={styles.action} onPress={() => void addQuickVoiceBookmark()}><Text style={styles.action}>⚑ Bookmark</Text></Pressable> : null}
        <Text style={styles.captureHint}>{captureBusy ? 'Saving locally…' : 'A thought is enough. Shape it later.'}</Text>
        <Pressable accessibilityRole="button" disabled={backupBusy || !captureReady || captureBusy || !normalizeQuickCaptureInput(captureText)} style={[styles.captureSaveButton, (backupBusy || !captureReady || captureBusy || !normalizeQuickCaptureInput(captureText)) && styles.disabledButton]} onPress={() => void saveCapture()}><Text style={styles.captureSaveText}>{captureBusy ? 'Saving…' : 'Save'}</Text></Pressable>
      </View>
      {captureStatus ? <Text accessibilityRole="alert" style={[styles.captureMessage, captureStatus.startsWith('Could not') && styles.captureError]}>{captureStatus}</Text> : null}
      {voiceAnchors.map(anchor => <Text key={anchor.id} style={styles.subtle}>⚑ {formatAudioTimestamp(anchor.offsetMs)} · {anchor.label || 'Bookmark'}</Text>)}
      {voiceStatus ? <Text accessibilityLiveRegion="polite" style={[styles.captureMessage, voicePhase === 'failed' && styles.captureError]}>{['recording','paused'].includes(voicePhase) ? `● ${Math.round(quickRecorder.currentTime)}s · ${voiceStatus}` : voiceStatus}</Text> : null}
    </View>
    <TextInput style={styles.search} placeholder="Search notes and tags" value={query} onChangeText={setQuery} returnKeyType="search" />
    <View style={styles.segmentRow}>{(['active', 'archived', 'trashed'] as const).map(value => <Pressable key={value} onPress={() => setLifecycleFilter(value)} style={[styles.segment, lifecycle === value && styles.segmentActive]}><Text style={[styles.segmentText, lifecycle === value && styles.segmentTextActive]}>{value === 'active' ? 'Notes' : value === 'archived' ? 'Archive' : 'Trash'}</Text></Pressable>)}</View>
    {status ? <Text accessibilityRole="alert" style={styles.status}>{status}</Text> : null}
    <FlatList data={visible} keyExtractor={item => item.id} scrollEnabled={!backupBusy && !quickVoiceActive} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" contentContainerStyle={styles.listContent} ListEmptyComponent={<Text style={styles.empty}>{captureText ? 'Your unsaved thought is safe above.' : 'Capture a thought above, or open the full editor.'}</Text>} renderItem={({ item }) => {
      const body = canonicalToPlainText(item.document); const preview = body.status === 'projected' ? body.text : 'Rich content · opens read-only';
      return <Pressable disabled={backupBusy || quickVoiceActive} style={styles.noteCard} onPress={() => navigation.navigate('Editor', { id: item.id })}>
        <View style={styles.noteTitleRow}><Text style={styles.noteTitle} numberOfLines={1}>{item.pinned ? '◆ ' : ''}{item.title || 'Untitled note'}</Text><Text style={styles.noteTime}>{new Date(item.updatedAt).toLocaleDateString()}</Text></View>
        <Text style={styles.preview} numberOfLines={2}>{preview || 'No text yet'}</Text>
        {!!item.tags?.length && <Text style={styles.tags}>{item.tags.map((tag: string) => `#${tag}`).join('   ')}</Text>}
        <View style={styles.cardActions}>
          {lifecycle === 'active' ? <><Text onPress={() => void togglePin(item)} style={styles.action}>{item.pinned ? 'Unpin' : 'Pin'}</Text><Text onPress={() => void changeLifecycle(item, 'archived')} style={styles.action}>Archive</Text><Text onPress={() => void changeLifecycle(item, 'trashed')} style={styles.action}>Trash</Text></> : lifecycle === 'archived' ? <><Text onPress={() => void changeLifecycle(item, 'active')} style={styles.action}>Restore</Text><Text onPress={() => void changeLifecycle(item, 'trashed')} style={styles.action}>Move to trash</Text></> : <><Text onPress={() => void changeLifecycle(item, 'active')} style={styles.action}>Restore</Text><Text onPress={() => deleteForever(item)} style={styles.dangerAction}>Delete forever</Text></>}
        </View>
      </Pressable>;
    }} />
    <View style={styles.backupPanel}>
      <View style={styles.segmentRow}><View><Text style={styles.sectionLabel}>DATA & BACKUP</Text><Text style={styles.subtle}>Local manual transfer · archives are unencrypted</Text></View><Text style={styles.subtle}>V2</Text></View>
      <View style={styles.backupActions}><Text style={styles.subtle}>Full Archive V2 · notes + audio</Text><Pressable disabled={backupBusy || quickVoiceActive} onPress={chooseArchiveMode}><Text style={styles.action}>Restore</Text></Pressable><Pressable disabled={backupBusy || quickVoiceActive} onPress={() => void backupExportFull()}><Text style={styles.action}>Export</Text></Pressable></View>
      <View style={styles.backupActions}><Text style={styles.subtle}>Legacy JSON V1 · notes only</Text><Pressable disabled={backupBusy} onPress={() => void backupImport()}><Text style={styles.action}>Import</Text></Pressable><Pressable disabled={backupBusy} onPress={() => void backupExportLegacy()}><Text style={styles.action}>Export</Text></Pressable></View>
      {backupBusy || backupStatus ? <Text accessibilityRole="alert" style={styles.backupStatus}>{backupBusy ? 'Working · ' : ''}{backupStatus}</Text> : null}
    </View>
  </KeyboardAvoidingView></SafeAreaView>;
}

function AudioItem({ item, onPlay, onSeek, onRename, onDelete, onRenameAnchor, onDeleteAnchor }: { item: Recording; onPlay: (item: Recording) => void; onSeek: (anchor: any) => void; onRename: (item: Recording) => void; onDelete: (item: Recording) => void; onRenameAnchor: (id: string, label: string) => void; onDeleteAnchor: (id: string) => void }) {
  return <View><View style={styles.audioRow}><View style={{ flex: 1 }}><Text style={styles.audioTitle}>{item.title}</Text><Text style={styles.subtle}>{item.file_uri ? item.status === 'complete' ? 'Saved locally' : 'Interrupted · recovery available' : 'Metadata preserved · no audio bytes available'}</Text></View><Pressable disabled={!item.file_uri} onPress={() => onPlay(item)} style={[styles.smallButton, !item.file_uri && { opacity: .45 }]}><Text style={styles.smallButtonText}>Play</Text></Pressable><Pressable onPress={() => onRename(item)}><Text style={styles.action}>Rename</Text></Pressable><Pressable onPress={() => onDelete(item)}><Text style={styles.dangerAction}>Delete</Text></Pressable></View>{item.audioAnchors?.items.map(anchor => <View key={anchor.id} style={styles.segmentRow}><Pressable disabled={!item.file_uri} onPress={() => onSeek(anchor)}><Text style={styles.action}>⚑ {formatAudioTimestamp(anchor.offsetMs)} · {anchor.label || 'Bookmark'}</Text></Pressable><Pressable onPress={() => onRenameAnchor(anchor.id, anchor.label)}><Text style={styles.action}>Rename</Text></Pressable><Pressable onPress={() => onDeleteAnchor(anchor.id)}><Text style={styles.dangerAction}>Delete</Text></Pressable></View>)}</View>;
}

function AudioPlayback({ uri, seekOffsetMs, onSeekConsumed, onBookmark, onClose }: { uri: string; seekOffsetMs: number | null; onSeekConsumed: () => void; onBookmark: (offsetMs: number) => void; onClose: () => void }) { const player = useAudioPlayer(uri); const status = useAudioPlayerStatus(player); const consumeSeekRef = useRef(onSeekConsumed); consumeSeekRef.current = onSeekConsumed; useEffect(() => { if (!status.isLoaded) return; if (seekOffsetMs !== null) { const offset = Math.min(Math.max(0, seekOffsetMs / 1000), status.duration > 0 ? status.duration : seekOffsetMs / 1000); void player.seekTo(offset).then(() => { player.play(); consumeSeekRef.current(); }); } else player.play(); }, [player, status.isLoaded, status.duration, seekOffsetMs]); return <View style={styles.segmentRow}><Text style={styles.subtle}>{status.isLoaded ? `${status.playing ? 'Playing' : 'Paused'} · ${formatAudioTimestamp(Math.max(0, Math.round(status.currentTime * 1000)))}` : 'Loading audio…'}</Text><Pressable onPress={() => onBookmark(Math.max(0, Math.round(status.currentTime * 1000)))} disabled={!status.isLoaded}><Text style={styles.action}>⚑ Bookmark this moment</Text></Pressable><Pressable onPress={() => { player.pause(); onClose(); }}><Text style={styles.action}>Stop</Text></Pressable></View>; }

function EditorScreen({ route, navigation }: any) {
  const [note, setNote] = useState<Note | null>(null); const [title, setTitle] = useState(''); const [document, setDocument] = useState<any>(createEmptyCanonicalDocument()); const [tags, setTags] = useState(''); const [pinned, setPinned] = useState(false); const [editable, setEditable] = useState(false); const [readOnlyReason, setReadOnlyReason] = useState(''); const [dirty, setDirty] = useState(false); const [status, setStatus] = useState(''); const [recordings, setRecordings] = useState<Recording[]>([]); const [recordingPhase, setRecordingPhase] = useState('idle'); const [recordingPending, setRecordingPending] = useState(false); const [recoveryHeld, setRecoveryHeld] = useState(false); const [playingUri, setPlayingUri] = useState(''); const [playingRecordingId, setPlayingRecordingId] = useState(''); const [playbackOffsetMs, setPlaybackOffsetMs] = useState<number | null>(null); const [editorFailed, setEditorFailed] = useState(false); const [editorReady, setEditorReady] = useState(false); const [editorHeight, setEditorHeight] = useState(320); const [saving, setSaving] = useState(false);
  const [sessionId, setSessionId] = useState(() => createEditorSession(route.params.id, makeId()));
  const gateRef = useRef(new RecordingSessionGate()); const recordingSessionRelease = useRef<null | (() => void)>(null); const editorAudioSession = useRef<null | { recording: any; metadata: RecordingArchiveMetadata }>(null); const editorRef = useRef<CanonicalEditorHandle>(null); const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null); const draftWriter = useRef<LatestDraftWriter | null>(null); const latestRef = useRef<any>(null);
  const noteRef = useRef<Note | null>(null); const documentRef = useRef<any>(null); const dirtyRef = useRef(false); const changeSequence = useRef(0); const editorGeneration = useRef(0); const sessionRef = useRef(sessionId); const snapshotSequence = useRef(0); const pendingSnapshot = useRef<null | { id: string; resolve: (value: { document: any; generation: number }) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>(null); const saveLock = useRef(new SingleSaveGate());
  const draftValues = useRef({ title, document, tags, pinned }); draftValues.current = { title, document, tags, pinned };
  sessionRef.current = sessionId;
  if (!draftWriter.current) draftWriter.current = new LatestDraftWriter((value: { id: string; revision: number; draft: RecoveryDraft }) => saveRecoveryDraft(value.id, value.revision, value.draft));
  function snapshotDraft(overrides: Partial<{ note: Note | null; title: string; document: any; tags: string; pinned: boolean }> = {}) { const currentNote = overrides.note ?? noteRef.current; if (!currentNote) return null; const latest = draftValues.current; return { id: currentNote.id, revision: currentNote.revision, draft: { version: 1 as const, baseRevision: currentNote.revision, title: overrides.title ?? latest.title, document: overrides.document ?? documentRef.current ?? latest.document, tagsText: overrides.tags ?? latest.tags, pinned: overrides.pinned ?? latest.pinned } }; }
  async function flushDraft(overrides?: Partial<{ note: Note | null; title: string; document: any; tags: string; pinned: boolean }>) { if (draftTimer.current) { clearTimeout(draftTimer.current); draftTimer.current = null; } const latest = snapshotDraft(overrides); if (latest && (dirtyRef.current || overrides)) { latestRef.current = latest; draftWriter.current?.enqueue(latest); } await draftWriter.current?.flush(); }
  function scheduleDraft() { const latest = snapshotDraft(); if (!latest) return; latestRef.current = latest; if (draftTimer.current) clearTimeout(draftTimer.current); draftTimer.current = setTimeout(() => { draftWriter.current?.enqueue(latest); void draftWriter.current?.flush().catch((error: unknown) => setStatus(`Recovery journal could not be updated: ${String(error)}`)); }, 500); }
  function markDirty() { dirtyRef.current = true; changeSequence.current += 1; setDirty(true); }
  function updateDocument(value: any) { documentRef.current = value; draftValues.current = { ...draftValues.current, document: value }; setDocument(value); markDirty(); }
  function updateTitle(value: string) { draftValues.current = { ...draftValues.current, title: value }; setTitle(value); markDirty(); }
  function updateTags(value: string) { draftValues.current = { ...draftValues.current, tags: value }; setTags(value); markDirty(); }
  function updatePinned(value: boolean) { draftValues.current = { ...draftValues.current, pinned: value }; setPinned(value); markDirty(); }
  const load = useCallback(async () => {
    const value = await getNote(route.params.id); if (!value) throw new Error('This note no longer exists.');
    noteRef.current = value; documentRef.current = value.document; draftValues.current = { title: value.title, document: value.document, tags: value.tags.join('\n'), pinned: value.pinned };
    setNote(value); setTitle(value.title); setDocument(value.document); setTags(value.tags.join('\n')); setPinned(value.pinned);
    const validation = validateCanonicalDocument(value.document); const bodySupported = validation.status === 'supported';
    setEditable(canEditNativeNote(value, bodySupported)); setReadOnlyReason(value.lifecycle !== 'active' ? 'Archived and trashed notes are read-only. Restore this note from Home before editing.' : value.schemaVersion !== 1 ? 'This note metadata uses a newer schema and is preserved read-only.' : bodySupported ? '' : validation.issues?.[0]?.message ?? 'Canonical content is preserved read-only.');
    dirtyRef.current = false; setDirty(false); setRecordings(await listRecordings(value.id));
    const journal = await getRecoveryDraft(value.id);
    if (journal) {
      const decision = recoveryDecision(value, journal);
      if (decision === 'offer-restore') Alert.alert('Recover draft?', 'A local recovery draft is available.', [
        { text: 'Keep draft', style: 'cancel', onPress: () => { setRecoveryHeld(true); setStatus('Recovery draft preserved. Editing is paused until you restore or discard it.'); } },
        { text: 'Discard', style: 'destructive', onPress: () => { void discardRecoveryDraft(value.id, journal.baseRevision).catch(error => setStatus(String(error))); } },
        { text: 'Restore', onPress: () => { const recovered = journal.draft; const recoveredValidation = validateCanonicalDocument(recovered.document); if (recoveredValidation.status !== 'supported') { setRecoveryHeld(true); setStatus('Draft contains unsupported content; its canonical JSON remains preserved read-only.'); return; } documentRef.current = recoveredValidation.document; draftValues.current = { title: recovered.title, document: recoveredValidation.document, tags: recovered.tagsText, pinned: recovered.pinned }; setDocument(recoveredValidation.document); setTitle(recovered.title); setTags(recovered.tagsText); setPinned(recovered.pinned); setSessionId(createEditorSession(value.id, makeId())); setEditorFailed(false); setEditorReady(false); dirtyRef.current = true; changeSequence.current += 1; setDirty(true); setStatus('Draft restored. Save it to commit.'); } },
      ]);
      else { setRecoveryHeld(true); Alert.alert('Older recovery draft', 'The note has changed since this draft was saved. Keep it for review or discard it; it cannot be restored over the newer note.', [{ text: 'Keep draft', style: 'cancel' }, { text: 'Discard', style: 'destructive', onPress: () => { void discardRecoveryDraft(value.id, journal.baseRevision).then(() => setRecoveryHeld(false)).catch(error => setStatus(String(error))); } }]); }
    }
  }, [route.params.id]);
  useEffect(() => { void load().catch(error => setStatus(String(error))); }, [load]);
  useEffect(() => { editorGeneration.current = 0; setEditorReady(false); if (pendingSnapshot.current) { clearTimeout(pendingSnapshot.current.timer); pendingSnapshot.current.reject(new Error('The WebView instance changed before returning the snapshot.')); pendingSnapshot.current = null; } }, [sessionId]);
  useEffect(() => navigation.setOptions({ title: note?.title || 'Note', headerBackTitle: 'Notes' }), [navigation, note?.title]);
  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, directory: 'document' });
  useEffect(() => { if (dirty && editable && !recoveryHeld) scheduleDraft(); }, [dirty, editable, recoveryHeld, title, document, tags, pinned, note]);
  useEffect(() => { const subscription = AppState.addEventListener('change', state => { if (state !== 'active' && dirtyRef.current && editable && !recoveryHeld) void flushDraft().catch(error => setStatus(`Background recovery flush is best effort and failed: ${String(error)}`)); }); return () => subscription.remove(); }, [editable, recoveryHeld, note]);
  function handleEditorMessage(event: any) {
    const parsed = validateEditorEnvelope(event.nativeEvent.data, { sessionId: sessionRef.current, afterGeneration: editorGeneration.current });
    if (!parsed.ok) { setStatus(`Editor message rejected: ${parsed.error}`); return; }
    const message = parsed.message; editorGeneration.current = message.generation;
    if (message.type === 'EDITOR_READY') { setEditorReady(true); return; }
    if (message.type === 'EDITOR_ERROR') { setEditorFailed(true); setEditorReady(false); setStatus(`Rich text editor error: ${message.payload.message} Original canonical content is preserved.`); return; }
    if (message.type === 'EDITOR_LAYOUT') { setEditorHeight(message.payload.height as number); return; }
    if (message.type === 'EDITOR_FOCUS_CHANGED') return;
    if (message.type === 'DOCUMENT_CHANGED' || message.type === 'DOCUMENT_SNAPSHOT') {
      if (!parsed.document) { setStatus('Editor document failed Canonical v1 validation. The last safe draft is preserved.'); return; }
      if (message.type === 'DOCUMENT_CHANGED') { updateDocument(parsed.document); return; }
      const pending = pendingSnapshot.current;
      if (!pending || pending.id !== message.payload.requestId) return;
      clearTimeout(pending.timer); pendingSnapshot.current = null; pending.resolve({ document: parsed.document, generation: message.generation });
    }
  }
  function requestDocumentSnapshot(): Promise<{ document: any; generation: number }> {
    if (!editorReady || !editorRef.current) return Promise.reject(new Error('The rich-text editor is not ready. The note has not been changed.'));
    if (pendingSnapshot.current) return Promise.reject(new Error('A document snapshot is already being requested.'));
    const id = `${sessionRef.current}:${Date.now().toString(36)}:${(++snapshotSequence.current).toString(36)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (pendingSnapshot.current?.id === id) pendingSnapshot.current = null; reject(new Error('The editor did not return a document snapshot. Your draft remains in the recovery journal.')); }, 5000);
      pendingSnapshot.current = { id, resolve, reject, timer }; editorRef.current?.requestDocument(id);
    });
  }
  async function save() {
    const capturedNote = noteRef.current; if (!capturedNote || !editable || recoveryHeld || !saveLock.current.begin()) return false;
    setSaving(true); setStatus('Requesting the latest document…');
    const capturedTitle = title; const capturedTags = tags; const capturedPinned = pinned; const sessionAtStart = sessionRef.current; const changeAtStart = changeSequence.current;
    try {
      const snapshot = editorFailed ? { document: documentRef.current, generation: editorGeneration.current } : await requestDocumentSnapshot();
      if (sessionRef.current !== sessionAtStart || noteRef.current?.id !== capturedNote.id || noteRef.current.revision !== capturedNote.revision) throw new RevisionConflictError();
      if (changeSequence.current !== changeAtStart) throw new Error('The note changed while Save was preparing. The newer draft is still here; save again.');
      const validation = validateCanonicalDocument(snapshot.document);
      if (validation.status !== 'supported') throw new Error(validation.issues?.[0]?.message ?? 'The editor returned unsupported content.');
      setStatus('Saving on this device…');
      await flushDraft({ note: capturedNote, title: capturedTitle, tags: capturedTags, pinned: capturedPinned, document: validation.document });
      if (changeSequence.current !== changeAtStart || sessionRef.current !== sessionAtStart || noteRef.current?.revision !== capturedNote.revision) throw new Error('The note changed before its save completed. The newer draft is preserved; save again.');
      const nextTags = normalizeTagList(capturedTags.split(/\r?\n/u).map(tag => tag.trim()).filter(Boolean));
      const result = await saveNote({ ...capturedNote, title: capturedTitle, document: validation.document, tags: nextTags, pinned: capturedPinned }, capturedNote.revision);
      if (sessionRef.current !== sessionAtStart || noteRef.current?.id !== capturedNote.id) return false;
      const newerEdits = changeSequence.current !== changeAtStart;
      noteRef.current = result.note; setNote(result.note);
      if (!newerEdits) {
        documentRef.current = result.note.document; setDocument(result.note.document); dirtyRef.current = false; setDirty(false); latestRef.current = null; draftWriter.current?.clearPending();
        setStatus(result.recoveryJournalCleared ? 'Saved on this device.' : 'Note saved. The previous matching recovery draft could not be cleared and remains safe.');
      } else {
        await flushDraft({ note: result.note });
        setStatus('Saved the requested snapshot. Newer edits remain unsaved and are in the recovery journal.');
      }
      editorRef.current?.saveResult(`save:${snapshotSequence.current}`, true, result.note.revision, newerEdits ? 'Earlier snapshot saved · newer edits are unsaved' : 'Saved on this device');
      return !newerEdits;
    } catch (error) {
      const message = error instanceof RevisionConflictError ? `${error.message} Your unsaved draft is still here.` : error instanceof Error ? error.message : 'Could not save.';
      setStatus(message); editorRef.current?.saveResult(`save:${snapshotSequence.current}`, false, noteRef.current?.revision ?? 0, message); return false;
    } finally { saveLock.current.finish(); setSaving(false); }
  }
  function back(action: any) {
    if (!gateRef.current.canNavigate() || recordingPending) { setStatus('Stop and save the recording before leaving this note.'); return; }
    if (saveLock.current.active) { setStatus('Save is in progress. Wait for its result before leaving this note.'); return; }
    if (!dirtyRef.current) { navigation.dispatch(action); return; }
    Alert.alert('Unsaved changes', 'Save this draft before leaving?', [
      { text: 'Keep editing', style: 'cancel' }, { text: 'Discard', style: 'destructive', onPress: () => { void (async () => { if (!note || !draftWriter.current) return; try { await discardDraftSafely({ cancelDebounce: () => { if (draftTimer.current) clearTimeout(draftTimer.current); draftTimer.current = null; latestRef.current = null; }, writer: draftWriter.current, noteId: note.id, expectedRevision: note.revision, deleteJournal: discardRecoveryDraft }); navigation.dispatch(action); } catch (error) { setStatus(`Could not confirm discard; you are still in this note. ${String(error)}`); } })(); } }, { text: 'Save', onPress: () => { void (async () => { if (await save()) navigation.dispatch(action); })(); } },
    ]);
  }
  usePreventRemove(!gateRef.current.canNavigate() || recordingPending || dirty || saving, ({ data }) => { if (!gateRef.current.canNavigate() || recordingPending) { setStatus('Stop and save the recording before leaving this note.'); return; } back(data.action); });
  async function startRecording() {
    const gate = gateRef.current; const currentNote = note; if (!currentNote || !gate.beginStart()) return;
    const release = acquireNativeRecordingSession(`editor:${route.params.id}`);
    if (!release) { gate.finish(); setStatus('Another recording session is already active. Stop and save it first.'); return; }
    recordingSessionRelease.current = release; setRecordingPhase(gate.phase);
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) { setStatus('Microphone access was denied. Enable it in iOS Settings to record.'); gate.finish(); setRecordingPhase(gate.phase); recordingSessionRelease.current?.(); recordingSessionRelease.current = null; return; }
      gate.move('requesting', 'starting'); setRecordingPhase(gate.phase);
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, allowsBackgroundRecording: false });
      await recorder.prepareToRecordAsync();
      if (gate.backgroundRequested) { await recorder.stop(); gate.finish(); setRecordingPhase(gate.phase); setStatus('Recording start was cancelled when the app left the foreground.'); recordingSessionRelease.current?.(); recordingSessionRelease.current = null; return; }
      const createdAt = timeNow(), recording = { id: `recording-${makeId()}`, note_id: currentNote.id, title: `Recording ${new Date(createdAt).toLocaleString()}`, file_uri: recorder.uri ?? '', status: 'recording', created_at: createdAt };
      const metadata = recordingArchiveMetadata({ ...recording, status: 'interrupted' });
      await beginAudioAnchorSession(currentNote.id, null, recording, metadata); editorAudioSession.current = { recording, metadata };
      recorder.record(); gate.move('starting', 'recording'); setRecordingPhase(gate.phase); setStatus('Recording locally…');
    } catch (error) { const session = editorAudioSession.current; if (session) { await removeAudioAnchorSession(session.recording.id).catch(() => {}); editorAudioSession.current = null; } gate.finish(); setRecordingPhase(gate.phase); recordingSessionRelease.current?.(); recordingSessionRelease.current = null; setStatus(`Recording could not start: ${String(error)}`); }
  }
  async function addEditorBookmark() {
    const session = editorAudioSession.current; if (!session) return;
    try { const offsetMs = Math.max(0, Math.round(recorder.currentTime * 1000)); const set = await addRecordingSessionAnchor(session.recording.id, createAudioAnchor(session.recording.id, offsetMs, '', { id: `bookmark-${makeId()}`, createdAt: timeNow() } as any)); session.metadata = { ...session.metadata, audioAnchors: set }; editorAudioSession.current = session; setStatus(`Bookmark saved at ${formatAudioTimestamp(offsetMs)}.`); }
    catch (error) { setStatus(`Could not save bookmark. The recording journal remains safe. ${String(error)}`); }
  }
  async function toggleEditorPause() {
    const gate = gateRef.current;
    try { if (gate.phase === 'recording' && gate.pause()) { await recorder.pause(); setRecordingPhase(gate.phase); setStatus('Recording paused.'); } else if (gate.phase === 'paused' && gate.resume()) { recorder.record(); setRecordingPhase(gate.phase); setStatus('Recording resumed.'); } }
    catch (error) { setStatus(`Could not change recording state. ${String(error)}`); }
  }
  async function finishRecording(interrupted = false) {
    const gate = gateRef.current; if (!note) return;
    let releaseFinalization: (() => void) | null = null;
    try { releaseFinalization = beginRecordingFinalization(); }
    catch (error) { setStatus(error instanceof Error ? error.message : 'Wait for backup to finish before stopping the recording.'); return; }
    if (!gate.beginStop()) { releaseFinalization(); return; } setRecordingPhase(gate.phase);
    try {
      const durationMs = Math.max(0, Math.round(recorder.currentTime * 1000));
      await recorder.stop();
      gate.move('stopping', 'finalizing'); setRecordingPhase(gate.phase);
      const uri = recorder.uri;
      if (!uri) throw new Error('Recorder did not provide a finalized audio file.');
      const file = new File(uri);
      if (!file.exists || file.size <= 0) throw new Error('Finalized recording file is missing or empty; it was not marked complete.');
      const session = editorAudioSession.current; if (!session) throw new Error('The provisional bookmark journal is missing; finalized audio was kept.');
      const recording = { ...session.recording, file_uri: uri, status: interrupted ? 'interrupted' : 'complete', title: interrupted ? `Interrupted recording ${new Date(session.recording.created_at).toLocaleString()}` : session.recording.title };
      const metadata = { ...session.metadata, durationMs, durationKnown: false, updatedAt: timeNow() };
      session.recording = recording; session.metadata = metadata; editorAudioSession.current = session;
      await commitAudioAnchorSession(recording.id, null, recording, metadata);
      editorAudioSession.current = null; setRecordingPending(false);
      setRecordings(await listRecordings(note.id));
      setStatus(interrupted ? 'Recording stopped when the app left the foreground and was kept as interrupted for recovery.' : 'Recording finalized, verified and saved locally.');
    } catch (error) { const retryable = ['complete', 'interrupted'].includes(editorAudioSession.current?.recording.status); setRecordingPending(retryable); setStatus(retryable ? `Finalized audio and its bookmark journal are preserved for retry. ${String(error)}` : `Recording did not finalize. Its provisional bookmark journal remains available for recovery. ${String(error)}`); }
    finally { gate.finish(); setRecordingPhase(gate.phase); releaseFinalization(); recordingSessionRelease.current?.(); recordingSessionRelease.current = null; }
  }
  async function retryEditorRecordingSave() {
    const session = editorAudioSession.current; if (!session || !note) return;
    try { await commitAudioAnchorSession(session.recording.id, null, session.recording, session.metadata); editorAudioSession.current = null; setRecordingPending(false); setRecordings(await listRecordings(note.id)); setStatus('Recording and bookmarks saved on this device.'); }
    catch (error) { setStatus(`Audio and bookmarks remain in the recovery journal. Retry when ready. ${String(error)}`); }
  }
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => { if (state === 'active') return; const gate = gateRef.current; if (gate.requestBackgroundStop()) void finishRecording(true); });
    return () => sub.remove();
  }, [note]);
  async function finishFileCleanup(uri: string) { if (uri) { const file = new File(uri); if (file.exists) file.delete(); } await markFileCleanupDone(uri); }
  function deleteRecording(item: Recording) {
    Alert.alert('Delete recording?', `“${item.title}” will be removed from this device.`, [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => { void (async () => { try { const uri = await removeRecording(item.id); setRecordings(await listRecordings(item.note_id)); await finishFileCleanup(uri); } catch (error) { setStatus(`Recording metadata may be removed; queued file cleanup will retry: ${String(error)}`); } })(); } }]);
  }
  function rename(item: Recording) { Alert.prompt('Rename recording', 'Enter a new title.', value => { if (value?.trim()) void renameRecording(item.id, value.trim()).then(() => listRecordings(item.note_id)).then(setRecordings).catch(error => setStatus(`Rename failed: ${String(error)}`)); }, 'plain-text', item.title); }
  function renameAnchor(item: Recording, anchorId: string, currentLabel: string) { Alert.prompt('Rename bookmark', 'Leave blank to show “Bookmark”.', value => { if (value !== undefined) void renameRecordingAnchor(item.id, anchorId, value).then(() => listRecordings(item.note_id)).then(setRecordings).catch(error => setStatus(`Bookmark rename failed: ${String(error)}`)); }, 'plain-text', currentLabel); }
  function deleteAnchor(item: Recording, anchorId: string) { void deleteRecordingAnchor(item.id, anchorId).then(() => listRecordings(item.note_id)).then(setRecordings).catch(error => setStatus(`Bookmark delete failed: ${String(error)}`)); }
  async function addPlaybackBookmark(recordingId: string, offsetMs: number) { const item = recordings.find(recording => recording.id === recordingId); if (!item) return; try { await addRecordingAnchor(recordingId, createAudioAnchor(recordingId, Math.max(0, Math.round(offsetMs)), '', { id: `bookmark-${makeId()}`, createdAt: timeNow() } as any)); setRecordings(await listRecordings(item.note_id)); setStatus(`Playback bookmark saved at ${formatAudioTimestamp(offsetMs)}.`); } catch (error) { setStatus(`Could not save playback bookmark. ${String(error)}`); } }
  async function shareAudio(item: Recording) {
    if (!item.file_uri) { setStatus('This recording’s metadata was preserved, but it contains no audio bytes to export.'); return; }
    const file = new File(item.file_uri);
    if (!file.exists || file.size <= 0) { setStatus('This audio file is missing or empty.'); return; }
    try { if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file.uri, { dialogTitle: `Export ${item.title}` }); else setStatus('Audio file exists but sharing is unavailable on this device.'); }
    catch (error) { setStatus(`Could not share audio: ${String(error)}`); }
  }
  if (!note) return <View style={styles.center}><Text>{status || 'Loading note…'}</Text></View>;
  const fallback = documentToNativeModel(document);
  const fallbackEditable = editorFailed && editable && fallback.editable && !recoveryHeld;
  return <SafeAreaView style={styles.screen} edges={['bottom', 'left', 'right']}><KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <ScrollView contentContainerStyle={styles.editorContent} keyboardShouldPersistTaps="handled" scrollEventThrottle={16}>
      {readOnlyReason ? <View style={styles.readOnly}><Text style={styles.readOnlyTitle}>Read-only note</Text><Text style={styles.readOnlyText}>{readOnlyReason}</Text></View> : null}
      <TextInput style={styles.titleInput} editable={editable && !recoveryHeld && !saving} value={title} onChangeText={updateTitle} placeholder="Title" multiline />
      {editable && !recoveryHeld ? <>
        <Text style={styles.sectionLabel}>BODY · CANONICAL DOCUMENT V1</Text>
        {!editorFailed ? <CanonicalEditor key={sessionId} ref={editorRef} sessionId={sessionId} document={document} editable={editable && !recoveryHeld} height={editorHeight} onMessage={handleEditorMessage} onFailure={message => { setEditorFailed(true); setEditorReady(false); setStatus(`${message} The original document remains preserved.`); }} onInstanceRestart={() => { const currentNote = noteRef.current; if (currentNote) { setStatus('The editor restarted. Its last validated document is being reopened; recent unsaved changes remain in the recovery journal.'); setSessionId(createEditorSession(currentNote.id, makeId())); } }} /> : fallbackEditable ? <View><Text style={styles.readOnlyText}>Bundled editor unavailable. The supported plain-text/checklist editor is active for this note.</Text><TextInput style={styles.bodyInput} value={fallback.paragraphs.join('\n')} onChangeText={value => updateDocument(nativeModelToDocument(value.split('\n'), fallback.tasks))} placeholder="Write a note…" multiline textAlignVertical="top" /><View style={styles.segmentRow}><Text style={styles.sectionLabel}>CHECKLIST</Text><Pressable onPress={() => updateDocument(nativeModelToDocument(fallback.paragraphs, fallback.tasks.length ? fallback.tasks : [{ text: '', checked: false }]))}><Text style={styles.action}>＋ Add item</Text></Pressable></View>{fallback.tasks.map((task, index) => <View key={index} style={styles.taskRow}><Pressable onPress={() => updateDocument(nativeModelToDocument(fallback.paragraphs, fallback.tasks.map((item, i) => i === index ? { ...item, checked: !item.checked } : item)))} style={[styles.checkbox, task.checked && styles.checked]}><Text style={styles.checkMark}>{task.checked ? '✓' : ''}</Text></Pressable><TextInput style={[styles.taskInput, task.checked && styles.taskDone]} value={task.text} onChangeText={text => updateDocument(nativeModelToDocument(fallback.paragraphs, fallback.tasks.map((item, i) => i === index ? { ...item, text } : item)))} placeholder="Checklist item" /><Pressable onPress={() => updateDocument(nativeModelToDocument(fallback.paragraphs, fallback.tasks.filter((_, i) => i !== index)))}><Text style={styles.dangerAction}>×</Text></Pressable></View>)}</View> : <ReadOnlyDocument document={document} />}
        <Text style={styles.sectionLabel}>ORGANIZE</Text>
        <TextInput style={[styles.field, { minHeight: 76 }]} editable={!saving} value={tags} onChangeText={updateTags} placeholder="One tag per line" autoCapitalize="none" multiline textAlignVertical="top" />
        <Pressable style={styles.pinRow} disabled={saving} onPress={() => updatePinned(!pinned)}><Text style={styles.action}>{pinned ? '◆ Pinned' : '◇ Pin note'}</Text></Pressable>
      </> : <ReadOnlyDocument document={note.document} />}
      {editable && !recoveryHeld ? <Pressable disabled={saving || (!dirty && !editorReady)} style={[styles.primaryWide, saving && { opacity: .65 }]} onPress={() => void save()}><Text style={styles.primaryText}>{saving ? 'Saving…' : dirty ? 'Save changes' : editorReady ? 'Saved' : 'Opening editor…'}</Text></Pressable> : null}
      {note.lifecycle === 'active' && editable && !recoveryHeld ? <View style={styles.audioPanel}>
        <View style={styles.segmentRow}><Text style={styles.sectionLabel}>LOCAL AUDIO</Text><Text style={styles.subtle}>Included in Full Archive V2</Text></View>
        <Text style={styles.subtle}>On-device recordings only · recording stops when the app leaves the foreground.</Text>
        {recordingPhase === 'idle' ? <Pressable style={styles.recordButton} onPress={() => void startRecording()}><Text style={styles.recordButtonText}>●  Record</Text></Pressable> : ['recording','paused'].includes(recordingPhase) ? <View style={styles.segmentRow}><Pressable style={styles.stopButton} onPress={() => void finishRecording(false)}><Text style={styles.stopText}>■ Stop · {Math.round(recorder.currentTime)}s</Text></Pressable><Pressable style={styles.smallButton} onPress={() => void toggleEditorPause()}><Text style={styles.smallButtonText}>{recordingPhase === 'paused' ? 'Resume' : 'Pause'}</Text></Pressable><Pressable style={styles.smallButton} onPress={() => void addEditorBookmark()}><Text style={styles.smallButtonText}>⚑ Bookmark</Text></Pressable></View> : recordingPending ? <Pressable style={styles.recordButton} onPress={() => void retryEditorRecordingSave()}><Text style={styles.recordButtonText}>Retry saving recording</Text></Pressable> : <Text style={styles.subtle}>Recording {recordingPhase}…</Text>}
        {recordingPending ? <Text accessibilityRole="alert" style={styles.status}>Final audio is preserved with its bookmark journal. Retry save before leaving this note.</Text> : null}
        {recordings.map(item => <View key={item.id} style={styles.audioWithShare}><AudioItem item={item} onPlay={recording => { const f = new File(recording.file_uri); if (!f.exists || f.size <= 0) { Alert.alert('File unavailable', 'This recording’s file is missing or empty.'); return; } setPlayingRecordingId(recording.id); setPlaybackOffsetMs(null); setPlayingUri(recording.file_uri); }} onSeek={anchor => { setPlayingRecordingId(item.id); setPlaybackOffsetMs(anchor.offsetMs); setPlayingUri(item.file_uri); }} onRename={rename} onDelete={deleteRecording} onRenameAnchor={(anchorId, currentLabel) => renameAnchor(item, anchorId, currentLabel)} onDeleteAnchor={anchorId => deleteAnchor(item, anchorId)} />{item.file_uri ? <Pressable onPress={() => void shareAudio(item)}><Text style={styles.action}>Export</Text></Pressable> : null}</View>)}
        {playingUri ? <AudioPlayback uri={playingUri} seekOffsetMs={playbackOffsetMs} onSeekConsumed={() => setPlaybackOffsetMs(null)} onBookmark={offsetMs => void addPlaybackBookmark(playingRecordingId, offsetMs)} onClose={() => { setPlayingUri(''); setPlayingRecordingId(''); setPlaybackOffsetMs(null); }} /> : null}
      </View> : null}
      {status ? <Text accessibilityRole="alert" style={styles.status}>{status}</Text> : null}
      <Text style={styles.revision}>Revision {note.revision} · {new Date(note.updatedAt).toLocaleString()}</Text>
  </ScrollView>
  </KeyboardAvoidingView></SafeAreaView>;
}

function ReadOnlyDocument({ document }: { document: any }) {
  const render = (node: any, key: string): React.ReactNode => {
    if (node?.type === 'text') return <Text key={key}>{node.text}</Text>;
    if (node?.type === 'taskItem') return <View key={key} style={styles.taskRow}><Text>{node.attrs?.checked ? '☑' : '☐'} </Text><View>{node.content?.map((child: any, i: number) => render(child, `${key}-${i}`))}</View></View>;
    const children = node?.content?.map((child: any, i: number) => render(child, `${key}-${i}`)) ?? [];
    return <View key={key} style={styles.readBlock}>{children.length ? children : <Text style={styles.subtle}> </Text>}</View>;
  };
  return <View style={styles.readOnlyBody}><Text style={styles.sectionLabel}>PRESERVED CANONICAL CONTENT</Text>{document?.content?.map((node: any, i: number) => render(node, String(i)))}</View>;
}

export default function App() {
  const [ready, setReady] = useState(false); const [error, setError] = useState('');
  useEffect(() => { void listNotes().then(() => setReady(true)).catch(reason => setError(String(reason))); }, []);
  if (error) return <View style={styles.center}><Text style={styles.heading}>Storage could not open</Text><Text>{error}</Text><Text style={styles.subtle}>No data was reset. Close and reopen the prototype after resolving this storage error.</Text></View>;
  if (!ready) return <View style={styles.center}><Text>Opening on-device notes…</Text></View>;
  return <SafeAreaProvider><NavigationContainer><Stack.Navigator screenOptions={{ headerStyle: { backgroundColor: '#F7F5F0' }, headerTintColor: '#202019', contentStyle: { backgroundColor: '#F7F5F0' }, headerShadowVisible: false }}><Stack.Screen name="Home" component={HomeScreen} options={{ headerShown: false }} /><Stack.Screen name="Editor" component={EditorScreen} options={{ title: 'Note' }} /></Stack.Navigator></NavigationContainer></SafeAreaProvider>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#F7F5F0' }, center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 12, backgroundColor: '#F7F5F0' },
  homeHeader: { paddingHorizontal: 22, paddingTop: 20, paddingBottom: 14, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }, eyebrow: { fontSize: 10, letterSpacing: 1.7, color: '#6F705F', fontWeight: '700' }, heading: { fontSize: 32, fontWeight: '700', color: '#202019', marginTop: 4 },
  primary: { backgroundColor: '#344D3F', paddingHorizontal: 15, paddingVertical: 11, borderRadius: 22 }, primaryWide: { backgroundColor: '#344D3F', borderRadius: 14, padding: 15, alignItems: 'center', marginVertical: 18 }, primaryText: { color: 'white', fontSize: 14, fontWeight: '700' },
  captureCard: { marginHorizontal: 20, marginBottom: 5, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 8, borderRadius: 15, borderWidth: 1, borderColor: '#E2DED4', backgroundColor: '#FFFEFC' }, captureFocused: { borderColor: '#82927F' }, captureInput: { minHeight: 75, maxHeight: 150, paddingHorizontal: 1, paddingTop: 5, color: '#272820', fontSize: 18, lineHeight: 26 }, captureActions: { flexDirection: 'row', alignItems: 'center', gap: 9, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#EBE8E0', paddingTop: 8 }, voiceButton: { minHeight: 42, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 22, backgroundColor: '#F2EAE1' }, voiceButtonText: { color: '#654A37', fontWeight: '700', fontSize: 13 }, voiceButtonRecording: { backgroundColor: '#A04435' }, voiceButtonRecordingText: { color: 'white' }, captureHint: { flex: 1, color: '#85847B', fontSize: 10, lineHeight: 14 }, captureSaveButton: { minWidth: 68, minHeight: 42, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14, borderRadius: 22, backgroundColor: '#344D3F' }, captureSaveText: { color: 'white', fontWeight: '700', fontSize: 13 }, disabledButton: { opacity: .48 }, captureMessage: { paddingTop: 8, color: '#416958', fontSize: 11, lineHeight: 16 }, captureError: { color: '#A04F3D' },
  search: { backgroundColor: '#ECEAE2', marginHorizontal: 20, borderRadius: 13, paddingHorizontal: 14, paddingVertical: 12, color: '#202019' }, segmentRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 7, marginHorizontal: 20, marginTop: 13, marginBottom: 7 }, segment: { flex: 1, paddingVertical: 9, alignItems: 'center', borderRadius: 18 }, segmentActive: { backgroundColor: '#DCE4DA' }, segmentText: { color: '#77786F', fontSize: 13, fontWeight: '600' }, segmentTextActive: { color: '#344D3F' },
  status: { color: '#77562D', backgroundColor: '#F0E6D1', padding: 10, marginHorizontal: 20, borderRadius: 9, overflow: 'hidden', marginVertical: 5 }, listContent: { paddingHorizontal: 18, paddingBottom: 16, flexGrow: 1 }, empty: { textAlign: 'center', color: '#88877F', padding: 36, lineHeight: 22 }, noteCard: { backgroundColor: '#FFFEFC', padding: 16, borderRadius: 16, marginTop: 10, borderWidth: 1, borderColor: '#EBE8E0' }, noteTitleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, noteTitle: { color: '#272820', fontWeight: '700', fontSize: 16, flex: 1 }, noteTime: { color: '#99978E', fontSize: 11, marginLeft: 6 }, preview: { color: '#77776E', lineHeight: 19, marginTop: 7 }, tags: { color: '#647D6C', fontSize: 12, marginTop: 8 }, cardActions: { borderTopColor: '#F0EEE9', borderTopWidth: 1, marginTop: 12, paddingTop: 10, flexDirection: 'row', gap: 17 }, action: { color: '#42644F', fontWeight: '600', paddingVertical: 4 }, dangerAction: { color: '#A04F3D', fontWeight: '600', paddingVertical: 4 }, backupRow: { borderTopColor: '#E5E2D9', borderTopWidth: 1, paddingHorizontal: 20, paddingVertical: 13, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, backupPanel: { borderTopColor: '#E5E2D9', borderTopWidth: 1, paddingHorizontal: 16, paddingBottom: 10 }, backupActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#EBE8E0' }, backupStatus: { color: '#77562D', fontSize: 12, lineHeight: 17, paddingVertical: 8 }, subtle: { color: '#8B8980', fontSize: 11 },
  editorContent: { paddingHorizontal: 21, paddingTop: 18, paddingBottom: 50 }, readOnly: { padding: 13, borderRadius: 12, backgroundColor: '#F0E6D1', marginBottom: 14 }, readOnlyTitle: { color: '#74502A', fontWeight: '700' }, readOnlyText: { color: '#74502A', marginTop: 4, lineHeight: 19 }, titleInput: { fontSize: 29, fontWeight: '700', color: '#22231D', paddingHorizontal: 0, paddingVertical: 8, marginBottom: 16 }, sectionLabel: { fontSize: 10, fontWeight: '800', letterSpacing: 1.4, color: '#797B6C', marginTop: 15, marginBottom: 7 }, bodyInput: { minHeight: 150, padding: 14, borderRadius: 13, backgroundColor: '#FFFEFC', color: '#25251F', fontSize: 16, lineHeight: 24, borderColor: '#EBE8E0', borderWidth: 1 }, field: { backgroundColor: '#FFFEFC', borderColor: '#EBE8E0', borderWidth: 1, borderRadius: 12, padding: 13, color: '#272820' }, pinRow: { alignSelf: 'flex-start', marginTop: 10 }, taskRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 5 }, checkbox: { width: 23, height: 23, borderRadius: 7, borderWidth: 1.5, borderColor: '#9A9A8C', alignItems: 'center', justifyContent: 'center' }, checked: { backgroundColor: '#496A52', borderColor: '#496A52' }, checkMark: { color: 'white', fontWeight: '800' }, taskInput: { flex: 1, paddingVertical: 8, color: '#272820', fontSize: 15 }, taskDone: { textDecorationLine: 'line-through', color: '#99978E' }, revision: { color: '#9B998F', fontSize: 11, textAlign: 'center', marginVertical: 22 }, readOnlyBody: { backgroundColor: '#FFFEFC', borderRadius: 13, padding: 15, borderColor: '#EBE8E0', borderWidth: 1, marginTop: 12 }, readBlock: { paddingVertical: 5, flexDirection: 'row', flexWrap: 'wrap' },
  audioPanel: { backgroundColor: '#FFFEFC', marginTop: 17, padding: 15, borderRadius: 15, borderColor: '#EBE8E0', borderWidth: 1 }, recordButton: { backgroundColor: '#F4E6E0', borderRadius: 12, padding: 13, alignItems: 'center', marginVertical: 12 }, recordButtonText: { color: '#A04435', fontWeight: '700' }, stopButton: { backgroundColor: '#A04435', borderRadius: 12, padding: 13, alignItems: 'center', marginVertical: 12 }, stopText: { color: 'white', fontWeight: '700' }, audioRow: { flexDirection: 'row', alignItems: 'center', gap: 9, borderTopColor: '#EFEDE7', borderTopWidth: 1, paddingVertical: 10 }, audioWithShare: { flexDirection: 'row', alignItems: 'center', gap: 3 }, audioTitle: { color: '#272820', fontWeight: '600' }, smallButton: { backgroundColor: '#E3EADF', borderRadius: 9, paddingHorizontal: 10, paddingVertical: 7 }, smallButtonText: { color: '#344D3F', fontWeight: '700', fontSize: 12 },
});
