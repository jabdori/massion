import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {memoryFindFixture} from './support/memory-find-fixture.ts';
import {verifyOwnedChild,stopOwnedChild} from './support/owned-process.ts';
test('actual DB normal CLI Chrome keyboard finds 22 exact explicit versions as 20 plus 2 and chooses inactive original, cancels and restarts without writes',{
 skip:!process.env.SURREAL_TEST_RUNTIME||!process.env.MASSION_PLAYWRIGHT_PATH,timeout:45000
},async t=>{
 const f=await memoryFindFixture(t,true,true),before=await f.current(),journal=await f.journal();
 const database=(await f.transport!.query('RETURN $session.db;',{}))[0] as string,{chromium}=await import(process.env.MASSION_PLAYWRIGHT_PATH!);
 const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const address=probe.address();assert.ok(address&&typeof address==='object');await new Promise<void>(r=>probe.close(()=>r()));
 const argv=[process.execPath,fileURLToPath(new URL('../src/server.ts',import.meta.url))],env={MASSION_SURREAL_RPC:process.env.MASSION_TEST_SURREAL_RPC!,MASSION_SURREAL_NAMESPACE:process.env.MASSION_TEST_SURREAL_NAMESPACE!,MASSION_SURREAL_DATABASE:database,MASSION_PORT:String(address.port)};
 let child:ReturnType<typeof spawn>|undefined,logs='',browser:Awaited<ReturnType<typeof chromium.launch>>|undefined,posts=0,reads=0,finds=0;
 const start=async()=>{logs='';child=spawn(process.execPath,argv.slice(1),{cwd:f.root,env,stdio:['ignore','pipe','pipe']});child.stdout!.on('data',d=>logs+=d);child.stderr!.on('data',d=>logs+=d);await f.until(()=>{assert.equal(child!.exitCode,null,logs);return logs.includes('Massion development workbench:');});};
 try{
  browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});await start();
  for(const restarted of [false,true]){
   const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();page.on('request',(r:any)=>{if(r.method()==='POST')posts++;if(r.method()==='GET'&&r.url().includes('/memory-usage?'))reads++;if(r.method()==='GET'&&r.url().includes('/memory-versions?'))finds++;});
   await page.goto('http://127.0.0.1:'+address.port+'/#mission=mission');await page.waitForFunction(()=>document.getElementById('loaded-id')?.textContent==='mission'&&document.getElementById('sync-notice')?.hidden);
   assert.deepEqual(await f.journal(),journal);assert.deepEqual(await f.current(),before);assert.equal(reads,restarted?1:0);assert.equal(finds,restarted?2:0);
   await page.locator('#memory-find-panel > summary').focus();await page.keyboard.press('Enter');await page.locator('#memory-find-id').fill(JSON.stringify(f.id));assert.equal(await page.locator('#memory-find-id').inputValue(),JSON.stringify(f.id));await page.locator('#memory-find-read').focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.getElementById('memory-find-status')?.textContent?.includes('showing 20'));assert.equal(await page.locator('#memory-find-results button').count(),20);assert.equal(await page.locator('#memory-find-results img').count(),0);
   await page.locator('#memory-find-more').focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.getElementById('memory-find-status')?.textContent?.includes('positions 21–22'));assert.equal(await page.locator('#memory-find-results button').count(),2);assert.equal(await page.locator('#memory-find-more').isDisabled(),true);assert.equal(finds,restarted?4:2);assert.equal(reads,restarted?1:0);
   await page.locator('#memory-find-results button').first().focus();await page.keyboard.press('Enter');assert.equal(await page.locator('#memory-usage-target').inputValue(),JSON.stringify([f.id,21]));assert.equal(await page.locator('#memory-find-results').isHidden(),true);assert.equal(reads,restarted?1:0);await page.keyboard.press('Enter');await page.waitForFunction(()=>document.getElementById('memory-usage-status')?.textContent?.includes('retained Work uses'));const result=JSON.parse(await page.locator('#memory-usage-result').textContent()||'{}');assert.equal(result.memory.id,f.id);assert.equal(result.memory.version,21);assert.equal(result.memory.effective,false);assert.equal(result.uses.length,0);assert.equal(reads,restarted?2:1);
   await page.locator('#memory-usage-cancel').focus();await page.keyboard.press('Enter');assert.equal(await page.locator('#memory-usage-result').isHidden(),true);assert.deepEqual(await f.journal(),journal);assert.deepEqual(await f.current(),before);
   for(const width of [390,1280]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}assert.equal(posts,0);await context.close();
   if(!restarted){await stopOwnedChild(child!,{cwd:f.root,argv});child=undefined;await start();}
  }
  t.diagnostic(JSON.stringify({...await verifyOwnedChild(child!,{cwd:f.root,argv}),normalCLI:true,keyboardMemoryChoice:true,freshBrowserAfterOwnedRestart:true,readWrites:0,cancelWrites:0,posts,usageGETs:reads,explicitFindGETs:finds,explicit20plus2:true,originalSnapshotJournalExact:true,providerCalls:0,modelCalls:0,liveCalls:0}));
 }finally{if(browser)await browser.close();if(child)await stopOwnedChild(child,{cwd:f.root,argv});}
});
