// Phase 09F browser check on the isolated synthetic stack: on-device Smart vs Exact search.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { SYNTHETIC_NOTES, syntheticNoteRecord } from '../sync-server/ai-eval/synthetic-notes.mjs';

const require = createRequire(import.meta.url), root = fileURLToPath(new URL('../../../../../', import.meta.url));
const { chromium, webkit } = require(require.resolve('playwright', { paths: [process.env.NOTEOS_PLAYWRIGHT_ROOT ?? `${root}/../ui-lens`] }));
const evidence = process.env.NOTEOS_AI_EVIDENCE ?? `${root}/artifacts/review/noteOS-Phase09B1A-to-09F-AI-AutoOrganize-review/evidence/09F`;
const origin = 'http://127.0.0.1:15745';
const FILLER = Number(process.env.FILLER ?? 2000);
const CASES = [
  { q: 'electricity bill', expectTitle: '今月の家計簿', exactCount: 0 },
  { q: 'du lịch', expectTitle: '京都旅行の計画' },
  { q: 'doctor appointment', expectTitle: 'Lịch khám sức khỏe', exactCount: 0 },
  { q: 'kham rang', expectTitle: 'Lịch khám sức khỏe' },
];

async function seed(page) {
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('textbox', { name: "What's on your mind?" }).waitFor();
  for (let i = 0; i < 120; i++) { if (await page.evaluate(async () => (await indexedDB.databases()).some(row => row.name === 'noteos-mvp-01' && row.version === 7))) break; await page.waitForTimeout(250); }
  const notes = SYNTHETIC_NOTES.map(entry => syntheticNoteRecord(entry, { privacy: 'DEVICE_ONLY' }));
  await page.evaluate(({ notes, filler }) => new Promise((ok, fail) => {
    const open = indexedDB.open('noteos-mvp-01');
    open.onsuccess = () => {
      try {
        const tx = open.result.transaction('notes', 'readwrite'), store = tx.objectStore('notes'), now = Date.now();
        for (const note of notes) store.put({ ...note, updatedAt: now, createdAt: now });
        const words = ['alpha', 'river', 'mountain', 'lamp', 'violet', 'orbit', 'paper', 'quiet', 'granite', 'harbor', 'cedar', 'signal'];
        for (let i = 0; i < filler; i++) store.put({ id: `filler-${i}`, title: `Filler ${words[i % 12]} ${i}`, document: { schemaVersion: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: Array.from({ length: 40 }, (_, j) => words[(i * 7 + j * 3) % 12]).join(' ') }] }] }, schemaVersion: 1, createdAt: now - i, updatedAt: now - i, lifecycle: 'active', revision: 1, pinned: false, tags: [], privacy: 'DEVICE_ONLY' });
        tx.oncomplete = () => { open.result.close(); ok(); }; tx.onerror = () => fail(tx.error);
      } catch (error) { open.result.close(); fail(error); }
    };
    open.onerror = () => fail(open.error);
  }), { notes, filler: FILLER });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.note-card').first().waitFor();
}

async function runCases(page, label) {
  const timings = [];
  const search = page.getByRole('searchbox', { name: 'Search notes' });
  for (const testCase of CASES) {
    await page.getByRole('button', { name: 'Smart', exact: true }).click();
    const started = Date.now();
    await search.fill(testCase.q);
    const firstCards = page.locator('.note-card').filter({ hasText: testCase.expectTitle });
    await firstCards.first().waitFor();
    timings.push(Date.now() - started);
    const rank = await page.locator('.note-card h2, .note-card .note-title').evaluateAll((nodes, title) => nodes.findIndex(node => node.textContent.includes(title)), testCase.expectTitle);
    assert.ok(rank >= 0 && rank < 5, `${label}: "${testCase.q}" ranked ${rank}`);
    await page.getByText('Ranked by meaning · searched on this device, nothing is sent anywhere').waitFor();
    if (testCase.exactCount !== undefined) {
      await page.getByRole('button', { name: 'Exact', exact: true }).click();
      await page.getByText(/^0 notes$/).waitFor();
    }
  }
  return timings;
}

const results = { result: 'FAIL', filler: FILLER, runs: [] };
await mkdir(evidence, { recursive: true });
const browsers = [];
try {
  for (const [label, engine, contextOptions] of [
    ['Mac Chromium', chromium, { viewport: { width: 1440, height: 1000 } }],
    ['iPhone-sized WebKit', webkit, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }],
  ]) {
    const browser = await engine.launch(); browsers.push(browser);
    const context = await browser.newContext(contextOptions); context.setDefaultTimeout(30000);
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const requests = [];
    page.on('request', request => { if (!request.url().startsWith(origin)) requests.push(request.url()); });
    await seed(page);
    const timings = await runCases(page, label);
    await page.getByRole('button', { name: 'Smart', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Search notes' }).fill('electricity bill');
    await page.locator('.note-card').first().waitFor(); await page.waitForTimeout(300);
    await page.screenshot({ path: `${evidence}/smart-search-${label.startsWith('Mac') ? 'desktop' : 'iphone'}.png` });
    assert.deepEqual(errors, []); assert.deepEqual(requests, [], 'search makes no cross-origin requests');
    results.runs.push({ browser: `${label} (${browser.version()})`, notes: 30 + FILLER, typeToResultMs: timings, queries: CASES.map(c => c.q) });
    console.log(`✓ ${label}: ${timings.join(', ')} ms`);
  }
  results.result = 'PASS';
} finally {
  await writeFile(`${evidence}/smart-search-browser.json`, `${JSON.stringify(results, null, 2)}\n`);
  for (const browser of browsers) await browser.close().catch(() => {});
}
console.log(results.result);
