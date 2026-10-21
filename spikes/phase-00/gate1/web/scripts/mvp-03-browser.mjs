import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const evidence = process.env.NOTEOS_MVP03_EVIDENCE ?? `${root}/artifacts/review/noteOS-MVP-03.1-review/evidence`;
const lens = process.env.NOTEOS_PLAYWRIGHT_ROOT ?? `${root}/../ui-lens`;
const { chromium } = require(require.resolve('playwright', { paths: [lens] }));
const baseUrl = process.env.NOTEOS_TEST_URL ?? 'http://127.0.0.1:3000';
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch();
const results = [], diagnostics = { browser: null, consoleErrors: [], pageErrors: [], externalRequests: [] };
diagnostics.browser = browser.version();
const check = (condition, message) => { if (!condition) throw new Error(message); };
async function scenario(name, run, viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ acceptDownloads: true, viewport });
  await context.route('**/*', (route) => new URL(route.request().url()).origin === baseUrl ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(4000);
  page.on('console', (message) => { if (message.type() === 'error') diagnostics.consoleErrors.push(`${name}: ${message.text()}`); });
  page.on('pageerror', (error) => diagnostics.pageErrors.push(`${name}: ${error.message}`));
  page.on('request', (request) => { if (!request.url().startsWith(baseUrl)) diagnostics.externalRequests.push(`${name}: ${request.url()}`); });
  try { await run(page, context); results.push({ name, status: 'PASS' }); }
  catch (error) {
    results.push({ name, status: 'FAIL', error: error instanceof Error ? error.stack : String(error) });
    await page.screenshot({ path: `${evidence}/${name.replace(/[^a-z0-9]+/gi, '-')}.png`, fullPage: true }).catch(() => {});
  } finally { await context.close(); }
}
async function openNew(page) {
  await page.goto(baseUrl);
  await page.getByRole('button', { name: /New note/ }).first().click();
  await page.locator('#note-title').waitFor();
  return new URL(page.url()).pathname.split('/').pop();
}
async function readNote(page, id) {
  return page.evaluate((noteId) => new Promise((resolve, reject) => {
    const request = indexedDB.open('noteos-mvp-01');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('notes', 'readonly'), get = tx.objectStore('notes').get(noteId);
      get.onsuccess = () => resolve(get.result); get.onerror = () => reject(get.error);
      tx.oncomplete = () => db.close();
    };
  }), id);
}
async function readAllNotes(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('noteos-mvp-01');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('notes', 'readonly'), get = tx.objectStore('notes').getAll();
      get.onsuccess = () => resolve(get.result); get.onerror = () => reject(get.error);
      tx.oncomplete = () => db.close();
    };
  }));
}
async function waitSaved(page) { await page.waitForTimeout(750); await page.getByText(/^Saved /).waitFor({ timeout: 10000 }); }
try {
  await scenario('checklist-tags-pin-search-backup', async (page) => {
    const id = await openNew(page);
    await page.locator('#note-title').fill('Checklist — ghi chú 東京 🌿');
    await page.getByRole('button', { name: 'Checklist' }).click();
    const editor = page.locator('.editor-content');
    await editor.locator('li[data-checked] p').first().click();
    await page.keyboard.insertText('Mua cà phê ☕');
    await page.keyboard.press('Enter');
    const secondItem = editor.locator('li[data-checked] p').nth(1);
    await secondItem.click(); await page.keyboard.insertText('東京を記録する 🗒️');
    await editor.locator('li[data-checked] input[type="checkbox"]').first().check();
    await secondItem.click(); await page.keyboard.press('Home'); await page.keyboard.press('Shift+End'); await page.getByRole('button', { name: 'Bold' }).click();
    await page.locator('#note-tag-input').fill('Tiếng Việt'); await page.getByRole('button', { name: 'Add tag' }).click();
    await page.locator('#note-tag-input').fill('東京'); await page.getByRole('button', { name: 'Add tag' }).click();
    await page.getByRole('button', { name: /Pin note/ }).click();
    await waitSaved(page);
    let saved = await readNote(page, id);
    check(saved.pinned && saved.tags.includes('Tiếng Việt') && saved.tags.includes('東京'), 'Pin or Unicode tags did not persist.');
    check(saved.document.content.some((node) => node.type === 'taskList' && node.content[0].attrs.checked === true), 'Checked task state did not persist in canonical JSON.');
    await page.screenshot({ path: `${evidence}/editor-checklist-tags.png`, fullPage: true });
    await page.reload(); await page.locator('.editor-content').waitFor();
    saved = await readNote(page, id);
    check(saved.document.content.some((node) => node.type === 'taskList' && node.content.length === 2 && node.content[0].attrs.checked === true), 'Checklist did not survive reload.');
    check(await page.locator('.editor-content strong').count() > 0, 'Formatting did not remain alongside checklist content.');
    const secondCheckbox = page.locator('.editor-content li[data-checked] input[type="checkbox"]').nth(1);
    await secondCheckbox.check(); await waitSaved(page);
    check((await readNote(page, id)).document.content.find((node) => node.type === 'taskList').content[1].attrs.checked === true, 'Checkbox update did not autosave.');
    await secondCheckbox.uncheck(); await waitSaved(page);
    check((await readNote(page, id)).document.content.find((node) => node.type === 'taskList').content[1].attrs.checked === false, 'Uncheck did not autosave.');
    await page.getByRole('button', { name: 'Remove tag Tiếng Việt' }).click(); await waitSaved(page);
    check(!(await readNote(page, id)).tags.includes('Tiếng Việt'), 'Tag removal did not persist.');
    await page.locator('#note-tag-input').fill('Tiếng Việt'); await page.getByRole('button', { name: 'Add tag' }).click(); await waitSaved(page);
    await page.goto(baseUrl);
    await page.getByRole('button', { name: 'Pin Checklist — ghi chú 東京 🌿' }).waitFor();
    await page.getByLabel('Filter by Tiếng Việt').click();
    await page.screenshot({ path: `${evidence}/home-pinned-tags-filtered.png`, fullPage: true });
    await page.getByLabel('Search notes').fill('東京');
    check(await page.locator('.note-card').count() === 1, 'Japanese tag/title search did not find the note.');
    await page.getByLabel('Sort notes').selectOption('title');
    await page.reload();
    check(await page.getByLabel('Search notes').inputValue() === '東京', 'Search preferences did not persist after reload.');
    await page.getByLabel('Search notes').fill('no-match-xyz');
    await page.getByRole('heading', { name: 'No notes match these filters' }).waitFor();
    await page.screenshot({ path: `${evidence}/home-filtered-empty.png`, fullPage: true });
    await page.getByRole('button', { name: 'Clear search and filters' }).click();
    await page.goto(`${baseUrl}/backup`);
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download backup' }).click()]);
    check(download.suggestedFilename().endsWith('.json'), 'Backup export did not create a JSON download.');
    const stream = await download.createReadStream();
    check(stream, 'Browser did not expose the downloaded backup bytes.');
    const chunks = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const downloadedBytes = Buffer.concat(chunks);
    await writeFile(`${evidence}/actual-downloaded-backup.json`, downloadedBytes);
    const backup = JSON.parse(downloadedBytes.toString('utf8'));
    check(backup.format === 'noteos.local-backup' && backup.version === 1, 'Downloaded backup format/version is invalid.');
    const exported = backup.notes.find((row) => row.id === id);
    check(exported, 'The downloaded backup does not contain the note under test.');
    check(exported.pinned === true && JSON.stringify([...exported.tags].sort()) === JSON.stringify(['Tiếng Việt', '東京'].sort()), `Real backup did not preserve pinned state and exact Unicode tags: ${JSON.stringify({ pinned: exported.pinned, tags: exported.tags })}`);
    const exportedChecklist = exported.document.content.find((node) => node.type === 'taskList');
    check(exportedChecklist?.content.length === 2 && exportedChecklist.content[0].attrs.checked === true && exportedChecklist.content[1].attrs.checked === false, `Real backup did not preserve checklist content and checked state: ${JSON.stringify(exportedChecklist)}`);
    const originalBeforeImport = JSON.parse(JSON.stringify(await readNote(page, id)));
    const copiedBundle = { ...backup, notes: backup.notes.map((row) => row.id === id ? { ...row, id: `${id}-copy` } : row) };
    await page.locator('input[type="file"]').setInputFiles({ name: 'noteos-backup-copy.json', mimeType: 'application/json', buffer: downloadedBytes.constructor.from(JSON.stringify(copiedBundle)) });
    await page.getByRole('button', { name: 'Validate and import' }).click();
    await page.getByRole('status').filter({ hasText: 'Imported 1 notes' }).waitFor();
    const imported = await readNote(page, `${id}-copy`);
    check(imported.pinned === true && JSON.stringify([...imported.tags].sort()) === JSON.stringify(['Tiếng Việt', '東京'].sort()), `Import from the actual downloaded bundle lost organization metadata: ${JSON.stringify({ pinned: imported.pinned, tags: imported.tags })}`);
    check(JSON.stringify(imported.document) === JSON.stringify(exported.document), 'Imported copy canonical document differs from downloaded export.');
    check(JSON.stringify(await readNote(page, id)) === JSON.stringify(originalBeforeImport), 'Importing the copy modified the original note.');
    await page.goto(`${baseUrl}/notes/${id}`);
    const tasks = page.locator('.editor-content li[data-checked]');
    await tasks.nth(1).locator('p').click(); await page.keyboard.press('End'); await page.keyboard.press('Enter');
    await tasks.nth(2).locator('p').click(); await page.keyboard.press('Home'); await page.keyboard.press('Backspace');
    await waitSaved(page);
    check(await page.locator('.editor-content ul[data-type="taskList"] li[data-checked]').count() >= 2, 'Enter/Backspace damaged checklist keyboard behavior.');
  });
  await scenario('stale-tab-organization-conflict', async (page, context) => {
    const id = await openNew(page); await page.locator('#note-title').fill('Two-tab draft'); await page.locator('#note-tag-input').fill('origin'); await page.getByRole('button', { name: 'Add tag' }).click(); await waitSaved(page);
    const other = await context.newPage(); await other.goto(page.url()); await other.locator('#note-title').waitFor({ state: 'visible' }); await other.waitForFunction(() => !document.querySelector('#note-title')?.disabled, null, { timeout: 5000 });
    await other.locator('#note-title').fill('Committed from second tab'); await other.locator('#note-tag-input').fill('remote'); await other.getByRole('button', { name: 'Add tag' }).click(); await waitSaved(other);
    await page.locator('.editor-content [contenteditable="true"]').click(); await page.keyboard.insertText('Local draft');
    await page.locator('#note-tag-input').fill('race'); await page.getByRole('button', { name: 'Add tag' }).click();
    await page.getByText('Not saved', { exact: true }).waitFor({ timeout: 5000 });
    check(await page.locator('#note-tag-input').inputValue() === 'race', 'Failed stale tag action cleared the attempted tag input.');
    check(await page.getByRole('alert').count() > 0, 'Stale tag action cleared its error banner.');
    check((await page.locator('.editor-content').innerText()).includes('Local draft'), 'The local draft was not retained after a stale revision conflict.');
    const saved = await readNote(page, id);
    check(saved.title === 'Committed from second tab' && saved.tags.includes('origin') && saved.tags.includes('remote') && !saved.tags.includes('race'), 'Stale metadata action overwrote newer tab data.');
    await page.screenshot({ path: `${evidence}/stale-tab-conflict.png`, fullPage: true });
    const originalPath = new URL(page.url()).pathname;
    await Promise.all([page.waitForURL((url) => url.pathname !== originalPath), page.getByRole('button', { name: 'Save this draft as a new note' }).click()]);
    await page.locator('#note-title').waitFor();
    const copiedId = new URL(page.url()).pathname.split('/').pop();
    const copy = await readNote(page, copiedId);
    check(copy.pinned === false && JSON.stringify(copy.tags) === JSON.stringify(['origin']), `Draft copy did not keep only source-tab committed tags or default unpinned: ${JSON.stringify({ pinned: copy.pinned, tags: copy.tags })}`);
    check((await readNote(page, id)).tags.includes('remote'), 'Saving draft as copy modified the source note.');
  });
  for (const errorName of ['SecurityError', 'QuotaExceededError']) {
    await scenario(`home-preferences-${errorName}`, async (page, context) => {
      await context.addInitScript((name) => {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function(key, value) {
          if (key === 'noteos:mvp03:home-preferences') throw new DOMException('Synthetic preference write denial', name);
          return original.call(this, key, value);
        };
      }, errorName);
      const id = await openNew(page);
      await page.locator('#note-title').fill(`Preference ${errorName}`);
      await page.locator('#note-tag-input').fill('session tag'); await page.getByRole('button', { name: 'Add tag' }).click(); await waitSaved(page);
      await page.goto(baseUrl); await page.getByRole('button', { name: /New note/ }).first().click();
      await page.locator('#note-title').fill('A second note'); await waitSaved(page);
      await page.goto(baseUrl);
      const before = JSON.stringify(await readAllNotes(page));
      await page.getByLabel('Sort notes').selectOption('title');
      const orderedTitles = await page.locator('.note-card h2').allTextContents();
      check(orderedTitles[0] === 'A second note' && orderedTitles[1] === `Preference ${errorName}`, `${errorName}: title sorting stopped working: ${JSON.stringify(orderedTitles)}`);
      await page.getByLabel('Search notes').fill(errorName);
      check(await page.locator('.note-card').count() === 1, `${errorName}: search stopped working.`);
      await page.getByLabel('Filter by session tag').click();
      check(await page.locator('.note-card').count() === 1, `${errorName}: tag filtering stopped working.`);
      check(await page.getByRole('heading', { name: `Preference ${errorName}` }).count() === 1, `${errorName}: Home did not render the existing note.`);
      check(JSON.stringify(await readAllNotes(page)) === before, `${errorName}: preference interactions changed IndexedDB notes.`);
      check((await readNote(page, id)).tags.includes('session tag'), `${errorName}: existing note metadata changed.`);
    });
  }
  await scenario('tag-write-failure-preserves-input-and-retry', async (page, context) => {
    await context.addInitScript(() => {
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(value, ...args) {
        if (this.name === 'notes' && sessionStorage.getItem('noteos:mvp031:fail-next-note-put') === 'yes') {
          sessionStorage.removeItem('noteos:mvp031:fail-next-note-put');
          throw new DOMException('Synthetic IndexedDB write failure', 'UnknownError');
        }
        return original.call(this, value, ...args);
      };
    });
    const id = await openNew(page);
    await page.evaluate(() => sessionStorage.setItem('noteos:mvp031:fail-next-note-put', 'yes'));
    await page.locator('#note-tag-input').fill('retry-tag'); await page.getByRole('button', { name: 'Add tag' }).click();
    await page.getByRole('alert').waitFor();
    check(await page.locator('#note-tag-input').inputValue() === 'retry-tag', 'Storage failure cleared attempted tag input.');
    const failedRecord = await readNote(page, id);
    check(!failedRecord.tags.includes('retry-tag'), 'Failed IndexedDB tag write changed stored metadata.');
    check((await page.locator('.notice.error[role="alert"]').innerText()).length > 0, 'Storage error banner was not retained.');
    await page.getByRole('button', { name: 'Add tag' }).click(); await waitSaved(page);
    check((await readNote(page, id)).tags.includes('retry-tag'), 'Successful retry did not persist the tag.');
    check(await page.locator('#note-tag-suggestions option').evaluateAll((options) => options.some((option) => option.value === 'retry-tag')), 'Successful retry did not update available tag suggestions.');
  });
  await scenario('recovery-as-copy-preserves-safe-source-tags', async (page) => {
    const id = await openNew(page);
    await page.locator('#note-title').fill('Committed source');
    await page.locator('#note-tag-input').fill('source-tag'); await page.getByRole('button', { name: 'Add tag' }).click(); await waitSaved(page);
    await page.getByRole('button', { name: /Pin note/ }).click(); await waitSaved(page);
    const original = JSON.parse(JSON.stringify(await readNote(page, id)));
    await page.evaluate(({ noteId, document }) => {
      const key = `noteos:mvp01:recovery:${encodeURIComponent(noteId)}:mvp031-copy-test`;
      localStorage.setItem(key, JSON.stringify({ version: 2, writerId: 'mvp031-copy-test', generation: 1, baseRevision: 999, recordCreatedAt: document.createdAt, deletionEpoch: '', title: 'Recovered copy title', document: document.document, inFlight: null, updatedAt: Date.now() }));
    }, { noteId: id, document: original });
    await page.reload();
    await page.getByRole('dialog', { name: 'A recovery draft was found' }).waitFor();
    const originalPath = new URL(page.url()).pathname;
    await Promise.all([page.waitForURL((url) => url.pathname !== originalPath), page.getByRole('button', { name: 'Recover as new note' }).click()]);
    await page.locator('#note-title').waitFor();
    const copiedId = new URL(page.url()).pathname.split('/').pop();
    const copy = await readNote(page, copiedId);
    check(copy.title === 'Recovered copy title (recovered)' && copy.pinned === false && JSON.stringify(copy.tags) === JSON.stringify(['source-tag']), `Recovery copy did not preserve the safe source tag and default unpinned: ${JSON.stringify({ title: copy.title, pinned: copy.pinned, tags: copy.tags })}`);
    check(JSON.stringify(await readNote(page, id)) === JSON.stringify(original), 'Recover as copy modified the source note.');
  });
  await scenario('editor-actions-menu-keyboard-and-outside-dismissal', async (page) => {
    await openNew(page);
    const trigger = page.getByRole('button', { name: 'More note actions' });
    await trigger.click();
    const menu = page.getByRole('menu', { name: 'Note actions' });
    await menu.getByRole('menuitem', { name: 'Archive', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'detached' });
    check(await trigger.evaluate(element => document.activeElement === element), 'Escape did not return focus to the menu trigger.');
    await trigger.click();
    await page.keyboard.press('ArrowDown');
    check(await page.evaluate(() => document.activeElement?.textContent?.trim()) === 'Move to trash', 'ArrowDown did not move focus through the actions menu.');
    await page.locator('#note-title').click();
    await menu.waitFor({ state: 'detached' });
  });
  await scenario('mobile-navigation-width', async (page) => {
    await page.goto(baseUrl);
    for (const width of [320, 360, 375, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: width <= 720 ? 844 : 1024 });
      const sizes = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, nav: document.querySelector('.mobile-nav')?.getBoundingClientRect().width }));
      check(sizes.viewport === width && sizes.document <= sizes.viewport, `Page overflows horizontally at ${width}px: ${JSON.stringify(sizes)}`);
      if (width <= 720) check(sizes.nav <= sizes.viewport && sizes.nav > 0, `Mobile navigation exceeds viewport at ${width}px: ${JSON.stringify(sizes)}`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${evidence}/mobile-home-navigation.png`, fullPage: true });
  }, { width: 390, height: 844 });
} finally {
  await browser.close();
  await writeFile(`${evidence}/diagnostics.json`, JSON.stringify({ results, diagnostics }, null, 2));
  process.stdout.write(`${JSON.stringify({ results, diagnostics }, null, 2)}\n`);
  if (results.some((result) => result.status !== 'PASS') || diagnostics.pageErrors.length || diagnostics.externalRequests.length) process.exitCode = 1;
}
