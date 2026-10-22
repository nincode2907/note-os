import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createEditorSession, validateEditorEnvelope } from '../editor-bridge.mjs';
import { canEditNativeNote, recoveryDecision, SingleSaveGate } from '../mobile-safety.mjs';
import { validateCanonicalDocument } from '../../web/packages/document-engine/src/index.js';

const rich = JSON.parse(await readFile(new URL('../../web/packages/document-engine/fixtures/schema-v1-rich.json', import.meta.url), 'utf8'));
rich.content[1].content.push({ type: 'text', text: ' — removed', marks: [{ type: 'strike' }] });
rich.content[3].content[0].content.push({ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'nested checked task' }] }] }] });
const envelope = (type, payload, generation = 1, sessionId = 'note-1:session-a') => JSON.stringify({ v: 1, sessionId, generation, type, payload });

test('canonical rich structure, formatting, nested lists, tasks, and multilingual text survive bridge validation', () => {
  const parsed = validateEditorEnvelope(envelope('DOCUMENT_CHANGED', { document: rich }), { sessionId: 'note-1:session-a' });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.document, validateCanonicalDocument(rich).document);
  const heading = parsed.document.content[0];
  assert.equal(heading.type, 'heading');
  assert.equal(heading.attrs.level, 2);
  const paragraph = parsed.document.content[1];
  assert.deepEqual(paragraph.content[1].marks.map(mark => mark.type), ['bold', 'italic']);
  assert.equal(paragraph.content[3].marks[0].attrs.href, 'https://example.test/notes');
  assert.deepEqual(paragraph.content[6].marks.map(mark => mark.type), ['strike']);
  assert.equal(paragraph.content[0].text, 'Tiếng Việt: á, ');
  assert.equal(paragraph.content[1].text, '東京・かな・カナ 🙂');
  assert.equal(parsed.document.content[2].content[0].content[1].type, 'orderedList');
  assert.deepEqual(parsed.document.content[3].content.map(task => task.attrs.checked), [false, true]);
  assert.equal(parsed.document.content[3].content[0].content[1].content[0].attrs.checked, true);
  assert.equal(parsed.document.content[5].attrs.language, 'ts');
  assert.deepEqual(parsed.document.content[6].content[0].attrs, { attachmentId: 'asset-01', label: 'diagram.png' });
});

test('snapshot replies require the matching request id and preserve checked states', () => {
  const parsed = validateEditorEnvelope(envelope('DOCUMENT_SNAPSHOT', { document: rich, requestId: 'request-7' }, 9), { sessionId: 'note-1:session-a', afterGeneration: 8 });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.message.payload.requestId, 'request-7');
  assert.deepEqual(parsed.document.content[3].content.map(task => task.attrs.checked), [false, true]);
  assert.equal(validateEditorEnvelope(envelope('DOCUMENT_SNAPSHOT', { document: rich, requestId: 'x'.repeat(101) }), { sessionId: 'note-1:session-a' }).ok, false);
});

test('unsupported future schema remains unchanged and cannot enter an editable bridge message', () => {
  const future = { schemaVersion: 2, type: 'doc', content: [{ type: 'futureBlock', payload: { keep: ['all', 'data'] } }] };
  const before = JSON.stringify(future);
  const parsed = validateEditorEnvelope(envelope('DOCUMENT_CHANGED', { document: future }), { sessionId: 'note-1:session-a' });
  assert.equal(parsed.ok, false);
  assert.equal(JSON.stringify(future), before);
  assert.equal(canEditNativeNote({ lifecycle: 'active', schemaVersion: 1 }, false), false);
});

test('malformed canonical documents and unsafe link protocols are rejected', () => {
  const unsafe = structuredClone(rich);
  unsafe.content[1].content[3].marks[0].attrs.href = 'javascript:alert(1)';
  for (const document of [null, { schemaVersion: 1, type: 'doc', content: [{ type: 'paragraph', content: 'bad' }] }, unsafe]) {
    const parsed = validateEditorEnvelope(envelope('DOCUMENT_CHANGED', { document }), { sessionId: 'note-1:session-a' });
    assert.equal(parsed.ok, false);
  }
});

test('bridge rejects malformed envelopes, unknown message types, oversized messages, and wrong-note sessions', () => {
  assert.equal(validateEditorEnvelope('{broken', { sessionId: 'note-1:session-a' }).ok, false);
  assert.equal(validateEditorEnvelope(envelope('EXECUTE', {}, 1), { sessionId: 'note-1:session-a' }).ok, false);
  assert.equal(validateEditorEnvelope(' '.repeat(2 * 1024 * 1024 + 1), { sessionId: 'note-1:session-a' }).ok, false);
  assert.equal(validateEditorEnvelope(envelope('EDITOR_READY', { editable: true }, 1, 'note-2:session-b'), { sessionId: 'note-1:session-a' }).ok, false);
  assert.equal(createEditorSession('note-1', 'nonce-a') === createEditorSession('note-2', 'nonce-a'), false);
});

test('stale and out-of-order WebView generations are rejected', () => {
  assert.equal(validateEditorEnvelope(envelope('EDITOR_READY', { editable: true }, 4), { sessionId: 'note-1:session-a', afterGeneration: 4 }).ok, false);
  assert.equal(validateEditorEnvelope(envelope('EDITOR_READY', { editable: true }, 3), { sessionId: 'note-1:session-a', afterGeneration: 5 }).ok, false);
  assert.equal(validateEditorEnvelope(envelope('EDITOR_READY', { editable: true }, Number.MAX_SAFE_INTEGER + 1), { sessionId: 'note-1:session-a' }).ok, false);
});

test('background recovery decision only offers a same-revision active schema-v1 draft', () => {
  const journal = { baseRevision: 8, draft: { version: 1, document: rich } };
  assert.equal(recoveryDecision({ revision: 8, lifecycle: 'active', schemaVersion: 1 }, journal), 'offer-restore');
  assert.equal(recoveryDecision({ revision: 9, lifecycle: 'active', schemaVersion: 1 }, journal), 'preserve-only');
  assert.equal(recoveryDecision({ revision: 8, lifecycle: 'trashed', schemaVersion: 1 }, journal), 'preserve-only');
});

test('native save gate in source prevents overlapping commits and preserves the revision CAS call', async () => {
  const gate = new SingleSaveGate();
  assert.equal(gate.begin(), true);
  assert.equal(gate.begin(), false);
  gate.finish();
  assert.equal(gate.begin(), true);
  gate.finish();
  const source = await readFile(new URL('../App.tsx', import.meta.url), 'utf8');
  assert.match(source, /recoveryHeld \|\| !saveLock\.current\.begin\(\)\) return false/);
  assert.match(source, /saveNote\(\{ \.\.\.capturedNote, title: capturedTitle, document: validation\.document, tags: nextTags, pinned: capturedPinned \}, capturedNote\.revision\)/);
  assert.match(source, /await flushDraft\(\{ note: capturedNote, title: capturedTitle, tags: capturedTags, pinned: capturedPinned, document: validation\.document \}\)/);
});
