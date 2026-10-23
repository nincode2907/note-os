import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:https';
import http from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url), root = fileURLToPath(new URL('../../../../../', import.meta.url));
const { chromium } = require(require.resolve('playwright', { paths: [process.env.NOTEOS_PLAYWRIGHT_ROOT ?? `${root}/../ui-lens`] }));
const container = process.env.NOTEOS_SYNC_CONTAINER ?? 'noteos-phase082a1-synthetic-web';
const httpOrigin = process.env.NOTEOS_SYNC_HTTP_ORIGIN ?? 'http://127.0.0.1:15742';
const httpPort = Number(new URL(httpOrigin).port);
const origin = process.env.NOTEOS_SYNC_ORIGIN ?? `https://localhost:${httpPort + 1}`;
const httpsPort = Number(new URL(origin).port);
const compose = process.env.NOTEOS_SYNC_COMPOSE ?? 'docker-compose.phase082a1-test.yml';
const evidence = process.env.NOTEOS_SYNC_EVIDENCE ?? `${root}/artifacts/review/noteOS-Phase08.2A.1-Sync-Reliability-review/evidence`;
const run = async args => (await promisify(execFile)('docker', args, { maxBuffer: 1024 * 1024 })).stdout.trim();
const fixture = async action => run(['exec', container, 'node', '/verification/fixture.mjs', action]);
const sleep = ms => delay(ms);
const waitFor = async fn => { for (let i = 0; i < 240; i++) { const value = await fn(); if (value) return value; await sleep(250); } throw new Error('Timed out waiting for browser sync reliability state'); };
const stateOf = page => page.evaluate(async () => {
  const open = indexedDB.open('noteos-mvp-01'), db = await new Promise((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
  const names = ['notes', 'syncOutbox', 'syncState', 'syncBaselines', 'syncQuarantine'];
  const tx = db.transaction(names, 'readonly');
  const result = await Promise.all(names.map(name => new Promise((resolve, reject) => { const request = tx.objectStore(name).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); })));
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error); });
  db.close(); return Object.fromEntries(names.map((name, index) => [name, result[index]]));
});
async function seedQueue(page, id, titlePrefix) {
  await page.evaluate(({ id, titlePrefix }) => new Promise((resolve, reject) => {
    const canonicalText = value => Array.isArray(value) ? `[${value.map(canonicalText).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalText(value[key])}`).join(',')}}` : JSON.stringify(value);
    const open = indexedDB.open('noteos-mvp-01');
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction(['notes', 'syncOutbox', 'syncEnrollment'], 'readwrite'), now = Date.now();
      const note = { id, title: `${titlePrefix} 0`, document: { schemaVersion: 1, type: 'doc', content: [] }, schemaVersion: 1, createdAt: now, updatedAt: now, lifecycle: 'active', revision: 0, pinned: false, tags: [], privacy: 'PRIVATE_SERVER' };
      tx.objectStore('notes').put(note); tx.objectStore('syncEnrollment').put({ id, optedIn: true, updatedAt: now });
      for (let index = 1; index <= 150; index++) {
        const record = { ...note, title: `${titlePrefix} ${index}`, revision: index, updatedAt: now + index };
        const operationId = `reliability-${id}-${String(index).padStart(3, '0')}`;
        tx.objectStore('syncOutbox').put({ operationId, entityId: id, localRevision: index, baseServerVersion: 0, ownerApproved: true, type: 'upsert', recordJson: canonicalText(record), createdAt: now + index });
      }
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = tx.onerror = () => reject(tx.error);
    };
    open.onerror = () => reject(open.error);
  }), { id, titlePrefix });
}
async function countServer() { return JSON.parse(await fixture('state')); }

await mkdir(evidence, { recursive: true });
const tlsDir = await mkdtemp(`${tmpdir()}/noteos-phase082a1-tls-`), key = `${tlsDir}/key.pem`, cert = `${tlsDir}/cert.pem`;
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
const proxy = createServer({ key: await readFile(key), cert: await readFile(cert) }, (req, res) => {
  const target = http.request({ hostname: '127.0.0.1', port: httpPort, path: req.url, method: req.method, headers: { ...req.headers, 'x-forwarded-host': req.headers.host, 'x-forwarded-proto': 'https', 'x-forwarded-port': String(httpsPort) } }, upstream => { res.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(res); });
  target.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(target);
});
await new Promise((resolve, reject) => proxy.once('error', reject).listen(httpsPort, '127.0.0.1', resolve));
const browser = await chromium.launch();
try {
  await fixture('init');
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  context.setDefaultTimeout(30000);
  const page = await context.newPage();
  await page.goto(`${origin}/icon.svg`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase('noteos-mvp-01'); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error('A previous synthetic IndexedDB connection remains open.')); }));
  await page.goto(`${origin}/sync`, { waitUntil: 'domcontentloaded' });
  await page.getByText('This browser is not paired.', { exact: true }).waitFor();
  const code = await fixture('pair');
  await page.getByLabel('Device label', { exact: true }).fill('Reliability synthetic browser');
  await page.getByLabel('Pairing code', { exact: true }).fill(code);
  await page.getByRole('button', { name: 'Pair this browser', exact: true }).click();
  await page.getByText('This browser is paired. Sync is available after you approve notes.', { exact: true }).waitFor();

  const beforePartialQueue = await countServer();
  const partialQueueId = `partial-queue-${randomUUID()}`;
  await seedQueue(page, partialQueueId, 'Partial queue revision');
  let firstPushes = 0;
  const abortAt101 = async route => { firstPushes++; if (firstPushes === 101) return route.abort('failed'); return route.continue(); };
  await context.route('**/api/v1/sync/push', abortAt101);
  await page.evaluate(() => window.dispatchEvent(new Event('noteos:local-note-commit')));
  await waitFor(() => Promise.resolve(firstPushes >= 101));
  await page.locator('.sync-worker-state').filter({ hasText: 'Sync · Pending' }).waitFor();
  let local = await stateOf(page);
  console.log('Partial queue after injected outage:', JSON.stringify({ firstPushes, outbox: local.syncOutbox.length, quarantine: local.syncQuarantine.length, status: await page.locator('body').innerText().then(text => text.includes('Pending')) }));
  assert.equal(local.syncOutbox.length, 50, 'first 100 ACKs must leave 50 operations pending');
  assert.equal(local.syncOutbox[0].operationId, `reliability-${partialQueueId}-101`);
  assert.ok(firstPushes >= 101);
  const partialEvidence = { status: 'PASS', pushesBeforeOutage: firstPushes, acknowledged: 100, pending: local.syncOutbox.length, workerLabel: await page.locator('.sync-worker-state').textContent() };
  await page.screenshot({ path: `${evidence}/pending-after-100-acks.png`, fullPage: true });
  await context.unroute('**/api/v1/sync/push', abortAt101);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitFor(async () => (await stateOf(page)).syncOutbox.length === 0);
  let server = await countServer();
  assert.equal(server.noteCount - beforePartialQueue.noteCount, 1); assert.equal(server.operationCount - beforePartialQueue.operationCount, 150); assert.equal(server.eventCount - beforePartialQueue.eventCount, 150);
  const recoveredEvidence = { status: 'PASS', remainingAfterReload: 0, serverOperationDelta: server.operationCount - beforePartialQueue.operationCount, serverEventDelta: server.eventCount - beforePartialQueue.eventCount };

  const lostAckQueueId = `lost-ack-queue-${randomUUID()}`;
  await seedQueue(page, lostAckQueueId, 'Lost ACK revision');
  const beforeLostAck = await countServer(); let lostAckId = '';
  const dropLaterAck = async route => {
    const body = route.request().postDataJSON(), operation = body?.operations?.[0];
    const record = operation ? JSON.parse(operation.recordJson) : null;
    if (record?.revision === 125 && operation.entityId === lostAckQueueId) { lostAckId = operation.operationId; await route.fetch(); return route.abort('failed'); }
    return route.continue();
  };
  await context.route('**/api/v1/sync/push', dropLaterAck);
  await page.evaluate(() => window.dispatchEvent(new Event('noteos:local-note-commit')));
  await page.locator('.sync-worker-state').filter({ hasText: 'Sync · Pending' }).waitFor();
  local = await stateOf(page);
  assert.equal(local.syncOutbox.length, 26); assert.equal(lostAckId, `reliability-${lostAckQueueId}-125`);
  await context.unroute('**/api/v1/sync/push', dropLaterAck);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitFor(async () => (await stateOf(page)).syncOutbox.length === 0);
  server = await countServer();
  assert.equal(server.operationCount - beforeLostAck.operationCount, 150);
  assert.equal(server.eventCount - beforeLostAck.eventCount, 150);
  const lostAckEvidence = { status: 'PASS', operationId: lostAckId, localRetries: 1, serverOperationDelta: 150, serverEventDelta: 150 };

  const report = { status: 'PASS', environment: { browser: browser.version(), origin, syntheticDatabase: 'isolated Docker SQLite volume', profile: 'disposable Playwright Chromium context' }, scenarios: { firstHundredAcknowledgedThenOutage: partialEvidence, reloadRecovery: recoveredEvidence, lostAckReplay: lostAckEvidence }, actualIPhoneTest: false };
  await writeFile(`${evidence}/reliability-browser.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  await context.close();
} finally {
  await browser.close(); await new Promise(resolve => proxy.close(resolve)); await rm(tlsDir, { recursive: true, force: true });
}
