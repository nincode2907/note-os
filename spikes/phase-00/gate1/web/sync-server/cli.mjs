import { openStore, serverMeta } from './storage.mjs';
import { issuePairingCode, revokeDevice } from './auth.mjs';

const [action, id] = process.argv.slice(2);
if (!['init','pair','devices','revoke'].includes(action)) throw new Error('Usage: cli.mjs init|pair|devices|revoke <device-id>');
if (process.env.NOTEOS_SYNC_ENABLED !== '1') throw new Error('Sync is disabled. Complete the activation gates before enabling.');
if (action === 'pair' && !process.stdout.isTTY) throw new Error('Pairing codes are shown only in an interactive terminal.');
const db = openStore(process.env.NOTEOS_SYNC_STORAGE, { initialize: action === 'init' });
try {
  if (action === 'init') console.log(JSON.stringify(serverMeta(db)));
  if (action === 'pair') console.log(`One-time pairing code (expires in 120 seconds): ${issuePairingCode(db)}`);
  if (action === 'devices') console.log(JSON.stringify(db.prepare('SELECT id,label,created_at,expires_at,revoked_at FROM sync_devices ORDER BY created_at').all(), null, 2));
  if (action === 'revoke') {
    if (!id || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('A device UUID is required');
    console.log(JSON.stringify({ revoked: revokeDevice(db, id) === 1 }));
  }
} finally { db.close(); }
