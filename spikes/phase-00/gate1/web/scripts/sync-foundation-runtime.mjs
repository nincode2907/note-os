import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, rm } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
const run=async args=>(await promisify(execFile)('docker',args,{maxBuffer:1024*1024})).stdout.trim();
const compose=['compose','-f','docker-compose.sync-foundation-test.yml'];
const container='noteos-sync-foundation-test-web-1';
const state=async()=>JSON.parse(await run(['exec',container,'node','/verification/fixture.mjs','state']));
async function health(){for(let i=0;i<120;i++){try{if((await fetch('http://127.0.0.1:15720/')).status===200)return;}catch{}await delay(500);}throw new Error('Test Web did not become ready');}
const before=await state();
await run([...compose,'up','-d','--force-recreate','--no-deps','--wait','web']);await health();assert.deepEqual(await state(),before);
console.log('PASS production image recreate preserved epoch, schema, cursor and seeded records:',JSON.stringify(before));
await run([...compose,'restart','web']);await health();assert.deepEqual(await state(),before);console.log('PASS ordinary app restart preserved history and records.');
for(const path of ['','/push','/unknown']){const r=await fetch('http://127.0.0.1:15720/api/v1/sync'+path);assert.equal(r.status,404);assert.equal((await r.json()).error,'route_not_found');}
assert.equal((await fetch('http://127.0.0.1:15720/api/v1/sync/status')).status,401);
assert.equal((await fetch('http://127.0.0.1:15720/api/v1/sync/status',{method:'PUT'})).status,405);
const manifest=JSON.parse(await run(['exec',container,'node','--input-type=module','-e',"import fs from 'node:fs';console.log(fs.readFileSync('.next/routes-manifest.json','utf8'))"]));
assert.ok(manifest.rewrites.fallback.some(r=>r.source==='/api/:path*'&&r.destination==='http://gate1-api:15001/api/:path*'));
console.log('PASS reserved API roots/unknown mutations stay in native handler; legacy rewrite remains fallback (historical backend not started).');
const override='/tmp/noteos-phase081-unavailable.yml';
await writeFile(override,'services:\n  web:\n    environment:\n      NOTEOS_SYNC_STORAGE: /unavailable-database-volume\n');
try{
 await run([...compose,'-f',override,'up','-d','--force-recreate','--no-deps','--wait','web']);await health();
 const r=await fetch('http://127.0.0.1:15720/api/v1/sync/status');assert.equal(r.status,503);assert.deepEqual(await r.json(),{error:'sync_storage_unavailable'});
 console.log('PASS unavailable database volume returns generic 503 while local-note Web remains HTTP 200.');
}finally{await run([...compose,'up','-d','--force-recreate','--no-deps','--wait','web']);await rm(override,{force:true});}
await health();assert.deepEqual(await state(),before);console.log('PASS original synthetic volume reattached without resetting data or history.');
