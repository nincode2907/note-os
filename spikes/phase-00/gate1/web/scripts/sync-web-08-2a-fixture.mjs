import { createHash } from 'node:crypto';

if (process.env.NOTEOS_SYNC_TEST_ONLY !== '1') throw new Error('Synthetic fixture requires NOTEOS_SYNC_TEST_ONLY=1');
const { openStore, serverMeta, transaction, appendChange } = await import('/app/sync-server/storage.mjs');
const { issuePairingCode } = await import('/app/sync-server/auth.mjs');
const { canonicalJson } = await import('/app/app/lib/sync-protocol.mjs');
const action = process.argv[2], db = openStore(process.env.NOTEOS_SYNC_STORAGE, { initialize: action === 'init' });
try {
  if (action === 'init') process.stdout.write(JSON.stringify(serverMeta(db)));
  else if (action === 'pair') process.stdout.write(issuePairingCode(db));
  else if (action === 'state') {
    const state = ['sync_entities','sync_tombstones','sync_operations','sync_changelog'].map(name => db.prepare(`SELECT * FROM ${name}`).all());
    process.stdout.write(JSON.stringify({ ...serverMeta(db), noteCount: state[0].filter(row => row.entity_type === 'note').length, noteIds: state[0].filter(row => row.entity_type === 'note').map(row => row.id).sort(), operationCount: state[2].length, eventCount: state[3].length, digest: createHash('sha256').update(JSON.stringify(state)).digest('hex') }));
  } else if (action === 'change-epoch') {
    const next = `synthetic-${crypto.randomUUID()}`;
    transaction(db, () => db.prepare('UPDATE sync_server_meta SET server_epoch=? WHERE singleton=1').run(next));
    const { writeFileSync } = await import('node:fs'); writeFileSync(`${process.env.NOTEOS_SYNC_STORAGE}/.sync-epoch`, next, { mode: 0o600 });
    process.stdout.write(next);
  } else throw new Error('Unknown fixture action');
} finally { db.close(); }
