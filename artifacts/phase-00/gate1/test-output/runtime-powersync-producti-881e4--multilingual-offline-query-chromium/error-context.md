# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: runtime.spec.ts >> powersync: production browser persistence, privacy and multilingual offline query
- Location: gate1/tests/runtime.spec.ts:26:7

# Error details

```
Error: expect(locator).toHaveText(expected) failed

Locator:  getByTestId('row-count')
Expected: "20"
Received: "0"
Timeout:  30000ms

Call log:
  - Expect "toHaveText" getByTestId('row-count') with timeout 30000ms
  - waiting for getByTestId('row-count')
    61 × locator resolved to <span data-testid="row-count">0</span>
       - unexpected value "0"

```

```yaml
- text: "0"
```

# Test source

```ts
  1  | import { test, expect, request, type Page } from '@playwright/test';
  2  | import fixture from '../fixtures/notes.json';
  3  | 
  4  | const api = process.env.API_URL!;
  5  | const artifactDir = process.env.ARTIFACTS_DIR ?? '/artifacts';
  6  | const canonical = (text: string) => JSON.stringify({ schemaVersion: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
  7  | const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
  8  | 
  9  | test.beforeAll(async () => {
  10 |   const client = await request.newContext({ baseURL: api });
  11 |   const existing = await client.get('/api/gate1/server-state');
  12 |   const state = await existing.json();
  13 |   if (state.length < fixture.length) {
  14 |     const created = fixture.map((row, index) => ({ id: row.id, title: row.title, body: canonical(row.text), privacy: 'PRIVATE_SERVER', dataset_id: 'phase00-gate1-v1', revision: index + 1, deleted: false }));
  15 |     const response = await client.post('/api/sync', { data: { changes: { notes: { created, updated: [], deleted: [] } }, lastPulledAt: 0 } });
  16 |     expect(response.status()).toBe(204);
  17 |   }
  18 |   await client.dispose();
  19 | });
  20 | 
  21 | async function waitForCount(page: Page, count: number) {
> 22 |   await expect(page.getByTestId('row-count')).toHaveText(String(count));
     |                                               ^ Error: expect(locator).toHaveText(expected) failed
  23 | }
  24 | 
  25 | for (const candidate of ['powersync', 'watermelon']) {
  26 |   test(`${candidate}: production browser persistence, privacy and multilingual offline query`, async ({ page, context, browserName }) => {
  27 |     const pageErrors: string[] = [];
  28 |     const failedRequests: string[] = [];
  29 |     const uploadPayloads: string[] = [];
  30 |     page.on('pageerror', error => pageErrors.push(error.message));
  31 |     page.on('requestfailed', request => failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`));
  32 |     page.on('request', request => {
  33 |       if (request.url().includes('/api/sync') || request.url().includes('/api/delta/push')) uploadPayloads.push(request.postData() ?? '');
  34 |     });
  35 |     await page.goto(`/${candidate}`);
  36 |     await page.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; });
  37 |     await page.reload();
  38 |     await page.waitForFunction(() => !!navigator.serviceWorker?.controller, { timeout: 30_000 });
  39 |     await waitForCount(page, 20);
  40 | 
  41 |     const fixtureRows = await page.locator('[data-testid="notes"] li[data-note-id]').evaluateAll(nodes => nodes.map(node => ({ id: node.getAttribute('data-note-id'), body: JSON.parse(node.querySelector('code')?.textContent ?? '{}') })));
  42 |     expect(fixtureRows).toHaveLength(20);
  43 |     for (const row of fixtureRows) {
  44 |       const fixtureRow = fixture.find(item => item.id === row.id);
  45 |       if (fixtureRow) expect(row.body).toEqual(JSON.parse(canonical(fixtureRow.text)));
  46 |     }
  47 |     const browserStorage = await page.evaluate(async () => ({ indexedDB: !!window.indexedDB, databases: await indexedDB.databases().then(rows => rows.map(row => row.name)), controlled: !!navigator.serviceWorker.controller }));
  48 |     expect(browserStorage.indexedDB).toBe(true);
  49 |     expect(browserStorage.databases.length).toBeGreaterThan(0);
  50 |     await page.screenshot({ path: `${artifactDir}/${candidate}-${browserName}-online.png`, fullPage: true });
  51 | 
  52 |     await context.setOffline(true);
  53 |     await page.getByLabel('Title').fill(`offline-private-${candidate}`);
  54 |     await page.getByLabel('Text').fill('Offline Tiếng Việt 日本語 かな 検索');
  55 |     await page.getByRole('button', { name: 'Create note' }).click();
  56 |     await page.getByLabel('Privacy').selectOption('DEVICE_ONLY');
  57 |     await page.getByLabel('Title').fill(`device-only-${candidate}`);
  58 |     await page.getByLabel('Text').fill('DEVICE_ONLY local only');
  59 |     await page.getByRole('button', { name: 'Create note' }).click();
  60 |     await expect(page.locator('[data-testid="notes"]')).toContainText(`device-only-${candidate}`);
  61 |     await page.reload();
  62 |     await expect(page.locator('[data-testid="notes"]')).toContainText(`offline-private-${candidate}`);
  63 |     await expect(page.locator('[data-testid="notes"]')).toContainText(`device-only-${candidate}`);
  64 | 
  65 |     for (const term of ['Tiếng Việt', 'tieng viet', 'English', 'かな', '漢字']) {
  66 |       await page.getByLabel('Search').fill(term);
  67 |       await expect(page.getByTestId('search-count')).toHaveText(/^[1-9]\d*$/);
  68 |     }
  69 |     await page.getByLabel('Search').fill('');
  70 |     await page.screenshot({ path: `${artifactDir}/${candidate}-${browserName}-offline.png`, fullPage: true });
  71 |     expect(pageErrors, `uncaught browser errors: ${pageErrors.join('; ')}`).toEqual([]);
  72 | 
  73 |     await context.setOffline(false);
  74 |     await page.getByRole('button', { name: 'Sync' }).click();
  75 |     await expect.poll(async () => {
  76 |       const state = await (await page.request.get(`${api}/api/gate1/server-state`)).json();
  77 |       return state.filter((row: any) => row.title === `offline-private-${candidate}`).length;
  78 |     }, { timeout: 30_000 }).toBe(1);
  79 |     const serverState = await (await page.request.get(`${api}/api/gate1/server-state`)).json();
  80 |     expect(serverState.some((row: any) => row.title === `device-only-${candidate}`)).toBe(false);
  81 |     const deviceNoteId = await page.locator(`[data-testid="notes"] li`).filter({ hasText: `device-only-${candidate}` }).getAttribute('data-note-id');
  82 |     expect(uploadPayloads.join('\n')).not.toContain(deviceNoteId);
  83 |     expect(failedRequests.filter(item => !item.includes('ERR_INTERNET_DISCONNECTED'))).toEqual([]);
  84 |   });
  85 | }
  86 | 
```