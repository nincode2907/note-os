import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openStore, serverMeta, transaction, appendChange } from './storage.mjs';
import { issuePairingCode, redeemPairingCode, authenticate, revokeDevice } from './auth.mjs';
import { handleSync } from './http.mjs';
import { canonicalJson, compareSummaries, validateSummaries, assertHistoryContinuity, SYNC_LIMITS } from '../app/lib/sync-protocol.mjs';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(),'noteos-sync-test-'));
  const db = openStore(root, { initialize:true });
  t.after(() => { try { db.close(); } catch {} rmSync(root,{recursive:true,force:true}); });
  return { root, db, env:{NOTEOS_SYNC_ENABLED:'1', NOTEOS_SYNC_STORAGE:root, NOTEOS_SYNC_ALLOWED_ORIGINS:'http://127.0.0.1:15700,https://notes.example.test'} };
}
const hash = 'a'.repeat(64);
const summary = (id, extra = {}) => ({ id, contentHash:hash, lifecycle:'active', localRevision:5, recordingCount:0,...extra });
function seed(db, rows) {
  transaction(db, () => { for (const row of rows) {
    const cursor = appendChange(db,'note',row.id,1);
    db.prepare('INSERT INTO sync_entities VALUES(?,?,?,?,?,?,?,?)').run('note',row.id,1,canonicalJson({ synthetic:true }),row.contentHash,row.lifecycle,row.recordingCount,cursor);
  } });
}
function enrollment(db, now) { return redeemPairingCode(db,issuePairingCode(db,now),'Synthetic test device',now); }
function request(path='status', {method='GET',body,cookie,origin='http://127.0.0.1:15700',headers={}} = {}) {
  return new Request(origin+'/api/v1/sync/'+path, { method, headers:{host:new URL(origin).host,...(method==='POST'?{'origin':origin,'content-type':'application/json','x-noteos-sync':'1'}:{}),...(cookie?{cookie}:{}),...headers}, ...(method==='POST'?{body:typeof body==='string'?body:JSON.stringify(body??{})}:{}) });
}
const cookie = (token, secure=false) => `${secure?'__Secure-noteos_sync':'noteos_sync_local'}=${token}`;
function snapshot(db) { return JSON.stringify(['sync_server_meta','sync_entities','sync_tombstones','sync_changelog','sync_operations'].map(table => db.prepare(`SELECT * FROM ${table}`).all())); }

test('migration v1, WAL, foreign keys and bounded busy timeout', t => {
  const {db}=setup(t);
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode,'wal');
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
  assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout,2000);
  assert.equal(serverMeta(db).schemaVersion,1);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table'").get().n,7);
});
test('epoch and schema survive close/reopen and idempotent init', t => {
  const {root,db}=setup(t), meta=serverMeta(db); db.close();
  const again=openStore(root,{initialize:true}); assert.deepEqual(serverMeta(again),meta); again.close();
});
test('future schema fails closed', t=> {const {root,db}=setup(t); db.exec('PRAGMA user_version=2'); assert.throws(()=>openStore(root),/Migration/);});
test('missing volume fails closed', t=> {setup(t); assert.throws(()=>openStore('/not-a-mounted-volume'));});
test('missing database cannot silently replace epoch', t=> {const {root,db}=setup(t);db.close();unlinkSync(join(root,'sync.sqlite'));assert.throws(()=>openStore(root,{initialize:true}),/Database missing/);});
test('changed epoch marker requires recovery', t=> {const {root}=setup(t);writeFileSync(join(root,'.sync-epoch'),'unexpected');assert.throws(()=>openStore(root),/Epoch mismatch/);});
test('cursor allocation requires a transaction', t=> {const {db}=setup(t);assert.throws(()=>appendChange(db,'note','test',1),/transaction/);});
test('rollback includes cursor and all committed-change tables', t=> {const {db}=setup(t);const before=snapshot(db);assert.throws(()=>transaction(db,()=>{appendChange(db,'note','test',1);throw new Error('injected');}));assert.equal(snapshot(db),before);});
test('entity versions reference their exact committed change and cannot coexist with tombstones',t=> {
  const {db}=setup(t);seed(db,[summary('live')]);
  assert.throws(()=>db.prepare("UPDATE sync_entities SET server_version=2 WHERE id='live'").run(),/FOREIGN KEY/);
  assert.throws(()=>transaction(db,()=>{const c=appendChange(db,'note','live',2,'tombstone');db.prepare('INSERT INTO sync_tombstones VALUES(?,?,?,?)').run('note','live',2,c);}),/live/);
  assert.equal(serverMeta(db).serverCursor,1);
});
test('independent concurrent WAL writers allocate contiguous committed cursors', async t=> {
  const {root,db}=setup(t);
  const code=`import {openStore,transaction,appendChange} from './sync-server/storage.mjs';const d=openStore(process.argv[1]);for(let i=0;i<12;i++)transaction(d,()=>{appendChange(d,'note',process.argv[2]+'-'+i,1);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,3);});d.close();`;
  await Promise.all(['one','two'].map(id=>promisify(execFile)(process.execPath,['--input-type=module','-e',code,root,id])));
  assert.equal(serverMeta(db).serverCursor,24);
  assert.deepEqual(db.prepare('SELECT server_cursor n FROM sync_changelog ORDER BY server_cursor').all().map(r=>r.n),Array.from({length:24},(_,i)=>i+1));
});
test('pairing expires at 120 seconds', t=> {const {db}=setup(t),code=issuePairingCode(db,1000);assert.equal(redeemPairingCode(db,code,'test',121000).status,401);});
test('pairing one-time use, only token hash stored', t=> {const {db}=setup(t),code=issuePairingCode(db),paired=redeemPairingCode(db,code,'test');assert.ok(paired.token);assert.equal(redeemPairingCode(db,code,'test').status,401);assert.notEqual(db.prepare('SELECT token_hash FROM sync_devices').get().token_hash,paired.token);});
test('pairing blocks after five attempts', t=> {const {db}=setup(t),code=issuePairingCode(db);for(let i=0;i<5;i++)assert.equal(redeemPairingCode(db,'wrong-code12','test').status,401);assert.equal(redeemPairingCode(db,code,'test').status,429);});
test('global pairing budget persists across new codes and store restart', t=> {const {db,root}=setup(t);for(let i=0;i<10;i++){issuePairingCode(db,1000);redeemPairingCode(db,'wrong-code12','test',1000);}const code=issuePairingCode(db,1000);db.close();const again=openStore(root);assert.equal(redeemPairingCode(again,code,'test',1000).status,429);again.close();});
test('missing invalid expired and revoked tokens denied immediately', t=> {const {db}=setup(t),p=enrollment(db,1000);assert.equal(authenticate(db,null,1000),null);assert.equal(authenticate(db,'invalid',1000),null);assert.ok(authenticate(db,p.token,1000));assert.equal(authenticate(db,p.token,p.expires),null);assert.equal(revokeDevice(db,p.id,2000),1);assert.equal(authenticate(db,p.token,2000),null);});
test('default disabled endpoint does not initialize a database', async t=> {const {env}=setup(t);const r=await handleSync(request(),'status',{...env,NOTEOS_SYNC_ENABLED:'0',NOTEOS_SYNC_STORAGE:'/missing'});assert.equal(r.status,503);assert.deepEqual(await r.json(),{error:'sync_disabled'});});
test('all metadata needs authentication; mutation routes absent', async t=> {const {env}=setup(t);assert.equal((await handleSync(request(),'status',env)).status,401);assert.equal((await handleSync(request('bootstrap/dry-run',{method:'POST'}),'bootstrap/dry-run',env)).status,401);assert.equal((await handleSync(request('push',{method:'POST'}),'push',env)).status,404);});
test('pair uses Secure HttpOnly SameSite cookie on HTTPS, never exposes token JSON', async t=> {
  const {db,env}=setup(t),code=issuePairingCode(db);
  const r=await handleSync(request('pair',{method:'POST',origin:'https://notes.example.test',body:{code,label:'Test HTTPS'}}),'pair',env);
  assert.equal(r.status,200);assert.match(r.headers.get('set-cookie'),/^__Secure-noteos_sync=/);assert.match(r.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);assert.match(r.headers.get('set-cookie'),/; Secure$/);assert.equal('token' in await r.json(),false);
});
test('localhost has distinct HttpOnly cookie and local-only insecure exception', async t=> {
  const {db,env}=setup(t),code=issuePairingCode(db);const r=await handleSync(request('pair',{method:'POST',body:{code,label:'Test local'}}),'pair',env);
  assert.equal(r.status,200);assert.match(r.headers.get('set-cookie'),/^noteos_sync_local=/);assert.doesNotMatch(r.headers.get('set-cookie'),/; Secure/);
});
for (const [name,headers] of [ ['missing Origin',{origin:''}],['wrong Origin',{origin:'https://evil.example'}],['cross-site',{'sec-fetch-site':'cross-site'}],['missing custom header',{'x-noteos-sync':''}],['wrong content type',{'content-type':'text/plain'}] ]) test(`CSRF denies ${name}`,async t=> {
  const {db,env}=setup(t),p=enrollment(db);assert.equal((await handleSync(request('bootstrap/dry-run',{method:'POST',cookie:cookie(p.token),body:{protocolVersion:1,records:[]},headers}),'bootstrap/dry-run',env)).status,403);
});
test('unconfigured Host and insecure non-loopback Origin denied',async t=> {const {env}=setup(t);assert.equal((await handleSync(request('status',{headers:{host:'evil.example'}}),'status',env)).status,403);assert.equal((await handleSync(request('status'),'status',{...env,NOTEOS_SYNC_ALLOWED_ORIGINS:'http://notes.example.test'})).status,503);});
test('oversized JSON, malformed JSON, unknown and duplicate summary fields rejected',async t=> {
  const {db,env}=setup(t),p=enrollment(db);
  for(const [body,status] of [['x'.repeat(SYNC_LIMITS.maxBytes+1),413],['{',400],[{protocolVersion:1,records:[summary('same'),summary('same')]},400],[{protocolVersion:1,records:[{...summary('x'),title:'never accepted'}]},400],[{protocolVersion:1,records:Array.from({length:1001},(_,i)=>summary('x'+i))},400]]) {
    const r=await handleSync(request('bootstrap/dry-run',{method:'POST',cookie:cookie(p.token),body}),'bootstrap/dry-run',env);assert.equal(r.status,status);
  }
});
test('genuine seeded comparison: equal/new/changed/lifecycle/audio/tombstone; zero server mutations',async t=> {
  const {db,env}=setup(t),p=enrollment(db);
  seed(db,[summary('equal'),summary('conflict'),summary('remote'),summary('lifecycle'),summary('audio',{recordingCount:1})]);
  transaction(db,()=>{const c=appendChange(db,'note','deleted',2,'tombstone');db.prepare('INSERT INTO sync_tombstones VALUES(?,?,?,?)').run('note','deleted',2,c);});
  const before=snapshot(db),rows=[summary('equal',{localRevision:99}),summary('conflict',{contentHash:'b'.repeat(64)}),summary('new'),summary('lifecycle',{lifecycle:'trashed'}),summary('audio',{recordingCount:1}),summary('deleted')];
  const r=await handleSync(request('bootstrap/dry-run',{method:'POST',cookie:cookie(p.token),body:{protocolVersion:1,records:rows}}),'bootstrap/dry-run',env);
  assert.equal(r.status,200);const preview=await r.json();assert.deepEqual(preview.identical,['equal']);assert.deepEqual(preview.toUpload,['new']);assert.deepEqual(preview.toDownload,['remote']);assert.deepEqual(preview.collidingIds,['audio','conflict','deleted','lifecycle']);assert.deepEqual(preview.audioRequiresReview,['audio']);assert.equal(preview.serverEmpty,false);assert.equal(snapshot(db),before);
});
test('empty-server preview is explicit',async t=> {const {db,env}=setup(t),p=enrollment(db);const r=await handleSync(request('bootstrap/dry-run',{method:'POST',cookie:cookie(p.token),body:{protocolVersion:1,records:[summary('new')]}}),'bootstrap/dry-run',env);assert.equal((await r.json()).serverEmpty,true);});
test('revocation endpoint makes existing cookie unusable',async t=> {const {db,env}=setup(t),p=enrollment(db);const c=cookie(p.token);assert.equal((await handleSync(request('revoke',{method:'POST',cookie:c}),'revoke',env)).status,200);assert.equal((await handleSync(request('status',{cookie:c}),'status',env)).status,401);});
test('unavailable database gives generic 503 without paths or query data',async t=> {const {env}=setup(t);const r=await handleSync(request(),'status',{...env,NOTEOS_SYNC_STORAGE:'/missing'});assert.equal(r.status,503);assert.deepEqual(await r.json(),{error:'sync_storage_unavailable'});});
test('history epoch or cursor rollback halts review',()=>{const previous={serverEpoch:'one',serverCursor:5};assert.throws(()=>assertHistoryContinuity(previous,{serverEpoch:'two',serverCursor:6}),/recovery/);assert.throws(()=>assertHistoryContinuity(previous,{serverEpoch:'one',serverCursor:4}),/recovery/);assert.equal(assertHistoryContinuity(previous,{serverEpoch:'one',serverCursor:6}).serverCursor,6);});
test('canonical hashes do not depend on object order; localRevision not serverVersion',()=>{assert.equal(canonicalJson({z:1,a:{b:2}}),canonicalJson({a:{b:2},z:1}));assert.deepEqual(compareSummaries([summary('x',{localRevision:999})],[summary('x',{serverVersion:1})]).identical,['x']);assert.throws(()=>validateSummaries({protocolVersion:1,records:[summary('x',{localRevision:-1})]}));});
test('summary hash cannot coerce arrays and canonical records cannot drop non-JSON objects',()=>{assert.throws(()=>validateSummaries({protocolVersion:1,records:[summary('x',{contentHash:[hash]})]}));assert.throws(()=>canonicalJson({future:new Date()}),/Non-JSON/);});
