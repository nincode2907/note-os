import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { transaction } from './storage.mjs';

export const digest = value => createHash('sha256').update(value).digest('hex');
export function issuePairingCode(db, now = Date.now()) {
  const code = randomBytes(9).toString('base64url');
  db.prepare('UPDATE sync_pairing SET code_hash=?,expires_at=?,attempts=0 WHERE singleton=1').run(digest(code), now + 120000);
  return code;
}
export function redeemPairingCode(db, code, label, now = Date.now()) {
  return transaction(db, () => {
    const row = db.prepare('SELECT * FROM sync_pairing WHERE singleton=1').get();
    const reset = now - row.window_start >= 120000;
    const count = reset ? 1 : row.window_attempts + 1;
    db.prepare('UPDATE sync_pairing SET window_start=?,window_attempts=?,attempts=attempts+1 WHERE singleton=1').run(reset ? now : row.window_start, count);
    if (count > 10 || row.attempts >= 5) return { error: 'pairing_rate_limited', status: 429 };
    if (!row.code_hash || row.expires_at <= now || !timingSafeEqual(Buffer.from(row.code_hash, 'hex'), Buffer.from(digest(code), 'hex'))) return { error: 'pairing_invalid_or_expired', status: 401 };
    const id = randomUUID(), token = randomBytes(32).toString('base64url');
    const expires = now + 30 * 86400000;
    db.prepare('INSERT INTO sync_devices(id,label,token_hash,created_at,expires_at) VALUES(?,?,?,?,?)').run(id, label, digest(token), now, expires);
    db.prepare('UPDATE sync_pairing SET code_hash=NULL,expires_at=0 WHERE singleton=1').run();
    return { id, label, token, expires };
  });
}
export function authenticate(db, token, now = Date.now()) {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return db.prepare('SELECT id,label,expires_at FROM sync_devices WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?').get(digest(token), now) ?? null;
}
export function revokeDevice(db, id, now = Date.now()) {
  return db.prepare('UPDATE sync_devices SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(now, id).changes;
}
