import test from 'node:test';
import assert from 'node:assert/strict';
import { syncRetryDelay, SYNC_RETRY_LIMIT } from './sync-retry.mjs';

test('sync retry delay uses bounded exponential equal jitter', () => {
  assert.equal(SYNC_RETRY_LIMIT, 5);
  assert.equal(syncRetryDelay(1, () => 0), 1000);
  assert.equal(syncRetryDelay(1, () => 0.999), 1999);
  assert.equal(syncRetryDelay(2, () => 0), 2000);
  assert.equal(syncRetryDelay(5, () => 0.999), 29985);
  assert.equal(syncRetryDelay(1, () => -1), 1000);
});
