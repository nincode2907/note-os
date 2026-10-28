import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, rmSync, writeSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

// Cross-process AI control plane. It lives beside sync.sqlite so every Web, API
// and worker process that opens the same store observes the same markers. Marker
// existence is the signal; bodies are never required, so an empty file created on
// a nearly full volume still fails closed.
const CONTROL_DIR = 'ai-control';
export const OPERATOR_STOP_FILE = 'INFERENCE_STOP';
const AUTO_STOP_PREFIX = 's-';
const INTENT_PREFIX = 'r-';
const WORKER_PREFIX = 'w-';

export const aiNoteKey = noteId => createHash('sha256').update(String(noteId)).digest('hex');
const controlError = (code, cause) => Object.assign(new Error(code), { code, cause });

/** Resolve the control directory from the open SQLite connection; in-memory stores have none. */
export function aiControlDir(db) {
  const main = db.prepare('PRAGMA database_list').all().find(row => row.name === 'main');
  if (!main?.file) throw controlError('control_plane_unavailable');
  return join(dirname(main.file), CONTROL_DIR);
}

function fsyncDirectory(dir) {
  const fd = openSync(dir, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writeDurable(dir, name, body = '', flag = 'wx') {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fd = openSync(join(dir, name), flag, 0o600);
  try { if (body) writeSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
  fsyncDirectory(dir);
}

const stamp = () => `${String(Date.now()).padStart(15, '0')}-${randomBytes(6).toString('hex')}`;
const stampTime = name => Number(name.slice(name.lastIndexOf('.') + 1).split('-')[0]);

export function ensureAiControlPlane(db) {
  const dir = aiControlDir(db);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Durable write-ahead intent. Returns the marker name; throws if it cannot be made durable. */
export function persistRevocationIntent(db, noteId) {
  const name = `${INTENT_PREFIX}${aiNoteKey(noteId)}.${stamp()}`;
  writeDurable(aiControlDir(db), name);
  return name;
}

/**
 * After a revocation commits, intents created at or before the commit are satisfied.
 * Intents written later belong to a newer revoke attempt and stay in place.
 */
export function clearSatisfiedRevocationIntents(db, noteId, committedAt = Date.now()) {
  const dir = aiControlDir(db), prefix = `${INTENT_PREFIX}${aiNoteKey(noteId)}.`;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(prefix) || !(stampTime(name) <= committedAt)) continue;
    rmSync(join(dir, name), { force: true }); removed++;
  }
  if (removed) fsyncDirectory(dir);
  return removed;
}

/** Withdraw one specific intent whose revoke was rejected as a caller error before any write. */
export function removeRevocationIntent(db, name) {
  if (typeof name !== 'string' || !/^r-[a-f0-9]{64}\.\d{15}-[a-f0-9]{12}$/.test(name)) throw new TypeError('Invalid intent marker');
  const dir = aiControlDir(db);
  rmSync(join(dir, name), { force: true });
  fsyncDirectory(dir);
}

/** Global stop used only when no per-note intent could be recorded. Clearing it is an operator action. */
export function persistAutomaticInferenceStop(db) {
  const name = `${AUTO_STOP_PREFIX}${stamp()}`;
  writeDurable(aiControlDir(db), name);
  return name;
}

export function listAiControlState(db) {
  const names = readdirSync(aiControlDir(db));
  const intents = new Map();
  for (const name of names.filter(value => value.startsWith(INTENT_PREFIX))) {
    const key = name.slice(INTENT_PREFIX.length, name.indexOf('.'));
    intents.set(key, (intents.get(key) ?? 0) + 1);
  }
  return {
    operatorStop: names.includes(OPERATOR_STOP_FILE),
    automaticStops: names.filter(value => value.startsWith(AUTO_STOP_PREFIX)).length,
    pendingRevocationKeys: [...intents.keys()].sort(),
  };
}

/** Operator recovery after the cause of an automatic stop is fixed. Never removes the operator stop. */
export function clearAutomaticInferenceStops(db) {
  const dir = aiControlDir(db);
  const names = readdirSync(dir).filter(value => value.startsWith(AUTO_STOP_PREFIX));
  for (const name of names) rmSync(join(dir, name), { force: true });
  if (names.length) fsyncDirectory(dir);
  return names.length;
}

/** Returns a fail-closed reason or null. Any filesystem uncertainty blocks inference. */
export function inferenceBlockReason(db, noteId) {
  let names;
  try { names = readdirSync(aiControlDir(db)); }
  catch { return 'control_plane_unavailable'; }
  if (names.includes(OPERATOR_STOP_FILE) || names.some(value => value.startsWith(AUTO_STOP_PREFIX))) return 'inference_stopped';
  if (noteId !== undefined && names.some(value => value.startsWith(`${INTENT_PREFIX}${aiNoteKey(noteId)}.`))) return 'revocation_state_uncertain';
  return null;
}

/** Worker liveness proof: dispatch requires a writable control plane, so a frozen volume blocks inference. */
export function recordWorkerHeartbeat(db, workerId, now = Date.now()) {
  if (typeof workerId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(workerId)) throw new TypeError('Invalid worker ID');
  try { writeDurable(aiControlDir(db), `${WORKER_PREFIX}${workerId}.alive`, String(now), 'w'); }
  catch (cause) { throw controlError('control_plane_unwritable', cause); }
}
