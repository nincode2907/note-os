import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireRecordingLock, recordingLockName } from './recording-lock.mjs';

function fakeLocks() {
  const held = new Set();
  return {
    async request(name, options, callback) {
      if (options.ifAvailable && held.has(name)) return callback(null);
      if (held.has(name)) throw new Error('Test lock unexpectedly queued.');
      held.add(name);
      try { return await callback({ name }); }
      finally { held.delete(name); }
    },
  };
}

test('a copied storage token cannot claim a per-note lock held by another component or tab', async () => {
  const locks = fakeLocks();
  const first = await acquireRecordingLock(locks, 'note with spaces');
  assert.equal(first.supported, true);
  assert.equal(recordingLockName('note with spaces'), 'noteos:audio-recording:note%20with%20spaces');
  const second = await acquireRecordingLock(locks, 'note with spaces');
  assert.equal(second.release, null);
  await first.release();
  const third = await acquireRecordingLock(locks, 'note with spaces');
  assert.equal(typeof third.release, 'function');
  await third.release();
});

test('missing Web Locks is explicitly reported as unsupported, never as ownership', async () => {
  assert.deepEqual(await acquireRecordingLock(undefined, 'note'), { supported: false, release: null });
});
