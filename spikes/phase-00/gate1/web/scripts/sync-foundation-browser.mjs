import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { localNotes } from './sync-foundation-fixtures.mjs';

const require=createRequire(import.meta.url),root=fileURLToPath(new URL('../../../../../',import.meta.url));
const {chromium,webkit}=require(require.resolve('playwright',{paths:[process.env.NOTEOS_PLAYWRIGHT_ROOT??`${root}/../ui-lens`]}));
const evidence=process.env.NOTEOS_SYNC_EVIDENCE??`${root}/artifacts/review/noteOS-Phase08.1-Sync-Foundation-review/evidence`;
const container='noteos-sync-foundation-test-web-1';
const fixture=async action=>(await promisify(execFile)('docker',['exec',container,'node','/verification/fixture.mjs',action])).stdout.trim();
await mkdir(evidence,{recursive:true});
const proxy=createServer({key:await readFile('/tmp/noteos-phase081-tls.key'),cert:await readFile('/tmp/noteos-phase081-tls.crt')},(req,res)=>{
  const target=http.request({hostname:'127.0.0.1',port:15720,path:req.url,method:req.method,headers:req.headers},up=>{res.writeHead(up.statusCode,up.headers);up.pipe(res);});
  target.on('error',()=>{res.writeHead(502);res.end();});req.pipe(target);
});
await new Promise(resolve=>proxy.listen(15721,'127.0.0.1',resolve));
const results=[];
async function localState(page) {
 return page.evaluate(async()=>{
  const req=indexedDB.open('noteos-mvp-01');const db=await new Promise((ok,fail)=>{req.onsuccess=()=>ok(req.result);req.onerror=()=>fail(req.error);});
  const tx=db.transaction(['notes','recordings','recordingChunks'],'readonly');
  const values=await Promise.all(['notes','recordings','recordingChunks'].map(s=>new Promise((ok,fail)=>{const r=tx.objectStore(s).getAll();r.onsuccess=()=>ok(r.result);r.onerror=()=>fail(r.error);})));db.close();return JSON.stringify(values);
 });
}
async function seedClient(page) {
 await page.goto('https://localhost:15721/');await page.getByRole('textbox',{name:"What's on your mind?"}).waitFor();await page.waitForLoadState('networkidle');
 await page.evaluate(async notes=>{
  const req=indexedDB.open('noteos-mvp-01');const db=await new Promise((ok,fail)=>{req.onsuccess=()=>ok(req.result);req.onerror=()=>fail(req.error);});
  const tx=db.transaction(['notes','recordings'],'readwrite');const done=new Promise((ok,fail)=>{tx.oncomplete=ok;tx.onerror=tx.onabort=()=>fail(tx.error);});
  for(const note of notes)tx.objectStore('notes').add(note);
  tx.objectStore('recordings').add({id:'synthetic-recording',noteId:'audio',title:'Synthetic metadata only',status:'complete',mimeType:'audio/webm',createdAt:1,updatedAt:1,ownerId:'synthetic',sourcePlatform:'web',chunkCount:0,durationMs:0});
  await done;db.close();
 },localNotes);
}
async function checkPhoneInputs(page) {
 const items=await page.locator('input:not([type=checkbox]):not([type=radio]),textarea,select,[contenteditable=true]').all();
 let count=0;
 for(const input of items)if(await input.isVisible()){
  const size=await input.evaluate(el=>parseFloat(getComputedStyle(el).fontSize));assert.ok(size>=16,`Phone input font is ${size}px`);await input.focus();count++;
 }
 assert.ok(count>0);return count;
}
try {
 for(const [name,engine] of [['chromium',chromium],['webkit',webkit]]) {
  const browser=await engine.launch();const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1100}});
  const page=await context.newPage();page.setDefaultTimeout(10000);const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  try {
   await seedClient(page);const before=await localState(page),serverBefore=await fixture('state');
   await page.goto('https://localhost:15721/sync');await page.getByText('This browser is not paired.',{exact:true}).waitFor();await page.waitForLoadState('networkidle');
   await page.getByRole('button',{name:'Inspect this browser'}).click();await page.getByText('5 local notes · 1 local recordings',{exact:true}).waitFor();
   const code=await fixture('pair');
   await page.getByLabel('Device label',{exact:true}).fill(`Synthetic ${name}`);await page.getByLabel('Pairing code',{exact:true}).fill(code);
   await page.getByRole('button',{name:'Pair this browser',exact:true}).click();await page.getByText('This browser is paired. Preview only.',{exact:true}).waitFor();
   assert.equal(await page.getByLabel('Pairing code',{exact:true}).count(),0);
   const cookies=await context.cookies();const session=cookies.find(c=>c.name==='__Secure-noteos_sync');assert.ok(session?.secure&&session?.httpOnly&&session?.sameSite==='Strict');
   assert.equal(await page.evaluate(()=>document.cookie.includes('__Secure-noteos_sync')),false);
   assert.equal(await page.evaluate(secret=>JSON.stringify({...localStorage}).includes(secret),session.value),false);
   await page.getByRole('button',{name:'Send summaries for preview'}).click();await page.locator('.sync-preview').waitFor();
   const counts=await page.locator('.sync-preview dd').allTextContents();assert.deepEqual(counts,['1','1','1','2','1']);
   assert.equal(await localState(page),before);assert.equal(await fixture('state'),serverBefore);
   await page.evaluate(()=>window.scrollTo(0,0));
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   await page.screenshot({path:`${evidence}/${name}-dry-run-desktop.png`,fullPage:true});
   await page.setViewportSize({width:390,height:844});await page.evaluate(()=>window.scrollTo(0,0));
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   assert.ok(Math.abs(await page.locator('.mobile-head').evaluate(el=>el.getBoundingClientRect().top))<=1);
   await page.screenshot({path:`${evidence}/${name}-dry-run-phone.png`,fullPage:true});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   await page.waitForLoadState('networkidle');await page.goto('https://localhost:15721/');await page.waitForLoadState('networkidle');const homeInputs=await checkPhoneInputs(page);
   await page.goto('https://localhost:15721/notes/equal');await page.getByRole('textbox',{name:'Note title',exact:true}).waitFor();await page.waitForLoadState('networkidle');const editorInputs=await checkPhoneInputs(page);
   assert.ok(await page.getByRole('textbox',{name:'Note title',exact:true}).evaluate(el=>parseFloat(getComputedStyle(el).fontSize))>=29);
   await page.goto('https://localhost:15721/backup');await page.waitForLoadState('networkidle');const backupInputs=await checkPhoneInputs(page);
   await page.goto('https://localhost:15721/sync');await page.getByText('This browser is paired. Preview only.',{exact:true}).waitFor();await page.waitForLoadState('networkidle');
   const negative=await page.request.post('https://localhost:15721/api/v1/sync/bootstrap/dry-run',{headers:{Origin:'https://unapproved.example','X-NoteOS-Sync':'1'},data:{protocolVersion:1,records:[]}});assert.equal(negative.status(),403);
   await page.getByRole('button',{name:'Revoke this browser'}).click();await page.getByText('This browser is not paired.',{exact:true}).waitFor();const pairInputs=await checkPhoneInputs(page);
   assert.equal((await page.request.get('https://localhost:15721/api/v1/sync/status')).status(),401);
   assert.equal(await page.evaluate(()=>document.querySelector('meta[name=viewport]').content.includes('user-scalable=no')),false);
   assert.deepEqual(errors,[]);
   results.push({browser:name,version:browser.version(),scenariosPassed:9,homeInputs,editorInputs,backupInputs,pairInputs,secureCookie:true,zeroNoteMutations:true,phoneFontMinimum:16,actualIPhoneTest:false});
  } catch(error) {await page.screenshot({path:`${evidence}/${name}-failure.png`,fullPage:true}).catch(()=>{});throw error;}
  finally {await context.close();await browser.close();}
 }
 const browser=await chromium.launch();const context=await browser.newContext();const page=await context.newPage();
 try {
  await page.goto('http://127.0.0.1:15720/');await page.getByRole('textbox',{name:"What's on your mind?"}).fill('Synthetic origin isolation');await page.getByRole('button',{name:'Save note',exact:true}).click();await page.getByRole('status').filter({hasText:'Saved on this device'}).waitFor();
  await page.goto('http://localhost:15720/');await page.getByText('0 notes',{exact:true}).waitFor();results.push({scenario:'real-browser-origin-isolation',passed:true});
 }finally {await context.close();await browser.close();}
 await writeFile(`${evidence}/browser-results.json`,JSON.stringify(results,null,2)+'\n');
 console.log(`PASS: ${results.length} browser runs; Chromium/WebKit HTTPS pairing, read-only preview, revocation, origin isolation and >=16px phone controls. No actual-iPhone claim.`);
} finally {await new Promise(resolve=>proxy.close(resolve));}
