import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, mkdtemp, stat } from 'node:fs/promises';
import { tmpdir, platform, release, arch, cpus, totalmem } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { seedBackupFixture, fingerprint } from './backup-v2-fixture.mjs';
const exec = promisify(execFile), require = createRequire(import.meta.url), root = fileURLToPath(new URL('../../../../../', import.meta.url));
const { chromium } = require(require.resolve('playwright',{paths:[process.env.NOTEOS_PLAYWRIGHT_ROOT ?? `${root}/../ui-lens`]}));
const baseUrl=process.env.NOTEOS_TEST_URL ?? 'http://127.0.0.1:15710', output=`${root}/artifacts/review/noteOS-Backup-V2-review/verification`;
await mkdir(output,{recursive:true}); const scratch=await mkdtemp(`${tmpdir()}/noteos-backup-v2-bench-`);
const samples=[]; let browserVersion='';
async function isolated(browser) {
  const context=await browser.newContext({acceptDownloads:true});
  await context.route('**/*',r=>new URL(r.request().url()).origin===baseUrl?r.continue():r.abort());
  return context;
}
async function measure(browser,page,operation) {
  const cdp=await browser.newBrowserCDPSession(), target=await page.context().newCDPSession(page); await target.send('Performance.enable');
  const memory=[]; let running=true;
  async function sample() {
    const processes=await cdp.send('SystemInfo.getProcessInfo'), pids=processes.processInfo.map(p=>p.id);
    const rss=await exec('ps',['-o','rss=','-p',pids.join(',')]).catch(()=>({stdout:''}));
    const metrics=await target.send('Performance.getMetrics');
    memory.push({rssBytes:rss.stdout.trim().split(/\s+/).filter(Boolean).reduce((s,v)=>s+Number(v)*1024,0),jsHeapBytes:metrics.metrics.find(m=>m.name==='JSHeapUsedSize')?.value ?? null});
  }
  await sample();
  const poll=(async()=>{while(running){await new Promise(r=>setTimeout(r,100));if(running)await sample();}})();
  const start=performance.now(); let value, durationMs;
  try{value=await operation();}finally{durationMs=performance.now()-start;running=false;await poll;}
  await sample(); await cdp.detach(); await target.detach();
  return {value,durationMs,memory:{baselineRssBytes:memory[0].rssBytes,peakSummedRssBytes:Math.max(...memory.map(m=>m.rssBytes)),baselineJsHeapBytes:memory[0].jsHeapBytes,peakJsHeapBytes:Math.max(...memory.map(m=>m.jsHeapBytes)),sampleCount:memory.length,pollMs:100}};
}
for(const sizeMiB of [50,200])for(let iteration=1;iteration<=3;iteration++){
  const browser=await chromium.launch();browserVersion=browser.version();
  const row={sizeMiB,iteration,status:'FAIL'};
  try{
    const source=await isolated(browser),page=await source.newPage(); await seedBackupFixture(page,baseUrl,sizeMiB);const before=await fingerprint(page);
    const path=`${scratch}/${sizeMiB}-${iteration}.tar`;
    const exported=await measure(browser,page,async()=>{const pending=page.waitForEvent('download',{timeout:120000});await page.getByRole('button',{name:'Download Full Archive V2',exact:true}).click();const download=await pending;await download.saveAs(path);await page.getByRole('status').filter({hasText:'Download requested for 3 notes and 2 recordings'}).waitFor();});
    row.exportMs=exported.durationMs;row.exportMemory=exported.memory;row.archiveBytes=(await stat(path)).size;await source.close();
    const target=await isolated(browser),restore=await target.newPage();await restore.goto(`${baseUrl}/backup`);await restore.locator('input[type=file]').setInputFiles(path);
    const imported=await measure(browser,restore,async()=>{await restore.getByRole('button',{name:'Validate and import',exact:true}).click();await restore.getByRole('status').filter({hasText:'Imported 3 notes and 2 recordings'}).waitFor({timeout:120000});});
    row.importMs=imported.durationMs;row.importMemory=imported.memory;assert.deepEqual(await fingerprint(restore),before);row.status='PASS';await target.close();
  }catch(error){row.error=error.stack;}finally{await browser.close();samples.push(row);console.log(JSON.stringify(row));await writeFile(`${output}/benchmark.json`,JSON.stringify({environment:{node:process.version,platform:platform(),os:release(),arch:arch(),cpu:cpus()[0].model,logicalCpus:cpus().length,totalMemoryBytes:totalmem(),browser:browserVersion},dataset:'Synthetic byte sequences, 3 Unicode notes, 2 recordings (complete/interrupted), 1 MiB chunks; no playback claim',scratch,memoryMethod:'Dedicated Chromium process IDs from CDP SystemInfo; summed RSS sampled with ps every ~100ms plus JSHeapUsedSize. Shared pages may be double-counted; Blob disk/cache allocations are not fully attributed. Not fixed-memory or zero-copy proof.',samples},null,2));}
}
if(samples.some(r=>r.status!=='PASS'))process.exitCode=1;
