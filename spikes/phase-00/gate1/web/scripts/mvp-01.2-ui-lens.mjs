// Run through the existing sibling UI Lens tsx executable. No UI Lens source is changed.
// The stock config actions cannot seed recovery/storage failures, so this harness
// supplies synthetic context setup and delegates screenshots/diagnostics to its runner.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const lens = process.env.NOTEOS_PLAYWRIGHT_ROOT ?? `${root}/../ui-lens`;
const { chromium } = require(require.resolve('playwright', { paths: [lens] }));
const { capture, newRun } = await import(pathToFileURL(`${lens}/apps/service/src/runner.ts`));
const { configSchema } = await import(pathToFileURL(`${lens}/packages/contracts/src/index.ts`));
const baseUrl = process.env.NOTEOS_TEST_URL ?? 'http://127.0.0.1:3000';
const target = (id, actions) => ({ id, name: `MVP-01.2 ${id}`, route: `/notes/capture-${id}`, viewports: ['desktop', 'mobile'], actions });
const config = configSchema.parse({ version: 1, project: 'noteOS MVP-01.2 Data Safety', baseUrl, outputDir: 'artifacts/ui-review', viewports: { desktop: { width: 1440, height: 1000 }, mobile: { width: 390, height: 844 } }, targets: [
  target('editor', [{ type: 'waitFor', selector: '[contenteditable=true]' }]),
  target('recovery', [{ type: 'waitFor', selector: '[role=dialog]' }]),
  target('save-error', [{ type: 'fill', selector: '#note-title', value: 'Unsaved title — synthetic' }, { type: 'fill', selector: '[contenteditable=true]', value: 'Unsaved body remains on screen.' }, { type: 'waitFor', selector: '.save-state:has-text("Not saved")' }]),
  target('navigation', [{ type: 'fill', selector: '[contenteditable=true]', value: 'Immediate navigation content — saved before leaving.' }, { type: 'click', selector: 'a.back-link' }, { type: 'waitFor', selector: '.note-card:has-text("Immediate navigation content")' }]),
] });
const launch = chromium.launch.bind(chromium);
const selected = process.env.NOTEOS_UI_TARGETS?.split(',') ?? config.targets.map(t => t.id);
const modes = selected.flatMap(id => [id, id]);
let contextIndex = 0;
chromium.launch = async options => {
  const browser = await launch(options), newContext = browser.newContext.bind(browser);
  browser.newContext = async options => {
    const context = await newContext(options), mode = modes[contextIndex++], newPage = context.newPage.bind(context);
    await context.route('**/*', route => new URL(route.request().url()).origin === baseUrl ? route.continue() : route.abort());
    if (mode === 'save-error') await context.addInitScript(() => { const put = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function(value, ...args) { if (value?.id === 'capture-save-error') throw new DOMException('Injected capture write failure', 'UnknownError'); return put.call(this, value, ...args); }; });
    context.newPage = async () => {
      const page = await newPage(); await page.goto(baseUrl);
      await page.evaluate(async mode => {
        const now = Date.now(), id = `capture-${mode}`, document = { schemaVersion: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Old body — synthetic acceptance data.' }] }] };
        const note = { id, title: 'Data safety note — synthetic', document, schemaVersion: 1, lifecycle: 'active', revision: 1, createdAt: now, updatedAt: now };
        await new Promise((resolve, reject) => { const req = indexedDB.open('noteos-mvp-01', 1); req.onupgradeneeded = () => { const store = req.result.createObjectStore('notes', { keyPath: 'id' }); store.createIndex('lifecycle', 'lifecycle'); store.createIndex('updatedAt', 'updatedAt'); }; req.onerror = () => reject(req.error); req.onsuccess = () => { const db = req.result, tx = db.transaction('notes', 'readwrite'); tx.objectStore('notes').add(note); tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error); }; });
        if (mode === 'recovery') localStorage.setItem(`noteos:mvp01:recovery:${id}`, JSON.stringify({ title: 'Recovered title — synthetic', document: { schemaVersion: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Recovered body — waiting for a safe restore.' }] }] }, baseRevision: 1, updatedAt: now }));
      }, mode);
      return page;
    };
    return context;
  };
  return browser;
};
try {
  const run = newRun('noteos');
  await capture({ id: 'noteos', root, config }, { projectId: 'noteos', targets: selected, artifacts: { png: true, pdf: false, diagnostics: true } }, run);
  console.log(JSON.stringify({ state: run.state, outputPath: run.outputPath, summary: run.manifest.summary }, null, 2));
  await writeFile(`/tmp/noteos-mvp012-evidence/ui-lens-${selected.join('-')}.json`, JSON.stringify(run, null, 2));
  if (run.manifest.summary.failed) process.exitCode = 1;
} finally { chromium.launch = launch; }
