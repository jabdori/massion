/** Normal CLI with owned loopback services only; no provider credentials or calls. */
import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {mkdtemp,readFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createHttpRpcTransport,SurrealStore} from '../src/storage.ts';
import {parsePortableBackup} from '../src/portable-backup.ts';

const entry=fileURLToPath(new URL('../src/server.ts',import.meta.url)),backupCLI=fileURLToPath(new URL('../scripts/backup.ts',import.meta.url));
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(check:()=>boolean){const deadline=Date.now()+10000;while(!check()){assert.ok(Date.now()<deadline,'Smoke startup deadline');await pause(10);}}
async function root(t:TestContext){const path=await mkdtemp(join(await realpath(tmpdir()),'massion-release-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
async function freePort(){const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');await new Promise<void>(r=>server.close(()=>r()));return address.port;}
async function host(t:TestContext,cwd:string,env:NodeJS.ProcessEnv,args:string[]=[]){
 const port=await freePort(),child=spawn(process.execPath,[entry,...args],{cwd,env:{...env,MASSION_PORT:String(port)},stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
 const exited=once(child,'exit');
 t.after(async()=>{if(child.exitCode!==null||child.signalCode!==null)return;child.kill('SIGTERM');const timer=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');},3000);try{await exited;}finally{clearTimeout(timer);}});
 return {child,exited,logs:()=>logs,base:`http://127.0.0.1:${port}`,
  ready:()=>until(()=>{assert.equal(child.exitCode,null,logs);assert.equal(child.signalCode,null,logs);return logs.includes('Massion development workbench:');}),
  stop:async()=>{child.kill('SIGTERM');const [code,signal]=await exited;assert.equal(signal,null,logs);assert.equal(code,0,logs);assert.match(logs,/"status":"drained"/);}};
}

for(const signal of ['SIGINT','SIGTERM'] as const)test(`normal CLI ${signal} during schema startup waits for the admitted write and never opens HTTP`,{timeout:15000},async t=>{
 const cwd=await root(t);let release!:()=>void,received=false,calls=0;
 const gate=new Promise<void>(r=>release=r);t.after(()=>release());
 const rpc=createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);calls++;received=true;await gate;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:body.id,result:[null,null,true,null].map(result=>({status:'OK',result}))}));});
 rpc.listen(0,'127.0.0.1');await once(rpc,'listening');t.after(()=>{rpc.closeAllConnections();rpc.close();});const address=rpc.address();assert.ok(address&&typeof address==='object');
 const cli=await host(t,cwd,{MASSION_SURREAL_RPC:`http://127.0.0.1:${address.port}/rpc`});await until(()=>received);
 cli.child.kill(signal);await pause(100);release();
 const [code,stoppedBy]=await cli.exited;assert.equal(stoppedBy,null,cli.logs());assert.equal(code,0,cli.logs());
 assert.match(cli.logs(),/"status":"drained"/);assert.doesNotMatch(cli.logs(),/Massion development workbench:/);assert.equal(calls,1);
 await assert.rejects(fetch(cli.base+'/health',{signal:AbortSignal.timeout(500)}));
});

test('normal CLI unknown migration during shutdown exits unsettled without resubmission',{timeout:15000},async t=>{
 const cwd=await root(t);let release!:()=>void,received=false,writes=0,reads=0;
 const gate=new Promise<void>(r=>release=r);t.after(()=>release());
 const rpc=createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);
  if(body.params[0].includes('BEGIN TRANSACTION')){writes++;received=true;await gate;res.destroy();return;}
  reads++;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:body.id,result:[{status:'OK',result:null}]}));
 });
 rpc.listen(0,'127.0.0.1');await once(rpc,'listening');t.after(()=>{rpc.closeAllConnections();rpc.close();});const address=rpc.address();assert.ok(address&&typeof address==='object');
 const cli=await host(t,cwd,{MASSION_SURREAL_RPC:`http://127.0.0.1:${address.port}/rpc`});await until(()=>received);
 cli.child.kill('SIGTERM');await pause(100);release();const [code,signal]=await cli.exited;
 assert.equal(signal,null);assert.equal(code,1);assert.match(cli.logs(),/unsettled/);assert.doesNotMatch(cli.logs(),/Massion development workbench:|"status":"drained"/);assert.equal(writes,1);assert.equal(reads,1);
});

test('installed normal CLI creates data once, drains, restarts, backs up and restores with fixtures',{skip:!process.env.MASSION_TEST_SURREAL_RPC,timeout:45000},async t=>{
 const cwd=await root(t),endpoint=process.env.MASSION_TEST_SURREAL_RPC!,namespace='smoke_'+randomUUID().replaceAll('-','');
 const admin=createHttpRpcTransport({endpoint,namespace:'massion_storage_tests',database:'massion_storage_tests'});
 await admin.query(`DEFINE NAMESPACE ${namespace}; USE NS ${namespace}; DEFINE DATABASE source; DEFINE DATABASE restored; DEFINE DATABASE fixture;`,{});
 const env={MASSION_SURREAL_RPC:endpoint,MASSION_SURREAL_NAMESPACE:namespace,MASSION_SURREAL_DATABASE:'source'};
 const transport=createHttpRpcTransport({endpoint,namespace,database:'source'}),store=new SurrealStore(transport);
 const cli=await host(t,cwd,env);await cli.ready();
 assert.equal((await fetch(cli.base+'/health')).status,200);assert.match(await (await fetch(cli.base)).text(),/<html/);
 assert.equal((await (await fetch(cli.base+'/connections')).json()).liveExecutionEnabled,false);
 const input={id:'smoke',commandId:'smoke-create',purpose:'Offline release fixture',scope:'local',constraints:[],criteria:{version:1,description:'Retain the owner request',oracle:'fixture/v1'}};
 const send=()=>fetch(cli.base+'/missions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
 const responses=await Promise.all([send(),send()]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,201]);
 const receipts=await Promise.all(responses.map(r=>r.json()));assert.deepEqual(receipts[0].value,receipts[1].value);
 const original=await store.exportJournal();assert.equal(original.operations.length,1);
 const state=await (await fetch(cli.base+'/read-state?mission=smoke')).json();
 await cli.stop();
 const restart=await host(t,cwd,env);await restart.ready();
 assert.deepEqual(await (await fetch(restart.base+'/read-state?mission=smoke')).json(),state);await restart.stop();
 const bundle=join(cwd,'backup.json'),nativeRoot=join(cwd,'.runtime/workspaces/model-artifacts'),restoredRoot=join(cwd,'restored-artifacts');
 function backup(mode:string,database:string,artifactRoot:string){const result=spawnSync(process.execPath,[backupCLI,mode,endpoint,namespace,database,artifactRoot,bundle],{cwd,env:{},encoding:'utf8',timeout:15000});assert.equal(result.status,0,result.stderr);return result.stdout;}
 backup('export','source',nativeRoot);
 assert.deepEqual(parsePortableBackup(await readFile(bundle,'utf8')).journal,original);
 assert.equal(JSON.parse(backup('restore-check','restored',restoredRoot)).status,'within-client-budget');
 assert.equal(JSON.parse(backup('restore','restored',restoredRoot)).effectsReplayed,0);
 const restored=await host(t,cwd,{...env,MASSION_SURREAL_DATABASE:'restored'},['--restored-bundle',bundle,'--restored-artifact-root',restoredRoot]);await restored.ready();
 const restoredState=await (await fetch(restored.base+'/read-state?mission=smoke')).json();assert.deepEqual(restoredState.snapshot,state.snapshot);assert.notEqual(restoredState.feedId,state.feedId);
 const stale=await fetch(restored.base+'/missions',{method:'POST',headers:{'content-type':'application/json','x-massion-feed':state.feedId},body:JSON.stringify({...input,id:'stale',commandId:'stale'})});assert.equal(stale.status,409);
 await restored.stop();
 const demo=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/demo.ts',import.meta.url))],{cwd,env:{...env,MASSION_SURREAL_DATABASE:'fixture'},encoding:'utf8',timeout:15000});assert.equal(demo.status,0,demo.stderr);
 const scenario=JSON.parse(demo.stdout);assert.equal(scenario.realProvider,false);
 for(const id of [scenario.workA,scenario.workB]){const work=scenario.works.find((w:any)=>w.id===id);assert.equal(work?.acceptance,'accepted');assert.ok(work.record);}
 await transport.query('UPDATE massion_feed:global SET storageVersion=2;',{});
 const refused=await host(t,cwd,env),[code]=await refused.exited;assert.equal(code,1);assert.match(refused.logs(),/Unsupported storage schema version/);assert.doesNotMatch(refused.logs(),/Massion development workbench:/);
 assert.deepEqual(await store.exportJournal(),original);
 t.diagnostic('Normal CLI, offline fixtures, restart, backup/restore, stale-feed refusal, future-schema refusal; live provider calls: 0');
});
