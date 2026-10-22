import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const evidence = process.env.NOTEOS_MVP02_EVIDENCE ?? '/tmp/noteos-mvp02-evidence';
const lens = process.env.NOTEOS_PLAYWRIGHT_ROOT ?? `${root}/../ui-lens`;
const { chromium } = require(require.resolve('playwright', { paths: [lens] }));
const baseUrl = process.env.NOTEOS_TEST_URL ?? 'http://127.0.0.1:3000';
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const results = [], diagnostics = { consoleErrors: [], pageErrors: [], externalRequests: [] };
function check(ok, message) { if (!ok) throw new Error(message); }
async function noteAction(page, action) { await page.getByRole('button', { name: 'More note actions' }).click(); await page.getByRole('menuitem', { name: action, exact: true }).click(); }
async function scenario(name, run, setup = {}) {
  const context = await browser.newContext({ acceptDownloads: true });
  await context.route('**/*', (route) => new URL(route.request().url()).origin === baseUrl ? route.continue() : route.abort());
  if (setup.denied) await context.addInitScript(() => Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => Promise.reject(new DOMException('Permission denied by test fixture', 'NotAllowedError')) } }));
  if (setup.unsupported) await context.addInitScript(() => Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: undefined }));
  if (setup.failWrites) await context.addInitScript(() => {
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function(value, ...args) {
      if (this.name === 'recordingChunks') throw new DOMException('Synthetic quota exceeded', 'QuotaExceededError');
      return add.call(this, value, ...args);
    };
  });
  const page = await context.newPage();
  page.on('console', (message) => { if (message.type() === 'error') diagnostics.consoleErrors.push(`${name}: ${message.text()}`); });
  page.on('pageerror', (error) => diagnostics.pageErrors.push(`${name}: ${error.message}`));
  page.on('request', (request) => { if (!request.url().startsWith(baseUrl)) diagnostics.externalRequests.push(`${name}: ${request.url()}`); });
  try { await run(page, context); results.push({ name, status: 'PASS' }); }
  catch (error) { results.push({ name, status: 'FAIL', error: error instanceof Error ? error.stack : String(error) }); await page.screenshot({ path: `${evidence}/${name.replace(/[^a-z0-9]+/gi, '-')}.png`, fullPage: true }).catch(() => {}); }
  finally { await context.close(); }
}
async function openNote(page) {
  await page.goto(baseUrl); await page.getByRole('button', { name: /New note/ }).first().click();
  await page.locator('#note-title').waitFor();
  const id = new URL(page.url()).pathname.split('/').pop();
  return { id, url: page.url() };
}
async function records(page, noteId) {
  return page.evaluate(async (id) => new Promise((resolve, reject) => {
    const request = indexedDB.open('noteos-mvp-01');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('recordings', 'readonly'), query = tx.objectStore('recordings').index('noteId').getAll(id);
      let rows = []; query.onsuccess = () => { rows = query.result; };
      tx.oncomplete = () => { db.close(); resolve(rows); }; tx.onerror = () => reject(tx.error);
    };
  }), noteId);
}
async function waitForChunks(page, noteId, minimum = 1) {
  const end = Date.now() + 12000;
  while (Date.now() < end) { const rows = await records(page, noteId); if (rows.some((row) => row.chunkCount >= minimum)) return rows; await new Promise((resolve) => setTimeout(resolve, 40)); }
  throw new Error('Timed out waiting for a committed audio chunk.');
}
async function waitForNewRecordingChunk(page, noteId, existingCount) {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    const rows = await records(page, noteId), current = rows.find((row) => row.status === 'recording');
    if (rows.length > existingCount && current?.chunkCount > 0) return current;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('Timed out waiting for a chunk from the new recording session.');
}
async function start(page) { const current = await page.locator('.audio-count').textContent(); const before = Number(current?.match(/\d+/)?.[0] ?? 0); await page.getByRole('button', { name: /Record audio/ }).click(); await page.getByText('Recording — audio chunks are being saved on this device.').waitFor(); await page.locator('.audio-count').filter({ hasText: new RegExp(`^${before + 1} recordings?$`) }).waitFor(); }
async function stop(page) { await page.getByRole('button', { name: 'Stop and save' }).click(); try { await page.getByText('Recording saved on this device.').waitFor({ timeout: 15000 }); } catch (error) { const body = await page.locator('body').innerText().catch(() => ''); throw new Error(`Stop did not complete: ${body}\n${error instanceof Error ? error.message : String(error)}`); } }

try {
  await scenario('unsupported-browser-api', async (page) => {
    await openNote(page); await page.getByRole('button', { name: /Record audio/ }).click();
    await page.getByRole('alert').filter({ hasText: 'not supported' }).waitFor();
  }, { unsupported: true });
  await scenario('permission-denied', async (page) => {
    await openNote(page); await page.getByRole('button', { name: /Record audio/ }).click();
    await page.getByRole('alert').filter({ hasText: 'permission was denied' }).waitFor();
    check(await records(page, new URL(page.url()).pathname.split('/').pop()).then((rows) => rows.length === 0), 'Permission failure created an empty recording session.');
  }, { denied: true });
  await scenario('record-pause-resume-reload-play-export', async (page, context) => {
    await context.grantPermissions(['microphone'], { origin: baseUrl });
    const { id, url } = await openNote(page); await start(page); await waitForChunks(page, id);
    await page.getByRole('button', { name: 'Pause' }).click(); await page.getByText('Paused — saved chunks are retained locally.').waitFor();
    await page.getByRole('button', { name: 'Resume' }).click(); await page.getByText('Recording — audio chunks are being saved on this device.').waitFor();
    await waitForChunks(page, id, 2); await stop(page);
    let rows = await records(page, id); check(rows.length === 1 && rows[0].status === 'complete' && rows[0].chunkCount >= 2, 'Recording did not reach complete with persisted chunks.');
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    const player = page.locator('audio.recording-player'); await player.waitFor();
    const audioState = await player.evaluate((audio) => ({ src: audio.currentSrc, controls: audio.controls, type: audio.getAttribute('src') }));
    check(Boolean(audioState.src && audioState.controls), 'Reloaded recording did not expose a playable audio source.');
    const played = await player.evaluate(async (audio) => { try { await audio.play(); return true; } catch { return false; } }); check(played, 'Saved audio failed to start playback.');
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export', exact: true }).click()]);
    check(download.suggestedFilename().match(/\.(webm|ogg|m4a|wav)$/), 'Audio export extension did not match detected MIME type.');
    check((await download.path()) !== null, 'Audio download did not produce a file.');
    await page.locator('audio').evaluate((audio) => audio.pause()); await page.reload();
    rows = await records(page, id); check(rows.length === 1 && rows[0].status === 'complete', 'Recording did not persist after reload.');
    await page.getByRole('button', { name: 'Play', exact: true }).click(); await page.locator('audio.recording-player').waitFor();
    await page.getByRole('button', { name: 'Rename' }).click(); const input = page.getByLabel('Recording title'); await input.fill('Field notes'); await page.getByRole('button', { name: 'Save name' }).click();
    await page.getByText('Field notes', { exact: true }).waitFor(); check(page.url() === url, 'Audio management navigated away from its note.');
  });
  await scenario('multiple-recordings-and-explicit-delete', async (page, context) => {
    await context.grantPermissions(['microphone'], { origin: baseUrl }); const { id } = await openNote(page);
    for (let i = 0; i < 2; i++) { const existingCount = (await records(page, id)).length; await start(page); await waitForNewRecordingChunk(page, id, existingCount); await stop(page); }
    check((await records(page, id)).length === 2, 'Multiple recordings were not independently stored.');
    page.once('dialog', (dialog) => dialog.accept()); await page.getByRole('button', { name: 'Delete', exact: true }).first().click();
    await page.waitForFunction(() => document.querySelectorAll('.recording-item').length === 1); check((await records(page, id)).length === 1, 'Confirmed deletion did not remove the selected recording.');
  });
  await scenario('storage-failure-keeps-interrupted-chunks', async (page, context) => {
    await context.grantPermissions(['microphone'], { origin: baseUrl }); const { id } = await openNote(page); await start(page);
    await page.getByRole('alert').filter({ hasText: 'Synthetic quota exceeded' }).waitFor({ timeout: 12000 });
    const rows = await records(page, id); check(rows.length === 1 && rows[0].status === 'failed', 'Storage failure was shown as complete or removed.');
  }, { failWrites: true });
  await scenario('reload-recovers-partial-session', async (page, context) => {
    await context.grantPermissions(['microphone'], { origin: baseUrl }); const { id, url } = await openNote(page); await start(page); await waitForChunks(page, id);
    await page.reload(); await page.getByText('Partial recording recovered', { exact: true }).waitFor({ timeout: 15000 });
    const rows = await records(page, id); check(rows.length === 1 && rows[0].status === 'interrupted' && rows[0].chunkCount > 0, 'Reload did not retain an explicitly partial recording.');
    await page.getByRole('button', { name: 'Play', exact: true }).click(); await page.locator('audio.recording-player').waitFor();
    await page.getByRole('button', { name: 'Export', exact: true }).click(); await page.waitForURL(url);
  });
  await scenario('copied-session-id-and-live-owner-protection', async (page, context) => {
    await context.grantPermissions(['microphone'], { origin: baseUrl });
    await context.addInitScript(() => sessionStorage.setItem('noteos:mvp02:tab', 'deliberately-copied-owner-id'));
    const { id, url } = await openNote(page); await start(page); await waitForChunks(page, id);
    await page.getByRole('button', { name: 'Pause' }).click(); await page.getByText('Paused — saved chunks are retained locally.').waitFor();
    const otherTab = await context.newPage(); await otherTab.goto(url);
    await otherTab.getByRole('button', { name: /Record audio/ }).waitFor({ state: 'visible' });
    await otherTab.evaluate(async () => new Promise((resolve, reject) => {
      const request = indexedDB.open('noteos-mvp-01'); request.onerror = () => reject(request.error);
      request.onsuccess = () => { const db = request.result, tx = db.transaction('recordings', 'readwrite'), store = tx.objectStore('recordings'), query = store.getAll(); query.onsuccess = () => { for (const row of query.result) if (['recording', 'paused'].includes(row.status) && row.noteId === location.pathname.split('/').pop()) { row.updatedAt = 1; store.put(row); } }; tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
    }));
    await otherTab.reload();
    let rows = await records(page, id); check(rows.length === 1 && rows[0].status === 'paused' && rows[0].updatedAt === 1, 'A long-paused session was rewritten while its live owner held the lock.');
    await otherTab.getByRole('button', { name: /Record audio/ }).click();
    await otherTab.getByRole('alert').filter({ hasText: 'already owns audio' }).waitFor();
    check((await records(page, id)).length === 1, 'A second tab created a competing active session.');
    await page.getByRole('button', { name: 'Resume' }).click(); await page.getByText('Recording — audio chunks are being saved on this device.').waitFor();
    await stop(page); await otherTab.getByRole('button', { name: /Record audio/ }).click();
    await otherTab.getByText('Recording — audio chunks are being saved on this device.').waitFor();
    await waitForNewRecordingChunk(otherTab, id, 1); await stop(otherTab);
    check((await records(page, id)).filter((row) => row.status === 'complete').length === 2, 'The per-note lock was not released after final chunk persistence.');
    await otherTab.close();
  });
  await scenario('unsupported-locks-preserve-unfinished-session', async (page, context) => {
    await context.grantPermissions(['microphone'], { origin: baseUrl });
    const { id, url } = await openNote(page); await start(page); await waitForChunks(page, id);
    const fallbackTab = await context.newPage();
    await fallbackTab.addInitScript(() => Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }));
    await fallbackTab.goto(url); await fallbackTab.getByRole('button', { name: 'Recover partial' }).waitFor();
    await fallbackTab.screenshot({ path: `${evidence}/unsupported-locks-recovery-state.png`, fullPage: true });
    const before = await records(page, id); check(before.length === 1 && before[0].status === 'recording', 'Unsupported-lock initialization changed an unfinished session.');
    await fallbackTab.getByRole('button', { name: /Record audio/ }).click();
    await fallbackTab.getByRole('alert').filter({ hasText: 'cannot safely coordinate' }).waitFor();
    check((await records(page, id))[0].status === 'recording', 'Unsupported Web Locks allowed a competing recorder or rewrote saved state.');
    await stop(page); await fallbackTab.close();
  });
  await scenario('active-recording-blocks-navigation-and-lifecycle', async (page, context) => {
    await context.grantPermissions(['microphone'], { origin: baseUrl }); const { id, url } = await openNote(page); await start(page); await waitForChunks(page, id);
    await noteAction(page, 'Archive');
    await page.getByRole('alert').filter({ hasText: 'Stop and save the audio recording' }).waitFor(); check(page.url() === url, 'Lifecycle navigation left while recording was active.');
    await page.locator('aside').getByRole('link', { name: 'Backup', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Background recording is not supported' }).waitFor(); check(page.url() === url, 'App navigation left while recording was active.');
    await stop(page); check((await records(page, id)).every((row) => row.status === 'complete'), 'Stopping after blocked navigation did not save the recording.');
  });
  await scenario('archive-trash-preserve-recordings-and-delete-cascade', async (page, context) => {
    await context.grantPermissions(['microphone'], { origin: baseUrl }); const { id } = await openNote(page); await start(page); await waitForChunks(page, id); await stop(page);
    await noteAction(page, 'Archive'); await page.waitForURL('**/archive');
    await page.getByRole('link', { name: /Untitled note/ }).click(); await page.getByRole('button', { name: 'Play', exact: true }).waitFor();
    check((await records(page, id)).length === 1, 'Archive removed associated media.');
    await page.getByRole('button', { name: 'Restore' }).click(); await page.waitForURL('**/'); await page.goto(`${baseUrl}/notes/${id}`);
    await noteAction(page, 'Move to trash'); await page.waitForURL('**/trash');
    await page.getByRole('button', { name: 'Delete forever', exact: true }).click();
    const dialog = page.getByRole('dialog'); const [backup] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Request notes backup download' }).click()]);
    check(backup.suggestedFilename().includes('noteos-backup'), 'The note-only backup step did not download.');
    await dialog.getByLabel('I verified that I saved the notes backup.').check();
    await dialog.getByLabel(/I exported any audio/).check(); await dialog.getByRole('button', { name: 'Delete forever', exact: true }).click();
    await page.getByText('Trash is empty').waitFor(); check((await records(page, id)).length === 0, 'Permanent note deletion did not cascade its recordings.');
  });
} finally {
  await writeFile(`${evidence}/browser-results.json`, JSON.stringify({ browser: browser.version(), launch: 'Chromium fake audio device; no physical microphone input', results, diagnostics }, null, 2));
  await browser.close();
}
check(results.every((result) => result.status === 'PASS') && diagnostics.consoleErrors.length === 0 && diagnostics.pageErrors.length === 0 && diagnostics.externalRequests.length === 0, 'MVP-02 browser acceptance failed; inspect browser-results.json.');
