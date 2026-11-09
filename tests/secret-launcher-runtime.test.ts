import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {lifetimeFixture} from './support/runtime-lifetime-fixture.ts';
import {ConfiguredTextRuntime} from '../src/configured-runtime.ts';
import {cliProfileFactory} from '../src/cli-agent-providers.ts';
import type {CliResult} from '../src/cli-agent-providers.ts';
import {CliLauncher} from '../src/cli-launcher.ts';
import {InMemorySecretSlots} from '../src/secret-slots.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';
import {createWorkbench} from '../src/server.ts';

const ok=(stdout=''):CliResult=>({spawned:true,exitCode:0,stdout,stderr:'',timedOut:false,aborted:false,overflow:false});
for(const timeout of [false,true])test(`secret CLI ${timeout?'timeout is durably unknown and never resent':'output is redacted before Records, artifacts and client reads'}`,async t=>{
 const f=await lifetimeFixture(t),secrets=new InMemorySecretSlots(),slot={owner:'fixture',slot:'token'},sentinel=randomUUID();await secrets.set(slot,sentinel);let sends=0;
 const executor=cliProfileFactory('claude-code-cli/v1',{mode:'local-http-mock',runner:async call=>{
  const launcher=new CliLauncher({command:process.execPath,args:call.args,environment:[],secrets:{TOOL_TOKEN:slot},readOnly:false,signature:{teamId:'FIXTURE123',identifier:'test.fixture'}},secrets,{prepare:async()=>async()=>{},runner:async child=>{
   sends++;assert.equal(child.env.TOOL_TOKEN,sentinel);
   if(timeout)return new Promise(()=>{});
   return {...ok(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Original bounded lifetime fixture '+sentinel,num_turns:1,usage:{input_tokens:1,output_tokens:1},modelUsage:{'fixture-model':{}}})),stderr:sentinel};
  }});
  return launcher.launch(call.invocationId!,{...call,command:process.execPath});
 }}).create({id:'fixture-cli',label:'Fixture',backend:'model-provider',providerKind:'fixture-cli',protocol:'claude-code-cli/v1',model:'fixture-model',endpoint:'cli://fixture/run',revision:'v1',enabled:true,auth:{method:'cli-login'},capabilities:['text-output'],usage:{inputTokens:'reported',outputTokens:'reported',cost:'unknown'},limits:{maxInputBytes:65536,maxOutputTokens:4,maxResponseBytes:65536,timeoutMs:timeout?25:1000}});
 const config={...f.config,executor:{identity:'host-executor',adapter:executor},authorization:{...f.config.authorization,executor:executor.descriptor}},runtime=new ConfiguredTextRuntime(f.store,config),revision=(await f.current()).revision;
 const logs:string[]=[];t.mock.method(console,'error',(...args:unknown[])=>logs.push(String(args)));
 const [a,b]=await Promise.all([runtime.run('mission','fresh','slot-run',revision),runtime.run('mission','fresh','slot-run',revision)]);
 const current=await f.current(),work=current.value.works.find(w=>w.id==='fresh')!;
 assert.equal(sends,1);assert.ok([a,b].some(r=>r.status===(timeout?'blocked':'settled')));assert.equal(work.effects[0]!.status,timeout?'unknown':'succeeded');assert.equal(work.runtimeRun!.toolTimeoutVersion,'tool-timeouts/v1');
 if(timeout){assert.equal(work.record,undefined);assert.equal((await new ConfiguredTextRuntime(f.store,config).run('mission','fresh','new-run',current.revision)).status,'already-started');assert.equal(sends,1);}
 else{assert.ok(work.record);const content=await f.artifacts.read(work.artifact!);assert.match(content,/REDACTED/);assert.ok(!content.includes(sentinel));}
 const journal=await f.journal();validateMissionJournalLineage(journal);assert.ok(!JSON.stringify([a,b,journal,current,logs]).includes(sentinel));
 const server=createWorkbench(f.store,f.root,{runtime,artifacts:f.artifacts,scheduleIntervalMs:0});await new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>r()));t.after(()=>server.close());
 const response=await fetch('http://127.0.0.1:'+(server.address() as {port:number}).port+'/read-state?mission=mission');assert.equal(response.status,200);assert.ok(!(await response.text()).includes(sentinel));
});
