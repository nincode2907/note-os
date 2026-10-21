import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const lens = process.env.NOTEOS_PLAYWRIGHT_ROOT ?? `${root}/../ui-lens`;
const { chromium } = require(require.resolve('playwright', { paths: [lens] }));
const { capture, newRun } = await import(pathToFileURL(`${lens}/apps/service/src/runner.ts`));
const { configSchema } = await import(pathToFileURL(`${lens}/packages/contracts/src/index.ts`));
const baseUrl = process.env.NOTEOS_TEST_URL ?? 'http://127.0.0.1:3000';
const config = configSchema.parse({
  version: 1,
  project: 'noteOS MVP-03 Organization',
  baseUrl,
  outputDir: 'artifacts/review/noteOS-MVP-03-review/ui-lens',
  viewports: { desktop: { width: 1440, height: 1000 }, mobile: { width: 390, height: 844 } },
  targets: [
    { id: 'home-pinned', name: 'Notes Home with pinned and tagged notes', route: '/', viewports: ['desktop'], actions: [{ type: 'waitFor', selector: '.note-card' }] },
    { id: 'editor-checklist', name: 'Editor with Unicode checklist', route: '/notes/lens-checklist', viewports: ['desktop', 'mobile'], actions: [{ type: 'waitFor', selector: '.editor-content li[data-checked]' }] },
    { id: 'tags-filtered', name: 'Notes filtered by shared tag', route: '/', viewports: ['desktop'], actions: [{ type: 'waitFor', selector: '.tag-filter' }, { type: 'click', selector: '.tag-filter' }] },
    { id: 'home-filtered-empty', name: 'Useful empty search state', route: '/', viewports: ['desktop'], actions: [{ type: 'fill', selector: '#note-search', value: 'no-match-mvp03' }, { type: 'waitFor', selector: 'text=No notes match these filters' }] },
    { id: 'mobile-navigation', name: 'Mobile navigation at 390px', route: '/', viewports: ['mobile'], actions: [{ type: 'waitFor', selector: '.mobile-nav' }] },
  ],
});

const launch = chromium.launch.bind(chromium);
chromium.launch = async (options = {}) => {
  const browser = await launch(options);
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (contextOptions) => {
    const context = await newContext(contextOptions);
    const newPage = context.newPage.bind(context);
    context.newPage = async () => {
      const page = await newPage();
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await page.evaluate(async () => {
        const now = Date.now();
        const notes = [
          {
            id: 'lens-checklist', title: 'Pinned checklist — ghi chú 東京 🌿',
            document: { schemaVersion: 1, type: 'doc', content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'Kế hoạch tuần này — 今週の予定 ✨' }] },
              { type: 'taskList', content: [
                { type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Viết ghi chú' }] }] },
                { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '東京を訪れる 🗒️' }] }] },
              ] },
            ] }, schemaVersion: 1, createdAt: now - 2000, updatedAt: now, lifecycle: 'active', revision: 1, pinned: true, tags: ['Tiếng Việt', '東京'],
          },
          {
            id: 'lens-ordinary', title: 'Một ý tưởng khác',
            document: { schemaVersion: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A note for shared tag filtering.' }] }] },
            schemaVersion: 1, createdAt: now - 1000, updatedAt: now - 1000, lifecycle: 'active', revision: 1, pinned: false, tags: ['Tiếng Việt'],
          },
        ];
        await new Promise((resolve, reject) => {
          const request = indexedDB.open('noteos-mvp-01', 2);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result, tx = db.transaction('notes', 'readwrite'), store = tx.objectStore('notes');
            for (const note of notes) store.put(note);
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => reject(tx.error);
          };
        });
      });
      return page;
    };
    return context;
  };
  return browser;
};

try {
  const run = newRun('noteos-mvp03');
  const targets = process.env.NOTEOS_UI_TARGETS?.split(',') ?? config.targets.map((target) => target.id);
  await capture({ id: 'noteos-mvp03', root, config }, { projectId: 'noteos-mvp03', targets, artifacts: { png: true, pdf: false, diagnostics: true } }, run);
  process.stdout.write(`${JSON.stringify({ state: run.state, outputPath: run.outputPath, summary: run.manifest.summary }, null, 2)}\n`);
  if (run.manifest.summary.failed) process.exitCode = 1;
} finally { chromium.launch = launch; }
