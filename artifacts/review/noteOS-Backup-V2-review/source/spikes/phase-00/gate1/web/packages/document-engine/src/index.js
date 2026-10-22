import { Editor, Node, getSchema } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import StarterKit from '@tiptap/starter-kit';
import { CANONICAL_DOCUMENT_TYPE, CANONICAL_SCHEMA_VERSION, createEmptyCanonicalDocument, plainTextToCanonicalDocument } from './plain-text.js';

export { CANONICAL_DOCUMENT_TYPE, CANONICAL_SCHEMA_VERSION, createEmptyCanonicalDocument, plainTextToCanonicalDocument };

const wrapperKeys = new Set(['schemaVersion', 'type', 'content']);
const nodeKeys = new Set(['type', 'attrs', 'content', 'text', 'marks']);
const markKeys = new Set(['type', 'attrs']);

const AttachmentReference = Node.create({
  name: 'attachmentReference',
  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      attachmentId: { default: null },
      label: { default: '' },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-noteos-attachment]' }];
  },
  renderHTML({ node }) {
    return [
      'span',
      {
        'data-noteos-attachment': node.attrs.attachmentId,
        class: 'noteos-attachment-reference',
      },
      node.attrs.label || node.attrs.attachmentId,
    ];
  },
});

export function createDocumentExtensions() {
  const VersionedDocument = Document.extend({ content: 'block*' });

  return [
    StarterKit.configure({
      document: false,
      code: false,
      horizontalRule: false,
      link: {
        autolink: false,
        linkOnPaste: false,
        openOnClick: false,
      },
      underline: false,
    }),
    VersionedDocument,
    TaskList,
    TaskItem.configure({ nested: true }),
    AttachmentReference,
  ];
}

let cachedSchema;

export function getCanonicalSchema() {
  cachedSchema ??= getSchema(createDocumentExtensions());
  return cachedSchema;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalid(code, path, message) {
  return { status: 'invalid', editable: false, issues: [{ code, path, message }] };
}

function unsupported(code, path, message) {
  return { status: 'unsupported', editable: false, issues: [{ code, path, message }] };
}

function getUnknownKeys(value, allowed) {
  return Object.keys(value).filter((key) => !allowed.has(key));
}

function validateAttributes(rawAttrs, typeSpec, path) {
  if (rawAttrs !== undefined && !isRecord(rawAttrs)) {
    return invalid('invalid-attributes', path, 'Node attributes must be a JSON object.');
  }

  const allowed = typeSpec.attrs ?? {};
  const attrs = rawAttrs ?? {};
  const unknown = Object.keys(attrs).filter((key) => !Object.hasOwn(allowed, key));
  if (unknown.length) {
    return unsupported('unknown-attribute', path, `Unknown attribute(s): ${unknown.join(', ')}.`);
  }

  for (const [name, attribute] of Object.entries(allowed)) {
    if (!Object.hasOwn(attrs, name) && !Object.hasOwn(attribute, 'default')) {
      return invalid('missing-attribute', `${path}.attrs.${name}`, `Required attribute "${name}" is missing.`);
    }
  }

  return null;
}

function validateMark(mark, schema, path) {
  if (!isRecord(mark) || typeof mark.type !== 'string') {
    return invalid('invalid-mark', path, 'A mark must be an object with a string type.');
  }

  const unknownKeys = getUnknownKeys(mark, markKeys);
  if (unknownKeys.length) {
    return unsupported('unknown-field', path, `Unknown mark field(s): ${unknownKeys.join(', ')}.`);
  }

  const type = schema.marks[mark.type];
  if (!type) {
    return unsupported('unknown-mark', `${path}.type`, `Mark "${mark.type}" is not in schema v1.`);
  }

  const attributeIssue = validateAttributes(mark.attrs, type.spec, `${path}.attrs`);
  if (attributeIssue) return attributeIssue;

  if (mark.type === 'link') {
    for (const name of ['target', 'rel', 'class', 'title']) {
      const value = mark.attrs?.[name];
      if (value != null && typeof value !== 'string') {
        return invalid('invalid-link-attribute', `${path}.attrs.${name}`, `Link ${name} must be a string or null.`);
      }
    }
    const href = mark.attrs?.href;
    if (typeof href !== 'string' || href.length === 0) {
      return invalid('invalid-link', `${path}.attrs.href`, 'A link requires a non-empty href string.');
    }
    // Persist only navigation schemes that are meaningful to a note document.
    // This rejects javascript:, data:, and other executable/ambiguous protocols.
    if (!/^(https?:|mailto:|tel:)/i.test(href)) {
      return invalid('unsafe-link-protocol', `${path}.attrs.href`, 'Links must use http, https, mailto, or tel.');
    }
  }

  return null;
}

function validateNodeShape(node, schema, path) {
  if (!isRecord(node) || typeof node.type !== 'string') {
    return invalid('invalid-node', path, 'A node must be an object with a string type.');
  }

  const unknownKeys = getUnknownKeys(node, nodeKeys);
  if (unknownKeys.length) {
    return unsupported('unknown-field', path, `Unknown node field(s): ${unknownKeys.join(', ')}.`);
  }

  const type = schema.nodes[node.type];
  if (!type) {
    return unsupported('unknown-node', `${path}.type`, `Node "${node.type}" is not in schema v1.`);
  }

  if (node.type === 'text') {
    if (typeof node.text !== 'string' || node.text.length === 0 || node.content !== undefined || node.attrs !== undefined) {
      return invalid('invalid-text-node', path, 'Text nodes require non-empty text and cannot have attrs or content.');
    }
  } else if (node.text !== undefined) {
    return invalid('invalid-node-text', `${path}.text`, 'Only text nodes may contain a text field.');
  }

  const attributeIssue = validateAttributes(node.attrs, type.spec, `${path}.attrs`);
  if (attributeIssue) return attributeIssue;

  if (node.marks !== undefined) {
    if (!Array.isArray(node.marks)) {
      return invalid('invalid-marks', `${path}.marks`, 'Marks must be an array.');
    }
    for (let index = 0; index < node.marks.length; index += 1) {
      const markIssue = validateMark(node.marks[index], schema, `${path}.marks[${index}]`);
      if (markIssue) return markIssue;
    }
  }

  if (node.content !== undefined && !Array.isArray(node.content)) {
    return invalid('invalid-content', `${path}.content`, 'Node content must be an array.');
  }

  if (node.content) {
    for (let index = 0; index < node.content.length; index += 1) {
      const childIssue = validateNodeShape(node.content[index], schema, `${path}.content[${index}]`);
      if (childIssue) return childIssue;
    }
  }

  if (node.type === 'heading' && (!Number.isInteger(node.attrs?.level) || node.attrs.level < 1 || node.attrs.level > 6)) {
    return invalid('invalid-heading-level', `${path}.attrs.level`, 'Heading level must be an integer from 1 through 6.');
  }
  if (node.type === 'orderedList' && (!Number.isInteger(node.attrs?.start) || node.attrs.start < 1)) {
    return invalid('invalid-list-start', `${path}.attrs.start`, 'Ordered list start must be a positive integer.');
  }
  if (node.type === 'orderedList' && node.attrs?.type != null && typeof node.attrs.type !== 'string') {
    return invalid('invalid-list-type', `${path}.attrs.type`, 'Ordered list type must be a string or null.');
  }
  if (node.type === 'taskItem' && typeof node.attrs?.checked !== 'boolean') {
    return invalid('invalid-task-state', `${path}.attrs.checked`, 'Checklist items require a boolean checked value.');
  }
  if (node.type === 'attachmentReference') {
    if (typeof node.attrs?.attachmentId !== 'string' || node.attrs.attachmentId.length === 0) {
      return invalid('invalid-attachment-id', `${path}.attrs.attachmentId`, 'Attachment references require a non-empty attachmentId.');
    }
    if (typeof node.attrs?.label !== 'string') {
      return invalid('invalid-attachment-label', `${path}.attrs.label`, 'Attachment reference label must be a string.');
    }
  }
  if (node.type === 'codeBlock' && node.attrs?.language != null && typeof node.attrs.language !== 'string') {
    return invalid('invalid-code-language', `${path}.attrs.language`, 'Code language must be a string or null.');
  }

  return null;
}

function toProseMirrorDocument(canonical) {
  return { type: canonical.type, content: canonical.content };
}

export function validateCanonicalDocument(input, schema = getCanonicalSchema()) {
  try {
    if (!isRecord(input)) return invalid('invalid-wrapper', '$', 'Canonical document must be a JSON object.');

    if (!Number.isInteger(input.schemaVersion)) {
      return invalid('invalid-schema-version', '$.schemaVersion', 'schemaVersion must be an integer.');
    }
    if (input.schemaVersion > CANONICAL_SCHEMA_VERSION) {
      return unsupported('unsupported-schema-version', '$.schemaVersion', `Schema version ${input.schemaVersion} is newer than supported version ${CANONICAL_SCHEMA_VERSION}.`);
    }
    if (input.schemaVersion !== CANONICAL_SCHEMA_VERSION) {
      return invalid('invalid-schema-version', '$.schemaVersion', `Schema version must be ${CANONICAL_SCHEMA_VERSION}.`);
    }

    const unknownWrapperKeys = getUnknownKeys(input, wrapperKeys);
    if (unknownWrapperKeys.length) {
      return unsupported('unknown-field', '$', `Unknown document field(s): ${unknownWrapperKeys.join(', ')}.`);
    }
    if (input.type !== CANONICAL_DOCUMENT_TYPE) {
      return invalid('invalid-document-type', '$.type', 'Canonical schema v1 requires a ProseMirror doc root.');
    }
    if (!Array.isArray(input.content)) {
      return invalid('invalid-document-content', '$.content', 'Canonical document content must be an array.');
    }

    const wrapperIssue = validateNodeShape({ type: input.type, content: input.content }, schema, '$.document');
    if (wrapperIssue) return wrapperIssue;

    const prosemirrorNode = schema.nodeFromJSON(toProseMirrorDocument(input));
    prosemirrorNode.check();
    // ProseMirror uses null-prototype objects for attrs. Normalize to ordinary
    // JSON values so persistence/reload has a stable, portable representation.
    const normalizedNode = JSON.parse(JSON.stringify(prosemirrorNode.toJSON()));
    const document = {
      schemaVersion: CANONICAL_SCHEMA_VERSION,
      type: normalizedNode.type,
      ...(normalizedNode.attrs === undefined ? {} : { attrs: normalizedNode.attrs }),
      content: normalizedNode.content ?? [],
    };

    return { status: 'supported', editable: true, document, issues: [] };
  } catch (error) {
    return invalid('invalid-document-tree', '$', error instanceof Error ? error.message : 'ProseMirror rejected the document tree.');
  }
}

export function parseCanonicalDocument(jsonText, schema = getCanonicalSchema()) {
  if (typeof jsonText !== 'string') return invalid('invalid-json-input', '$', 'JSON input must be a string.');
  let value;
  try {
    value = JSON.parse(jsonText);
  } catch (error) {
    return invalid('malformed-json', '$', error instanceof Error ? error.message : 'JSON parsing failed.');
  }
  return validateCanonicalDocument(value, schema);
}

export function serializeCanonicalDocument(input, schema = getCanonicalSchema()) {
  const validation = validateCanonicalDocument(input, schema);
  if (validation.status !== 'supported') return { status: validation.status, json: null, validation };
  return { status: 'serialized', json: JSON.stringify(validation.document), document: validation.document };
}

export function canonicalDocumentFromTiptapJSON(editorJson, schema = getCanonicalSchema()) {
  if (!isRecord(editorJson)) return invalid('invalid-editor-json', '$', 'Tiptap editor JSON must be an object.');
  const candidate = { schemaVersion: CANONICAL_SCHEMA_VERSION, ...editorJson };
  return validateCanonicalDocument(candidate, schema);
}

export function toTiptapJSON(canonicalDocument, schema = getCanonicalSchema()) {
  const validation = validateCanonicalDocument(canonicalDocument, schema);
  if (validation.status !== 'supported') return { status: validation.status, json: null, validation };
  return { status: 'ready', json: toProseMirrorDocument(validation.document), document: validation.document };
}

function addWarning(warnings, code, path, message) {
  const key = `${code}:${path}`;
  if (!warnings.has(key)) warnings.set(key, { code, path, message });
}

function inlinePlainText(nodes = [], warnings, path) {
  return nodes.map((node, index) => {
    const nodePath = `${path}[${index}]`;
    if (node.type === 'text') {
      if (node.marks?.length) addWarning(warnings, 'inline-formatting-omitted', nodePath, 'Plain text projection omits inline mark formatting.');
      return node.text;
    }
    if (node.type === 'hardBreak') return '\n';
    if (node.type === 'attachmentReference') {
      addWarning(warnings, 'attachment-projection', nodePath, 'Plain text can show the label but cannot preserve an attachment reference.');
      return node.attrs.label || node.attrs.attachmentId;
    }
    return '';
  }).join('');
}

function blockPlainText(node, warnings, path) {
  switch (node.type) {
    case 'paragraph':
    case 'heading':
      if (node.type === 'heading') addWarning(warnings, 'block-formatting-omitted', path, 'Plain text projection omits heading level.');
      return inlinePlainText(node.content, warnings, `${path}.content`);
    case 'codeBlock':
      if (node.attrs?.language) addWarning(warnings, 'code-language-omitted', path, 'Plain text projection omits code block language metadata.');
      return inlinePlainText(node.content, warnings, `${path}.content`);
    case 'blockquote':
      addWarning(warnings, 'block-formatting-omitted', path, 'Plain text projection omits blockquote structure.');
      return (node.content ?? []).map((child, index) => blockPlainText(child, warnings, `${path}.content[${index}]`)).join('\n');
    case 'bulletList':
    case 'orderedList':
    case 'taskList': {
      addWarning(warnings, node.type === 'taskList' ? 'checklist-state-projected' : 'list-structure-omitted', path, 'Plain text projection does not preserve nested list structure.');
      return (node.content ?? []).map((item, index) => {
        const itemText = (item.content ?? []).map((child, childIndex) => blockPlainText(child, warnings, `${path}.content[${index}].content[${childIndex}]`)).join('\n');
        const prefix = item.type === 'taskItem' ? (item.attrs.checked ? '[x] ' : '[ ] ') : '- ';
        return `${prefix}${itemText}`;
      }).join('\n');
    }
    default:
      return '';
  }
}

export function canonicalToPlainText(input, schema = getCanonicalSchema()) {
  const validation = validateCanonicalDocument(input, schema);
  if (validation.status !== 'supported') return { status: 'blocked', text: null, warnings: [], validation };
  const warnings = new Map();
  const text = validation.document.content.map((node, index) => blockPlainText(node, warnings, `$.content[${index}]`)).join('\n');
  return { status: 'projected', text, warnings: [...warnings.values()] };
}

function escapeMarkdownText(text) {
  return text.replace(/[\\`*_{}\[\]<>!|]/g, '\\$&');
}

function renderInline(nodes = [], warnings, path) {
  return nodes.map((node, index) => {
    const nodePath = `${path}[${index}]`;
    if (node.type === 'hardBreak') return '  \n';
    if (node.type === 'attachmentReference') {
      addWarning(warnings, 'attachment-not-representable', nodePath, 'Markdown has no canonical attachment-reference type; a label is shown as text only.');
      return `[Attachment: ${escapeMarkdownText(node.attrs.label || node.attrs.attachmentId)}]`;
    }

    let text = escapeMarkdownText(node.text);
    for (const mark of node.marks ?? []) {
      switch (mark.type) {
        case 'bold': text = `**${text}**`; break;
        case 'italic': text = `*${text}*`; break;
        case 'strike': text = `~~${text}~~`; break;
        case 'link': {
          const href = String(mark.attrs.href).replace(/[<>\\\s]/g, (character) => encodeURIComponent(character));
          text = `[${text}](<${href}>)`;
          break;
        }
        default: break;
      }
    }
    return text;
  }).join('');
}

function codeFence(code) {
  const runs = code.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

function renderList(node, depth, warnings, path) {
  if (node.type === 'taskList') {
    addWarning(warnings, 'extended-markdown-checklist', path, 'Checklist output uses the common GFM [x]/[ ] extension, which is not part of basic CommonMark.');
  }
  if (node.type === 'orderedList' && node.attrs?.type != null) {
    addWarning(warnings, 'ordered-list-style-omitted', path, 'Markdown numeric list markers do not preserve the ordered list marker style.');
  }
  const output = [];
  const first = Number.isInteger(node.attrs?.start) ? node.attrs.start : 1;
  for (let index = 0; index < (node.content ?? []).length; index += 1) {
    const item = node.content[index];
    const indent = '  '.repeat(depth);
    const marker = item.type === 'taskItem' ? (item.attrs.checked ? '- [x]' : '- [ ]')
      : node.type === 'orderedList' ? `${first + index}.` : '-';
    const itemBlocks = item.content ?? [];
    const paragraph = itemBlocks.find((block) => block.type === 'paragraph');
    output.push(`${indent}${marker} ${paragraph ? renderInline(paragraph.content, warnings, `${path}.content[${index}].paragraph`) : ''}`.trimEnd());
    for (let childIndex = 0; childIndex < itemBlocks.length; childIndex += 1) {
      const child = itemBlocks[childIndex];
      if (child === paragraph) continue;
      const nested = renderBlock(child, depth + 1, warnings, `${path}.content[${index}].content[${childIndex}]`);
      output.push(...nested.split('\n'));
    }
  }
  return output.join('\n');
}

function renderBlock(node, depth, warnings, path) {
  switch (node.type) {
    case 'paragraph':
      return renderInline(node.content, warnings, `${path}.content`);
    case 'heading':
      return `${'#'.repeat(node.attrs.level)} ${renderInline(node.content, warnings, `${path}.content`)}`;
    case 'codeBlock': {
      const code = inlinePlainText(node.content, warnings, `${path}.content`);
      const fence = codeFence(code);
      const language = node.attrs?.language ?? '';
      return `${fence}${language}\n${code}${code.endsWith('\n') ? '' : '\n'}${fence}`;
    }
    case 'blockquote':
      return (node.content ?? []).map((child, index) => renderBlock(child, depth, warnings, `${path}.content[${index}]`)
        .split('\n').map((line) => `> ${line}`).join('\n')).join('\n');
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return renderList(node, depth, warnings, path);
    default:
      return '';
  }
}

export function canonicalToMarkdown(input, schema = getCanonicalSchema()) {
  const validation = validateCanonicalDocument(input, schema);
  if (validation.status !== 'supported') return { status: 'blocked', markdown: null, warnings: [], validation };
  const warnings = new Map();
  const markdown = validation.document.content.map((node, index) => renderBlock(node, 0, warnings, `$.content[${index}]`)).join('\n\n');
  return { status: 'projected', markdown, warnings: [...warnings.values()] };
}

export function createTiptapEditor({ element, document, editable = true, onUpdate }) {
  const validation = validateCanonicalDocument(document);
  if (validation.status !== 'supported') {
    throw new TypeError(`Refusing to open unsupported document: ${validation.issues[0]?.message ?? validation.status}`);
  }

  const editorJson = toProseMirrorDocument(validation.document);
  return new Editor({
    element,
    extensions: createDocumentExtensions(),
    content: editorJson,
    editable,
    onUpdate: ({ editor }) => {
      const result = canonicalDocumentFromTiptapJSON(editor.getJSON());
      if (result.status === 'supported') onUpdate?.(result.document);
    },
  });
}
