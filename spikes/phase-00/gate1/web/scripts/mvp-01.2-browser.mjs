// Synthetic acceptance only. Reuses the Playwright already installed with sibling UI Lens.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const { chromium } = require(require.resolve('playwright', { paths: [process.env.NOTEOS_PLAYWRIGHT_ROOT ?? `${repoRoot}/../ui-lens`] }));
const root = process.env.NOTEOS_TEST_URL ?? 'http://127.0.0.1:3000';
const output = process.env.NOTEOS_TEST_OUTPUT ?? '/tmp/noteos-mvp012-evidence';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [], diagnostics = { consoleErrors: [], pageErrors: [], failedRequests: [], externalRequests: [] };
const check = (ok, message) => { if (!ok) throw new Error(message); };
async function noteAction(page, action) { await page.getByRole('button', { name: 'More note actions' }).click(); await page.getByRole('menuitem', { name: action, exact: true }).click(); }
const textDocument = text => ({ schemaVersion: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const bodyOf = note => note.document.content.flatMap(p => (p.content ?? []).map(n => n.text ?? '')).join('');
async function fresh(action) {
  const context = await browser.newContext({ acceptDownloads: true });
  await context.route('**/*', async route => {
    if (new URL(route.request().url()).origin !== root) { diagnostics.externalRequests.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  await context.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, ...args) {
      if (sessionStorage.getItem('noteos:test-fail') === 'yes' && this.name === 'notes') throw new DOMException('Injected test write failure', 'UnknownError');
      return put.call(this, value, ...args);
    };
  });
  context.on('page', page => {
    page.on('console', m => { if (m.type() === 'error') diagnostics.consoleErrors.push(m.text()); });
    page.on('pageerror', e => diagnostics.pageErrors.push(e.message));
    page.on('requestfailed', r => diagnostics.failedRequests.push({ url: r.url(), error: r.failure()?.errorText }));
    page.on('dialog', dialog => void dialog.accept());
    page.setDefaultTimeout(12000);
  });
  const page = await context.newPage();
  try { await action(page, context); }
  catch (error) {
    const pages = await Promise.all(context.pages().map(async p => ({ url: p.url(), body: await p.locator('body').innerText(), storage: await p.evaluate(() => ({ ...localStorage })), editor: await p.locator('.editor-content').innerHTML().catch(() => null) })));
    await writeFile(`${output}/failure-${results.length}.json`, JSON.stringify(pages, null, 2)); throw error;
  } finally { await context.close(); }
}
async function read(page, id) {
  return page.evaluate(id => new Promise((resolve, reject) => {
    const open = indexedDB.open('noteos-mvp-01'); open.onerror = () => reject(open.error);
    open.onsuccess = () => { const db = open.result, tx = db.transaction('notes'), req = tx.objectStore('notes').get(id); req.onsuccess = () => resolve(req.result ?? null); req.onerror = () => reject(req.error); tx.oncomplete = () => db.close(); };
  }), id);
}
async function committed(page, id, title, body) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const note = await read(page, id);
    if (note?.title === title && JSON.stringify(note.document).includes(body) && /^Saved /.test(await page.locator('.editor-top .save-state').innerText())) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Expected committed title/body not found: ${title} / ${body}`);
}
async function create(page, title = 'Old title', body = 'Old body') {
  await page.goto(root); await page.getByRole('button', { name: /New note/ }).click(); await page.waitForURL(/\/notes\//);
  const id = new URL(page.url()).pathname.split('/').pop();
  await page.locator('#note-title').fill(title); await page.locator('[contenteditable=true]').fill(body); await committed(page, id, title, body);
  return id;
}
async function journals(page, id) {
  return page.evaluate(id => Object.keys(localStorage).filter(k => k.startsWith(`noteos:mvp01:recovery:${id}`)).map(k => ({ key: k, ...JSON.parse(localStorage.getItem(k)) })), id);
}
async function scenario(name, fn) {
  if (process.env.NOTEOS_TEST_FILTER && !name.includes(process.env.NOTEOS_TEST_FILTER)) return;
  try { await fresh(fn); results.push({ name, status: 'PASS' }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, status: 'FAIL', error: error.stack ?? String(error) }); console.error(`FAIL ${name}: ${error.stack}`); }
}
try {
  await scenario('F-01 recovery updates live body/title, continued editing survives reload', async page => {
    const id = await create(page);
    await page.evaluate(() => sessionStorage.setItem('noteos:test-fail', 'yes'));
    await page.locator('#note-title').fill('Recovered title'); await page.locator('[contenteditable=true]').fill('Recovered body');
    await page.getByText('Not saved', { exact: true }).waitFor();
    await page.evaluate(() => sessionStorage.setItem('noteos:test-fail', 'no')); await page.reload();
    await page.getByRole('dialog').waitFor(); await page.getByRole('button', { name: 'Restore draft', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    check(await page.locator('#note-title').inputValue() === 'Recovered title', 'recovered title absent');
    check(await page.locator('[contenteditable=true]').innerText() === 'Recovered body', 'live editor still has old body');
    await page.locator('[contenteditable=true]').click(); await page.locator('[contenteditable=true]').press('ControlOrMeta+End'); await page.locator('[contenteditable=true]').pressSequentially(' + new text');
    await page.locator('#note-title').fill('Recovered title + new'); await committed(page, id, 'Recovered title + new', 'Recovered body + new text');
    await page.reload(); await page.locator('[contenteditable=true]').waitFor();
    check(await page.locator('[contenteditable=true]').innerText() === 'Recovered body + new text', 'continued body lost');
    check(await page.locator('#note-title').inputValue() === 'Recovered title + new', 'continued title lost');
  });
  await scenario('F-01 failed recovery save retains journal; explicit Keep saved version resets live editor safely', async page => {
    const id = await create(page); await page.evaluate(() => sessionStorage.setItem('noteos:test-fail', 'yes'));
    await page.locator('#note-title').fill('Failed recovery title'); await page.locator('[contenteditable=true]').fill('Failed recovery body'); await page.getByText('Not saved', { exact: true }).waitFor(); await page.reload();
    await page.getByRole('button', { name: 'Restore draft', exact: true }).click(); await page.getByRole('dialog').getByRole('alert').waitFor();
    check((await journals(page, id)).some(x => x.title === 'Failed recovery title'), 'failed restoration removed journal');
    check((await page.locator('.tiptap').innerText()) === 'Failed recovery body', 'failed save did not retain applied body');
    await page.getByRole('button', { name: 'Keep saved version', exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'hidden' });
    check(await page.locator('[contenteditable=true]').innerText() === 'Old body', 'discard did not restore saved body'); check(await page.locator('#note-title').inputValue() === 'Old title', 'discard did not restore saved title');
    check((await journals(page, id)).length === 0, 'explicit discard left current draft journal');
  });
  await scenario('F-01 concurrent recovery revision stays safe and offers a separate recovered note', async (page, context) => {
    const id = await create(page), url = page.url(); await page.evaluate(() => sessionStorage.setItem('noteos:test-fail', 'yes'));
    await page.locator('[contenteditable=true]').fill('Recovery copy body'); await page.getByText('Not saved', { exact: true }).waitFor(); await page.evaluate(() => sessionStorage.setItem('noteos:test-fail', 'no')); await page.reload(); await page.getByRole('dialog').waitFor();
    const other = await context.newPage(); await other.goto(url); await other.getByRole('button', { name: 'Keep saved version', exact: true }).click(); await other.getByRole('dialog').waitFor({ state: 'hidden' });
    await other.locator('[contenteditable=true]').fill('Other tab newer body'); await committed(other, id, 'Old title', 'Other tab newer body');
    await page.getByRole('button', { name: 'Restore draft', exact: true }).click(); await page.getByRole('button', { name: 'Recover as new note', exact: true }).waitFor(); check(bodyOf(await read(page, id)) === 'Other tab newer body', 'recovery overwrote other tab');
    await page.getByRole('button', { name: 'Recover as new note', exact: true }).click(); await page.waitForURL(u => u.pathname.startsWith('/notes/') && !u.pathname.endsWith(id)); await page.locator('[contenteditable=true]').waitFor(); check(await page.locator('[contenteditable=true]').innerText() === 'Recovery copy body', 'recovered copy lost body'); check((await journals(page, id)).length === 0, 'successful recovery copy left its own old-note journal');
  });
  for (const action of ['Archive', 'Move to trash']) await scenario(`F-02 stale two-tab revision blocks ${action}`, async (page, context) => {
    const id = await create(page), url = page.url(), second = await context.newPage(); await second.goto(url); await second.locator('[contenteditable=true]').waitFor();
    await page.locator('[contenteditable=true]').fill('Other tab committed'); await committed(page, id, 'Old title', 'Other tab committed'); const before = await read(page, id);
    await second.locator('[contenteditable=true]').fill('Stale draft'); await noteAction(second, action);
    await second.getByRole('alert').filter({ hasText: 'changed in another tab' }).waitFor();
    const after = await read(page, id); check(second.url() === url, 'unsafe navigation'); check(after.lifecycle === 'active' && after.revision === before.revision, 'DB transition or revision bypassed conflict');
    check(await second.locator('[contenteditable=true]').innerText() === 'Stale draft', 'draft lost'); check((await journals(second, id)).some(x => JSON.stringify(x.document).includes('Stale draft')), 'journal missing');
  });
  await scenario('F-02 save failure blocks Archive and preserves body/title/journal', async page => {
    const id = await create(page), url = page.url(), before = await read(page, id); await page.evaluate(() => sessionStorage.setItem('noteos:test-fail', 'yes'));
    await page.locator('#note-title').fill('Unsaved title'); await page.locator('[contenteditable=true]').fill('Unsaved body'); await noteAction(page, 'Archive');
    await page.getByText('Not saved', { exact: true }).waitFor(); const after = await read(page, id);
    check(page.url() === url && after.lifecycle === 'active' && after.revision === before.revision, 'failed-save lifecycle bypass');
    check(await page.locator('[contenteditable=true]').innerText() === 'Unsaved body', 'body lost'); check((await journals(page, id)).some(x => x.title === 'Unsaved title'), 'title journal lost');
    await page.evaluate(() => sessionStorage.setItem('noteos:test-fail', 'no')); await page.getByRole('button', { name: 'Retry save', exact: true }).click(); await committed(page, id, 'Unsaved title', 'Unsaved body');
  });
  await scenario('F-02 immediate Archive flushes latest text; untouched lifecycle adds only one revision; restore/trash happy paths', async page => {
    const id = await create(page), before = await read(page, id);
    await page.locator('[contenteditable=true]').fill('Immediate Archive body'); await noteAction(page, 'Archive'); await page.waitForURL('**/archive');
    let saved = await read(page, id); check(saved.lifecycle === 'archived' && bodyOf(saved) === 'Immediate Archive body' && saved.revision === before.revision + 2, 'immediate archive failed');
    await page.getByRole('button', { name: 'Restore', exact: true }).click(); await page.getByText('Nothing in the archive').waitFor(); await page.goto(`${root}/notes/${id}`);
    const restored = await read(page, id); await noteAction(page, 'Move to trash'); await page.waitForURL('**/trash');
    saved = await read(page, id); check(saved.revision === restored.revision + 1 && saved.lifecycle === 'trashed', 'untouched trash performed an extra save');
    await page.getByRole('button', { name: 'Restore', exact: true }).click(); await page.getByText('Trash is empty').waitFor(); check((await read(page, id)).lifecycle === 'active', 'restore failed');
  });
  await scenario('F-03 delayed real IndexedDB transaction + A/B/C edits + Archive serialize to latest', async page => {
    const id = await create(page);
    await page.evaluate(async () => {
      await new Promise(resolve => { const r = indexedDB.open('noteos-mvp-01'); r.onsuccess = () => { const db = r.result, tx = db.transaction('notes', 'readwrite'), store = tx.objectStore('notes'); window.__noteosHold = true; const pump = () => { const q = store.get('hold'); q.onsuccess = () => { if (window.__noteosHold) pump(); }; }; pump(); tx.oncomplete = () => db.close(); resolve(); }; });
    });
    await page.locator('[contenteditable=true]').fill('A'); await page.getByText('Saving…', { exact: true }).waitFor();
    await page.locator('[contenteditable=true]').fill('B'); await page.locator('[contenteditable=true]').fill('C latest');
    check((await journals(page, id)).some(x => JSON.stringify(x.document).includes('C latest')), 'newest journal absent');
    const click = noteAction(page, 'Archive');
    await page.evaluate(() => { window.__noteosHold = false; }); await click; await page.waitForURL('**/archive');
    const saved = await read(page, id); check(saved.lifecycle === 'archived' && bodyOf(saved) === 'C latest', 'latest draft lost or self-conflicted');
    check((await journals(page, id)).length === 0, 'committed journal not cleaned');
  });
  for (const destination of ['back', 'sidebar']) await scenario(`F-04 immediate ${destination} navigation flushes under 650ms`, async page => {
    const id = await create(page); await page.evaluate(() => { window.__noteosClickAt = 0; document.addEventListener('click', () => { window.__noteosClickAt = performance.now(); }, { once: true, capture: true }); });
    await page.locator('[contenteditable=true]').fill(`Immediate ${destination} body`); const editedAt = await page.evaluate(() => performance.now());
    await (destination === 'back' ? page.locator('a.back-link') : page.locator('aside').getByRole('link', { name: 'Backup', exact: true })).click();
    await page.waitForURL(destination === 'back' ? root : `${root}/backup`);
    const clickAt = await page.evaluate(() => window.__noteosClickAt); check(clickAt - editedAt < 650, `click was not immediate: ${clickAt - editedAt}ms`);
    await page.goto(`${root}/notes/${id}`); await page.locator('[contenteditable=true]').waitFor(); check(await page.locator('[contenteditable=true]').innerText() === `Immediate ${destination} body`, 'navigation lost draft');
  });
  await scenario('F-04 failed flush blocks sidebar navigation and retains latest draft', async page => {
    const id = await create(page), url = page.url(); await page.evaluate(() => sessionStorage.setItem('noteos:test-fail', 'yes'));
    await page.locator('[contenteditable=true]').fill('Navigation failure draft'); await page.locator('aside').getByRole('link', { name: 'Backup', exact: true }).click(); await page.getByText('Not saved', { exact: true }).waitFor();
    check(page.url() === url, 'failure navigated away'); check((await journals(page, id)).some(x => JSON.stringify(x.document).includes('Navigation failure draft')), 'navigation failure lost journal');
  });
  await scenario('F-05 delete/reimport same ID removes stale journal and retains newer journal as copy only', async page => {
    const id = await create(page), original = await read(page, id); await noteAction(page, 'Move to trash'); await page.waitForURL('**/trash'); const trashed = await read(page, id);
    await page.evaluate(({ id, note, doc }) => {
      localStorage.setItem(`noteos:mvp01:recovery:${id}:stale-test`, JSON.stringify({ title: note.title, document: note.document, baseRevision: note.revision }));
      localStorage.setItem(`noteos:mvp01:recovery:${id}:newer-test`, JSON.stringify({ title: 'Retained draft', document: doc, baseRevision: 0 }));
    }, { id, note: trashed, doc: textDocument('Retained draft body') });
    await page.getByRole('button', { name: 'Delete forever', exact: true }).click(); const dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: 'Request notes backup download' }).click(); await dialog.getByLabel('I verified that I saved the notes backup.').check(); await dialog.getByLabel(/I exported any audio/).check(); await dialog.getByRole('button', { name: 'Delete forever', exact: true }).click(); await page.getByText('Trash is empty').waitFor();
    const remaining = await journals(page, id); check(remaining.length === 1 && remaining[0].title === 'Retained draft', 'delete cleaned wrong journal');
    await page.goto(`${root}/backup`); await page.locator('input[type=file]').setInputFiles({ name: 'synthetic-reimport.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'noteos.local-backup', version: 1, exportedAt: new Date().toISOString(), notes: [original] })) }); await page.getByRole('button', { name: 'Validate and import' }).click(); await page.getByRole('status').filter({ hasText: 'Imported 1 notes' }).waitFor();
    await page.goto(`${root}/notes/${id}`); await page.getByRole('dialog').waitFor(); await page.getByRole('button', { name: 'Recover as new note', exact: true }).waitFor(); check(await page.getByRole('button', { name: 'Restore draft', exact: true }).count() === 0, 'old journal could overwrite reimport');
  });
  await scenario('MVP-01.1 smoke: search Unicode, backup download/collision, future readonly, missing ID does not resurrect', async page => {
    const id = await create(page, 'Điện thoại — Đà Nẵng', '日本語 東京かな'); await page.locator('a.back-link').click(); await page.waitForURL(root);
    await page.getByLabel('Search notes').fill('dien thoai'); await page.getByRole('link', { name: /Điện thoại/ }).waitFor(); await page.getByLabel('Search notes').fill('東京かな'); await page.getByRole('link', { name: /Điện thoại/ }).waitFor();
    const original = await read(page, id); await page.goto(`${root}/backup`); const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download backup' }).click()]); check(Boolean(await download.path()), 'backup unavailable');
    const future = { ...original, id: crypto.randomUUID(), schemaVersion: 99, document: { schemaVersion: 99, type: 'doc', content: [], future: true } };
    await page.locator('input[type=file]').setInputFiles({ name: 'future.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'noteos.local-backup', version: 1, notes: [{ ...original, title: 'must not overwrite' }, future] })) }); await page.getByRole('button', { name: 'Validate and import' }).click(); await page.getByRole('status').filter({ hasText: 'Imported 1 notes' }).waitFor(); check((await read(page, id)).title === original.title, 'collision overwrite');
    await page.goto(`${root}/notes/${future.id}`); await page.locator('.readonly-panel').waitFor(); check(await page.locator('[contenteditable=true]').count() === 0, 'future editable');
    const missing = crypto.randomUUID(); await page.goto(`${root}/notes/${missing}`); await page.getByRole('alert').filter({ hasText: 'no longer exists' }).waitFor(); check(await read(page, missing) === null, 'missing note resurrected');
  });
} finally {
  await writeFile(`${output}/browser-results.json`, JSON.stringify({ browser: browser.version(), results, diagnostics }, null, 2)); await browser.close();
}
check(results.every(x => x.status === 'PASS') && !diagnostics.consoleErrors.length && !diagnostics.pageErrors.length && !diagnostics.externalRequests.length, 'browser acceptance failed; inspect browser-results.json');
