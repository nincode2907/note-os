import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { createNotesRepository, makeEmptyNote } from './local-notes.js';
import { createAiAnalysisIntent, deliverAiOutbox, revokeAiConsent } from './ai-sync-client.mjs';

let sequence = 0;
const consent = noteId => ({ consent: { noteId, state: 'APPROVED_LOCAL_ONLY', scopes: ['organize'], providerBoundary: 'MOCK', consentEpoch: 3, updatedAt: 10 } });
const makeFetcher = ({ noteId, onAnalysis = () => {}, onRevoke = () => {}, fail = false }) => async (path, options = {}) => {
  if (fail) throw new TypeError('offline');
  if (path === '/api/v1/sync/ai-session') return Response.json({ ok: true });
  if (path === `/api/v1/ai/consents/${noteId}` && options.method === 'GET') return Response.json(consent(noteId));
  if (path === `/api/v1/ai/consents/${noteId}` && options.method === 'DELETE') { onRevoke(JSON.parse(options.body)); return Response.json({ consent: { noteId, state: 'REVOKED', scopes: [], providerBoundary: 'MOCK', consentEpoch: 4, updatedAt: 11 } }); }
  if (path === '/api/v1/ai/analysis-requests') { const body = JSON.parse(options.body); onAnalysis(body); return Response.json({ requestId: body.requestId, jobId: 'job-synthetic', status: 'QUEUED' }); }
  throw new Error(`Unexpected AI test request: ${options.method ?? 'GET'} ${path}`);
};

function setup() {
  const name = `noteos-ai-client-${++sequence}`, repository = createNotesRepository(indexedDB, name);
  return { name, repository };
}

async function addNote(repository, id) {
  const note = { ...makeEmptyNote(100, id), title: 'Synthetic secret title', privacy: 'PRIVATE_SERVER' };
  await repository.create(note);
  await repository.cacheAiConsent({ noteId: id, state: 'APPROVED_LOCAL_ONLY', scopes: ['organize'], providerBoundary: 'MOCK', consentEpoch: 3 });
  return note;
}

test('AI outbox intent persists across repository restart and contains metadata only', async () => {
  const { name, repository } = setup(), note = await addNote(repository, 'offline-restart');
  const intent = await repository.createAiAnalysisIntent({ requestId: crypto.randomUUID(), noteId: note.id, localRevision: note.revision, consentEpoch: 3 });
  const stored = (await repository.listAiIntents(note.id))[0];
  assert.equal(stored.status, 'WAITING_FOR_SYNC');
  assert.deepEqual(Object.keys(stored).sort(), ['consentEpoch','createdAt','executionBoundary','kind','localRevision','noteId','requestId','scope','status','updatedAt'].sort());
  assert.doesNotMatch(JSON.stringify(stored), /Synthetic secret title|document|content/i);
  const restarted = createNotesRepository(indexedDB, name);
  assert.equal((await restarted.listAiIntents(note.id))[0].requestId, intent.requestId);
  assert.equal((await restarted.listPendingAiIntents()).length, 1);
});

test('explicit analysis waits for exact Sync ACK and then sends only the acknowledged revision metadata', async () => {
  const { repository } = setup(), note = await addNote(repository, 'ack-gate'); let analysisBody = null;
  const fetcher = makeFetcher({ noteId: note.id, onAnalysis: body => { analysisBody = body; } });
  const intent = await createAiAnalysisIntent({ repository, noteId: note.id, localRevision: note.revision, fetcher });
  assert.equal(intent.status, 'WAITING_FOR_SYNC'); assert.equal(analysisBody, null);
  await repository.setSyncEnrollment([note.id], true);
  const operation = (await repository.listSyncOutbox())[0], contentHash = 'a'.repeat(64);
  const ack = { id: note.id, localRevision: note.revision, serverVersion: 1, contentHash };
  await repository.acknowledgeSyncOperations([{ operationId: operation.operationId, baseline: ack }], { serverEpoch: 'epoch-ai-test', serverCursor: 1 });
  const result = await deliverAiOutbox({ repository, fetcher, acknowledged: [{ ...ack, serverEpoch: 'epoch-ai-test' }] });
  assert.deepEqual(result, { delivered: 1, waiting: 0, failed: 0 });
  assert.equal(analysisBody.noteId, note.id); assert.equal(analysisBody.expectedServerEpoch, 'epoch-ai-test');
  assert.equal(analysisBody.expectedServerVersion, 1); assert.equal(analysisBody.expectedContentHash, contentHash);
  assert.equal(Object.hasOwn(analysisBody, 'document'), false); assert.equal((await repository.listAiIntents(note.id))[0].status, 'QUEUED');
});

test('changed revision becomes stale before delivery and is never submitted', async () => {
  const { repository } = setup(), note = await addNote(repository, 'stale-local'); let submissions = 0;
  const intent = await repository.createAiAnalysisIntent({ requestId: crypto.randomUUID(), noteId: note.id, localRevision: note.revision, consentEpoch: 3 });
  await repository.save(note.id, { title: 'Changed after request', document: note.document }, note.revision);
  const result = await deliverAiOutbox({ repository, fetcher: makeFetcher({ noteId: note.id, onAnalysis: () => submissions++ }) });
  assert.equal(result.failed, 1); assert.equal(submissions, 0);
  assert.equal((await repository.listAiIntents(note.id)).find(row => row.requestId === intent.requestId).status, 'STALE');
});

test('offline intents survive restart; local revoke cancels them and sends only revocation metadata', async () => {
  const { name, repository } = setup(), note = await addNote(repository, 'revoke-local');
  const intent = await repository.createAiAnalysisIntent({ requestId: crypto.randomUUID(), noteId: note.id, localRevision: note.revision, consentEpoch: 3 });
  const offline = await deliverAiOutbox({ repository, fetcher: makeFetcher({ noteId: note.id, fail: true }) });
  assert.equal(offline.waiting, 1);
  const restarted = createNotesRepository(indexedDB, name); let revokeBody = null, submissions = 0;
  const revoke = await revokeAiConsent({ repository: restarted, noteId: note.id, fetcher: makeFetcher({ noteId: note.id, onRevoke: body => { revokeBody = body; }, onAnalysis: () => submissions++ }) });
  assert.equal(revoke.status, 'REVOKED'); assert.equal(revokeBody.protocolVersion, 1);
  assert.equal(Object.keys(revokeBody).sort().join(','), 'protocolVersion,requestId');
  assert.equal(submissions, 0);
  const rows = await restarted.listAiIntents(note.id);
  assert.equal(rows.find(row => row.requestId === intent.requestId).status, 'CANCELED');
  assert.equal((await restarted.getAiConsentCache(note.id)).state, 'REVOKED');
});

test('local request queue evicts oldest terminal metadata and never pending intents', async () => {
  const { repository } = setup(), note = await addNote(repository, 'bounded-outbox');
  for (let index = 0; index < 1000; index++) {
    const requestId = crypto.randomUUID();
    const row = await repository.createAiAnalysisIntent({ requestId, noteId: note.id, localRevision: note.revision, consentEpoch: 3, now: index });
    await repository.updateAiIntent(row.requestId, index === 0 ? 'QUEUED' : 'WAITING_FOR_SYNC');
  }
  const next = await repository.createAiAnalysisIntent({ requestId: crypto.randomUUID(), noteId: note.id, localRevision: note.revision, consentEpoch: 3, now: 2000 });
  const rows = await repository.listAiIntents(note.id);
  assert.equal(rows.length, 1000); assert.equal(rows.some(row => row.requestId === next.requestId), true);
  assert.equal(rows.some(row => row.createdAt === 0), false);
  await assert.rejects(repository.createAiAnalysisIntent({ requestId: crypto.randomUUID(), noteId: note.id, localRevision: note.revision, consentEpoch: 3, now: 2001 }), /queue is full/);
});

test('09B-1B: a STRICT_LOCAL consent carries its boundary into the intent and delivery; a boundary change needs new consent', async () => {
  const { repository } = setup(), note = { ...makeEmptyNote(100, 'strict-local'), title: 'Synthetic local', privacy: 'PRIVATE_SERVER' };
  await repository.create(note);
  await repository.cacheAiConsent({ noteId: note.id, state: 'APPROVED_LOCAL_ONLY', scopes: ['organize'], providerBoundary: 'STRICT_LOCAL', consentEpoch: 3 });
  let analysisBody = null, serverBoundary = 'STRICT_LOCAL';
  const fetcher = async (path, options = {}) => {
    if (path === '/api/v1/sync/ai-session') return Response.json({ ok: true });
    if (path === `/api/v1/ai/consents/${note.id}`) return Response.json({ consent: { noteId: note.id, state: 'APPROVED_LOCAL_ONLY', scopes: ['organize'], providerBoundary: serverBoundary, consentEpoch: 3, updatedAt: 10 } });
    if (path === '/api/v1/ai/analysis-requests') { analysisBody = JSON.parse(options.body); return Response.json({ requestId: analysisBody.requestId, jobId: 'job-local', status: 'QUEUED' }); }
    throw new Error(`Unexpected ${path}`);
  };
  const intent = await createAiAnalysisIntent({ repository, noteId: note.id, localRevision: note.revision, fetcher });
  assert.equal(intent.executionBoundary, 'STRICT_LOCAL');
  await repository.setSyncEnrollment([note.id], true);
  const operation = (await repository.listSyncOutbox())[0], ack = { id: note.id, localRevision: note.revision, serverVersion: 1, contentHash: 'b'.repeat(64) };
  await repository.acknowledgeSyncOperations([{ operationId: operation.operationId, baseline: ack }], { serverEpoch: 'epoch-local', serverCursor: 1 });
  serverBoundary = 'MOCK';
  assert.deepEqual(await deliverAiOutbox({ repository, fetcher }), { delivered: 0, waiting: 0, failed: 1 });
  assert.equal(analysisBody, null, 'a server boundary that differs from the consented boundary is never submitted');
  assert.equal((await repository.listAiIntents(note.id))[0].status, 'NEEDS_CONSENT');
});
