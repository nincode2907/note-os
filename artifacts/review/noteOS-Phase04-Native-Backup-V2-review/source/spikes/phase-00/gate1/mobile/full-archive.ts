import { Directory, File, Paths } from 'expo-file-system';
import {
  NATIVE_ARCHIVE_LIMITS, assertAvailableSpace, buildArchivePlan, planArchiveImport, streamVerifiedMedia,
  verifyArchiveStream, writeArchivePlan, hashReadableStream,
} from './archive-v2-native.mjs';
import {
  commitFullArchiveImport, finishArchiveImport, listAllRecordings, listArchiveImports,
  recordArchiveImport, snapshotFullArchive, beginFullArchiveOperation,
} from './store';
import { reconcileImportJournals } from './archive-reconcile.mjs';

const AUDIO_ROOT_NAME = 'noteos-recordings';
const IMPORT_ROOT_NAME = 'noteos-archive-imports';
const makeId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;

function ensureDirectory(directory: Directory) {
  if (!directory.exists) directory.create({ intermediates: true });
  return directory;
}
function checkedFile(uri: string) {
  if (typeof uri !== 'string' || !uri.startsWith('file://')) throw new Error('This recording is not stored in an accessible local file.');
  return new File(uri);
}
function randomFileName(prefix: string, extension: string) { return `${prefix}-${makeId()}.${extension}`; }

export async function createFullArchive(onProgress: (message: string) => void = () => {}) {
  const release = beginFullArchiveOperation();
  try {
  onProgress('Taking a brief SQLite metadata snapshot…');
  const snapshot = await snapshotFullArchive();
  onProgress('Checking recording files and calculating checksums…');
  const plan = await buildArchivePlan({
    ...snapshot,
    readStream: uri => checkedFile(uri).readableStream(),
    stat: uri => checkedFile(uri).info(),
    onProgress,
  });
  assertAvailableSpace(Paths.availableDiskSpace, plan.size, 16 * 1024 ** 2, 'build this archive');
  const output = new File(Paths.cache, randomFileName('noteos-full-archive', 'tar'));
  output.create({ intermediates: true, overwrite: false });
  try {
    onProgress('Writing the unencrypted TAR archive…');
    const result = await writeArchivePlan(plan, output, { readStream: uri => checkedFile(uri).readableStream(), onProgress });
    return { ...result, file: output, expectedBytes: plan.size, warnings: plan.manifest.warnings };
  } catch (error) { try { if (output.exists) output.delete(); } catch {} throw error; }
  } finally { release(); }
}

function safeOwnedFile(uri: string, directory: Directory) {
  if (typeof uri !== 'string' || !uri.startsWith(`${directory.uri}/`)) throw new Error('An import recovery record points outside the noteOS import folders. It was preserved for review.');
  return new File(uri);
}

/** Reconciles only paths recorded by the archive protocol; it never sweeps the general audio directory. */
export async function reconcileArchiveImports() {
  const importRoot = new Directory(Paths.document, IMPORT_ROOT_NAME);
  const audioRoot = new Directory(Paths.document, AUDIO_ROOT_NAME);
  const entries = await listArchiveImports();
  const recordings = await listAllRecordings();
  const recovery = await reconcileImportJournals(entries, recordings, {
    removeStaged: async (stagedUri: string, finalUri: string|null) => {
      const staged = safeOwnedFile(stagedUri, importRoot); if (staged.exists) staged.delete();
      if (finalUri) { const final = safeOwnedFile(finalUri, audioRoot); if (final.exists) final.delete(); }
    },
    inspectFinal: async (uri: string) => {
      const file = safeOwnedFile(uri, audioRoot), info = file.info();
      if (!info.exists || info.size == null) return { exists: false, size: 0, sha256: '' };
      return { exists: true, size: info.size, sha256: (await hashReadableStream(file.readableStream())).sha256 };
    },
    finish: finishArchiveImport,
  });
  const known = recovery.unresolvedIds;
  const unresolved = recovery.unresolved;
  if (importRoot.exists) {
    for (const child of importRoot.list()) {
      if (child instanceof Directory && !known.has(child.name)) { try { child.delete(); } catch (error) { unresolved.push(`Could not remove abandoned import staging folder: ${String(error)}`); } }
    }
  }
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const child of Paths.cache.list()) {
    if (child instanceof File && /^noteos-(full-archive|backup)-[a-zA-Z0-9-]+\.(tar|json)$/u.test(child.name)) {
      const info = child.info();
      if ((info.modificationTime ?? 0) < cutoff) { try { child.delete(); } catch (error) { unresolved.push(`Could not remove an expired temporary backup: ${String(error)}`); } }
    }
  }
  return unresolved;
}

export async function restoreFullArchive(file: File, mode: 'merge'|'skip', onProgress: (message: string) => void = () => {}) {
  const archiveInfo = file.info();
  if (!archiveInfo.exists || !archiveInfo.size || archiveInfo.size > NATIVE_ARCHIVE_LIMITS.maxArchiveBytes) throw new Error('Archive is missing, empty, or exceeds the 1 GiB native limit.');
  onProgress('Phase A · verifying TAR structure, manifest, notes, relationships and audio checksums…');
  const verified = await verifyArchiveStream(file.readableStream(), { onProgress });
  const current = await snapshotFullArchive();
  const plan = planArchiveImport(verified, current.notes, current.recordings, mode);
  const acceptedIds = new Set(plan.recordingRows.filter(row => row.chunks.length).map(row => row.recording.id));
  const media = (verified.media as Array<{recordingId:string;path:string;size:number;sha256:string;mimeType:string}>).filter(item => acceptedIds.has(item.recordingId));
  const required = media.reduce((sum: number, item) => sum + item.size, 0);
  assertAvailableSpace(Paths.availableDiskSpace, required, 16 * 1024 ** 2, 'stage restored audio beyond the selected archive copy');

  const importId = makeId();
  const importRoot = ensureDirectory(new Directory(Paths.document, IMPORT_ROOT_NAME));
  const audioRoot = ensureDirectory(new Directory(Paths.document, AUDIO_ROOT_NAME));
  const stagingDirectory = new Directory(importRoot, importId);
  if (stagingDirectory.exists) throw new Error('A generated import staging folder already exists. Existing data was not changed.');
  const destinations = new Map<string, File>(), finalFiles: Array<{recordingId:string;staged:File;final:File;sha256:string;size:number}> = [];
  for (const [index, item] of media.entries()) {
    const extension = item.path.slice(item.path.lastIndexOf('.') + 1);
    const staged = new File(stagingDirectory, `audio-${index}.${extension}`);
    const final = new File(audioRoot, `${importId}-${index}.${extension}`);
    if (final.exists) throw new Error('A generated destination already exists. No existing recording was overwritten.');
    destinations.set(item.recordingId, staged); finalFiles.push({ recordingId: item.recordingId, staged, final, sha256: item.sha256, size: item.size });
  }
  let journaled = false, committed = false;
  try {
    stagingDirectory.create({ intermediates: true });
    for (const item of finalFiles) item.staged.create({ intermediates: true, overwrite: false });
    onProgress('Phase B · staging verified audio in app-private storage…');
    const acceptedArchive = { ...verified, media };
    await streamVerifiedMedia(file.readableStream(), acceptedArchive, destinations, { onProgress });
    const journalFiles = finalFiles.map(item => ({ stagedUri: item.staged.uri, finalUri: item.final.uri, recordingId: item.recordingId, size: item.size, sha256: item.sha256 }));
    await recordArchiveImport(importId, journalFiles); journaled = true;
    for (const item of finalFiles) await item.staged.move(item.final);
    onProgress('Phase C · committing notes and recording metadata in one SQLite transaction…');
    const acceptedRows = plan.recordingRows;
    await commitFullArchiveImport(importId, plan.notes, acceptedRows, finalFiles.map(item => ({ recordingId: item.recordingId, finalUri: item.final.uri, sha256: item.sha256, size: item.size })), verified.manifest.sourcePlatform);
    committed = true;
    try { await finishArchiveImport(importId); } catch { /* Startup reconciliation will finish a committed journal without touching its records. */ }
    try { if (stagingDirectory.exists) stagingDirectory.delete(); } catch {}
    onProgress('Restore complete.');
    return { importedNotes: plan.notes.length, skippedNotes: plan.skippedNotes, importedRecordings: plan.recordingRows.length, skippedRecordings: plan.skippedRecordings, warnings: verified.manifest.warnings };
  } catch (error) {
    if (!committed) {
      let cleanupSucceeded = true;
      for (const item of finalFiles) { try { if (item.staged.exists) item.staged.delete(); if (item.final.exists) item.final.delete(); } catch { cleanupSucceeded = false; } }
      try { if (stagingDirectory.exists) stagingDirectory.delete(); } catch { cleanupSucceeded = false; }
      if (journaled && cleanupSucceeded) { try { await finishArchiveImport(importId); } catch { /* Startup reconciliation owns this journal and its exact paths. */ } }
    }
    throw error;
  }
}
