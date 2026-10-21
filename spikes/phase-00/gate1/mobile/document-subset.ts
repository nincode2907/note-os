import { validateCanonicalDocument } from '../web/packages/document-engine/src/index.js';

export type CanonicalDocument = { schemaVersion: number; type: 'doc'; content: any[]; [key: string]: any };

function plainText(node: any): string | null {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'text' && typeof node.text === 'string' && !/[\r\n]/u.test(node.text) && !node.marks && Object.keys(node).every(k => ['type', 'text'].includes(k))) return node.text;
  return null;
}

function paragraphText(node: any): string | null {
  if (!node || node.type !== 'paragraph' || (node.attrs && Object.keys(node.attrs).length) || Object.keys(node).some(k => !['type', 'content'].includes(k))) return null;
  if (!Array.isArray(node.content)) return '';
  let output = '';
  for (const item of node.content) {
    const text = plainText(item);
    if (text === null) return null;
    output += text;
  }
  return output;
}

export function documentToNativeModel(document: CanonicalDocument): { editable: boolean; reason?: string; paragraphs: string[]; tasks: { text: string; checked: boolean }[] } {
  const validation = validateCanonicalDocument(document);
  if (validation.status !== 'supported') return { editable: false, reason: validation.issues?.[0]?.message ?? 'Unknown schema; preserved read-only.', paragraphs: [], tasks: [] };
  if (document.schemaVersion !== 1 || document.type !== 'doc' || Object.keys(document).some(k => !['schemaVersion', 'type', 'content'].includes(k))) return { editable: false, reason: 'Document wrapper is outside the native editor subset.', paragraphs: [], tasks: [] };
  const paragraphs: string[] = [], tasks: { text: string; checked: boolean }[] = [];
  let seenTasks = false;
  for (const block of document.content) {
    if (block.type === 'paragraph' && !seenTasks) {
      const text = paragraphText(block);
      if (text === null) return { editable: false, reason: 'Rich text or paragraph attributes are preserved read-only.', paragraphs: [], tasks: [] };
      paragraphs.push(text);
      continue;
    }
    if (block.type === 'taskList' && !seenTasks && Object.keys(block).every(k => ['type', 'content'].includes(k)) && Array.isArray(block.content)) {
      seenTasks = true;
      for (const item of block.content) {
        if (item.type !== 'taskItem' || typeof item.attrs?.checked !== 'boolean' || Object.keys(item).some(k => !['type', 'attrs', 'content'].includes(k)) || Object.keys(item.attrs).some(k => k !== 'checked') || !Array.isArray(item.content) || item.content.length !== 1) return { editable: false, reason: 'Nested or decorated checklist content is preserved read-only.', paragraphs: [], tasks: [] };
        const text = paragraphText(item.content[0]);
        if (text === null) return { editable: false, reason: 'Rich checklist content is preserved read-only.', paragraphs: [], tasks: [] };
        tasks.push({ text, checked: item.attrs.checked });
      }
      continue;
    }
    return { editable: false, reason: 'This canonical structure is outside the native editor subset and is preserved read-only.', paragraphs: [], tasks: [] };
  }
  return { editable: true, paragraphs, tasks };
}

export function nativeModelToDocument(paragraphs: string[], tasks: { text: string; checked: boolean }[]): CanonicalDocument {
  const content: any[] = paragraphs.map(text => ({ type: 'paragraph', ...(text.length ? { content: [{ type: 'text', text }] } : {}) }));
  if (tasks.length) content.push({ type: 'taskList', content: tasks.map(task => ({ type: 'taskItem', attrs: { checked: task.checked }, content: [{ type: 'paragraph', ...(task.text.length ? { content: [{ type: 'text', text: task.text }] } : {}) }] })) });
  const document = { schemaVersion: 1, type: 'doc' as const, content };
  const validation = validateCanonicalDocument(document);
  if (validation.status !== 'supported') throw new Error(validation.issues?.[0]?.message ?? 'The edited document failed canonical validation.');
  return document;
}
