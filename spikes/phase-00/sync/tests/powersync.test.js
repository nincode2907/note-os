import test from 'node:test';
import assert from 'node:assert/strict';

test('PowerSync Open Edition MySQL replication service is healthy', async () => {
  let response;
  for (let attempt = 0; attempt < 5; attempt++) {
    response = await fetch(`${process.env.POWERSYNC_URL}/probes/liveness`);
    if (response.ok) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(response?.status, 200, `PowerSync liveness status after retries ${response?.status}`);
});
