import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, Button, FlatList, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { NavigationContainer, usePreventRemove } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioPlayer, useAudioRecorder, useAudioRecorderState } from 'expo-audio';
import { File, Paths } from 'expo-file-system';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { makeBackup, parseBackup, filterNotes, sortNotes } from '../web/app/lib/mvp-utils.mjs';
import { normalizeTagList } from '../web/app/lib/note-organization.mjs';
import { createEmptyCanonicalDocument } from '../web/packages/document-engine/src/plain-text.js';
import { documentToNativeModel, nativeModelToDocument } from './document-subset';
import { createNote, discardRecoveryDraft, exportNotes, getNote, getRecoveryDraft, importNotes, listNotes, listPendingFileCleanups, listRecordings, markFileCleanupDone, Note, permanentlyDeleteNote, RecoveryDraft, Recording, removeRecording, renameRecording, RevisionConflictError, saveNote, saveRecording, saveRecoveryDraft, setLifecycle, setPinned } from './store';
import { canEditNativeNote, discardDraftSafely, LatestDraftWriter, recoveryDecision, RecordingSessionGate } from './mobile-safety.mjs';

type RootStack = { Home: undefined; Editor: { id: string } };
const Stack = createNativeStackNavigator<RootStack>();
const makeId = () => `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
const timeNow = () => Date.now();

function HomeScreen({ navigation }: any) {
  const [notes, setNotes] = useState<Note[]>([]); const [query, setQuery] = useState('');
  const [lifecycle, setLifecycleFilter] = useState<'active' | 'archived' | 'trashed'>('active'); const [status, setStatus] = useState('');
  const pendingPins = useRef(new Set<string>());
  const refresh = useCallback(async () => { setNotes(await listNotes()); const pending = await listPendingFileCleanups(); for (const uri of pending) { try { const file = new File(uri); if (file.exists) file.delete(); await markFileCleanupDone(uri); } catch (error) { setStatus(`File cleanup is pending retry: ${String(error)}`); } } }, []);
  async function togglePin(item: Note) { if (pendingPins.current.has(item.id)) return; pendingPins.current.add(item.id); try { await setPinned(item.id, !item.pinned, item.revision); await refresh(); } catch (error) { setStatus(String(error)); } finally { pendingPins.current.delete(item.id); } }
  useEffect(() => { void refresh().catch(error => setStatus(String(error))); }, [refresh]);
  useEffect(() => { const unsubscribe = navigation.addListener('focus', () => { void refresh(); }); return unsubscribe; }, [navigation, refresh]);
  const visible = useMemo(() => sortNotes(filterNotes(notes, query, lifecycle) as Note[]), [notes, query, lifecycle]);
  async function create() {
    const now = timeNow();
    const note: Note = { id: makeId(), title: 'Untitled note', document: createEmptyCanonicalDocument(), schemaVersion: 1, createdAt: now, updatedAt: now, lifecycle: 'active', revision: 0, pinned: false, tags: [] };
    try { await createNote(note); navigation.navigate('Editor', { id: note.id }); } catch (error) { setStatus(String(error)); }
  }
  async function backupExport() {
    try {
      const data = makeBackup(await exportNotes());
      const file = new File(Paths.cache, `noteos-backup-${new Date().toISOString().slice(0, 10)}.json`);
      if (file.exists) file.delete(); file.create(); await file.write(JSON.stringify(data, null, 2));
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file.uri, { mimeType: 'application/json', dialogTitle: 'Export noteOS notes backup' });
      else setStatus(`Backup prepared at ${file.uri}; sharing is unavailable on this device.`);
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Could not export notes.'); }
  }
  async function backupImport() {
    try {
      const picked = await DocumentPicker.getDocumentAsync({ type: ['application/json', 'text/json'], copyToCacheDirectory: true });
      if (picked.canceled) return;
      const text = new File(picked.assets[0].uri).textSync();
      const bundle = parseBackup(text);
      await importNotes(bundle.notes as Note[]); await refresh(); setStatus(`Imported ${bundle.notes.length} notes. Audio is not part of this backup.`);
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Could not import this backup.'); }
  }
  async function changeLifecycle(note: Note, next: 'active' | 'archived' | 'trashed') {
    try { await setLifecycle(note.id, next, note.revision); await refresh(); }
    catch (error) { setStatus(error instanceof Error ? error.message : 'Could not update note.'); }
  }
  function deleteForever(note: Note) {
    Alert.alert('Delete permanently?', `“${note.title || 'Untitled note'}” and its local recordings will be removed from this device. Notes backup does not include audio.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => { void (async () => {
        try {
          const uris = await permanentlyDeleteNote(note.id, note.revision); await refresh();
          for (const uri of uris) { const file = new File(uri); if (file.exists) file.delete(); await markFileCleanupDone(uri); }
        } catch (error) { setStatus(`Metadata is preserved if the database operation failed; file cleanup will retry where queued: ${String(error)}`); }
      })(); } },
    ]);
  }
  return <SafeAreaView style={styles.screen} edges={['top', 'left', 'right', 'bottom']}>
    <View style={styles.homeHeader}><View><Text style={styles.eyebrow}>PRIVATE · ON THIS DEVICE</Text><Text style={styles.heading}>Your notes</Text></View><Pressable style={styles.primary} onPress={() => void create()}><Text style={styles.primaryText}>＋ New note</Text></Pressable></View>
    <TextInput style={styles.search} placeholder="Search notes and tags" value={query} onChangeText={setQuery} returnKeyType="search" />
    <View style={styles.segmentRow}>{(['active', 'archived', 'trashed'] as const).map(value => <Pressable key={value} onPress={() => setLifecycleFilter(value)} style={[styles.segment, lifecycle === value && styles.segmentActive]}><Text style={[styles.segmentText, lifecycle === value && styles.segmentTextActive]}>{value === 'active' ? 'Notes' : value === 'archived' ? 'Archive' : 'Trash'}</Text></Pressable>)}</View>
    {status ? <Text accessibilityRole="alert" style={styles.status}>{status}</Text> : null}
    <FlatList data={visible} keyExtractor={item => item.id} contentContainerStyle={styles.listContent} ListEmptyComponent={<Text style={styles.empty}>Nothing here yet. Create a note or import a Web backup.</Text>} renderItem={({ item }) => {
      const body = documentToNativeModel(item.document); const preview = body.editable ? [...body.paragraphs, ...body.tasks.map(task => task.text)].filter(Boolean).join(' · ') : 'Rich content · opens read-only';
      return <Pressable style={styles.noteCard} onPress={() => navigation.navigate('Editor', { id: item.id })}>
        <View style={styles.noteTitleRow}><Text style={styles.noteTitle} numberOfLines={1}>{item.pinned ? '◆ ' : ''}{item.title || 'Untitled note'}</Text><Text style={styles.noteTime}>{new Date(item.updatedAt).toLocaleDateString()}</Text></View>
        <Text style={styles.preview} numberOfLines={2}>{preview || 'No text yet'}</Text>
        {!!item.tags?.length && <Text style={styles.tags}>{item.tags.map((tag: string) => `#${tag}`).join('   ')}</Text>}
        <View style={styles.cardActions}>
          {lifecycle === 'active' ? <><Text onPress={() => void togglePin(item)} style={styles.action}>{item.pinned ? 'Unpin' : 'Pin'}</Text><Text onPress={() => void changeLifecycle(item, 'archived')} style={styles.action}>Archive</Text><Text onPress={() => void changeLifecycle(item, 'trashed')} style={styles.action}>Trash</Text></> : lifecycle === 'archived' ? <><Text onPress={() => void changeLifecycle(item, 'active')} style={styles.action}>Restore</Text><Text onPress={() => void changeLifecycle(item, 'trashed')} style={styles.action}>Move to trash</Text></> : <><Text onPress={() => void changeLifecycle(item, 'active')} style={styles.action}>Restore</Text><Text onPress={() => deleteForever(item)} style={styles.dangerAction}>Delete forever</Text></>}
        </View>
      </Pressable>;
    }} />
    <View style={styles.backupRow}><Text style={styles.subtle}>Manual transfer · notes only</Text><Pressable onPress={() => void backupImport()}><Text style={styles.action}>Import</Text></Pressable><Pressable onPress={() => void backupExport()}><Text style={styles.action}>Export</Text></Pressable></View>
  </SafeAreaView>;
}

function AudioItem({ item, onPlay, onRename, onDelete }: { item: Recording; onPlay: (item: Recording) => void; onRename: (item: Recording) => void; onDelete: (item: Recording) => void }) {
  return <View style={styles.audioRow}><View style={{ flex: 1 }}><Text style={styles.audioTitle}>{item.title}</Text><Text style={styles.subtle}>{item.status === 'complete' ? 'Saved locally' : 'Interrupted · recovery available'}</Text></View><Pressable onPress={() => onPlay(item)} style={styles.smallButton}><Text style={styles.smallButtonText}>Play</Text></Pressable><Pressable onPress={() => onRename(item)}><Text style={styles.action}>Rename</Text></Pressable><Pressable onPress={() => onDelete(item)}><Text style={styles.dangerAction}>Delete</Text></Pressable></View>;
}

function AudioPlayback({ uri, onClose }: { uri: string; onClose: () => void }) { const player = useAudioPlayer(uri); useEffect(() => { player.play(); return () => { try { player.pause(); } catch {} }; }, [player]); return <Pressable onPress={onClose}><Text style={styles.action}>Playing audio · tap to stop</Text></Pressable>; }

function EditorScreen({ route, navigation }: any) {
  const [note, setNote] = useState<Note | null>(null); const [title, setTitle] = useState(''); const [paragraphs, setParagraphs] = useState<string[]>([]); const [tasks, setTasks] = useState<{ text: string; checked: boolean }[]>([]); const [tags, setTags] = useState(''); const [pinned, setPinned] = useState(false); const [editable, setEditable] = useState(false); const [readOnlyReason, setReadOnlyReason] = useState(''); const [dirty, setDirty] = useState(false); const [status, setStatus] = useState(''); const [recordings, setRecordings] = useState<Recording[]>([]); const [recordingPhase, setRecordingPhase] = useState('idle'); const [recoveryHeld, setRecoveryHeld] = useState(false); const [playingUri, setPlayingUri] = useState('');
  const gateRef = useRef(new RecordingSessionGate()); const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null); const draftWriter = useRef<LatestDraftWriter | null>(null); const latestRef = useRef<any>(null);
  if (!draftWriter.current) draftWriter.current = new LatestDraftWriter((value: { id: string; revision: number; draft: RecoveryDraft }) => saveRecoveryDraft(value.id, value.revision, value.draft));
  function snapshotDraft() { if (!note) return null; return { id: note.id, revision: note.revision, draft: { version: 1 as const, baseRevision: note.revision, title, document: nativeModelToDocument(paragraphs, tasks), tagsText: tags, pinned } }; }
  async function flushDraft() { if (draftTimer.current) { clearTimeout(draftTimer.current); draftTimer.current = null; } const latest = snapshotDraft(); if (latest && dirty) { latestRef.current = latest; draftWriter.current?.enqueue(latest); } await draftWriter.current?.flush(); }
  function scheduleDraft() { const latest = snapshotDraft(); if (!latest) return; latestRef.current = latest; if (draftTimer.current) clearTimeout(draftTimer.current); draftTimer.current = setTimeout(() => { draftWriter.current?.enqueue(latest); void draftWriter.current?.flush().catch((error: unknown) => setStatus(`Recovery journal could not be updated: ${String(error)}`)); }, 500); }
  const load = useCallback(async () => {
    const value = await getNote(route.params.id); if (!value) throw new Error('This note no longer exists.');
    setNote(value); setTitle(value.title); setTags(value.tags.join('\n')); setPinned(value.pinned);
    const body = documentToNativeModel(value.document); setEditable(canEditNativeNote(value, body.editable)); setReadOnlyReason(value.lifecycle !== 'active' ? 'Archived and trashed notes are read-only. Restore this note from Home before editing.' : value.schemaVersion !== 1 ? 'This note metadata uses a newer schema and is preserved read-only.' : body.reason ?? '');
    setParagraphs(body.paragraphs); setTasks(body.tasks); setDirty(false); setRecordings(await listRecordings(value.id));
    const journal = await getRecoveryDraft(value.id);
    if (journal) {
      const decision = recoveryDecision(value, journal);
      if (decision === 'offer-restore') Alert.alert('Recover draft?', 'A local recovery draft is available.', [
        { text: 'Keep draft', style: 'cancel', onPress: () => { setRecoveryHeld(true); setStatus('Recovery draft preserved. Editing is paused until you restore or discard it.'); } },
        { text: 'Discard', style: 'destructive', onPress: () => { void discardRecoveryDraft(value.id, journal.baseRevision).catch(error => setStatus(String(error))); } },
        { text: 'Restore', onPress: () => { const recovered = journal.draft; const recoveredBody = documentToNativeModel(recovered.document); if (!recoveredBody.editable) { setRecoveryHeld(true); setStatus('Draft contains content outside the safe native subset; it remains preserved read-only.'); return; } setTitle(recovered.title); setParagraphs(recoveredBody.paragraphs); setTasks(recoveredBody.tasks); setTags(recovered.tagsText); setPinned(recovered.pinned); setDirty(true); setStatus('Draft restored. Save it to commit.'); } },
      ]);
      else { setRecoveryHeld(true); Alert.alert('Older recovery draft', 'The note has changed since this draft was saved. Keep it for review or discard it; it cannot be restored over the newer note.', [{ text: 'Keep draft', style: 'cancel' }, { text: 'Discard', style: 'destructive', onPress: () => { void discardRecoveryDraft(value.id, journal.baseRevision).then(() => setRecoveryHeld(false)).catch(error => setStatus(String(error))); } }]); }
    }
  }, [route.params.id]);
  useEffect(() => { void load().catch(error => setStatus(String(error))); }, [load]);
  useEffect(() => navigation.setOptions({ title: note?.title || 'Note', headerBackTitle: 'Notes' }), [navigation, note?.title]);
  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, directory: 'document' });
  const recorderState = useAudioRecorderState(recorder);
  const setBody = (fn: () => void) => { fn(); setDirty(true); };
  useEffect(() => { if (dirty && editable && !recoveryHeld) scheduleDraft(); }, [dirty, editable, recoveryHeld, title, paragraphs, tasks, tags, pinned, note]);
  useEffect(() => { const subscription = AppState.addEventListener('change', state => { if (state !== 'active' && dirty && editable && !recoveryHeld) void flushDraft().catch(error => setStatus(`Background recovery flush is best effort and failed: ${String(error)}`)); }); return () => subscription.remove(); }, [dirty, editable, recoveryHeld, title, paragraphs, tasks, tags, pinned, note]);
  async function save() {
    if (!note || !editable || recoveryHeld) return false;
    try {
      await flushDraft();
      const nextDoc = nativeModelToDocument(paragraphs, tasks);
      const nextTags = normalizeTagList(tags.split(/\r?\n/u).map(tag => tag.trim()).filter(Boolean));
      const result = await saveNote({ ...note, title, document: nextDoc, tags: nextTags, pinned }, note.revision);
      if (draftTimer.current) clearTimeout(draftTimer.current); latestRef.current = null; draftWriter.current?.clearPending(); setNote(result.note); setDirty(false); setStatus(result.recoveryJournalCleared ? 'Saved on this device.' : 'Note saved, but the matching recovery journal could not be cleared. It is safe and will not overwrite this newer revision.'); return true;
    } catch (error) { setStatus(error instanceof RevisionConflictError ? `${error.message} Your unsaved draft is still here.` : error instanceof Error ? error.message : 'Could not save.'); return false; }
  }
  function back(action: any) {
    if (!gateRef.current.canNavigate()) { setStatus('Stop and save the recording before leaving this note.'); return; }
    if (!dirty) { navigation.dispatch(action); return; }
    Alert.alert('Unsaved changes', 'Save this draft before leaving?', [
      { text: 'Keep editing', style: 'cancel' }, { text: 'Discard', style: 'destructive', onPress: () => { void (async () => { if (!note || !draftWriter.current) return; try { await discardDraftSafely({ cancelDebounce: () => { if (draftTimer.current) clearTimeout(draftTimer.current); draftTimer.current = null; latestRef.current = null; }, writer: draftWriter.current, noteId: note.id, expectedRevision: note.revision, deleteJournal: discardRecoveryDraft }); navigation.dispatch(action); } catch (error) { setStatus(`Could not confirm discard; you are still in this note. ${String(error)}`); } })(); } }, { text: 'Save', onPress: () => { void (async () => { if (await save()) navigation.dispatch(action); })(); } },
    ]);
  }
  usePreventRemove(!gateRef.current.canNavigate() || dirty, ({ data }) => { if (!gateRef.current.canNavigate()) { setStatus('Stop and save the recording before leaving this note.'); return; } back(data.action); });
  async function startRecording() {
    const gate = gateRef.current; if (!gate.beginStart()) return; setRecordingPhase(gate.phase);
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) { setStatus('Microphone access was denied. Enable it in iOS Settings to record.'); gate.finish(); setRecordingPhase(gate.phase); return; }
      gate.move('requesting', 'starting'); setRecordingPhase(gate.phase);
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, allowsBackgroundRecording: false });
      await recorder.prepareToRecordAsync();
      if (gate.backgroundRequested) { await recorder.stop(); gate.finish(); setRecordingPhase(gate.phase); setStatus('Recording start was cancelled when the app left the foreground.'); return; }
      recorder.record(); gate.move('starting', 'recording'); setRecordingPhase(gate.phase); setStatus('Recording locally…');
    } catch (error) { gate.finish(); setRecordingPhase(gate.phase); setStatus(`Recording could not start: ${String(error)}`); }
  }
  async function finishRecording(interrupted = false) {
    const gate = gateRef.current; if (!gate.beginStop() || !note) return; setRecordingPhase(gate.phase);
    try {
      await recorder.stop();
      gate.move('stopping', 'finalizing'); setRecordingPhase(gate.phase);
      const uri = recorder.uri;
      if (!uri) throw new Error('Recorder did not provide a finalized audio file.');
      const file = new File(uri);
      if (!file.exists || file.size <= 0) throw new Error('Finalized recording file is missing or empty; it was not marked complete.');
      const id = makeId(); const created = timeNow();
      await saveRecording({ id, note_id: note.id, title: interrupted ? `Interrupted recording ${new Date(created).toLocaleString()}` : `Recording ${new Date(created).toLocaleString()}`, file_uri: uri, status: interrupted ? 'interrupted' : 'complete', created_at: created });
      setRecordings(await listRecordings(note.id));
      setStatus(interrupted ? 'Recording stopped when the app left the foreground and was kept as interrupted for recovery.' : 'Recording finalized, verified and saved locally.');
    } catch (error) { setStatus(`Audio save state is unknown. Any recorder file was left in place for recovery: ${String(error)}`); }
    finally { gate.finish(); setRecordingPhase(gate.phase); }
  }
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => { if (state === 'active') return; const gate = gateRef.current; if (gate.requestBackgroundStop()) void finishRecording(true); });
    return () => sub.remove();
  }, [note]);
  async function finishFileCleanup(uri: string) { const file = new File(uri); if (file.exists) file.delete(); await markFileCleanupDone(uri); }
  function deleteRecording(item: Recording) {
    Alert.alert('Delete recording?', `“${item.title}” will be removed from this device.`, [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => { void (async () => { try { const uri = await removeRecording(item.id); setRecordings(await listRecordings(item.note_id)); await finishFileCleanup(uri); } catch (error) { setStatus(`Recording metadata may be removed; queued file cleanup will retry: ${String(error)}`); } })(); } }]);
  }
  function rename(item: Recording) { Alert.prompt('Rename recording', 'Enter a new title.', value => { if (value?.trim()) void renameRecording(item.id, value.trim()).then(() => listRecordings(item.note_id)).then(setRecordings).catch(error => setStatus(`Rename failed: ${String(error)}`)); }, 'plain-text', item.title); }
  async function shareAudio(item: Recording) {
    const file = new File(item.file_uri);
    if (!file.exists || file.size <= 0) { setStatus('This audio file is missing or empty.'); return; }
    try { if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file.uri, { dialogTitle: `Export ${item.title}` }); else setStatus('Audio file exists but sharing is unavailable on this device.'); }
    catch (error) { setStatus(`Could not share audio: ${String(error)}`); }
  }
  if (!note) return <View style={styles.center}><Text>{status || 'Loading note…'}</Text></View>;
  return <SafeAreaView style={styles.screen} edges={['bottom', 'left', 'right']}><KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <ScrollView contentContainerStyle={styles.editorContent} keyboardShouldPersistTaps="handled">
      {readOnlyReason ? <View style={styles.readOnly}><Text style={styles.readOnlyTitle}>Read-only note</Text><Text style={styles.readOnlyText}>{readOnlyReason}</Text></View> : null}
      <TextInput style={styles.titleInput} editable={editable && !recoveryHeld} value={title} onChangeText={value => { setTitle(value); setDirty(true); }} placeholder="Title" multiline />
      {editable && !recoveryHeld ? <>
        <Text style={styles.sectionLabel}>BODY</Text>
        <TextInput style={styles.bodyInput} value={paragraphs.join('\n')} onChangeText={value => setBody(() => setParagraphs(value.split('\n')))} placeholder="Write a note…" multiline textAlignVertical="top" />
        <View style={styles.segmentRow}><Text style={styles.sectionLabel}>CHECKLIST</Text><Pressable onPress={() => setBody(() => { if (!tasks.length) setTasks([{ text: '', checked: false }]); })}><Text style={styles.action}>＋ Add item</Text></Pressable></View>
        {tasks.map((task, index) => <View key={index} style={styles.taskRow}><Pressable onPress={() => setBody(() => setTasks(tasks.map((item, i) => i === index ? { ...item, checked: !item.checked } : item)))} style={[styles.checkbox, task.checked && styles.checked]}><Text style={styles.checkMark}>{task.checked ? '✓' : ''}</Text></Pressable><TextInput style={[styles.taskInput, task.checked && styles.taskDone]} editable={editable} value={task.text} onChangeText={text => setBody(() => setTasks(tasks.map((item, i) => i === index ? { ...item, text } : item)))} placeholder="Checklist item" /><Pressable onPress={() => setBody(() => setTasks(tasks.filter((_, i) => i !== index)))}><Text style={styles.dangerAction}>×</Text></Pressable></View>)}
        <Text style={styles.sectionLabel}>ORGANIZE</Text>
        <TextInput style={[styles.field, { minHeight: 76 }]} value={tags} onChangeText={value => { setTags(value); setDirty(true); }} placeholder="One tag per line" autoCapitalize="none" multiline textAlignVertical="top" />
        <Pressable style={styles.pinRow} onPress={() => { setPinned(!pinned); setDirty(true); }}><Text style={styles.action}>{pinned ? '◆ Pinned' : '◇ Pin note'}</Text></Pressable>
      </> : <ReadOnlyDocument document={note.document} />}
      {editable && !recoveryHeld ? <Pressable style={styles.primaryWide} onPress={() => void save()}><Text style={styles.primaryText}>{dirty ? 'Save changes' : 'Saved'}</Text></Pressable> : null}
      {note.lifecycle === 'active' && editable && !recoveryHeld ? <View style={styles.audioPanel}>
        <View style={styles.segmentRow}><Text style={styles.sectionLabel}>LOCAL AUDIO</Text><Text style={styles.subtle}>Not included in notes backup</Text></View>
        <Text style={styles.subtle}>On-device recordings only · recording stops when the app leaves the foreground.</Text>
        {recordingPhase === 'idle' ? <Pressable style={styles.recordButton} onPress={() => void startRecording()}><Text style={styles.recordButtonText}>●  Record</Text></Pressable> : recordingPhase === 'recording' ? <Pressable style={styles.stopButton} onPress={() => void finishRecording(false)}><Text style={styles.stopText}>■  Stop & save · {Math.round(recorderState.durationMillis / 1000)}s</Text></Pressable> : <Text style={styles.subtle}>Recording {recordingPhase}…</Text>}
        {recordings.map(item => <View key={item.id} style={styles.audioWithShare}><AudioItem item={item} onPlay={recording => { const f = new File(recording.file_uri); if (!f.exists || f.size <= 0) { Alert.alert('File unavailable', 'This recording’s file is missing or empty.'); return; } setPlayingUri(recording.file_uri); }} onRename={rename} onDelete={deleteRecording} /><Pressable onPress={() => void shareAudio(item)}><Text style={styles.action}>Export</Text></Pressable></View>)}
        {playingUri ? <AudioPlayback uri={playingUri} onClose={() => setPlayingUri('')} /> : null}
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
  search: { backgroundColor: '#ECEAE2', marginHorizontal: 20, borderRadius: 13, paddingHorizontal: 14, paddingVertical: 12, color: '#202019' }, segmentRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 7, marginHorizontal: 20, marginTop: 13, marginBottom: 7 }, segment: { flex: 1, paddingVertical: 9, alignItems: 'center', borderRadius: 18 }, segmentActive: { backgroundColor: '#DCE4DA' }, segmentText: { color: '#77786F', fontSize: 13, fontWeight: '600' }, segmentTextActive: { color: '#344D3F' },
  status: { color: '#77562D', backgroundColor: '#F0E6D1', padding: 10, marginHorizontal: 20, borderRadius: 9, overflow: 'hidden', marginVertical: 5 }, listContent: { paddingHorizontal: 18, paddingBottom: 16, flexGrow: 1 }, empty: { textAlign: 'center', color: '#88877F', padding: 36, lineHeight: 22 }, noteCard: { backgroundColor: '#FFFEFC', padding: 16, borderRadius: 16, marginTop: 10, borderWidth: 1, borderColor: '#EBE8E0' }, noteTitleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, noteTitle: { color: '#272820', fontWeight: '700', fontSize: 16, flex: 1 }, noteTime: { color: '#99978E', fontSize: 11, marginLeft: 6 }, preview: { color: '#77776E', lineHeight: 19, marginTop: 7 }, tags: { color: '#647D6C', fontSize: 12, marginTop: 8 }, cardActions: { borderTopColor: '#F0EEE9', borderTopWidth: 1, marginTop: 12, paddingTop: 10, flexDirection: 'row', gap: 17 }, action: { color: '#42644F', fontWeight: '600', paddingVertical: 4 }, dangerAction: { color: '#A04F3D', fontWeight: '600', paddingVertical: 4 }, backupRow: { borderTopColor: '#E5E2D9', borderTopWidth: 1, paddingHorizontal: 20, paddingVertical: 13, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, subtle: { color: '#8B8980', fontSize: 11 },
  editorContent: { paddingHorizontal: 21, paddingTop: 18, paddingBottom: 50 }, readOnly: { padding: 13, borderRadius: 12, backgroundColor: '#F0E6D1', marginBottom: 14 }, readOnlyTitle: { color: '#74502A', fontWeight: '700' }, readOnlyText: { color: '#74502A', marginTop: 4, lineHeight: 19 }, titleInput: { fontSize: 29, fontWeight: '700', color: '#22231D', paddingHorizontal: 0, paddingVertical: 8, marginBottom: 16 }, sectionLabel: { fontSize: 10, fontWeight: '800', letterSpacing: 1.4, color: '#797B6C', marginTop: 15, marginBottom: 7 }, bodyInput: { minHeight: 150, padding: 14, borderRadius: 13, backgroundColor: '#FFFEFC', color: '#25251F', fontSize: 16, lineHeight: 24, borderColor: '#EBE8E0', borderWidth: 1 }, field: { backgroundColor: '#FFFEFC', borderColor: '#EBE8E0', borderWidth: 1, borderRadius: 12, padding: 13, color: '#272820' }, pinRow: { alignSelf: 'flex-start', marginTop: 10 }, taskRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 5 }, checkbox: { width: 23, height: 23, borderRadius: 7, borderWidth: 1.5, borderColor: '#9A9A8C', alignItems: 'center', justifyContent: 'center' }, checked: { backgroundColor: '#496A52', borderColor: '#496A52' }, checkMark: { color: 'white', fontWeight: '800' }, taskInput: { flex: 1, paddingVertical: 8, color: '#272820', fontSize: 15 }, taskDone: { textDecorationLine: 'line-through', color: '#99978E' }, revision: { color: '#9B998F', fontSize: 11, textAlign: 'center', marginVertical: 22 }, readOnlyBody: { backgroundColor: '#FFFEFC', borderRadius: 13, padding: 15, borderColor: '#EBE8E0', borderWidth: 1, marginTop: 12 }, readBlock: { paddingVertical: 5, flexDirection: 'row', flexWrap: 'wrap' },
  audioPanel: { backgroundColor: '#FFFEFC', marginTop: 17, padding: 15, borderRadius: 15, borderColor: '#EBE8E0', borderWidth: 1 }, recordButton: { backgroundColor: '#F4E6E0', borderRadius: 12, padding: 13, alignItems: 'center', marginVertical: 12 }, recordButtonText: { color: '#A04435', fontWeight: '700' }, stopButton: { backgroundColor: '#A04435', borderRadius: 12, padding: 13, alignItems: 'center', marginVertical: 12 }, stopText: { color: 'white', fontWeight: '700' }, audioRow: { flexDirection: 'row', alignItems: 'center', gap: 9, borderTopColor: '#EFEDE7', borderTopWidth: 1, paddingVertical: 10 }, audioWithShare: { flexDirection: 'row', alignItems: 'center', gap: 3 }, audioTitle: { color: '#272820', fontWeight: '600' }, smallButton: { backgroundColor: '#E3EADF', borderRadius: 9, paddingHorizontal: 10, paddingVertical: 7 }, smallButtonText: { color: '#344D3F', fontWeight: '700', fontSize: 12 },
});
