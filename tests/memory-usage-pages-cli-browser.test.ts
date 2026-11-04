import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {memoryUsagePagesFixture} from './support/memory-usage-pages-fixture.ts';
import {verifyOwnedChild,stopOwnedChild} from './support/owned-process.ts';
test('actual DB normal CLI Chrome keyboard reads 22 exact memory uses as explicit 20 plus 2, cancels and restarts without writes',{
 skip:!process.env.SURREAL_TEST_RUNTIME||!process.env.MASSION_PLAYWRIGHT_PATH,timeout:45000
},async t=>{
 const f=await memoryUsagePagesFixture(t,true,true),before=await f.current(),journal=await f.journal();
 const database=(await f.transport!.query('RETURN $session.db;',{}))[0] as string,{chromium}=await import(process.env.MASSION_PLAYWRIGHT_PATH!);
 const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const address=probe.address();assert.ok(address&&typeof address==='object');await new Promise<void>(r=>probe.close(()=>r()));
 const argv=[process.execPath,fileURLToPath(new URL('../src/server.ts',import.meta.url))],env={MASSION_SURREAL_RPC:process.env.MASSION_TEST_SURREAL_RPC!,MASSION_SURREAL_NAMESPACE:process.env.MASSION_TEST_SURREAL_NAMESPACE!,MASSION_SURREAL_DATABASE:database,MASSION_PORT:String(address.port)};
 let child:ReturnType<typeof spawn>|undefined,logs='',browser:Awaited<ReturnType<typeof chromium.launch>>|undefined,posts=0,reads=0;
 const start=async()=>{logs='';child=spawn(process.execPath,argv.slice(1),{cwd:f.root,env,stdio:['ignore','pipe','pipe']});child.stdout!.on('data',d=>logs+=d);child.stderr!.on('data',d=>logs+=d);await f.until(()=>{assert.equal(child!.exitCode,null,logs);return logs.includes('Massion development workbench:');});};
 try{
  browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});await start();
  for(const restarted of [false,true]){
   const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();page.on('request',(r:any)=>{if(r.method()==='POST')posts++;if(r.method()==='GET'&&r.url().includes('/memory-usage?'))reads++;});
   await page.goto('http://127.0.0.1:'+address.port+'/#mission=mission');await page.waitForFunction(()=>document.getElementById('loaded-id')?.textContent==='mission'&&document.getElementById('sync-notice')?.hidden);
   assert.deepEqual(await f.journal(),journal);assert.deepEqual(await f.current(),before);assert.equal(reads,restarted?2:0);
   await page.locator('#memory-usage-panel > summary').focus();await page.keyboard.press('Enter');await page.locator('#memory-usage-target').focus();for(let i=0;i<1;i++)await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
   assert.equal(await page.locator('#memory-usage-target').inputValue(),JSON.stringify([f.id,1]));await page.locator('#memory-usage-read').focus();await page.keyboard.press('Enter');
   await page.waitForFunction(()=>!(document.getElementById('memory-usage-result') as HTMLElement).hidden||document.getElementById('memory-usage-status')?.textContent?.includes('No newer version substituted'));
   const status=await page.locator('#memory-usage-status').textContent();t.diagnostic(JSON.stringify({normalCLI:true,restarted,literalID:f.id,readStatus:status,snapshotUnchanged:JSON.stringify(await f.current())===JSON.stringify(before),journalUnchanged:JSON.stringify(await f.journal())===JSON.stringify(journal),posts,modelCalls:0}));
   assert.equal(await page.locator('#memory-usage-result').isHidden(),false,status||'');const result=JSON.parse(await page.locator('#memory-usage-result').textContent()||'{}');
   assert.equal(result.memory.id,f.id);assert.equal(result.versionHash,(await f.query()).versionHash);assert.equal(result.memory.content,'Original page memory <img src=x>\r\n원문 😀');assert.equal(result.uses[0].record.id,'page-record');assert.deepEqual(result.uses[0].record.memoryVersions,before.value.works.find(w=>w.id==='use-00')!.record!.memoryVersions);assert.equal(result.uses.length,20);assert.equal(result.nextAfter,20);assert.equal(reads,restarted?3:1);await page.locator('#memory-usage-more').focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.getElementById('memory-usage-status')?.textContent?.includes('positions 21–22'));const last=JSON.parse(await page.locator('#memory-usage-result').textContent()||'{}');assert.equal(last.uses.length,2);assert.equal(last.offset,20);assert.equal(last.nextAfter,null);assert.equal(await page.locator('#memory-usage-more').isDisabled(),true);assert.deepEqual([...result.uses,...last.uses].map((u:any)=>u.workId),Array.from({length:22},(_,i)=>'use-'+String(i).padStart(2,'0')));assert.equal(reads,restarted?4:2);assert.equal(await page.locator('#memory-usage-result img').count(),0);
   await page.locator('#memory-usage-cancel').focus();await page.keyboard.press('Enter');assert.equal(await page.locator('#memory-usage-result').isHidden(),true);assert.deepEqual(await f.journal(),journal);assert.deepEqual(await f.current(),before);
   for(const width of [390,1280]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}assert.equal(posts,0);await context.close();
   if(!restarted){await stopOwnedChild(child!,{cwd:f.root,argv});child=undefined;await start();}
  }
  t.diagnostic(JSON.stringify({...await verifyOwnedChild(child!,{cwd:f.root,argv}),normalCLI:true,keyboardMemoryChoice:true,freshBrowserAfterOwnedRestart:true,readWrites:0,cancelWrites:0,posts,usageGETs:reads,explicit20plus2:true,originalSnapshotJournalExact:true,providerCalls:0,modelCalls:0,liveCalls:0}));
 }finally{if(browser)await browser.close();if(child)await stopOwnedChild(child,{cwd:f.root,argv});}
});
