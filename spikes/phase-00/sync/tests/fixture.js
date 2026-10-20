import assert from 'node:assert/strict';

export const DATASET_ID = 'phase00-bakeoff-v1';
export const FIXTURE_SIZE = 100;

export async function snapshot(cursor = 0) {
  const response = await fetch(`${process.env.API_URL}/api/sync?dataset_id=${DATASET_ID}&last_pulled_at=${cursor}`);
  assert.equal(response.ok, true, `snapshot ${response.status}`);
  return response.json();
}

export async function ensureFixture() {
  const present = new Set();
  for (const group of ['created', 'updated']) for (const note of (await snapshot()).changes.notes[group]) present.add(note.id);
  const baseRevision = (await snapshot()).timestamp;
  for (let index = 1; index <= FIXTURE_SIZE; index++) {
    const id = `syncbench-v1-${String(index).padStart(4, '0')}`;
    if (present.has(id)) continue;
    const response = await fetch(`${process.env.API_URL}/api/delta/push`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mutationId: `seed-${id}`, baseRevision,
        note: {
          id, title: `Synthetic note ${index}`, privacy: 'PRIVATE_SERVER', dataset_id: DATASET_ID,
          body: `Fixture ${index}: tiếng Việt; English; 日本語; markdown **bold**; JSON {"n":${index}}; ${'offline-sync synthetic content '.repeat(12)}`
        }
      })
    });
    assert.equal(response.status, 200, `seed ${id}: ${await response.text()}`);
  }
  const final = await snapshot();
  const ids = new Set([...final.changes.notes.created, ...final.changes.notes.updated].map(note => note.id).filter(id => id.startsWith('syncbench-v1-')));
  assert.equal(ids.size, FIXTURE_SIZE, 'common synthetic dataset has exactly 100 rows');
  return final;
}
