// Captures only synthetic notes and fake/generated audio through the existing UI Lens runner.
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
const selected = process.env.NOTEOS_UI_TARGETS?.split(',');
const target = (id, actions) => ({ id, name: `noteOS MVP-02 ${id}`, route: `/notes/capture-${id}`, viewports: ['desktop', 'mobile'], actions });
const config = configSchema.parse({ version: 1, project: 'noteOS MVP-02 Local Audio', baseUrl, outputDir: 'artifacts/ui-review', viewports: { desktop: { width: 1440, height: 1000 }, mobile: { width: 390, height: 844 } }, targets: [
  target('audio-idle', [{ type: 'waitFor', selector: '.audio-panel button' }]),
  target('audio-recording', [{ type: 'click', selector: '.audio-controls button' }, { type: 'waitFor', selector: '.recording-indicator' }]),
  target('audio-saved', [{ type: 'click', selector: '.audio-controls button' }, { type: 'wait', ms: 1500 }, { type: 'click', selector: '.audio-controls button.btn-danger' }, { type: 'waitFor', selector: '.recording-state-complete' }]),
  target('audio-playback', [{ type: 'click', selector: '.audio-controls button' }, { type: 'wait', ms: 1500 }, { type: 'click', selector: '.audio-controls button.btn-danger' }, { type: 'waitFor', selector: '.recording-state-complete' }, { type: 'click', selector: '.recording-actions button:first-child' }, { type: 'waitFor', selector: 'audio.recording-player' }]),
  target('audio-permission-error', [{ type: 'click', selector: '.audio-controls button' }, { type: 'waitFor', selector: '.notice.error' }]),
  target('audio-partial-recovery', [{ type: 'waitFor', selector: '.recording-state-interrupted' }]),
] });
const launch = chromium.launch.bind(chromium);
chromium.launch = async (options = {}) => {
  const browser = await launch({ ...options, args: [...(options.args ?? []), '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const newContext = browser.newContext.bind(browser); let index = 0;
  browser.newContext = async (contextOptions) => {
    const context = await newContext({ ...contextOptions, acceptDownloads: true });
    const mode = (selected ?? config.targets.map((item) => item.id)).flatMap((id) => [id, id])[index++];
    await context.route('**/*', (route) => new URL(route.request().url()).origin === baseUrl ? route.continue() : route.abort());
    if (mode === 'audio-permission-error') await context.addInitScript(() => Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => Promise.reject(new DOMException('Permission denied in synthetic UI Lens fixture', 'NotAllowedError')) } }));
    if (['audio-recording', 'audio-playback', 'audio-permission-error'].includes(mode)) await context.grantPermissions(['microphone'], { origin: baseUrl });
    const newPage = context.newPage.bind(context);
    context.newPage = async () => {
      const page = await newPage(); await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: /New note/ }).first().waitFor();
      await page.evaluate(async (captureMode) => {
        const now = Date.now(), id = `capture-${captureMode}`;
        const document = { schemaVersion: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Synthetic note for the local audio review.' }] }] };
        const note = { id, title: `Synthetic ${captureMode}`, document, schemaVersion: 1, lifecycle: 'active', revision: 1, createdAt: now, updatedAt: now };
        await new Promise((resolve, reject) => {
          const request = indexedDB.open('noteos-mvp-01', 2);
          request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('notes')) { const store = db.createObjectStore('notes', { keyPath: 'id' }); store.createIndex('lifecycle', 'lifecycle'); store.createIndex('updatedAt', 'updatedAt'); }
            if (!db.objectStoreNames.contains('recordings')) { const store = db.createObjectStore('recordings', { keyPath: 'id' }); store.createIndex('noteId', 'noteId'); store.createIndex('status', 'status'); store.createIndex('updatedAt', 'updatedAt'); }
            if (!db.objectStoreNames.contains('recordingChunks')) { const store = db.createObjectStore('recordingChunks', { keyPath: 'id' }); store.createIndex('recordingId', 'recordingId'); store.createIndex('recordingSequence', ['recordingId', 'sequence'], { unique: true }); }
          };
          request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error('The app left a database connection at an older version.'));
          request.onsuccess = () => {
            const db = request.result, tx = db.transaction(['notes', 'recordings', 'recordingChunks'], 'readwrite');
            tx.objectStore('notes').add(note);
            if (captureMode === 'audio-partial-recovery') {
              const status = captureMode === 'audio-partial-recovery' ? 'interrupted' : 'complete';
              const recordingId = `fixture-${captureMode}`;
              tx.objectStore('recordings').add({ id: recordingId, noteId: id, title: 'Synthetic field recording', mimeType: 'audio/webm', status, ownerId: 'fixture', createdAt: now - 90000, updatedAt: now, durationMs: 42000, chunkCount: 1 });
              tx.objectStore('recordingChunks').add({ id: `${recordingId}:0`, recordingId, sequence: 0, blob: new Blob(['synthetic UI Lens audio fixture'], { type: 'audio/webm' }) });
            }
            tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
          };
        });
      }, mode);
      return page;
    };
    return context;
  };
  return browser;
};
try {
  const targets = selected ?? config.targets.map((item) => item.id);
  const run = newRun('noteos-mvp02');
  await capture({ id: 'noteos-mvp02', root, config }, { projectId: 'noteos-mvp02', targets, artifacts: { png: true, pdf: false, diagnostics: true } }, run);
  console.log(JSON.stringify({ state: run.state, outputPath: run.outputPath, summary: run.manifest.summary }, null, 2));
  await writeFile('/tmp/noteos-mvp02-evidence/ui-lens.json', JSON.stringify(run, null, 2));
  if (run.manifest.summary.failed) process.exitCode = 1;
} finally { chromium.launch = launch; }
