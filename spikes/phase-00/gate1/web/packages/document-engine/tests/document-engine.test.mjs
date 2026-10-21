import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  CANONICAL_SCHEMA_VERSION,
  canonicalDocumentFromTiptapJSON,
  canonicalToMarkdown,
  canonicalToPlainText,
  createEmptyCanonicalDocument,
  parseCanonicalDocument,
  plainTextToCanonicalDocument,
  serializeCanonicalDocument,
  toTiptapJSON,
  validateCanonicalDocument,
} from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const readFixture = async (name) => JSON.parse(await readFile(resolve(here, `../fixtures/${name}`), 'utf8'));
const rich = await readFixture('schema-v1-rich.json');

function textDocument(text) {
  return {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

test('accepts empty and minimal v1 documents', () => {
  assert.equal(validateCanonicalDocument(createEmptyCanonicalDocument()).status, 'supported');
  assert.equal(validateCanonicalDocument({ schemaVersion: 1, type: 'doc', content: [] }).status, 'supported');
  assert.equal(validateCanonicalDocument({ schemaVersion: 1, type: 'doc', content: [{ type: 'paragraph' }] }).status, 'supported');
});

test('accepts supported blocks, marks, task lists, nested lists and attachment references', async () => {
  const result = validateCanonicalDocument(rich);
  assert.equal(result.status, 'supported', JSON.stringify(result.issues));
  const types = result.document.content.map((node) => node.type);
  assert.deepEqual(types, ['heading', 'paragraph', 'bulletList', 'taskList', 'blockquote', 'codeBlock', 'paragraph']);
  assert.equal(result.document.content[3].content[1].attrs.checked, true);
});

test('preserves Vietnamese combining marks without Unicode normalization', () => {
  const input = 'Vie\u0323\u0302t a\u0301';
  const roundTrip = canonicalToPlainText(plainTextToCanonicalDocument(input));
  assert.equal(roundTrip.text, input);
  assert.equal(roundTrip.text.normalize('NFC') === input, false);
});

test('preserves Japanese Kanji, Hiragana, Katakana and punctuation', () => {
  const input = '漢字・ひらがな・カタカナ「句読点」、。';
  assert.equal(canonicalToPlainText(plainTextToCanonicalDocument(input)).text, input);
});

test('preserves actual mixed Japanese Kanji and Kana code points', () => {
  const input = '\u4f1a\u8b70\u30fb\u3053\u3093\u306b\u3061\u306f\u30fb\u30ce\u30fc\u30c8\u3002';
  assert.equal(canonicalToPlainText(plainTextToCanonicalDocument(input)).text, input);
});

test('preserves emoji including surrogate pairs and joined emoji sequences', () => {
  const input = '🙂 🧑🏽‍💻 👩‍👩‍👧‍👦';
  assert.equal(canonicalToPlainText(plainTextToCanonicalDocument(input)).text, input);
});

test('plain text conversion preserves multiline input, blank lines and edge whitespace', () => {
  const input = '  leading  \n\n中間\ntrailing  \n';
  const canonical = plainTextToCanonicalDocument(input);
  assert.equal(canonicalToPlainText(canonical).text, input);
  assert.equal(canonical.content.length, 5);
  assert.deepEqual(canonical.content[1], { type: 'paragraph' });
});

test('empty plain text produces an empty document and a trailing newline remains observable', () => {
  assert.deepEqual(plainTextToCanonicalDocument(''), createEmptyCanonicalDocument());
  assert.equal(canonicalToPlainText(plainTextToCanonicalDocument('line\n')).text, 'line\n');
});

test('plain-text API rejects non-string input instead of coercing it', () => {
  assert.throws(() => plainTextToCanonicalDocument({ text: 'hello' }), TypeError);
});

test('converts links to Markdown and keeps href and link text', async () => {
  const doc = await readFixture('schema-v1-rich.json');
  const result = canonicalToMarkdown(doc);
  assert.equal(result.status, 'projected');
  assert.match(result.markdown, /\[link\]\(<https:\/\/example\.test\/notes>\)/);
});

test('projects nested lists and checklists with an explicit GFM warning', () => {
  const result = canonicalToMarkdown(rich);
  assert.match(result.markdown, /- outer item\n  3\. nested item/);
  assert.match(result.markdown, /- \[ \] open task/);
  assert.match(result.markdown, /- \[x\] done task/);
  assert.ok(result.warnings.some((warning) => warning.code === 'extended-markdown-checklist'));
});

test('projects attachments with a warning and leaves the canonical reference intact', () => {
  const before = structuredClone(rich);
  const result = canonicalToMarkdown(rich);
  assert.ok(result.warnings.some((warning) => warning.code === 'attachment-not-representable'));
  assert.match(result.markdown, /\[Attachment: diagram\.png\]/);
  assert.deepEqual(rich, before);
});

test('reports omitted formatting for plain-text projection', () => {
  const result = canonicalToPlainText(rich);
  assert.ok(result.warnings.some((warning) => warning.code === 'inline-formatting-omitted'));
  assert.ok(result.warnings.some((warning) => warning.code === 'block-formatting-omitted'));
});

test('malformed JSON is explicit', () => {
  const result = parseCanonicalDocument('{"schemaVersion":1,,}');
  assert.equal(result.status, 'invalid');
  assert.equal(result.issues[0].code, 'malformed-json');
});

test('rejects unsupported schema versions read-only without modifying input', async () => {
  const future = await readFixture('unsupported-v2.json');
  const before = structuredClone(future);
  const result = validateCanonicalDocument(future);
  assert.equal(result.status, 'unsupported');
  assert.equal(result.editable, false);
  assert.equal(result.issues[0].code, 'unsupported-schema-version');
  assert.deepEqual(future, before);
  assert.equal(canonicalToMarkdown(future).status, 'blocked');
});

test('unknown node types are unsupported rather than discarded', async () => {
  const futureNode = await readFixture('unknown-node.json');
  const result = validateCanonicalDocument(futureNode);
  assert.equal(result.status, 'unsupported');
  assert.equal(result.issues[0].code, 'unknown-node');
  assert.equal(canonicalToPlainText(futureNode).text, null);
});

test('unknown marks are unsupported rather than stripped', async () => {
  const result = validateCanonicalDocument(await readFixture('unknown-mark.json'));
  assert.equal(result.status, 'unsupported');
  assert.equal(result.issues[0].code, 'unknown-mark');
});

test('unknown nested nodes and deeply nested marks remain unsupported and untouched', async () => {
  for (const [fixture, code] of [
    ['unknown-nested-node.json', 'unknown-node'],
    ['unknown-deep-mark.json', 'unknown-mark'],
  ]) {
    const input = await readFixture(fixture);
    const before = structuredClone(input);
    const result = validateCanonicalDocument(input);
    assert.equal(result.status, 'unsupported', fixture);
    assert.equal(result.editable, false, fixture);
    assert.equal(result.issues[0].code, code, fixture);
    assert.deepEqual(input, before, fixture);
    assert.equal(canonicalToMarkdown(input).status, 'blocked', fixture);
  }
});

test('unknown node fields and attributes are kept out of the editable path', () => {
  const unknownField = { ...textDocument('data'), futureFlag: { keep: true } };
  assert.equal(validateCanonicalDocument(unknownField).issues[0].code, 'unknown-field');

  const unknownAttribute = textDocument('data');
  unknownAttribute.content[0].attrs = { future: 'keep' };
  assert.equal(validateCanonicalDocument(unknownAttribute).issues[0].code, 'unknown-attribute');
});

test('rejects partial/corrupt trees and schema-invalid nesting', async () => {
  const partial = await readFixture('corrupt-tree.json');
  assert.equal(validateCanonicalDocument(partial).issues[0].code, 'invalid-text-node');

  const corruptNesting = {
    schemaVersion: 1,
    type: 'doc',
    content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'bulletList' }] }],
  };
  assert.equal(validateCanonicalDocument(corruptNesting).status, 'invalid');
});

test('rejects invalid known attributes and invalid link marks', () => {
  const invalidHeading = { schemaVersion: 1, type: 'doc', content: [{ type: 'heading', attrs: { level: 7 } }] };
  assert.equal(validateCanonicalDocument(invalidHeading).issues[0].code, 'invalid-heading-level');

  const invalidLink = textDocument('text');
  invalidLink.content[0].content[0].marks = [{ type: 'link', attrs: { href: '' } }];
  assert.equal(validateCanonicalDocument(invalidLink).issues[0].code, 'invalid-link');

  const corruptList = { schemaVersion: 1, type: 'doc', content: [{ type: 'orderedList', attrs: { start: 1, type: 7 }, content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] }] };
  assert.equal(validateCanonicalDocument(corruptList).issues[0].code, 'invalid-list-type');

  const corruptLinkAttribute = textDocument('text');
  corruptLinkAttribute.content[0].content[0].marks = [{ type: 'link', attrs: { href: 'https://example.test', title: { unsafe: true } } }];
  assert.equal(validateCanonicalDocument(corruptLinkAttribute).issues[0].code, 'invalid-link-attribute');
});

test('plain text and Markdown warn when export drops code/list metadata', () => {
  const document = {
    schemaVersion: 1,
    type: 'doc',
    content: [
      { type: 'codeBlock', attrs: { language: 'typescript' }, content: [{ type: 'text', text: 'const x = 1;' }] },
      { type: 'orderedList', attrs: { start: 1, type: 'a' }, content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] }] },
    ],
  };
  const plain = canonicalToPlainText(document);
  const markdown = canonicalToMarkdown(document);
  assert.ok(plain.warnings.some(({ code }) => code === 'code-language-omitted'));
  assert.ok(markdown.warnings.some(({ code }) => code === 'ordered-list-style-omitted'));
});

test('rejects executable and ambiguous link protocols', () => {
  for (const href of ['javascript:alert(1)', 'data:text/html,hello', 'file:///etc/passwd', '//example.test/path']) {
    const input = textDocument('link');
    input.content[0].content[0].marks = [{ type: 'link', attrs: { href } }];
    const result = validateCanonicalDocument(input);
    assert.equal(result.status, 'invalid', href);
    assert.equal(result.issues[0].code, 'unsafe-link-protocol', href);
  }
});

test('round-trips canonical JSON through serialization and parsing', () => {
  const first = serializeCanonicalDocument(rich);
  assert.equal(first.status, 'serialized');
  const parsed = parseCanonicalDocument(first.json);
  assert.equal(parsed.status, 'supported');
  const second = serializeCanonicalDocument(parsed.document);
  assert.equal(second.json, first.json);
});

test('editor JSON conversion wraps and validates schemaVersion 1', () => {
  const canonical = canonicalDocumentFromTiptapJSON({ type: 'doc', content: [{ type: 'paragraph' }] });
  assert.equal(canonical.status, 'supported');
  assert.equal(canonical.document.schemaVersion, 1);
  assert.equal(toTiptapJSON(canonical.document).json.type, 'doc');
});

test('repeated serialize/deserialize cycles remain stable', () => {
  let current = rich;
  let expected;
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const serialized = serializeCanonicalDocument(current);
    assert.equal(serialized.status, 'serialized');
    if (expected !== undefined) assert.equal(serialized.json, expected);
    expected = serialized.json;
    current = parseCanonicalDocument(serialized.json).document;
  }
});

test('batched projection and serialization calls do not mutate canonical input', async () => {
  const input = structuredClone(rich);
  const before = structuredClone(input);
  const [plain, markdown, serialized, validated] = await Promise.all([
    Promise.resolve().then(() => canonicalToPlainText(input)),
    Promise.resolve().then(() => canonicalToMarkdown(input)),
    Promise.resolve().then(() => serializeCanonicalDocument(input)),
    Promise.resolve().then(() => validateCanonicalDocument(input)),
  ]);
  assert.equal(plain.status, 'projected');
  assert.equal(markdown.status, 'projected');
  assert.equal(serialized.status, 'serialized');
  assert.equal(validated.status, 'supported');
  assert.deepEqual(input, before);
});

test('saved JSON fixture survives reload and still validates', async () => {
  const serialized = serializeCanonicalDocument(await readFixture('schema-v1-rich.json'));
  const reloaded = JSON.parse(serialized.json);
  assert.equal(validateCanonicalDocument(reloaded).status, 'supported');
  assert.deepEqual(reloaded, parseCanonicalDocument(serialized.json).document);
});

test('exports never mutate canonical source objects', () => {
  const before = structuredClone(rich);
  canonicalToMarkdown(rich);
  canonicalToPlainText(rich);
  serializeCanonicalDocument(rich);
  validateCanonicalDocument(rich);
  assert.deepEqual(rich, before);
});

test('generative Unicode and whitespace cases preserve every input string', () => {
  const atoms = ['plain', 'Vie\u0323\u0302t', '漢字', 'ひらがな', 'カタカナ', '🙂', '👩‍💻', '  ', '\t', 'e\u0301'];
  for (let seed = 0; seed < 40; seed += 1) {
    const parts = Array.from({ length: (seed % 7) + 1 }, (_, index) => atoms[(seed * 3 + index * 5) % atoms.length]);
    const input = `${seed % 3 === 0 ? ' ' : ''}${parts.join(seed % 2 ? ' ' : '\n')}${seed % 4 === 0 ? '\n' : ''}`;
    assert.equal(canonicalToPlainText(plainTextToCanonicalDocument(input)).text, input, `seed ${seed}`);
  }
});
