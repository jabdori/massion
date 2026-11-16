import test from 'node:test';
import assert from 'node:assert/strict';
import {lifetimeFixture} from './support/runtime-lifetime-fixture.ts';
import {ConfiguredTextRuntime} from '../src/configured-runtime.ts';
import {cliProfileFactory} from '../src/cli-agent-providers.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';
import {createWorkbench} from '../src/server.ts';

test('a timed-out CLI run is durably unknown and never resent',async t=>{
 const f=await lifetimeFixture(t);let sends=0;
 const executor=cliProfileFactory('claude-code-cli/v1',{mode:'local-http-mock',runner:async()=>{sends++;return new Promise(()=>{});}}).create({id:'fixture-cli',label:'Fixture',backend:'model-provider',providerKind:'fixture-cli',protocol:'claude-code-cli/v1',model:'fixture-model',endpoint:'cli://fixture/run',revision:'v1',enabled:true,auth:{method:'cli-login'},capabilities:['text-output'],usage:{inputTokens:'reported',outputTokens:'reported',cost:'unknown'},limits:{maxInputBytes:65536,maxOutputTokens:4,maxResponseBytes:65536,timeoutMs:25}});
 const config={...f.config,executor:{identity:'host-executor',adapter:executor},authorization:{...f.config.authorization,executor:executor.descriptor}},runtime=new ConfiguredTextRuntime(f.store,config),revision=(await f.current()).revision;
 const [a,b]=await Promise.all([runtime.run('mission','fresh','slot-run',revision),runtime.run('mission','fresh','slot-run',revision)]);
 const current=await f.current(),work=current.value.works.find(w=>w.id==='fresh')!;
 assert.equal(sends,1);assert.ok([a,b].some(r=>r.status==='blocked'));assert.equal(work.effects[0]!.status,'unknown');assert.equal(work.runtimeRun!.toolTimeoutVersion,'tool-timeouts/v1');
 assert.equal(work.record,undefined);
 assert.equal((await new ConfiguredTextRuntime(f.store,config).run('mission','fresh','new-run',current.revision)).status,'already-started');assert.equal(sends,1);
 const journal=await f.journal();validateMissionJournalLineage(journal);
 const server=createWorkbench(f.store,f.root,{runtime,artifacts:f.artifacts,scheduleIntervalMs:0});await new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>r()));t.after(()=>server.close());
 const response=await fetch('http://127.0.0.1:'+(server.address() as {port:number}).port+'/read-state?mission=mission');assert.equal(response.status,200);
});
