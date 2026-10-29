// Phase 09C browser verification on the isolated synthetic stack (docker-compose.phase09-ai-synthetic.yml).
// Synthetic notes only. The "local model" is the fake loopback Gateway from sync-server/ai-eval.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { startFakeGateway } from '../sync-server/ai-eval/fake-gateway.mjs';

const require = createRequire(import.meta.url), root = fileURLToPath(new URL('../../../../../', import.meta.url));
const { chromium, webkit } = require(require.resolve('playwright', { paths: [process.env.NOTEOS_PLAYWRIGHT_ROOT ?? `${root}/../ui-lens`] }));
const evidence = process.env.NOTEOS_AI_EVIDENCE ?? `${root}/artifacts/review/noteOS-Phase09B1A-to-09F-AI-AutoOrganize-review/evidence/09C`;
const origin = 'http://127.0.0.1:15745', container = 'noteos-phase09-ai-synthetic-web';
const run = async args => (await promisify(execFile)('docker', args, { maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
const fixture = action => run(['exec', '-w', '/app', container, 'node', '/verification/ai-fixture.mjs', action]);
const state = async () => JSON.parse(await fixture('state'));
const waitFor = async (fn, label) => { for (let i = 0; i < 120; i++) { const value = await fn(); if (value) return value; await delay(250); } throw new Error(`Timed out: ${label}`); };
const trace = [], started = Date.now();
const step = (name, extra = {}) => { trace.push({ step: name, ms: Date.now() - started, ...extra }); console.log(`✓ ${name}`); };

const doc = (...blocks) => ({ schemaVersion: 1, type: 'doc', content: blocks });
const para = text => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const tasks = (...items) => ({ type: 'taskList', content: items.map(text => ({ type: 'taskItem', attrs: { checked: false }, content: [para(text)] })) });
// Text Sync enrollment does not classify privacy; these synthetic notes carry an explicit owner
// classification because AI never treats missing privacy as eligible.
const NOTES = [
  { id: 'ai-e2e-launch', title: 'Kế hoạch ra mắt sản phẩm Q3', document: doc(para('Họp với nhóm thiết kế vào thứ Hai để chốt giao diện.'), para('Phải gửi lịch họp cho nhóm thiết kế trước thứ Sáu.'), tasks('Gửi bản nháp thông cáo báo chí cho chị Lan', 'Cần đặt phòng họp cho buổi demo')), tags: [], privacy: 'PRIVATE_SERVER' },
  { id: 'ai-e2e-launch-ref', title: 'Kế hoạch ra mắt sản phẩm Q3', document: doc(para('Ghi chú tham khảo: ngân sách và lịch họp thiết kế.')), tags: ['thiết kế'], privacy: 'PRIVATE_SERVER' },
  { id: 'ai-e2e-device', title: 'Never leaves this device', document: doc(para('Device-only synthetic text for the AI boundary check.')), tags: [], privacy: 'DEVICE_ONLY' },
];

async function seed(page) {
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('textbox', { name: "What's on your mind?" }).waitFor();
  // Wait until the app itself has created schema v7; opening earlier would create an empty database.
  await waitFor(() => page.evaluate(async () => (await indexedDB.databases()).some(row => row.name === 'noteos-mvp-01' && row.version === 7)), 'app-created IndexedDB v7');
  await page.evaluate(notes => new Promise((ok, fail) => {
    const open = indexedDB.open('noteos-mvp-01');
    open.onsuccess = () => {
      try {
        const tx = open.result.transaction('notes', 'readwrite'); const now = Date.now();
        for (const note of notes) tx.objectStore('notes').put({ schemaVersion: 1, createdAt: now, updatedAt: now, lifecycle: 'active', revision: 0, pinned: false, ...note });
        tx.oncomplete = () => { open.result.close(); ok(); }; tx.onerror = () => fail(tx.error);
      } catch (error) { open.result.close(); fail(error); }
    };
    open.onerror = () => fail(open.error);
  }), NOTES);
}

async function pair(page, label) {
  await page.goto(`${origin}/sync`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Device label', { exact: true }).fill(label);
  await page.getByLabel('Pairing code', { exact: true }).fill(await fixture('pair'));
  await page.getByRole('button', { name: 'Pair this browser', exact: true }).click();
  await page.getByText('This browser is paired.', { exact: false }).first().waitFor();
}

const item = (page, kind) => page.locator('.ai-item').filter({ has: page.locator('.ai-kind', { hasText: new RegExp(`^${kind}$`) }) }).first();
// The item of this kind that currently offers the given action (duplicates offer none).
const actionable = (page, kind, action) => page.locator('.ai-item').filter({ has: page.locator('.ai-kind', { hasText: new RegExp(`^${kind}$`) }) }).filter({ has: page.getByRole('button', { name: action, exact: true }) }).first();
const feedback = (page, text) => page.locator('.ai-feedback', { hasText: text }).waitFor();

async function main() {
  await mkdir(evidence, { recursive: true });
  const gateway = await startFakeGateway({ port: 15746, latencyMs: 150 });
  const browsers = [];
  try {
    const meta = JSON.parse(await fixture('init'));
    step('synthetic server initialized with AI ledger', { serverEpoch: meta.serverEpoch.slice(0, 8) });

    const mac = await chromium.launch(); browsers.push(mac);
    const macContext = await mac.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' });
    macContext.setDefaultTimeout(30000); macContext.setDefaultNavigationTimeout(30000);
    const page = await macContext.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await seed(page); step('seeded synthetic notes in Mac IndexedDB');
    await pair(page, 'Mac Chromium'); step('Mac paired');
    await page.getByRole('button', { name: 'Inspect this browser' }).click();
    await page.getByRole('button', { name: /^Approve 2 selected notes$/ }).click();
    await page.getByText('2 enrolled', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Sync now', exact: true }).click();
    await waitFor(async () => (await state()).noteCount === 2, 'two notes on server');
    const synced = await state();
    assert.deepEqual(synced.notes.map(note => note.id).sort(), ['ai-e2e-launch', 'ai-e2e-launch-ref']);
    assert.ok(synced.notes.every(note => note.privacy === 'PRIVATE_SERVER'));
    step('Text Sync uploaded 2 PRIVATE_SERVER notes; DEVICE_ONLY stayed local');

    for (const id of ['ai-e2e-launch-ref', 'ai-e2e-launch']) {
      await page.goto(`${origin}/notes/${id}`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'AI request controls' }).waitFor();
      await page.getByRole('checkbox', { name: /I allow explicit organize requests/ }).check();
      await page.getByRole('button', { name: 'Grant consent' }).click();
      await page.getByText(/Granted for organize · local model only/).waitFor();
      await page.getByRole('button', { name: 'Request analysis for this revision' }).click();
      await page.getByText(/Request accepted by the paired Mac/).waitFor();
    }
    step('explicit per-note consent and analysis request for 2 notes (STRICT_LOCAL boundary)');

    const drained = (await fixture('drain')).split('\n').map(line => JSON.parse(line));
    const jobs = drained.filter(line => line.event === 'job');
    assert.deepEqual(jobs.map(line => line.status), ['COMPLETED', 'COMPLETED', 'idle']);
    assert.ok(drained.find(line => line.event === 'preflight').ok);
    const gatewayChats = gateway.requests.filter(request => request.path === '/v1/chat/completions');
    assert.equal(gatewayChats.length, 2);
    assert.ok(gatewayChats.every(request => request.body.provider === 'ollama' && request.body.model === 'synthetic-local-8b'));
    step('on-demand worker inside the container drained 2 jobs via host fake Gateway', { gatewayRequests: gateway.requests.length });

    await page.goto(`${origin}/notes/ai-e2e-launch`, { waitUntil: 'domcontentloaded' });
    const panel = page.locator('.ai-inbox');
    await panel.waitFor();
    await page.waitForTimeout(400);
    await panel.screenshot({ path: `${evidence}/inbox-note-desktop-light.png` });
    await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForTimeout(300);
    await panel.screenshot({ path: `${evidence}/inbox-note-desktop-dark.png` });
    await page.emulateMedia({ colorScheme: 'light' });
    step('suggestion panel rendered with reason, quote, confidence and preview', { items: await page.locator('.ai-item').count() });

    const tagItem = actionable(page, 'Tag', 'Approve'), tag = await tagItem.locator('.ai-value').innerText();
    await tagItem.getByRole('button', { name: 'Approve' }).click();
    await feedback(page, 'Applied');
    await page.locator('.editor-tag', { hasText: tag }).waitFor();
    step('Approve tag → saved through SaveCoordinator (tag chip present)', { tag });

    const duplicates = await page.locator('.ai-item.is-duplicate').count();
    await actionable(page, 'Task', 'Edit').getByRole('button', { name: 'Edit' }).click();
    await actionable(page, 'Task', 'Apply edit').getByRole('textbox').fill('Đặt phòng họp tầng 3 cho buổi demo');
    await actionable(page, 'Task', 'Apply edit').getByRole('button', { name: 'Apply edit' }).click();
    await feedback(page, 'Edited and applied');
    await page.locator('.editor-content', { hasText: 'Đặt phòng họp tầng 3 cho buổi demo' }).waitFor();
    step('Edit task → applied as a checklist item; existing checklist items shown as duplicates', { duplicates });

    await actionable(page, 'Category', 'Reject').getByRole('button', { name: 'Reject' }).click(); await feedback(page, 'Rejected');
    await item(page, 'Summary').locator('.ai-item-status', { hasText: 'Already in this note.' }).waitFor();
    await actionable(page, 'Tag', 'Later').getByRole('button', { name: 'Later' }).click(); await feedback(page, 'Saved for later');
    await actionable(page, 'Related note', 'Approve').getByRole('button', { name: 'Approve' }).click(); await feedback(page, 'Applied');
    await page.locator('.editor-content', { hasText: 'Related: Kế hoạch ra mắt sản phẩm Q3' }).waitFor();
    step('Reject category, defer a tag, approve related note; identical summary shown as duplicate');
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${evidence}/inbox-note-desktop-after-decisions.png`, fullPage: true });

    await actionable(page, 'Task', 'Undo').getByRole('button', { name: 'Undo' }).click();
    await page.locator('.ai-feedback', { hasText: /^Undone\./ }).waitFor();
    await waitFor(async () => !(await page.locator('.editor-content').innerText()).includes('tầng 3'), 'task removed by undo');
    assert.ok((await page.locator('.editor-content').innerText()).includes('Related: Kế hoạch ra mắt sản phẩm Q3'), 'later edits are preserved by undo');
    step('Undo edited task after a later edit → only the inserted checklist item removed');

    await page.goto(`${origin}/sync`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Sync now', exact: true }).click();
    const afterSync = await waitFor(async () => { const value = await state(); return value.notes.find(note => note.id === 'ai-e2e-launch').tags.includes(tag) ? value : null; }, 'server note has approved tag');
    const decisions = Object.fromEntries(afterSync.itemStates.map(row => [row.itemKey, row.decision]));
    assert.equal(decisions.category, 'REJECTED'); assert.ok(Object.values(decisions).includes('DEFERRED'));
    assert.ok(Object.entries(decisions).some(([key, value]) => key.startsWith('task:') && value === 'UNDONE'));
    step('approved changes reached the server only through ordinary Text Sync; decisions recorded', { decisions });

    await page.goto(`${origin}/inbox`, { waitUntil: 'domcontentloaded' });
    await page.locator('.ai-inbox-row').first().waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${evidence}/ai-inbox-page-desktop.png` });
    step('AI Inbox page lists notes with pending items');

    await page.goto(`${origin}/notes/ai-e2e-device`, { waitUntil: 'domcontentloaded' });
    await page.getByText(/This note is DEVICE_ONLY/).waitFor();
    assert.equal(await page.locator('.ai-inbox').count(), 0);
    assert.ok(!gateway.requests.some(request => JSON.stringify(request).includes('Device-only synthetic')));
    step('DEVICE_ONLY note: no AI controls, never sent to the Gateway');

    const phone = await webkit.launch(); browsers.push(phone);
    const phoneContext = await phone.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'light' });
    phoneContext.setDefaultTimeout(30000); phoneContext.setDefaultNavigationTimeout(30000);
    const mobile = await phoneContext.newPage();
    await mobile.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    await pair(mobile, 'iPhone-sized WebKit');
    await mobile.getByRole('button', { name: 'Sync now', exact: true }).click();
    await waitFor(async () => mobile.evaluate(() => new Promise(ok => { const open = indexedDB.open('noteos-mvp-01'); open.onsuccess = () => { const r = open.result.transaction('notes').objectStore('notes').getAll(); r.onsuccess = () => { ok(r.result.length >= 2); open.result.close(); }; }; })), 'phone pulled notes');
    await mobile.goto(`${origin}/notes/ai-e2e-launch`, { waitUntil: 'domcontentloaded' });
    await mobile.locator('.ai-inbox').waitFor();
    await mobile.locator('.ai-item').filter({ has: mobile.locator('.ai-kind', { hasText: /^Tag$/ }) }).filter({ has: mobile.locator('.ai-value', { hasText: new RegExp(`^${tag}$`) }) }).locator('.ai-item-status', { hasText: 'Applied' }).waitFor();
    await mobile.waitForTimeout(300);
    await mobile.locator('.ai-inbox').screenshot({ path: `${evidence}/inbox-note-iphone-light.png` });
    await mobile.emulateMedia({ colorScheme: 'dark' }); await mobile.waitForTimeout(300);
    await mobile.locator('.ai-inbox').screenshot({ path: `${evidence}/inbox-note-iphone-dark.png` });
    step('second device (iPhone-sized WebKit) sees the tag as Applied — no duplicate apply offered');
    await mobile.emulateMedia({ colorScheme: 'light' });
    await mobile.goto(`${origin}/inbox`, { waitUntil: 'domcontentloaded' });
    await mobile.locator('.ai-inbox-row').first().waitFor(); await mobile.waitForTimeout(300);
    await mobile.screenshot({ path: `${evidence}/ai-inbox-page-iphone.png` });

    const finalState = await state();
    assert.ok(finalState.maxRequestsPerDeviceWindow < 45, `AI request burst ${finalState.maxRequestsPerDeviceWindow} must stay well under the 60/min limit`);
    step('AI API request rate stayed under the per-device limit', { maxRequestsPerDeviceWindow: finalState.maxRequestsPerDeviceWindow });
    assert.deepEqual(errors, []);
    await writeFile(`${evidence}/browser-results.json`, `${JSON.stringify({ result: 'PASS', origin, browsers: { mac: `chromium ${mac.version()}`, phone: `webkit ${phone.version()}` }, gatewayRequests: gateway.requests.map(({ method, path, body }) => ({ method, path, provider: body?.provider ?? null, model: body?.model ?? null, userChars: body?.userChars ?? null })), trace }, null, 2)}\n`);
    console.log('PASS');
  } catch (error) {
    await writeFile(`${evidence}/browser-results.json`, `${JSON.stringify({ result: 'FAIL', error: String(error?.stack ?? error), trace }, null, 2)}\n`).catch(() => {});
    throw error;
  } finally {
    for (const browser of browsers) await browser.close().catch(() => {});
    await gateway.close();
  }
}

await main();
