// UI Pass 01 visual evidence through the existing sibling UI Lens runner.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const lens = process.env.NOTEOS_PLAYWRIGHT_ROOT ?? `${root}/../ui-lens`;
const { chromium } = require(require.resolve('playwright', { paths: [lens] }));
const { capture, newRun } = await import(pathToFileURL(`${lens}/apps/service/src/runner.ts`));
const { configSchema } = await import(pathToFileURL(`${lens}/packages/contracts/src/index.ts`));
const baseUrl = process.env.NOTEOS_TEST_URL ?? 'http://noteos.localhost';
const viewports = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1440, height: 900 },
};
const all = Object.keys(viewports);
const config = configSchema.parse({
  version: 1,
  project: 'noteOS UI Implementation Pass 01',
  baseUrl,
  outputDir: 'artifacts/review/noteOS-UI-Pass-01-review/ui-lens',
  capture: { reducedMotion: true, timeoutMs: 15000 },
  viewports,
  targets: [
    { id: 'home', name: 'Home with local sample notes', route: '/', viewports: all, actions: [{ type: 'waitFor', selector: '.note-card:first-child' }] },
    { id: 'editor', name: 'Editor with tags and checklist', route: '/notes/ui-pass-editor', viewports: all, actions: [{ type: 'waitFor', selector: '.editor-content' }] },
    { id: 'audio-expanded', name: 'Expanded local audio panel', route: '/notes/ui-pass-audio', viewports: ['mobile', 'desktop'], actions: [{ type: 'waitFor', selector: '.audio-panel-content:not([hidden])' }] },
    { id: 'audio-recording', name: 'Active recording controls with fake audio input', route: '/notes/ui-pass-recording', viewports: ['mobile', 'desktop'], actions: [{ type: 'click', selector: '.audio-controls button:has-text("Record audio")' }, { type: 'waitFor', selector: '.recording-indicator' }] },
    { id: 'archive', name: 'Archive with restore action', route: '/archive', viewports: all, actions: [{ type: 'waitFor', selector: '.note-card' }] },
    { id: 'trash', name: 'Trash with restore and delete controls', route: '/trash', viewports: all, actions: [{ type: 'waitFor', selector: '.note-card' }] },
    { id: 'backup', name: 'Backup and restore', route: '/backup', viewports: all, actions: [{ type: 'waitFor', selector: '.backup-panel:first-of-type' }] },
    { id: 'recovery', name: 'Recovery draft safety dialog', route: '/notes/ui-pass-recovery', viewports: ['mobile', 'desktop'], actions: [{ type: 'waitFor', selector: '[role="dialog"]' }] },
  ],
});

const ids = config.targets.flatMap((target) => target.viewports.map(() => target.id));
const launch = chromium.launch.bind(chromium);
let contextIndex = 0;
chromium.launch = async (options = {}) => {
  const browser = await launch({ ...options, args: [...(options.args ?? []), '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (contextOptions) => {
    const context = await newContext(contextOptions);
    const targetId = ids[contextIndex++];
    await context.grantPermissions(['microphone'], { origin: baseUrl });
    const newPage = context.newPage.bind(context);
    context.newPage = async () => {
      const page = await newPage();
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
        await page.getByRole('heading', { name: 'A fresh page' }).waitFor();
      const now = Date.now();
      const mainDoc = { schemaVersion: 1, type: 'doc', content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'A thought worth keeping, with enough room to finish it.' }] },
        { type: 'taskList', content: [
          { type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Keep the original meaning' }] }] },
          { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Return to this later' }] }] },
        ] },
      ] };
      await page.evaluate(async ({ targetId, now, mainDoc }) => {
        const rows = [
          { id: 'ui-pass-editor', title: 'Field notes — Đà Nẵng', lifecycle: 'active', pinned: true, tags: ['Field notes', 'Vietnam'], document: mainDoc },
          { id: 'ui-pass-audio', title: 'A voice memo', lifecycle: 'active', pinned: false, tags: ['Audio'], document: { schemaVersion: 1, type: 'doc', content: [{ type: 'paragraph' }] } },
          { id: 'ui-pass-recording', title: 'In progress', lifecycle: 'active', pinned: false, tags: [], document: { schemaVersion: 1, type: 'doc', content: [{ type: 'paragraph' }] } },
          { id: 'ui-pass-archive', title: 'A note set aside', lifecycle: 'archived', pinned: false, tags: ['Later'], document: mainDoc },
          { id: 'ui-pass-trash', title: 'A note in Trash', lifecycle: 'trashed', pinned: false, tags: [], document: mainDoc },
          { id: 'ui-pass-recovery', title: 'Saved version', lifecycle: 'active', pinned: false, tags: ['Draft'], document: { schemaVersion: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'The saved version.' }] }] } },
        ].map((row) => ({ ...row, schemaVersion: 1, createdAt: now - 86400000, updatedAt: now, revision: 2 }));
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open('noteos-mvp-01');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve(request.result);
        });
        await new Promise((resolve, reject) => {
          const tx = db.transaction(['notes'], 'readwrite');
          for (const row of rows) tx.objectStore('notes').put(row);
          tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
        });
        db.close();
        const recovery = rows.find((row) => row.id === 'ui-pass-recovery');
        localStorage.setItem(`noteos:mvp01:recovery:${encodeURIComponent(recovery.id)}:ui-pass01`, JSON.stringify({
          version: 2, writerId: 'ui-pass01', generation: 1, baseRevision: 2, recordCreatedAt: recovery.createdAt, deletionEpoch: '',
          title: 'Recovered version', document: { schemaVersion: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'This draft is preserved until you choose.' }] }] }, inFlight: null, updatedAt: now + 1,
        }));
      }, { targetId, now, mainDoc });
      const routes = { home: '/', archive: '/archive', trash: '/trash', backup: '/backup', 'audio-expanded': '/notes/ui-pass-audio', 'audio-recording': '/notes/ui-pass-recording', editor: '/notes/ui-pass-editor', recovery: '/notes/ui-pass-recovery' };
      await page.goto(new URL(routes[targetId], baseUrl).href, { waitUntil: 'domcontentloaded' });
      return page;
    };
    return context;
  };
  return browser;
};

try {
  const run = newRun('noteos-ui-pass-01');
  const selected = process.env.NOTEOS_UI_TARGETS?.split(',') ?? config.targets.map((target) => target.id);
  await capture({ id: 'noteos-ui-pass-01', root, config }, { projectId: 'noteos-ui-pass-01', targets: selected, artifacts: { png: true, pdf: false, diagnostics: true } }, run);
  process.stdout.write(`${JSON.stringify({ state: run.state, outputPath: run.outputPath, summary: run.manifest.summary, packPath: run.packPath }, null, 2)}\n`);
  if (run.manifest.summary.failed) process.exitCode = 1;
} finally { chromium.launch = launch; }
