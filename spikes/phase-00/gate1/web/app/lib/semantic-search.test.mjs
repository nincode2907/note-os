import test from 'node:test';
import assert from 'node:assert/strict';
import { conceptsOf, createSearchIndex, embedText, foldText, keywordTokens } from './semantic-search.mjs';
import { SEARCH_QUERIES } from './fixtures/search-queries.mjs';
import { SYNTHETIC_NOTES, syntheticNoteRecord } from '../../sync-server/ai-eval/synthetic-notes.mjs';

const notes = () => SYNTHETIC_NOTES.map(entry => ({ ...syntheticNoteRecord(entry), id: entry.id }));

test('tokenization handles Vietnamese folding and Japanese bigrams; concepts avoid diacritic collisions', () => {
  assert.equal(foldText('Hóa Đơn'), 'hoa don');
  assert.deepEqual(keywordTokens('会議室'), ['会議', '議室']);
  assert.deepEqual([...conceptsOf('thanh toán hóa đơn')], ['invoice']);
  assert.deepEqual([...conceptsOf('lau dọn nhà')], ['cleaning'], '"dọn" is cleaning, never invoice');
  assert.deepEqual([...conceptsOf('turn on the light')], [], 'folded "ôn" never matches English "on"');
  assert.deepEqual([...conceptsOf('hoa don dien nuoc')], ['invoice'], 'multi-word terms still match without accents');
  const vector = embedText('Kế hoạch ra mắt');
  assert.equal(vector.length, 512);
  assert.ok(Math.abs(vector.reduce((sum, value) => sum + value * value, 0) - 1) < 1e-5);
  assert.deepEqual(embedText('same text'), embedText('same text'), 'deterministic');
});

test('hybrid search finds cross-lingual and paraphrased notes that keyword search misses', () => {
  const index = createSearchIndex(); index.sync(notes());
  const top = (q, mode) => index.search(q, { mode, limit: 5 }).map(row => row.id);
  assert.ok(top('electricity bill').includes('ja-02'));
  assert.equal(top('electricity bill', 'keyword').includes('ja-02'), false);
  assert.ok(top('du lịch').includes('ja-04'));
  assert.ok(top('tax return deadline').includes('vi-10'));
  assert.equal(top('kham rang')[0], 'vi-03', 'accentless Vietnamese');
  let hits = 0;
  for (const query of SEARCH_QUERIES) if (index.search(query.q, { limit: 5 }).some(row => query.relevant.includes(row.id))) hits++;
  assert.ok(hits / SEARCH_QUERIES.length >= 0.9, `hybrid hit rate ${hits}/${SEARCH_QUERIES.length}`);
});

test('index stays in sync: edits re-index, deletions and trashed notes disappear, unchanged notes are skipped', () => {
  const index = createSearchIndex(), list = notes();
  assert.equal(index.sync(list), 30);
  assert.equal(index.sync(list), 0, 'no work when nothing changed');
  const edited = list.map(note => note.id === 'en-10' ? { ...note, revision: 2, updatedAt: 9, title: 'Kayak rental for the lake' } : note);
  assert.equal(index.sync(edited), 1);
  assert.equal(index.search('kayak', { limit: 3 })[0].id, 'en-10');
  assert.equal(index.search('insurance', { limit: 5, mode: 'keyword' }).some(row => row.id === 'en-10'), false, 'old text is gone');
  const trashed = edited.map(note => note.id === 'en-10' ? { ...note, lifecycle: 'trashed', revision: 3 } : note);
  index.sync(trashed);
  assert.equal(index.search('kayak').length, 0, 'only active notes are searched by default');
  assert.equal(index.search('kayak', { lifecycle: 'trashed' })[0].id, 'en-10');
  index.sync(trashed.filter(note => note.id !== 'en-10'));
  assert.equal(index.size, 29);
  assert.equal(index.search('kayak', { lifecycle: 'trashed' }).length, 0);
});

test('privacy filter: callers can restrict results by privacy class', () => {
  const index = createSearchIndex();
  index.sync(notes().map(note => note.id === 'vi-03' ? { ...note, privacy: 'DEVICE_ONLY' } : note));
  assert.equal(index.search('khám răng')[0].id, 'vi-03', 'on-device search covers every local note');
  assert.equal(index.search('khám răng', { allowPrivacy: privacy => privacy !== 'DEVICE_ONLY' }).some(row => row.id === 'vi-03'), false);
  assert.deepEqual(index.search('   '), []);
});
