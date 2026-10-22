import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateCanonicalDocument } from '../../web/packages/document-engine/src/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = path.resolve(root, '../../../../..');
const lens = process.env.NOTEOS_PLAYWRIGHT_ROOT ?? path.resolve(workspace, 'ui-lens');
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [lens] }));
const fixture = JSON.parse(await readFile(path.resolve(root, '../web/packages/document-engine/fixtures/schema-v1-rich.json'), 'utf8'));
fixture.content[1].content.push({ type: 'text', text: ' — removed', marks: [{ type: 'strike' }] });
fixture.content[3].content[0].content.push({ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'nested checked task' }] }] }] });
const browser = await chromium.launch();
const page = await browser.newPage();
const externalRequests = [];
const runtimeErrors = [];
page.on('request', request => { if (!request.url().startsWith('file:')) externalRequests.push(request.url()); });
page.on('pageerror', error => runtimeErrors.push(error.message));
page.on('console', message => { if (message.type() === 'error') runtimeErrors.push(message.text()); });
try {
  await page.addInitScript(() => {
    window.__nativeMessages = [];
    window.ReactNativeWebView = { postMessage(raw) { window.__nativeMessages.push(JSON.parse(raw)); } };
  });
  await page.goto(pathToFileURL(path.join(root, 'editor/canonical-editor.html')).href);
  await page.evaluate(document => window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ v: 1, sessionId: 'synthetic-note:session-1', generation: 1, type: 'INIT_DOCUMENT', payload: { document, editable: true } }) })), fixture);
  await page.waitForFunction(() => window.__nativeMessages.some(message => message.type === 'EDITOR_READY'), null, { timeout: 5000 }).catch(async () => {
    const diagnostic = await page.evaluate(() => ({ readyState: document.readyState, error: document.getElementById('error')?.textContent, editorText: document.getElementById('editable')?.innerText, nativeMessages: window.__nativeMessages }));
    throw new Error(`The bundled editor did not become ready. ${JSON.stringify({ diagnostic, runtimeErrors })}`);
  });
  assert.equal(await page.locator('#editable h2').textContent(), 'noteOS document v1');
  assert.equal(await page.locator('#editable blockquote').count(), 1);
  assert.equal(await page.locator('#editable pre code').textContent(), 'const answer = `42`;');
  assert.equal(await page.locator('#editable ol[start="3"]').count(), 1);
  assert.equal(await page.locator('#editable ul[data-type="taskList"] ul[data-type="taskList"]').count(), 1);
  assert.equal(await page.locator('#editable [data-noteos-attachment="asset-01"]').count(), 1);
  assert.equal(await page.locator('#editable p s').textContent(), ' — removed');

  await page.locator('#editable').dispatchEvent('compositionstart', { data: 'かな' });
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ v: 1, sessionId: 'synthetic-note:session-1', generation: 2, type: 'REQUEST_DOCUMENT', payload: { requestId: 'composition-check' } }) })));
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.__nativeMessages.some(message => message.type === 'DOCUMENT_SNAPSHOT' && message.payload.requestId === 'composition-check')), false);
  await page.locator('#editable').dispatchEvent('compositionend', { data: 'かな' });
  await page.waitForFunction(() => window.__nativeMessages.some(message => message.type === 'DOCUMENT_SNAPSHOT' && message.payload.requestId === 'composition-check'));

  await page.evaluate(() => {
    const text = [...document.querySelectorAll('#editable p')].find(node => node.textContent === 'open task');
    const range = document.createRange(); range.selectNodeContents(text);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  await page.locator('[data-command="bold"]').click();
  await page.locator('#editable input[type="checkbox"]').first().click();
  await page.waitForFunction(() => window.__nativeMessages.some(message => message.type === 'DOCUMENT_CHANGED'));

  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ v: 1, sessionId: 'synthetic-note:session-1', generation: 3, type: 'REQUEST_DOCUMENT', payload: { requestId: 'browser-check-1' } }) })));
  await page.waitForFunction(() => window.__nativeMessages.some(message => message.type === 'DOCUMENT_SNAPSHOT' && message.payload.requestId === 'browser-check-1'));
  const snapshot = await page.evaluate(() => window.__nativeMessages.find(message => message.type === 'DOCUMENT_SNAPSHOT' && message.payload.requestId === 'browser-check-1'));
  const expected = validateCanonicalDocument(fixture).document;
  assert.deepEqual(snapshot.payload.document.content[1], expected.content[1]);
  assert.equal(snapshot.payload.document.content[2].content[0].content[1].type, 'orderedList');
  assert.deepEqual(snapshot.payload.document.content[3].content.map(task => task.attrs.checked), [true, true]);
  assert.equal(snapshot.payload.document.content[3].content[0].content[1].content[0].attrs.checked, true);
  const openedTask = snapshot.payload.document.content[3].content[0].content[0].content[0];
  assert.ok(openedTask.marks?.some(mark => mark.type === 'bold'));
  assert.equal(externalRequests.length, 0, `Offline editor attempted network requests: ${externalRequests.join(', ')}`);
  console.log(`PASS Chromium ${browser.version()}: local Tiptap runtime, canonical round-trip, bold toolbar, task toggle, IME snapshot deferral, and zero external requests.`);
} finally {
  await browser.close();
}
