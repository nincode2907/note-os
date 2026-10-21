import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBackup, parseBackup } from '../../web/app/lib/mvp-utils.mjs';
const engine = await import('../../web/packages/document-engine/src/index.js');
const { documentToNativeModel, nativeModelToDocument } = await import('../document-subset.ts');

const doc = { schemaVersion: 1, type: 'doc', content: [
  { type: 'paragraph', content: [{ type: 'text', text: 'Xin chào 日本語' }] },
  { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Đã xong' }] }] }, { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph' }] }] },
] };

test('supported paragraph and checklist subset round-trips through native model', () => {
  const model = documentToNativeModel(doc);
  assert.equal(model.editable, true);
  assert.deepEqual(nativeModelToDocument(model.paragraphs, model.tasks), doc);
});

test('unsupported canonical structures and future schema remain read-only without changing bytes', () => {
  const documents = [
    { schemaVersion: 1, type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Heading' }] }] },
    { schemaVersion: 2, type: 'doc', content: [{ type: 'futureBlock', payload: { keep: true } }] },
  ];
  for (const document of documents) {
    const original = JSON.stringify(document);
    assert.equal(documentToNativeModel(document).editable, false);
    assert.equal(JSON.stringify(document), original);
  }
});

test('native record uses the Web notes-only backup v1 contract and keeps checklist state', () => {
  const note = { id: 'synthetic-note', title: 'Gate A fixture', document: doc, schemaVersion: 1, createdAt: 10, updatedAt: 11, lifecycle: 'active', revision: 2, pinned: true, tags: ['Vietnamese', '東京'] };
  const parsed = parseBackup(JSON.stringify(makeBackup([note], '2026-10-21T00:00:00.000Z')));
  assert.equal(parsed.format, 'noteos.local-backup');
  assert.deepEqual(parsed.notes[0], note);
  assert.equal(engine.validateCanonicalDocument(parsed.notes[0].document).status, 'supported');
  assert.deepEqual(parsed.notes[0].document.content[1].content.map(item => item.attrs.checked), [true, false]);
});

test('backup parser rejects invalid JSON and future bundle versions', () => {
  assert.throws(() => parseBackup('{bad'), /valid JSON/);
  assert.throws(() => parseBackup({ format: 'noteos.local-backup', version: 2, notes: [] }), /supported/);
});
