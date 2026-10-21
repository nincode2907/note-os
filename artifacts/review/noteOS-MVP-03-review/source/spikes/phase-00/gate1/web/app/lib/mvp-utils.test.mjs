import test from 'node:test';
import assert from 'node:assert/strict';
import { filterNotes, filterNotesByTags, makeBackup, noteSearchText, parseBackup, searchableText, sortNotes } from './mvp-utils.mjs';

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

test('tag filtering uses case-insensitive canonical Unicode identity and requires every selected tag', () => {
  const notes = [
    { ...note('both', 'One', 'x'), tags: ['Work', '日本語'] },
    { ...note('work', 'Two', 'x'), tags: ['work'] },
    { ...note('kana', 'Three', 'x'), tags: ['にほんご'] },
  ];
  assert.deepEqual(filterNotesByTags(notes, ['WORK']).map(({ id }) => id), ['both', 'work']);
  assert.deepEqual(filterNotesByTags(notes, ['work', '日本語']).map(({ id }) => id), ['both']);
  assert.deepEqual(filterNotesByTags(notes, ['日本語']).map(({ id }) => id), ['both']);
  assert.equal(noteSearchText({ ...notes[0], tags: ['Công việc', '日本語'] }).includes('cong viec'), true);
});

test('pinned notes stay first; pinned ties use updatedAt and remaining notes honor selected sort', () => {
  const notes = [
    { ...note('older-pin', 'A pin', 'x'), pinned: true, updatedAt: 3 },
    { ...note('newer-pin', 'Z pin', 'x'), pinned: true, updatedAt: 9 },
    { ...note('recent', 'Zulu', 'x'), updatedAt: 20 },
    { ...note('alpha', 'Alpha', 'x'), updatedAt: 10 },
  ];
  assert.deepEqual(sortNotes(notes).map(({ id }) => id), ['newer-pin', 'older-pin', 'recent', 'alpha']);
  assert.deepEqual(sortNotes(notes, 'title').map(({ id }) => id), ['newer-pin', 'older-pin', 'alpha', 'recent']);
});

test('backup parser accepts version 1 data and preserves document values', () => {
  const source = note('one', 'A note', 'hello');
  const parsed = parseBackup(JSON.stringify(makeBackup([source], '2026-10-21T00:00:00.000Z')));
  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.notes[0].document, source.document);
});

test('backup v1 preserves organization metadata and remains compatible with older v1 notes', () => {
  const source = { ...note('tagged', '日本語', '本文'), pinned: true, tags: ['仕事', 'Công việc'] };
  const parsed = parseBackup(makeBackup([source]));
  assert.equal(parsed.notes[0].pinned, true); assert.deepEqual(parsed.notes[0].tags, source.tags);
  const older = note('older', 'Old export', 'body'); delete older.pinned; delete older.tags;
  assert.deepEqual(parseBackup(makeBackup([older])).notes[0], older);
});

test('backup v1 rejects invalid organization metadata without rewriting source notes', () => {
  const invalid = { ...note('invalid-tags', 'Bad', 'x'), pinned: true, tags: ['duplicate', ' Duplicate '] };
  const before = structuredClone(invalid);
  assert.throws(() => parseBackup(makeBackup([invalid])), /duplicate tags/i);
  assert.deepEqual(invalid, before);
});

test('backup parser rejects duplicate IDs before repository mutation', () => {
  assert.throws(() => parseBackup(makeBackup([note('same', 'one', 'x'), note('same', 'two', 'y')])), /duplicate note ID/i);
});

test('backup parser rejects unsupported bundle versions and invalid note metadata', () => {
  assert.throws(() => parseBackup({ format: 'noteos.local-backup', version: 7, notes: [] }), /not a supported/i);
  const invalid = note('bad', 'Bad', 'x'); invalid.updatedAt = Number.NaN;
  assert.throws(() => parseBackup(makeBackup([invalid])), /invalid metadata/i);
});
