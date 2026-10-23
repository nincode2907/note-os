// Only call with a newly-created, nonpersistent Playwright browser context.
export async function seedBackupFixture(page, baseUrl, totalMiB = 0) {
  await page.goto(baseUrl);
  await page.getByRole('textbox', { name: "What's on your mind?" }).fill('Synthetic backup fixture');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Saved on this device' }).waitFor();
  const noteId = await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('noteos-mvp-01'); request.onerror = () => reject(request.error);
    request.onsuccess = () => { const db = request.result, tx = db.transaction('notes', 'readonly'), get = tx.objectStore('notes').getAll(); get.onsuccess = () => { db.close(); resolve(get.result[0]?.id); }; get.onerror = () => reject(get.error); };
  }));
  if (typeof noteId !== 'string') throw new Error('Synthetic quick-capture fixture was not stored.');
  await page.goto(`${baseUrl}/backup`);
  await page.evaluate(async ({ noteId, totalMiB }) => {
    const notes = ['active', 'archived', 'trashed'].map((lifecycle, index) => ({
      id: index === 0 ? noteId : `synthetic-${lifecycle}`, title: `Ghi chú — 日本語 ${lifecycle}`, document: { schemaVersion: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Synthetic archive fixture — 東京' }] }] },
      schemaVersion: 1, createdAt: 100, updatedAt: 200, lifecycle, revision: 7, pinned: true, tags: ['Tiếng Việt', '日本語'],
    }));
    const recordings = [], chunks = [];
    for (let r = 0; r < 2; r++) {
      const id = `synthetic-recording-${r}`, count = totalMiB ? totalMiB / 2 : 2;
      recordings.push({ id, noteId, title: `Thu âm 日本語 ${r}`, mimeType: 'audio/webm;codecs=opus', status: r ? 'interrupted' : 'complete', ownerId: 'synthetic-tab', createdAt: 100, updatedAt: 200, durationMs: count * 1000, chunkCount: count, extensions: { validatedExample: true } });
      for (let sequence = 0; sequence < count; sequence++) {
        const bytes = new Uint8Array(totalMiB ? 1024 ** 2 : 64);
        for (let i = 0; i < bytes.length; i++) bytes[i] = (i + r + sequence) % 251;
        chunks.push({ id: `${id}:${sequence}`, recordingId: id, sequence, blob: new Blob([bytes], { type: 'audio/webm;codecs=opus' }) });
      }
    }
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('noteos-mvp-01'); request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction(['notes', 'recordings', 'recordingChunks'], 'readwrite');
        for (const note of notes) tx.objectStore('notes').put(note);
        for (const recording of recordings) tx.objectStore('recordings').add(recording);
        for (const chunk of chunks) tx.objectStore('recordingChunks').add(chunk);
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
  }, { noteId, totalMiB });
  return noteId;
}
export async function fingerprint(page) {
  return page.evaluate(async () => {
    const snapshot = await new Promise((resolve, reject) => {
      const request = indexedDB.open('noteos-mvp-01'); request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction(['notes', 'recordings', 'recordingChunks'], 'readonly'), data = {};
        for (const name of ['notes', 'recordings', 'recordingChunks']) { const get = tx.objectStore(name).getAll(); get.onsuccess = () => { data[name] = get.result; }; }
        tx.oncomplete = () => { db.close(); resolve(data); }; tx.onabort = () => reject(tx.error);
      };
    });
    const chunks = [];
    for (const chunk of snapshot.recordingChunks) {
      const hash = await crypto.subtle.digest('SHA-256', await chunk.blob.arrayBuffer());
      chunks.push({ id: chunk.id, recordingId: chunk.recordingId, sequence: chunk.sequence, mimeType: chunk.blob.type, byteLength: chunk.blob.size, sha256: Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('') });
    }
    return { notes: snapshot.notes, recordings: snapshot.recordings, chunks };
  });
}
