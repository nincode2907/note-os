// Synthetic-only fixture executed inside the isolated Phase 09 AI test container.
if (process.env.NOTEOS_SYNC_TEST_ONLY !== '1') throw new Error('Synthetic fixture requires NOTEOS_SYNC_TEST_ONLY=1');
const { openStore, serverMeta } = await import('/app/sync-server/storage.mjs');
const { issuePairingCode } = await import('/app/sync-server/auth.mjs');
const { applyAiSchema } = await import('/app/sync-server/ai-foundation.mjs');
const action = process.argv[2];
if (action === 'drain') {
  const { runWorker } = await import('/app/sync-server/ai-worker.mjs');
  process.exitCode = await runWorker({ mode: 'drain', maxJobs: 20 });
} else {
  const db = openStore(process.env.NOTEOS_SYNC_STORAGE, { initialize: action === 'init' });
  try {
    if (action === 'init') { applyAiSchema(db); process.stdout.write(JSON.stringify(serverMeta(db))); }
    else if (action === 'pair') process.stdout.write(issuePairingCode(db));
    else if (action === 'state') {
      const notes = db.prepare("SELECT id,server_version v,record_json r FROM sync_entities WHERE entity_type='note' ORDER BY id").all();
      process.stdout.write(JSON.stringify({
        noteCount: notes.length, notes: notes.map(row => ({ id: row.id, serverVersion: row.v, tags: JSON.parse(row.r).tags, privacy: JSON.parse(row.r).privacy })),
        consents: db.prepare('SELECT note_id noteId,state,provider_boundary boundary,consent_epoch epoch FROM ai_note_consent ORDER BY note_id').all(),
        jobs: db.prepare('SELECT status,count(*) n FROM ai_jobs GROUP BY status').all(),
        suggestions: db.prepare('SELECT note_id noteId,status,provider_identity provider FROM ai_suggestions ORDER BY created_at').all(),
        itemStates: db.prepare('SELECT item_key itemKey,decision,version,applied_local_revision appliedLocalRevision FROM ai_suggestion_item_state ORDER BY item_key').all(),
        maxRequestsPerDeviceWindow: db.prepare('SELECT coalesce(max(request_count),0) n FROM ai_bridge_rate_limits').get().n,
      }));
    } else throw new Error('Unknown fixture action');
  } finally { db.close(); }
}
