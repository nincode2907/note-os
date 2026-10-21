import test from 'node:test';
import assert from 'node:assert/strict';
import { safeTagsForNoteCopy } from './note-organization.mjs';

test('safe note copies retain supported source tags but never pin or carry unsupported metadata', () => {
  const supported = { schemaVersion: 1, pinned: true, tags: ['Tiếng Việt', '東京'] };
  assert.deepEqual(safeTagsForNoteCopy(supported), ['Tiếng Việt', '東京']);
  assert.deepEqual(safeTagsForNoteCopy({ ...supported, tags: ['safe', 'safe'] }), []);
  assert.deepEqual(safeTagsForNoteCopy({ ...supported, schemaVersion: 2 }), []);
  assert.deepEqual(safeTagsForNoteCopy({ schemaVersion: 1, tags: undefined }), []);
  // Callers explicitly create copies with pinned:false; source state is not mutated.
  assert.equal(supported.pinned, true);
  assert.deepEqual(supported.tags, ['Tiếng Việt', '東京']);
});
