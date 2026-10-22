import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [result, template] = await Promise.all([
  build({
    absWorkingDir: root,
    entryPoints: ['editor/webview-entry.js'],
    bundle: true,
    minify: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: ['safari15'],
    legalComments: 'inline',
  }),
  readFile(path.join(root, 'editor/canonical-editor.template.html'), 'utf8'),
]);
const script = result.outputFiles[0].text.replace(/<\/script/giu, '<\\/script');
if (template.split('__EDITOR_SCRIPT__').length !== 2) throw new Error('Editor bundle template must contain one script placeholder.');
const html = template.replace('__EDITOR_SCRIPT__', () => script);
await writeFile(path.join(root, 'editor/canonical-editor.html'), html);
console.log(`Built offline Tiptap editor asset (${Buffer.byteLength(html)} bytes).`);
