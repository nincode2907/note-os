import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createNotesRepository, makeEmptyNote } from './local-notes.js';
import { discoverLocal, noteSummary } from './sync-discovery.mjs';

test('read-only discovery never creates a missing browser database',async()=>{
  const factory=new IDBFactory();
  assert.deepEqual(await discoverLocal(factory),{noteCount:0,recordingCount:0,excludedCount:0,records:[],databasePresent:false});
  assert.deepEqual(await factory.databases(),[]);
});
test('discovery leaves synthetic local records and schema unchanged; missing privacy stays excluded',async()=>{
  const factory=new IDBFactory(), repo=createNotesRepository(factory);
  await repo.create({...makeEmptyNote(1,'device-only'),privacy:'DEVICE_ONLY'});
  await repo.create(makeEmptyNote(1,'missing-privacy'));
  await repo.create({...makeEmptyNote(1,'server-allowed'),privacy:'PRIVATE_SERVER'});
  const before=JSON.stringify(await repo.snapshotArchive()),dbs=await factory.databases();
  const preview=await discoverLocal(factory);
  assert.equal(preview.noteCount,3);assert.equal(preview.excludedCount,2);assert.deepEqual(preview.records.map(r=>r.id),['server-allowed']);
  assert.equal(JSON.stringify(await repo.snapshotArchive()),before);assert.deepEqual(await factory.databases(),dbs);
});
test('content hash ignores client CAS/clocks but includes unknown semantic data',()=>{
  const note={...makeEmptyNote(1,'x'),privacy:'PRIVATE_SERVER'};
  const first=noteSummary(note);
  assert.equal(noteSummary({...note,revision:100,updatedAt:999}).contentHash,first.contentHash);
  assert.notEqual(noteSummary({...note,futureSemanticField:{keep:true}}).contentHash,first.contentHash);
  assert.equal(noteSummary(note,[{noteId:'x',id:'audio'}]).recordingCount,1);
});
test('two separate factories represent isolated origins',async()=>{
  const a=new IDBFactory(),b=new IDBFactory();await createNotesRepository(a).create(makeEmptyNote(1,'only-a'));
  assert.equal((await discoverLocal(a)).noteCount,1);assert.equal((await discoverLocal(b)).noteCount,0);
});
