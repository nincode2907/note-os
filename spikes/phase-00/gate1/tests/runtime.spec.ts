import { test, expect, request, type Page } from '@playwright/test';
import fixture from '../fixtures/notes.json';

const api = process.env.API_URL!;
const artifactDir = process.env.ARTIFACTS_DIR ?? '/artifacts';
const canonical = (text: string) => JSON.stringify({ schemaVersion: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();

test.beforeAll(async () => {
  const client = await request.newContext({ baseURL: api });
  const existing = await client.get('/api/gate1/server-state');
  const state = await existing.json();
  if (state.length < fixture.length) {
    const created = fixture.map((row, index) => ({ id: row.id, title: row.title, body: canonical(row.text), privacy: 'PRIVATE_SERVER', dataset_id: 'phase00-gate1-v1', revision: index + 1, deleted: false }));
    const response = await client.post('/api/sync', { data: { changes: { notes: { created, updated: [], deleted: [] } }, lastPulledAt: 0 } });
    expect(response.status()).toBe(204);
  }
  await client.dispose();
});

async function waitForCount(page: Page, count: number) {
  await expect(page.getByTestId('row-count')).toHaveText(String(count));
}

for (const candidate of ['powersync', 'watermelon']) {
  test(`${candidate}: production browser persistence, privacy and multilingual offline query`, async ({ page, context, browserName }) => {
    const pageErrors: string[] = [];
    const failedRequests: string[] = [];
    const uploadPayloads: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('requestfailed', request => failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`));
    page.on('request', request => {
      if (request.url().includes('/api/sync') || request.url().includes('/api/delta/push')) uploadPayloads.push(request.postData() ?? '');
    });
    await page.goto(`/${candidate}`);
    await page.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; });
    await page.reload();
    await page.waitForFunction(() => !!navigator.serviceWorker?.controller, { timeout: 30_000 });
    if (candidate === 'powersync') {
      await page.waitForTimeout(5_000);
      console.log('PowerSync browser database diagnostic', await page.evaluate(async () => {
        const db = (window as any).__gate1Db;
        return { status: db?.currentStatus, tables: await db?.getAll("SELECT name FROM sqlite_master WHERE type='table'"), rows: await db?.getAll('SELECT * FROM notes') };
      }));
    }
    await waitForCount(page, 20);

    const fixtureRows = await page.locator('[data-testid="notes"] li[data-note-id]').evaluateAll(nodes => nodes.map(node => ({ id: node.getAttribute('data-note-id'), body: JSON.parse(node.querySelector('code')?.textContent ?? '{}') })));
    expect(fixtureRows).toHaveLength(20);
    for (const row of fixtureRows) {
      const fixtureRow = fixture.find(item => item.id === row.id);
      if (fixtureRow) expect(row.body).toEqual(JSON.parse(canonical(fixtureRow.text)));
    }
    const browserStorage = await page.evaluate(async () => ({ indexedDB: !!window.indexedDB, databases: await indexedDB.databases().then(rows => rows.map(row => row.name)), controlled: !!navigator.serviceWorker.controller }));
    expect(browserStorage.indexedDB).toBe(true);
    expect(browserStorage.databases.length).toBeGreaterThan(0);
    await page.screenshot({ path: `${artifactDir}/${candidate}-${browserName}-online.png`, fullPage: true });

    await context.setOffline(true);
    await page.getByLabel('Title').fill(`offline-private-${candidate}`);
    await page.getByLabel('Text').fill('Offline Tiếng Việt 日本語 かな 検索');
    await page.getByRole('button', { name: 'Create note' }).click();
    await page.getByLabel('Privacy').selectOption('DEVICE_ONLY');
    await page.getByLabel('Title').fill(`device-only-${candidate}`);
    await page.getByLabel('Text').fill('DEVICE_ONLY local only');
    await page.getByRole('button', { name: 'Create note' }).click();
    await expect(page.locator('[data-testid="notes"]')).toContainText(`device-only-${candidate}`);
    await page.reload();
    await expect(page.locator('[data-testid="notes"]')).toContainText(`offline-private-${candidate}`);
    await expect(page.locator('[data-testid="notes"]')).toContainText(`device-only-${candidate}`);

    for (const term of ['Tiếng Việt', 'tieng viet', 'English', 'かな', '漢字']) {
      await page.getByLabel('Search').fill(term);
      await expect(page.getByTestId('search-count')).toHaveText(/^[1-9]\d*$/);
    }
    await page.getByLabel('Search').fill('');
    await page.screenshot({ path: `${artifactDir}/${candidate}-${browserName}-offline.png`, fullPage: true });
    expect(pageErrors, `uncaught browser errors: ${pageErrors.join('; ')}`).toEqual([]);

    await context.setOffline(false);
    await page.getByRole('button', { name: 'Sync' }).click();
    await expect.poll(async () => {
      const state = await (await page.request.get(`${api}/api/gate1/server-state`)).json();
      return state.filter((row: any) => row.title === `offline-private-${candidate}`).length;
    }, { timeout: 30_000 }).toBe(1);
    const serverState = await (await page.request.get(`${api}/api/gate1/server-state`)).json();
    expect(serverState.some((row: any) => row.title === `device-only-${candidate}`)).toBe(false);
    const deviceNoteId = await page.locator(`[data-testid="notes"] li`).filter({ hasText: `device-only-${candidate}` }).getAttribute('data-note-id');
    expect(uploadPayloads.join('\n')).not.toContain(deviceNoteId);
    expect(failedRequests.filter(item => !item.includes('ERR_INTERNET_DISCONNECTED'))).toEqual([]);
  });
}
