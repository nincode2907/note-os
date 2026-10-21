import test from 'node:test';
import assert from 'node:assert/strict';
import { filterNotes, makeBackup, noteSearchText, parseBackup, searchableText } from './mvp-utils.mjs';

const note = (id, title, body, lifecycle = 'active') => ({
  id, title, document: { schemaVersion: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }] },
  schemaVersion: 1, createdAt: 1, updatedAt: 2, lifecycle, revision: 0,
});

test('search folds Vietnamese accents including đ/Đ and punctuation while retaining Japanese text', () => {
  assert.equal(searchableText('  Ghi chú: Buổi sáng! '), 'ghi chu buoi sang');
  assert.equal(searchableText('Điện thoại ở Đà Nẵng'), 'dien thoai o da nang');
  const notes = [note('vi', 'Điện thoại', 'Đà Nẵng'), note('ja', '日記', '今日は雨です')];
  assert.deepEqual(filterNotes(notes, 'dien thoai', 'active').map(({ id }) => id), ['vi']);
  assert.deepEqual(filterNotes(notes, 'ĐA nang', 'active').map(({ id }) => id), ['vi']);
  assert.deepEqual(filterNotes(notes, '今日は', 'active').map(({ id }) => id), ['ja']);
  assert.deepEqual(filterNotes(notes, '雨です', 'active').map(({ id }) => id), ['ja']);
  assert.deepEqual(filterNotes(notes, 'ひらがな', 'active').map(({ id }) => id), []);
  assert.equal(noteSearchText(notes[0]).includes('dien thoai'), true);
});

test('lifecycle filtering does not include archived or trashed notes in active search', () => {
  const notes = [note('a', 'Same phrase', 'same'), note('b', 'Same archived', 'same', 'archived'), note('c', 'Same trashed', 'same', 'trashed')];
  assert.deepEqual(filterNotes(notes, 'same', 'active').map(({ id }) => id), ['a']);
});

test('backup parser accepts version 1 data and preserves document values', () => {
  const source = note('one', 'A note', 'hello');
  const parsed = parseBackup(JSON.stringify(makeBackup([source], '2026-10-21T00:00:00.000Z')));
  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.notes[0].document, source.document);
});

test('backup parser rejects duplicate IDs before repository mutation', () => {
  assert.throws(() => parseBackup(makeBackup([note('same', 'one', 'x'), note('same', 'two', 'y')])), /duplicate note ID/i);
});

test('backup parser rejects unsupported bundle versions and invalid note metadata', () => {
  assert.throws(() => parseBackup({ format: 'noteos.local-backup', version: 7, notes: [] }), /not a supported/i);
  const invalid = note('bad', 'Bad', 'x'); invalid.updatedAt = Number.NaN;
  assert.throws(() => parseBackup(makeBackup([invalid])), /invalid metadata/i);
});
