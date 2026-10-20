import test from 'node:test';
import assert from 'node:assert/strict';

test('PowerSync Open Edition MySQL replication service is healthy', async () => {
  const response = await fetch(`${process.env.POWERSYNC_URL}/probes/liveness`);
  assert.equal(response.ok, true, `PowerSync liveness status ${response.status}`);
});
