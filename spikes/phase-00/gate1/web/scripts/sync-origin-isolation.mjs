import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const { chromium } = require(require.resolve('playwright', { paths: [resolve(root, '../ui-lens')] }));
const evidence = process.env.NOTEOS_SYNC_EVIDENCE ?? `${root}/artifacts/review/noteOS-Phase08.2A-Web-Sync-Engine-review/evidence`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const openOrigin = async url => page.goto(url, { waitUntil: 'commit', timeout: 60000 });
  const countSynthetic = async (seed = false) => page.evaluate(async shouldSeed => {
    const request = indexedDB.open('noteos-mvp-01', 3);
    request.onupgradeneeded = () => { const db = request.result; if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' }); };
    const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const tx = db.transaction('notes', shouldSeed ? 'readwrite' : 'readonly');
    const store = tx.objectStore('notes');
    if (shouldSeed) store.put({ id: 'synthetic-origin-isolation-check', title: 'Synthetic origin isolation check' });
    const count = await new Promise((resolve, reject) => { const result = store.count(); result.onsuccess = () => resolve(result.result); result.onerror = () => reject(result.error); });
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error); });
    db.close(); return count;
  }, seed);
  await openOrigin('http://127.0.0.1:15740/');
  const firstCount = await countSynthetic(true);
  await openOrigin('http://localhost:15740/');
  const secondCount = await countSynthetic(false);
  if (firstCount < 1 || secondCount !== 0) throw new Error(`Origin storage leaked or seed missing (first=${firstCount}, second=${secondCount}).`);
  await openOrigin('http://127.0.0.1:15740/');
  const firstCountAfterReturn = await countSynthetic(false);
  if (firstCountAfterReturn !== firstCount) throw new Error('First-origin record did not remain isolated and durable.');
  const result = { result: 'PASS', origins: ['http://127.0.0.1:15740', 'http://localhost:15740'], firstOriginCount: firstCount, secondOriginCount: secondCount, firstOriginAfterReturn: firstCountAfterReturn, syntheticOnly: true };
  await writeFile(`${evidence}/origin-isolation.json`, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
