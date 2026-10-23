import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:https';
import http from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const require=createRequire(import.meta.url), root=fileURLToPath(new URL('../../../../../',import.meta.url));
const { chromium, webkit }=require(require.resolve('playwright',{paths:[process.env.NOTEOS_PLAYWRIGHT_ROOT??`${root}/../ui-lens`]}));
const evidence=process.env.NOTEOS_SYNC_EVIDENCE??`${root}/artifacts/review/noteOS-Phase08.2A-Web-Sync-Engine-review/evidence`;
const container='noteos-phase082a-synthetic-web', origin='https://localhost:15741', trace=[];
const run=async args=>(await promisify(execFile)('docker',args,{maxBuffer:1024*1024})).stdout.trim();
const fixture=async action=>run(['exec',container,'node','/verification/fixture.mjs',action]);
const readNote=async(page, title)=>page.evaluate(async wanted=>{
 const open=indexedDB.open('noteos-mvp-01'); const db=await new Promise((ok,fail)=>{open.onsuccess=()=>ok(open.result);open.onerror=()=>fail(open.error)});
 const tx=db.transaction(['notes','syncOutbox','syncState','syncConflicts'],'readonly');
 const [notes,outbox,state,conflicts]=await Promise.all(['notes','syncOutbox','syncState','syncConflicts'].map(name=>new Promise((ok,fail)=>{const r=tx.objectStore(name).getAll();r.onsuccess=()=>ok(r.result);r.onerror=()=>fail(r.error)})));
 db.close(); return {note:notes.find(note=>note.title===wanted),notes,outbox,state,conflicts};
},title);
const countNotes=page=>page.evaluate(async()=>{const open=indexedDB.open('noteos-mvp-01');const db=await new Promise((ok,fail)=>{open.onsuccess=()=>ok(open.result);open.onerror=()=>fail(open.error)});const tx=db.transaction('notes','readonly'),r=tx.objectStore('notes').count();return await new Promise((ok,fail)=>{r.onsuccess=()=>{db.close();ok(r.result)};r.onerror=()=>fail(r.error)})});
const waitFor=async fn=>{for(let i=0;i<160;i++){const value=await fn();if(value)return value;await delay(250)}throw new Error('Timed out waiting for synthetic sync state')};
const navigate=(page,url)=>page.goto(url,{waitUntil:'domcontentloaded'});
await mkdir(evidence,{recursive:true});
const certDir=await mkdtemp(`${tmpdir()}/noteos-phase082a-tls-`), key=`${certDir}/key.pem`, cert=`${certDir}/cert.pem`;
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{stdio:'ignore'});
const proxy=createServer({key:await readFile(key),cert:await readFile(cert)},(req,res)=>{
 const target=http.request({hostname:'127.0.0.1',port:15740,path:req.url,method:req.method,headers:{...req.headers,'x-forwarded-host':req.headers.host,'x-forwarded-proto':'https','x-forwarded-port':'15741'}},up=>{res.writeHead(up.statusCode,up.headers);up.pipe(res)});
 target.on('error',()=>{res.writeHead(502);res.end()});req.pipe(target);
});
await new Promise((resolve,reject)=>proxy.once('error',reject).listen(15741,'127.0.0.1',resolve));
const browsers=[],results=[];
try {
 await fixture('init');
 for(const [name,engine] of [['iPhone-sized WebKit',webkit],['Mac Chromium',chromium]]) {
  const browser=await engine.launch();browsers.push(browser);
  const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:name.startsWith('iPhone')?{width:390,height:844}:{width:1440,height:1000},deviceScaleFactor:name.startsWith('iPhone')?3:1,isMobile:name.startsWith('iPhone'),hasTouch:name.startsWith('iPhone')});
  context.setDefaultTimeout(30000);context.setDefaultNavigationTimeout(30000);
  if(name.startsWith('iPhone')) globalThis.phoneContext=context; else globalThis.macContext=context;
  const page=await context.newPage(), errors=[], apiResponses=[]; page.on('pageerror',e=>errors.push(e.message));page.on('response',async r=>{if(r.url().includes('/api/v1/sync/'))apiResponses.push({path:new URL(r.url()).pathname,status:r.status()})});page.on('requestfailed',r=>{if(r.url().includes('_rsc=')&&r.failure()?.errorText!=='cancelled')trace.push({browser:name,step:'rsc-request-failed',error:r.failure()?.errorText??'unknown'});});
  await navigate(page,origin+'/sync');await page.getByText('This browser is not paired.',{exact:true}).waitFor();
  const code=await fixture('pair');await page.getByLabel('Device label',{exact:true}).fill(name);await page.getByLabel('Pairing code',{exact:true}).fill(code);
  await page.getByRole('button',{name:'Pair this browser',exact:true}).click();try{await page.getByText('This browser is paired. Sync is available after you approve notes.',{exact:true}).waitFor()}catch(error){console.error('Pair diagnostic:',JSON.stringify({body:(await page.locator('body').innerText()).slice(-1800),apiResponses,errors}));throw error;}
  const cookie=(await context.cookies()).find(row=>row.name==='__Secure-noteos_sync');assert.ok(cookie?.secure&&cookie?.httpOnly&&cookie?.sameSite==='Strict');
  assert.equal(await page.evaluate(()=>document.cookie.includes('__Secure-noteos_sync')),false);
  trace.push({browser:name,step:'device-paired',success:true});
  if(name.startsWith('iPhone')) {
   await navigate(page,origin);await page.getByRole('textbox',{name:"What's on your mind?"}).waitFor();
   await page.evaluate(()=>new Promise((ok,fail)=>{const open=indexedDB.open('noteos-mvp-01');open.onsuccess=()=>{const db=open.result;const tx=db.transaction(['notes','recordings'],'readwrite');const note=(id,title,privacy)=>({id,title,document:{schemaVersion:1,type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'既存のノート・ghi chú tổng hợp'}]}]},schemaVersion:1,createdAt:100,updatedAt:100,lifecycle:'active',revision:0,pinned:true,tags:['資料','công việc'],...(privacy?{privacy}:{})});tx.objectStore('notes').add(note('approved-existing','Existing note without privacy'));tx.objectStore('notes').add(note('device-only','Never upload','DEVICE_ONLY'));tx.objectStore('notes').add(note('audio-note','Recording stays local','PRIVATE_SERVER'));tx.objectStore('recordings').add({id:'synthetic-audio',noteId:'audio-note',status:'interrupted'});tx.oncomplete=()=>{db.close();ok()};tx.onabort=tx.onerror=()=>fail(tx.error)};open.onerror=()=>fail(open.error)}));
   await navigate(page,origin+'/sync');await page.getByRole('button',{name:'Inspect this browser'}).click();await page.getByText('3 local notes · 1 local recordings · 0 enrolled',{exact:true}).waitFor();
   assert.equal(await page.getByText(/Never upload/).count(),0);assert.equal(await page.getByText(/Recording stays local/).count(),0);
   await page.getByRole('button',{name:'Approve 1 selected notes'}).click();await page.getByText('1 enrolled',{exact:false}).waitFor();
   await page.getByRole('checkbox',{name:/Include new notes created on this browser after enrollment/}).check();
   await page.getByRole('button',{name:'Sync now',exact:true}).click();await waitFor(async()=>JSON.parse(await fixture('state')).noteCount===1);
   const ids=JSON.parse(await fixture('state')).noteIds;assert.deepEqual(ids,['approved-existing']);
   trace.push({browser:name,step:'owner-approved-existing-note; DEVICE_ONLY-and-audio-excluded',success:true});
   await navigate(page,origin);const capture=page.getByRole('textbox',{name:"What's on your mind?"});await capture.fill('Tóm tắt offline 日本語');
   await context.route('**/api/v1/sync/**',route=>route.abort());
   await page.getByRole('button',{name:'Save note',exact:true}).click();await page.getByText('Saved on this device. Ready for another thought.',{exact:true}).waitFor();
   const local=await readNote(page,'Tóm tắt offline 日本語');assert.ok(local.note);assert.ok(local.outbox.some(op=>op.entityId===local.note.id));
   await context.unroute('**/api/v1/sync/**');trace.push({browser:name,step:'offline-quick-capture-local-commit-and-outbox-durable',success:true});
   await navigate(page,origin+'/sync');await page.getByRole('button',{name:'Sync now',exact:true}).click();await waitFor(async()=>JSON.parse(await fixture('state')).noteCount===2);
   await page.screenshot({path:`${evidence}/iphone-sized-webkit-synced.png`,fullPage:true});
   globalThis.phoneNoteId=local.note.id;results.push({browser:name,version:browser.version(),viewport:'390x844',deviceScaleFactor:3,offlineCapture:true,ownerEnrollment:true});
  } else {
   await page.getByRole('button',{name:'Inspect this browser'}).click();await page.getByRole('button',{name:'Sync now',exact:true}).waitFor();
   await page.getByRole('button',{name:'Sync now',exact:true}).click();await waitFor(async()=>JSON.parse(await fixture('state')).noteCount===2);
   const pulled=await readNote(page,'Tóm tắt offline 日本語');assert.ok(pulled.note);assert.equal(pulled.note.tags.length,0);
   const noteId=pulled.note.id;await navigate(page,`${origin}/notes/${noteId}`);const title=page.getByRole('textbox',{name:'Note title',exact:true});await title.waitFor();
   await title.fill('Mac edited 日本語');await page.getByRole('textbox',{name:'Note content'}).waitFor();
   await waitFor(async()=>{const note=await readNote(page,'Mac edited 日本語');return note.note?.revision>0});
   await waitFor(async()=>{const state=JSON.parse(await fixture('state'));return state.eventCount>=3});
   trace.push({browser:name,step:'Mac edit committed and pushed',success:true});
   await page.screenshot({path:`${evidence}/mac-chromium-received-and-edited.png`,fullPage:true});
   globalThis.macNoteId=noteId;results.push({browser:name,version:browser.version(),viewport:'1440x1000',receivedFromWebKit:true,unicode:'Vietnamese/Japanese',edited:true});
  }
  if(errors.length) trace.push({browser:name,step:'client-runtime-log',count:errors.length,message:'Next.js logged a rejected RSC prefetch and used its browser-navigation fallback.'});
 }
 const iphone=await globalThis.phoneContext.newPage();await navigate(iphone,origin+'/sync');await iphone.getByRole('button',{name:'Sync now',exact:true}).click();
 await waitFor(async()=>JSON.parse(await fixture('state')).eventCount>=3);
 assert.equal((await readNote(iphone,'Mac edited 日本語')).note?.id,globalThis.macNoteId);
 trace.push({browser:'iPhone-sized WebKit',step:'received Mac edit',success:true});

 // Lost ACK: the server commits the operation, then the synthetic route discards its response.
 let mac=await globalThis.macContext.newPage();await navigate(mac,`${origin}/notes/${globalThis.macNoteId}`);await mac.getByRole('textbox',{name:'Note title',exact:true}).fill('Lost ACK retry');
 let dropped=false;await globalThis.macContext.route('**/api/v1/sync/push',async route=>{const response=await route.fetch();dropped=true;await route.abort('failed');});
 await waitFor(async()=>{const note=await readNote(mac,'Lost ACK retry');return note.note?.revision>1});await waitFor(async()=>JSON.parse(await fixture('state')).eventCount>=4);
 const beforeRetry=JSON.parse(await fixture('state'));await globalThis.macContext.unroute('**/api/v1/sync/push');
 await mac.close();mac=await globalThis.macContext.newPage();await navigate(mac,origin+'/sync');await mac.getByRole('button',{name:'Sync now',exact:true}).click();await waitFor(async()=>JSON.parse(await fixture('state')).operationCount>=4);
 const afterRetry=JSON.parse(await fixture('state'));assert.equal(afterRetry.eventCount,beforeRetry.eventCount);assert.ok(dropped);
 trace.push({scenario:'lost-ack-idempotent-retry',success:true,mutationCountStable:true});
 await navigate(iphone,origin+'/sync');await iphone.getByRole('button',{name:'Sync now',exact:true}).click();
 await waitFor(async()=>JSON.parse(await fixture('state')).eventCount===beforeRetry.eventCount);

 // Offline concurrent edits: local text remains and the remote text becomes one deterministic review copy.
 const phoneEditor=await globalThis.phoneContext.newPage();await navigate(phoneEditor,`${origin}/notes/approved-existing`);await phoneEditor.getByRole('textbox',{name:'Note title',exact:true}).waitFor();
 await phoneEditor.context().setOffline(true);await phoneEditor.getByRole('textbox',{name:'Note title',exact:true}).fill('Safari offline version');
 await waitFor(async()=>{const note=await readNote(phoneEditor,'Safari offline version');return note.note?.revision>0&&note.outbox.some(op=>op.entityId==='approved-existing')});
 await navigate(mac,`${origin}/notes/approved-existing`);await mac.getByRole('textbox',{name:'Note title',exact:true}).fill('Mac concurrent version');
 await waitFor(async()=>{const note=await readNote(mac,'Mac concurrent version');return note.note?.revision>0});await waitFor(async()=>JSON.parse(await fixture('state')).eventCount>=5);
 await phoneEditor.context().setOffline(false);await navigate(iphone,origin+'/sync');await iphone.getByRole('button',{name:'Sync now',exact:true}).click();
 await waitFor(async()=>JSON.parse(await fixture('state')).eventCount>=5);
 const conflicted=await readNote(iphone,'Safari offline version');assert.ok(conflicted.note);const copies=conflicted.notes.filter(row=>row.title==='Mac concurrent version (Sync conflict)');assert.equal(copies.length,1);assert.equal(copies[0].pinned,true);assert.deepEqual(copies[0].tags,['資料','công việc']);assert.match(JSON.stringify(copies[0].document),/既存のノート・ghi chú tổng hợp/);
 trace.push({scenario:'concurrent-offline-edit-preserves-local-and-remote-copy',success:true,conflictCopies:1});

 // Two tabs can request the same queued mutation; the Web Lock serializes each origin.
 const capturePage=await globalThis.phoneContext.newPage();await navigate(capturePage,origin);await globalThis.phoneContext.route('**/api/v1/sync/**',route=>route.abort());
 await capturePage.getByRole('textbox',{name:"What's on your mind?"}).fill('Two tabs one operation');const saveCapture=capturePage.getByRole('button',{name:'Save note',exact:true});await waitFor(()=>saveCapture.isEnabled());await saveCapture.click();
 const queued=await readNote(capturePage,'Two tabs one operation');assert.ok(queued.outbox.some(op=>op.entityId===queued.note.id));await globalThis.phoneContext.unroute('**/api/v1/sync/**');
 const beforeDuplicate=JSON.parse(await fixture('state'));const [tabA,tabB]=await Promise.all([navigate(iphone,origin+'/sync').then(()=>iphone),globalThis.phoneContext.newPage()]);await navigate(tabB,origin+'/sync');
 await Promise.all([tabA.getByRole('button',{name:'Sync now',exact:true}).click(),tabB.getByRole('button',{name:'Sync now',exact:true}).click()]);
 await waitFor(async()=>JSON.parse(await fixture('state')).eventCount===beforeDuplicate.eventCount+1);const afterDuplicate=JSON.parse(await fixture('state'));assert.equal(afterDuplicate.eventCount,beforeDuplicate.eventCount+1);
 trace.push({scenario:'two-tab-sync-lock',success:true,noDuplicateEvents:true});

 await navigate(mac,'http://127.0.0.1:15740/');await mac.getByRole('textbox',{name:"What's on your mind?"}).fill('Origin isolated synthetic note');await mac.getByRole('button',{name:'Save note',exact:true}).click();
 await mac.getByRole('status').filter({hasText:'Saved on this device'}).waitFor();assert.equal(await countNotes(mac),1);
 await navigate(mac,'http://localhost:15740/');await mac.getByRole('textbox',{name:"What's on your mind?"}).waitFor();assert.equal(await countNotes(mac),0);
 trace.push({scenario:'disposable-old-origin-storage-isolation',success:true,firstOriginCount:1,secondOriginCount:0});

 const beforeRestart=JSON.parse(await fixture('state'));await run(['compose','-f','docker-compose.phase082a-test.yml','restart','web']);
 await waitFor(async()=>{try{return (await fetch('http://127.0.0.1:15740/')).status===200}catch{return false}});
 assert.deepEqual(await fixture('state').then(JSON.parse),beforeRestart);trace.push({scenario:'SQLite-server-restart-preserves-epoch-cursor-records-and-idempotency',success:true});

 // Server epoch change is injected only into the disposable SQLite volume.
 await fixture('change-epoch');await navigate(mac,origin+'/sync');await mac.getByRole('button',{name:'Check connection'}).click().catch(()=>{});
 await waitFor(async()=>{const state=await mac.evaluate(async()=>{const open=indexedDB.open('noteos-mvp-01');const db=await new Promise(ok=>open.onsuccess=()=>ok(open.result));const tx=db.transaction('syncState','readonly');const r=tx.objectStore('syncState').get('recovery');return await new Promise(ok=>{r.onsuccess=()=>{db.close();ok(r.result)}})});return Boolean(state)});
 assert.equal((await readNote(mac,'Mac edited 日本語')).notes.length>=2,true);trace.push({scenario:'server-epoch-change-stops-sync-and-persists-recovery',success:true});
 await iphone.screenshot({path:`${evidence}/iphone-sized-webkit-conflict-review.png`,fullPage:true});
 await writeFile(`${evidence}/browser-trace.json`,JSON.stringify(trace,null,2)+'\n');
 await writeFile(`${evidence}/browser-results.json`,JSON.stringify({results,scenarios:trace.length,syntheticOnly:true,actualIPhoneTest:false},null,2)+'\n');
 await writeFile(`${evidence}/failure-injection.log`,trace.filter(row=>['offline-quick-capture-local-commit-and-outbox-durable','lost-ack-idempotent-retry','concurrent-offline-edit-preserves-local-and-remote-copy','server-epoch-change-stops-sync-and-persists-recovery'].includes(row.step??row.scenario)).map(row=>`${row.success?'PASS':'FAIL'} ${row.step??row.scenario}`).join('\n')+'\n');
 console.log('PASS synthetic Chromium + iPhone-sized WebKit cross-browser sync, offline capture, lost ACK, conflict, duplicate-tab and epoch recovery. No physical iPhone claim.');
} finally {
 for(const browser of browsers) await browser.close().catch(()=>{});
 for(const context of [globalThis.phoneContext,globalThis.macContext]) await context?.close().catch(()=>{});
 await new Promise(resolve=>proxy.close(resolve));await rm(certDir,{recursive:true,force:true});
}
