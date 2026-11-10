import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {LoginConnections} from '../src/connection-logins.ts';
import {spawnCliRunner} from '../src/cli-process.ts';
import type {CliResult} from '../src/cli-agent-providers.ts';

for(const mode of ['login drain','status drain','status abort before drain'] as const){
 test(`${mode} waits for real runner cleanup after SIGTERM is ignored`,{skip:process.platform==='win32'},async t=>{
  const root=await mkdtemp(join(tmpdir(),'login-cleanup-')),ready=join(root,'ready');
  const script='process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)';
  let cleanup:Promise<CliResult>|undefined,cleaned=false,calls=0;
  const logins=new LoginConnections(call=>{
   calls++;
   // Use the real process runner with a local helper and no inherited credentials.
   cleanup=spawnCliRunner({...call,command:process.execPath,args:['-e',script,ready],env:{}});
   void cleanup.then(()=>{cleaned=true;});
   return cleanup;
  });
  t.after(async()=>{logins.beginDrain();await cleanup;await rm(root,{recursive:true,force:true});});
  const controller=new AbortController();
  const response=mode==='login drain'?undefined:logins.recheck('codex-cli',controller.signal);
  if(!response)assert.equal((await logins.start({providerType:'codex-cli',commandId:'cleanup:login'})).status,'started');
  let pid:number|undefined;const deadline=Date.now()+3000;
  while(pid===undefined){
   try{const value=Number(await readFile(ready,'utf8'));if(Number.isSafeInteger(value)&&value>0)pid=value;}
   catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   assert.ok(Date.now()<deadline,'helper installed its SIGTERM handler');
   if(pid===undefined)await delay(10);
  }
  assert.equal(cleaned,false);
  if(mode==='status abort before drain'){
   controller.abort();
   assert.equal((await response!).status,'unknown');
   assert.equal(cleaned,false,'the caller responds before process cleanup');
  }
  const draining=logins.drain();
  if(mode==='status drain'){
   assert.equal((await response!).status,'unknown');
   assert.equal(cleaned,false,'the caller responds before process cleanup');
  }
  await draining;
  assert.equal(cleaned,true,'drain must await underlying process cleanup, not only the aborted tool wrapper');
  assert.throws(()=>process.kill(pid!,0),{code:'ESRCH'});
  assert.equal(calls,1,'cleanup never retries a login or status command');
 });
}

test('login drain kills a stdio-detached descendant even when the direct child exits on SIGTERM',{skip:process.platform==='win32'},async t=>{
 const root=await mkdtemp(join(tmpdir(),'login-descendant-')),ready=join(root,'ready');
 const descendant='process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(process.argv[1],JSON.stringify({direct:process.ppid,descendant:process.pid}));setInterval(()=>{},1000)';
 const script='process.on("SIGTERM",()=>process.exit(0));require("node:child_process").spawn(process.execPath,["-e",'+JSON.stringify(descendant)+',process.argv[1]],{stdio:"ignore"});setInterval(()=>{},1000)';
 let cleanup:Promise<CliResult>|undefined,pids:{direct:number;descendant:number}|undefined;
 const logins=new LoginConnections(call=>cleanup=spawnCliRunner({...call,command:process.execPath,args:['-e',script,ready],env:{}}));
 const running=(pid:number)=>{
  try{const status=execFileSync('/bin/ps',['-o','stat=','-p',String(pid)],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();return status!==''&&!status.startsWith('Z');}
  catch{return false;}
 };
 t.after(async()=>{
  logins.beginDrain();
  if(pids){try{process.kill(-pids.direct,'SIGKILL');}catch{}}
  await cleanup;await rm(root,{recursive:true,force:true});
 });
 await logins.start({providerType:'codex-cli',commandId:'cleanup:descendant'});
 const deadline=Date.now()+3000;
 while(!pids){
  try{pids=JSON.parse(await readFile(ready,'utf8'));}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
  assert.ok(Date.now()<deadline,'descendant installed its SIGTERM handler');
  if(!pids)await delay(10);
 }
 assert.ok(Number.isSafeInteger(pids.direct)&&pids.direct>0&&Number.isSafeInteger(pids.descendant)&&pids.descendant>0);
 assert.equal(running(pids.direct),true);assert.equal(running(pids.descendant),true);
 await logins.drain();
 assert.equal((await cleanup!).aborted,true);
 assert.equal(running(pids.direct),false,'the direct child has exited');
 assert.equal(running(pids.descendant),false,'drain cannot leave a live descendant awaiting a future SIGKILL timer');
});
