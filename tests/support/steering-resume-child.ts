import {join} from 'node:path';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {InMemoryStore} from '../../src/storage.ts';
import {TextArtifactStore} from '../../src/text-artifacts.ts';
import {ConfiguredTextRuntime} from '../../src/configured-runtime.ts';
import {createWorkbench} from '../../src/server.ts';
import {fixtureOptions} from './steering-resume-fixture.ts';
const path=process.argv[2]!,mode=process.argv[3],seed=JSON.parse(await readFile(path,'utf8')),store=new InMemoryStore<any>();
// The fixture reloads the same persisted database identity; replacing it is tested separately.
(store as any).feedId=seed.feedId;
for(const o of seed.operations)await store.commit({id:o.aggregateId,commandId:o.commandId,expectedRevision:o.expectedRevision,fingerprint:o.fingerprint,value:o.value,events:o.events,outbox:o.outbox});
const calls:{id:string;prompt:any}[]=[],artifacts=new TextArtifactStore(join(seed.root,'artifacts')),runtime=new ConfiguredTextRuntime(store,fixtureOptions(artifacts,calls));
if(mode==='crash'){
 const commit=store.commit.bind(store);store.commit=async input=>{const c=(input.events[0] as any)?.command;if(c?.type==='settle-task'&&c.taskId===seed.workId+':step:0'){
  await writeFile(path,JSON.stringify({...seed,operations:store.inspect(),calls}));process.kill(process.pid,'SIGKILL');await new Promise(()=>{});
 }return commit(input);};
 await runtime.run('mission',seed.workId,'run',(await store.load('mission'))!.revision);throw Error('Crash checkpoint was not reached');
}
const resumed=Promise.withResolvers<unknown>(),resume=runtime.resume.bind(runtime);runtime.resume=async(...args)=>{try{const result=await resume(...args);resumed.resolve(result);return result;}catch(error){resumed.reject(error);throw error;}};
const server=createWorkbench(store,seed.root,{runtime,scheduleIntervalMs:0});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const timeout=setTimeout(()=>resumed.reject(Error('Startup did not resume')),5000);
try{
 const result=await resumed.promise as any;assert.equal(result.status,'settled');const work=(await store.load('mission'))!.value.works[0];assert.equal(work.acceptance,'accepted');
 const all=[...seed.calls,...calls];assert.equal(all.length,7);assert.equal(new Set(all.map(c=>c.id)).size,7);assert.equal(work.budget.reserved,70);assert.equal(work.budget.measured,7);
 assert.notEqual(work.runtimeRun.resumptions[0].hostSessionId,work.runtimeRun.ownership.hostSessionId);assert.equal(work.runtimeRun.resumptions[0].deadlineAt,work.runtimeRun.ownership.deadlineAt);
 console.log(JSON.stringify({accepted:true,providerCalls:all.length,distinctDispatches:work.runtimeRun.resumptions.length+1}));
}finally{clearTimeout(timeout);await server.drain();}
