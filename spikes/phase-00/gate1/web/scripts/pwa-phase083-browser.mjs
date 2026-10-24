import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const web = fileURLToPath(new URL('../', import.meta.url));
const evidenceDir = process.env.NOTEOS_PWA_EVIDENCE ?? `${root}/artifacts/review/noteOS-Phase08.3-PWA-AutoSync-review/evidence`;
const origin = process.env.NOTEOS_PWA_ORIGIN ?? 'http://127.0.0.1:15751';
const require = createRequire(import.meta.url);
const { chromium, webkit } = require(require.resolve('playwright', { paths: [process.env.NOTEOS_PLAYWRIGHT_ROOT ?? `${root}/../ui-lens`] }));

await mkdir(evidenceDir, { recursive: true });
const results = { syntheticOnly: true, actualIPhoneTest: false, cases: {} };
const counters = { pair: 0, status: 0, pulls: 0, pushes: 0, outages: 0, concurrentStatus: 0, maxConcurrentStatus: 0 };
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ serviceWorkers: 'allow', viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  let paired = false, outage = false, cursor = 0;
  await context.route('**/api/v1/sync/**', async route => {
    const url = new URL(route.request().url()), action = url.pathname.split('/').filter(Boolean).at(-1);
    counters[action === 'bootstrap' ? `bootstrap:${url.pathname.split('/').at(-1)}` : action] = (counters[action] ?? 0) + 1;
    const json = (body, status = 200, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
    if (action === 'status') {
      counters.concurrentStatus++;
      counters.maxConcurrentStatus = Math.max(counters.maxConcurrentStatus, counters.concurrentStatus);
      await new Promise(resolve => setTimeout(resolve, 150));
      counters.concurrentStatus--;
      if (!paired) return json({ error: 'authentication_required' }, 401);
      return json({ serverEpoch: 'pwa-synthetic-epoch', serverCursor: cursor, device: { label: 'Synthetic PWA' }, noteCount: 0 });
    }
    if (action === 'pair') { paired = true; return json({ paired: true }, 200, { 'set-cookie': '__Secure-noteos_sync=synthetic; Path=/; Secure; HttpOnly; SameSite=Strict' }); }
    if (action === 'pull') { counters.pulls++; return json({ serverEpoch: 'pwa-synthetic-epoch', serverCursor: cursor, nextCursor: cursor, hasMore: false, changes: [] }); }
    if (action === 'push') {
      counters.pushes++;
      if (outage) { counters.outages++; return json({ error: 'sync_storage_unavailable' }, 503); }
      const op = route.request().postDataJSON().operations[0]; cursor++;
      return json({ acknowledgements: [{ operationId: op.operationId, id: op.entityId, serverVersion: cursor, localRevision: JSON.parse(op.recordJson).revision, contentHash: `hash-${cursor}`, lifecycle: 'active' }], serverEpoch: 'pwa-synthetic-epoch', serverCursor: cursor });
    }
    if (action === 'revoke') { paired = false; return json({ revoked: true }); }
    return json({ error: 'not_found' }, 404);
  });

  await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  const manifest = await page.evaluate(async () => {
    const link = document.querySelector('link[rel="manifest"]');
    const response = await fetch(link.href, { cache: 'no-store' });
    return { href: link.href, ...(await response.json()) };
  });
  assert.equal(manifest.name, 'noteOS'); assert.equal(manifest.short_name, 'noteOS');
  assert.equal(manifest.display, 'standalone'); assert.equal(new URL(manifest.start_url, origin).origin, origin);
  for (const icon of manifest.icons) assert.equal((await page.request.get(new URL(icon.src, origin).href)).status(), 200);
  const swHeaders = await page.request.get(`${origin}/sw.js`);
  assert.match(swHeaders.headers()['cache-control'] ?? '', /no-store/);
  results.cases.manifestAndLifecycle = { status: 'PASS', display: manifest.display, icons: manifest.icons.length, serviceWorkerActive: true };

  await page.goto(`${origin}/sync`, { waitUntil: 'domcontentloaded' });
  await page.getByText('This browser is not paired.', { exact: true }).waitFor();
  await page.getByLabel('Device label', { exact: true }).fill('Synthetic PWA');
  await page.getByLabel('Pairing code', { exact: true }).fill('SYNTHETIC123');
  await page.getByRole('button', { name: 'Pair this browser', exact: true }).click();
  await page.getByText('This browser is paired. Sync is available after you approve notes.', { exact: true }).waitFor();
  assert.equal(counters.pair, 1);
  await page.getByRole('button', { name: 'Inspect this browser' }).click();
  const defaultEnrollment = page.getByLabel('Include new notes created on this browser after enrollment');
  await defaultEnrollment.click();
  await page.waitForFunction(() => document.querySelector('.sync-default-enrollment input')?.checked === true);
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
  const capture = page.getByRole('textbox', { name: "What's on your mind?" });
  await capture.fill('PWA SYNTHETIC NOTE MARKER 7d1e');
  outage = true;
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await page.getByText('Saved on this device. Ready for another thought.', { exact: true }).waitFor();
  await page.locator('.sync-worker-state').filter({ hasText: 'Waiting for connection' }).waitFor({ timeout: 10000 });
  await page.waitForTimeout(1200);
  const local = await page.evaluate(async () => {
    const open = indexedDB.open('noteos-mvp-01');
    const db = await new Promise((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    const tx = db.transaction(['notes', 'syncOutbox'], 'readonly');
    const read = name => new Promise((resolve, reject) => { const req = tx.objectStore(name).getAll(); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    const [notes, outbox] = await Promise.all([read('notes'), read('syncOutbox')]); db.close();
    return { notes, outbox };
  });
  assert.equal(local.notes.length, 1); assert.equal(local.outbox.length, 1);
  assert.ok(counters.pushes <= 2, 'Retry budget must not create a request storm');
  results.cases.localFirstAndBoundedRetry = { status: 'PASS', localNoteCount: 1, pendingOperations: 1, firstRetryAttempts: counters.pushes };

  outage = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.locator('.sync-worker-state').filter({ hasText: 'Synced to Mac' }).waitFor({ timeout: 12000 });
  await page.getByRole('textbox', { name: "What's on your mind?" }).fill('');
  const remaining = await page.evaluate(async () => {
    const open = indexedDB.open('noteos-mvp-01'); const db = await new Promise((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    const tx = db.transaction('syncOutbox', 'readonly'), req = tx.objectStore('syncOutbox').count(); return await new Promise((resolve, reject) => { req.onsuccess = () => { db.close(); resolve(req.result); }; req.onerror = () => reject(req.error); });
  });
  assert.equal(remaining, 0);
  results.cases.reconnectAutoSync = { status: 'PASS', pushes: counters.pushes, pendingAfterAck: remaining };

  const statusBeforeTabs = counters.status;
  const secondTab = await context.newPage();
  await Promise.all([page.reload({ waitUntil: 'domcontentloaded' }), secondTab.goto(`${origin}/`, { waitUntil: 'domcontentloaded' })]);
  await page.waitForTimeout(600);
  const simultaneousWorkerChecks = counters.status - statusBeforeTabs;
  assert.equal(simultaneousWorkerChecks, 1, 'Web Locks should allow only one active auto-sync worker across tabs');
  assert.equal(counters.maxConcurrentStatus, 1);
  await secondTab.close();
  const statusBeforeForeground = counters.status;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(300);
  assert.ok(counters.status > statusBeforeForeground, 'Foreground activity should check Sync again');
  results.cases.multiTabAndForeground = { status: 'PASS', simultaneousWorkerChecks, maxConcurrentStatusRequests: counters.maxConcurrentStatus, foregroundWake: true };

  const noteId = local.notes[0].id;
  await page.goto(`${origin}/notes/${encodeURIComponent(noteId)}`, { waitUntil: 'domcontentloaded' });
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.waitFor();
  await editor.fill('PWA SYNTHETIC NOTE MARKER 7d1e\nEDITED OFFLINE');
  await page.waitForTimeout(1200);
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1000)));
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  try { await page.locator('[contenteditable="true"]').filter({ hasText: 'EDITED OFFLINE' }).waitFor({ timeout: 10000 }); }
  catch (error) { console.error('Offline note detail diagnostic:', await page.locator('body').innerText().catch(() => ''), await page.url()); throw error; }
  const cacheAudit = await page.evaluate(async () => {
    const names = await caches.keys(), entries = [];
    for (const name of names) { const cache = await caches.open(name); for (const request of await cache.keys()) { const response = await cache.match(request); entries.push({ url: request.url, body: await response.clone().text() }); } }
    return { names, entryCount: entries.length, syncApi: entries.filter(entry => new URL(entry.url).pathname.startsWith('/api/v1/sync/')).length, noteMarker: entries.some(entry => entry.body.includes('PWA SYNTHETIC NOTE MARKER 7d1e')) };
  });
  assert.equal(cacheAudit.syncApi, 0); assert.equal(cacheAudit.noteMarker, false);
  assert.ok(cacheAudit.entryCount > 0);
  results.cases.offlineReloadAndCacheIsolation = { status: 'PASS', offlineDetailEditReload: true, cachedEntries: cacheAudit.entryCount, syncApiCached: cacheAudit.syncApi, privateNoteMarkerCached: cacheAudit.noteMarker };
  await context.close();
} finally { await browser.close(); }

const webkitBrowser = await webkit.launch();
try {
  const context = await webkitBrowser.newContext({ serviceWorkers: 'allow', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto(`${origin}/pwa-guide`, { waitUntil: 'networkidle' });
  await page.getByText(/Safari and the installed Home Screen app can keep separate local notes/).waitFor();
  results.cases.webkitTransitionGuide = { status: 'PASS', browser: `WebKit ${webkitBrowser.version()}`, physicalIPhone: false };
  await context.close();
} finally { await webkitBrowser.close(); }

results.counters = counters;
results.actualIPhoneTest = false;
await writeFile(`${evidenceDir}/browser-results.json`, `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify(results, null, 2));
