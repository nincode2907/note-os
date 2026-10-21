import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const evidence = process.env.NOTEOS_MVP03_EVIDENCE ?? `${root}/artifacts/review/noteOS-MVP-03-review/evidence`;
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
async function waitSaved(page) { await page.getByText(/^Saved /).waitFor({ timeout: 10000 }); }
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
    const tasks = page.locator('.editor-content li[data-checked]');
    await tasks.nth(1).locator('p').click(); await page.keyboard.press('End'); await page.keyboard.press('Enter');
    await tasks.nth(2).locator('p').click(); await page.keyboard.press('Home'); await page.keyboard.press('Backspace');
    await waitSaved(page);
    check(await page.locator('.editor-content ul[data-type="taskList"] li[data-checked]').count() >= 2, 'Enter/Backspace damaged checklist keyboard behavior.');
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
    const exported = await readNote(page, id); check(exported.pinned && exported.tags.length === 2, 'Backup export changed organization metadata in source storage.');
    const backup = { format: 'noteos.local-backup', version: 1, exportedAt: new Date().toISOString(), notes: [{ ...exported, id: `${id}-copy`, title: 'Imported checklist' }] };
    await page.locator('input[type="file"]').setInputFiles({ name: 'noteos-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
    await page.getByRole('button', { name: 'Validate and import' }).click();
    await page.getByRole('status').filter({ hasText: 'Imported 1 notes' }).waitFor();
    check((await readNote(page, `${id}-copy`)).tags.includes('東京'), 'Backup v1 import lost organization metadata.');
  });
  await scenario('stale-tab-organization-conflict', async (page, context) => {
    const id = await openNew(page); await page.locator('#note-title').fill('Two-tab draft'); await waitSaved(page);
    const other = await context.newPage(); await other.goto(page.url()); await other.locator('#note-title').waitFor({ state: 'visible' }); await other.waitForFunction(() => !document.querySelector('#note-title')?.disabled, null, { timeout: 5000 });
    await other.locator('#note-title').fill('Committed from second tab'); await waitSaved(other);
    await page.locator('.editor-content [contenteditable="true"]').click(); await page.keyboard.insertText('Local draft');
    await page.locator('#note-tag-input').fill('race'); await page.getByRole('button', { name: 'Add tag' }).click();
    await page.getByText('Not saved', { exact: true }).waitFor({ timeout: 5000 });
    check((await page.locator('.editor-content').innerText()).includes('Local draft'), 'The local draft was not retained after a stale revision conflict.');
    const saved = await readNote(page, id);
    check(saved.title === 'Committed from second tab' && !saved.tags.includes('race'), 'Stale metadata action overwrote newer tab data.');
    await page.screenshot({ path: `${evidence}/stale-tab-conflict.png`, fullPage: true });
  });
  await scenario('mobile-navigation-width', async (page) => {
    await page.goto(baseUrl);
    const sizes = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, nav: document.querySelector('.mobile-nav')?.getBoundingClientRect().width, navContent: document.querySelector('.mobile-nav')?.scrollWidth }));
    check(sizes.viewport === 390 && sizes.document <= sizes.viewport, `Mobile page overflows horizontally: ${JSON.stringify(sizes)}`);
    check(sizes.nav <= sizes.viewport && sizes.nav > 0, `Mobile navigation exceeds viewport: ${JSON.stringify(sizes)}`);
    await page.screenshot({ path: `${evidence}/mobile-home-navigation.png`, fullPage: true });
  }, { width: 390, height: 844 });
} finally {
  await browser.close();
  await writeFile(`${evidence}/diagnostics.json`, JSON.stringify({ results, diagnostics }, null, 2));
  process.stdout.write(`${JSON.stringify({ results, diagnostics }, null, 2)}\n`);
  if (results.some((result) => result.status !== 'PASS') || diagnostics.pageErrors.length || diagnostics.externalRequests.length) process.exitCode = 1;
}
