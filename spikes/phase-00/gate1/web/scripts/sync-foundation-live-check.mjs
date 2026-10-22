// Fresh temporary contexts only. Never inspect a user's persistent browser profile.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),root=fileURLToPath(new URL('../../../../../',import.meta.url));
const {chromium}=require(require.resolve('playwright',{paths:[process.env.NOTEOS_PLAYWRIGHT_ROOT??`${root}/../ui-lens`]}));
const httpsOrigin=process.env.NOTEOS_LIVE_HTTPS_URL;
assert.ok(httpsOrigin?.startsWith('https://'));
const evidence=`${root}/artifacts/review/noteOS-Phase08.1-Sync-Foundation-review/evidence`;
const browser=await chromium.launch(),results=[];
try{
 for(const origin of ['http://127.0.0.1:15700',httpsOrigin]){
  const context=await browser.newContext({viewport:{width:390,height:844}});const page=await context.newPage();page.setDefaultTimeout(15000);
  try{
   const r=await page.request.get(origin+'/api/v1/sync/status');assert.equal(r.status(),503);assert.equal((await r.json()).error,'sync_disabled');assert.equal(r.headers()['set-cookie'],undefined);
   await page.goto(origin+'/sync');await page.getByText('Private API is disabled or unavailable. Local notes remain available.',{exact:true}).waitFor();await page.waitForLoadState('networkidle');
   assert.equal(await page.getByRole('button',{name:'Send summaries for preview'}).isDisabled(),true);
   assert.equal((await page.evaluate(()=>indexedDB.databases())).length,0);
   if(origin===httpsOrigin)await page.screenshot({path:`${evidence}/live-disabled-sync-phone.png`,fullPage:true});
   await page.goto(origin);const input=page.getByRole('textbox',{name:"What's on your mind?"});await input.waitFor();await input.focus();
   assert.ok(await input.evaluate(el=>parseFloat(getComputedStyle(el).fontSize))>=16);
   assert.ok(await page.getByRole('searchbox',{name:'Search notes'}).evaluate(el=>parseFloat(getComputedStyle(el).fontSize))>=16);
   results.push({origin,syncApi:'disabled-503',noAutomaticPairing:true,secureContext:await page.evaluate(()=>isSecureContext),microphoneApiPresent:await page.evaluate(()=>!!navigator.mediaDevices?.getUserMedia),phoneInputMinimum:16,personalBrowserDatabasesAccessed:false,actualIPhoneTest:false});
  }finally{await context.close();}
 }
 await writeFile(`${evidence}/live-results.json`,JSON.stringify(results,null,2)+'\n');console.log('PASS live localhost and private HTTPS: API disabled, no automatic database discovery/enrollment, local capture access and >=16px phone inputs.');
}finally{await browser.close();}
