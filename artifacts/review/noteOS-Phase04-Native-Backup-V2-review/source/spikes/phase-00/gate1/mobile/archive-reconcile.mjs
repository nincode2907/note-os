/** Recover only paths captured by a durable import journal. Filesystem and DB APIs are injected for isolated tests. */
export async function reconcileImportJournals(entries, recordingRows, { removeStaged, inspectFinal, finish }) {
  const unresolved = [], unresolvedIds = new Set();
  const recordings = new Map(recordingRows.map(row => [row.id, row]));
  for (const entry of entries) {
    if (entry.state === 'staged') {
      if (entry.files.some(file => recordings.get(file.recordingId)?.file_uri === file.finalUri)) {
        unresolved.push(`Import ${entry.importId} has database references while still marked staged.`); unresolvedIds.add(entry.importId); continue;
      }
      try {
        for (const file of entry.files) await removeStaged(file.stagedUri, file.finalUri);
        await finish(entry.importId);
      } catch (error) { unresolved.push(`Could not clean staged import ${entry.importId}: ${String(error)}`); unresolvedIds.add(entry.importId); }
      continue;
    }
    let valid = true;
    for (const item of entry.files) {
      const recording = recordings.get(item.recordingId);
      if (!recording || recording.file_uri !== item.finalUri) { valid = false; break; }
      const actual = await inspectFinal(item.finalUri);
      if (!actual.exists || actual.size !== item.size || actual.sha256 !== item.sha256) { valid = false; break; }
    }
    if (!valid) {
      unresolved.push(`Committed import ${entry.importId} has missing or corrupt media; existing note data and files were left intact.`); unresolvedIds.add(entry.importId); continue;
    }
    try {
      for (const item of entry.files) await removeStaged(item.stagedUri, null);
      await finish(entry.importId);
    } catch (error) { unresolved.push(`Could not finish import cleanup ${entry.importId}: ${String(error)}`); unresolvedIds.add(entry.importId); }
  }
  return { unresolved, unresolvedIds };
}
