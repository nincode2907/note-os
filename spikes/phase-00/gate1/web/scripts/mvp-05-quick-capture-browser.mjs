import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const evidence = process.env.NOTEOS_MVP05_EVIDENCE ?? `${root}/artifacts/review/noteOS-Phase05-Quick-Capture-review/evidence`;
const lens = process.env.NOTEOS_PLAYWRIGHT_ROOT ?? `${root}/../ui-lens`;
const { chromium } = require(require.resolve('playwright', { paths: [lens] }));
const baseUrl = process.env.NOTEOS_TEST_URL ?? 'http://127.0.0.1:3000';
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch();
const diagnostics = { browser: browser.version(), errors: [], externalRequests: [], quickCaptureWriteLatency: null };
const check = (condition, message) => { if (!condition) throw new Error(message); };

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

async function scenario(name, viewport, run) {
  const context = await browser.newContext({ viewport });
  await context.route('**/*', (route) => new URL(route.request().url()).origin === baseUrl ? route.continue() : route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(6000);
  page.on('console', (message) => { if (message.type() === 'error') diagnostics.errors.push(`${name}: ${message.text()}`); });
  page.on('pageerror', (error) => diagnostics.errors.push(`${name}: ${error.message}`));
  page.on('request', (request) => { if (!request.url().startsWith(baseUrl)) diagnostics.externalRequests.push(`${name}: ${request.url()}`); });
  await page.goto(`${baseUrl}/icon.svg`);
  await page.evaluate(() => new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase('noteos-mvp-01'); request.onsuccess = resolve; request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error('A previous synthetic database connection remains open.')); }));
  try { await run(page); }
  catch (error) { await page.screenshot({ path: `${evidence}/${name}-failure.png`, fullPage: true }).catch(() => {}); throw error; }
  finally { await context.close(); }
}

try {
  await scenario('quick-capture-desktop', { width: 1440, height: 1000 }, async (page) => {
    await page.goto(baseUrl);
    await page.waitForFunction(() => localStorage.getItem('noteos:mvp03:home-preferences') !== null);
    const input = page.getByRole('textbox', { name: "What's on your mind?" });
    const save = page.getByRole('button', { name: 'Save note' });
    check(await save.isDisabled(), 'An empty capture should not be saveable.');
    const text = '  Ghi chú cho buổi chiều\n\n東京でアイデアを整理する\nExpo SDK 57 + SQLite  ';
    await input.fill(text);
    check(!(await save.isDisabled()), 'Save should become available after input.');
    await page.reload();
    await page.waitForFunction((expected) => document.querySelector('#quick-capture-input')?.value === expected, text);
    await input.focus();
    check(await input.evaluate((element) => document.activeElement === element), 'Quick Capture did not take keyboard focus.');
    await save.evaluate((element) => { element.click(); element.click(); });
    await page.getByRole('status').filter({ hasText: 'Saved on this device' }).waitFor();
    await page.waitForFunction(async () => {
      const request = indexedDB.open('noteos-mvp-01');
      const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const tx = db.transaction('notes', 'readonly'), result = await new Promise((resolve, reject) => { const get = tx.objectStore('notes').getAll(); get.onsuccess = () => resolve(get.result); get.onerror = () => reject(get.error); });
      db.close(); return result.length === 1;
    });
    check((await input.inputValue()) === '', 'The composer did not clear after durable save.');
    const note = (await readAllNotes(page))[0];
    check(note.title === 'Ghi chú cho buổi chiều', `Unexpected title: ${note.title}`);
    check(note.document.schemaVersion === 1 && note.document.content.map((line) => line.content?.[0]?.text ?? '').join('\n') === text.trim(), 'Canonical note body lost text or Unicode.');
    await input.fill('Second independent thought');
    await page.getByRole('button', { name: 'Save note' }).click();
    await page.getByRole('status').filter({ hasText: 'Saved on this device' }).waitFor();
    check((await readAllNotes(page)).length === 2, 'Repeated capture did not create a separate note.');
    await page.screenshot({ path: `${evidence}/quick-capture-desktop.png`, fullPage: true });
    await page.locator('.note-card-link').filter({ hasText: 'Ghi chú cho buổi chiều' }).click();
    await page.locator('.editor-content').waitFor();
    check((await page.locator('.editor-content').innerText()).includes('東京でアイデアを整理する'), 'Saved Quick Capture did not open in the existing editor.');
    const samples = [];
    for (let index = 0; index < 20; index++) {
      await page.goto(baseUrl);
      await page.waitForFunction(() => localStorage.getItem('noteos:mvp03:home-preferences') !== null);
      const capture = page.getByRole('textbox', { name: "What's on your mind?" });
      const saveButton = page.getByRole('button', { name: 'Save note' });
      await capture.fill(`Synthetic local write latency ${index + 1}`);
      const countBefore = (await readAllNotes(page)).length;
      await page.evaluate(() => { window.__quickCaptureWriteStart = performance.now(); });
      await saveButton.click();
      await page.locator('.quick-capture-status').getByText('Saved on this device. Ready for another thought.', { exact: true }).waitFor();
      await page.waitForFunction(async (expected) => {
        const request = indexedDB.open('noteos-mvp-01');
        const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        const tx = db.transaction('notes', 'readonly');
        const count = await new Promise((resolve, reject) => { const query = tx.objectStore('notes').count(); query.onsuccess = () => resolve(query.result); query.onerror = () => reject(query.error); });
        db.close(); return count === expected;
      }, countBefore + 1);
      samples.push(await page.evaluate(() => performance.now() - window.__quickCaptureWriteStart));
    }
    const sorted = [...samples].sort((a, b) => a - b);
    diagnostics.quickCaptureWriteLatency = { metric: 'Save click to IndexedDB count increment and local saved confirmation', dataset: '20 synthetic one-line notes, local browser storage only', unit: 'ms', iterations: samples.length, p50: sorted[Math.floor((sorted.length - 1) * 0.5)], p95: sorted[Math.ceil((sorted.length - 1) * 0.95)], max: sorted.at(-1), samples };
  });

  await scenario('quick-capture-phone-layout', { width: 390, height: 844 }, async (page) => {
    await page.goto(baseUrl);
    await page.waitForFunction(() => localStorage.getItem('noteos:mvp03:home-preferences') !== null);
    const input = page.getByRole('textbox', { name: "What's on your mind?" });
    await input.fill('Quick note on a phone browser');
    const composer = page.locator('.quick-capture');
    const box = await composer.boundingBox();
    check(Boolean(box && box.width <= 390 && box.height > 120), 'Quick Capture did not fit the phone viewport.');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    check(!overflow, 'Home has horizontal overflow at phone width.');
    await page.screenshot({ path: `${evidence}/quick-capture-phone.png`, fullPage: true });
  });

  check(diagnostics.errors.length === 0, `Browser console errors: ${diagnostics.errors.join(' | ')}`);
  check(diagnostics.externalRequests.length === 0, `Unexpected external requests: ${diagnostics.externalRequests.join(' | ')}`);
  await writeFile(`${evidence}/quick-capture-browser-diagnostics.json`, JSON.stringify(diagnostics, null, 2));
  console.log(`PASS Chromium ${diagnostics.browser}: reload recovery, empty guard, double-click dedupe, canonical Unicode save, independent notes, editor open, 1440px desktop and 390px phone layout; zero console errors and external requests.`);
} finally { await browser.close(); }
