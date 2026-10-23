import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const { chromium } = require(require.resolve('playwright', { paths: [resolve(root, '../ui-lens')] }));
const evidence = process.env.NOTEOS_SYNC_EVIDENCE ?? `${root}/artifacts/review/noteOS-Phase08.2A-Web-Sync-Engine-review/evidence`;
const httpOrigin = process.env.NOTEOS_SYNC_HTTP_ORIGIN ?? 'http://127.0.0.1:15742';
const httpPort = Number(new URL(httpOrigin).port);
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const openOrigin = async url => { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForFunction(() => document.readyState === 'interactive' || document.readyState === 'complete'); };
  const countSynthetic = async (seed = false) => page.evaluate(async shouldSeed => {
    const request = indexedDB.open('noteos-mvp-01');
    request.onupgradeneeded = () => { const db = request.result; if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' }); };
    const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const tx = db.transaction('notes', shouldSeed ? 'readwrite' : 'readonly');
    const store = tx.objectStore('notes');
    if (shouldSeed) store.put({ id: 'synthetic-origin-isolation-check', title: 'Synthetic origin isolation check' });
    const count = await new Promise((resolve, reject) => { const result = store.count(); result.onsuccess = () => resolve(result.result); result.onerror = () => reject(result.error); });
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error); });
    db.close(); return count;
  }, seed);
  await openOrigin(`${httpOrigin}/icon.svg`);
  await page.evaluate(() => new Promise((resolve,reject) => { const request=indexedDB.deleteDatabase('noteos-mvp-01');request.onsuccess=resolve;request.onerror=()=>reject(request.error);request.onblocked=()=>reject(new Error('Previous synthetic browser profile is still open')); }));
  await openOrigin(`${httpOrigin}/`);
  const firstCount = await countSynthetic(true);
  await openOrigin(`http://localhost:${httpPort}/`);
  const secondCount = await countSynthetic(false);
  if (firstCount < 1 || secondCount !== 0) throw new Error(`Origin storage leaked or seed missing (first=${firstCount}, second=${secondCount}).`);
  await openOrigin(`${httpOrigin}/`);
  const firstCountAfterReturn = await countSynthetic(false);
  if (firstCountAfterReturn !== firstCount) throw new Error('First-origin record did not remain isolated and durable.');
  const result = { result: 'PASS', origins: [httpOrigin, `http://localhost:${httpPort}`], firstOriginCount: firstCount, secondOriginCount: secondCount, firstOriginAfterReturn: firstCountAfterReturn, syntheticOnly: true };
  await writeFile(`${evidence}/origin-isolation.json`, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
