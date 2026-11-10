import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHostConnections,parseHostManifest} from '../src/host-connections.ts';
import {InMemoryStore} from '../src/storage.ts';
import {InMemorySecretSlots} from '../src/secret-slots.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';
import {ConnectionLifecycle} from '../src/connection-lifecycle.ts';
import {ProductService} from '../src/product.ts';
import {ProviderRegistry} from '../src/providers.ts';
import {TEXT_REVIEW_ORACLE} from '../src/configured-runtime.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';
import type {Mission} from '../src/domain.ts';

async function setup(t:test.TestContext,unknown=false,environment=false){
 const root=await mkdtemp(join(tmpdir(),'credential-repair-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new InMemoryStore<Mission>(),secrets=new InMemorySecretSlots();let calls=0,checks=0,writes=0;
 await secrets.set({owner:'producer',slot:'api-key'},'sentinel-old-key');await secrets.set({owner:'checker',slot:'api-key'},'sentinel-check-key');
 const set=secrets.set.bind(secrets);secrets.set=async(slot,value)=>{writes++;await set(slot,value);};
 const manifest=parseHostManifest({version:1,revision:'repair-v1',mode:'https',connections:[{id:'producer',label:'OpenAI',providerType:'openai',baseUrl:'https://api.openai.com/v1/',models:['gpt-test'],credential:environment?{ref:'producer-ref',environment:'FIXTURE_API_KEY'}:{ref:'producer-ref',slot:'api-key'}},{id:'checker',label:'Anthropic',providerType:'anthropic',baseUrl:'https://api.anthropic.com/v1/',models:['claude-test'],credential:{ref:'checker-ref',slot:'api-key'}}]});
 const manager=createHostConnections(store,new TextArtifactStore(root),{manifest,allowLiveExecution:true},{secrets,readEnvironment:()=>environment?'sentinel-old-key':assert.fail('No environment credentials'),transport:async(url,init)=>{
  if(url.includes('openai.com')){calls++;if(calls===1){if(unknown)throw Error('sentinel-transport-error');return Response.json({error:{code:'invalid_api_key',message:'sentinel-provider-diagnostic'}},{status:401});}
   assert.equal(new Headers(init.headers).get('authorization'),'Bearer sentinel-new-key');return Response.json({id:'chatcmpl-test',object:'chat.completion',created:1,model:'gpt-test',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'A checked result.'}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}});
  }
  checks++;const prompt=JSON.parse(JSON.parse(String(init.body)).messages[0].content);return Response.json({type:'message',id:'msg-test',role:'assistant',model:'claude-test',usage:{input_tokens:1,output_tokens:1},stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify({artifactSha256:prompt.binding.artifactSha256,criteriaVersion:prompt.criteria.version,criteriaHash:prompt.binding.criteriaHash,verdict:'passed',checks:[{criterion:prompt.criteria.description,passed:true,quote:'checked result',reason:'Exact text checked'}]})}]});
 }});
 const catalog=manager.configuration() as any,[executor,verifier]=catalog.connections;
 manager.authorize({id:'grant',scope:'test',executorProfileId:executor.id,verifierProfileId:verifier.id,maxOutputTokensPerCall:32,expectedConfigHash:manager.list().configHash});
 const choice={executorProfileId:executor.id,verifierProfileId:verifier.id,authorizationId:'grant',outputTokenCap:32};
 const product=new ProductService(store,new ProviderRegistry(),manager);await product.create({id:'mission',purpose:'Check repair',scope:'test',constraints:[],criteria:{version:1,description:'A checked result',oracle:TEXT_REVIEW_ORACLE}},'create');await product.admit('mission',{commandId:'admit',expectedRevision:1,workId:'work',title:'Check repair',budget:128});
 const service=new ConnectionLifecycle(store,manager),target=manager.list().connections[0]!;
 t.after(()=>manager.beginDrain());return {store,manager,service,target,choice,product,calls:()=>calls,checks:()=>checks,writes:()=>writes};
}
async function until(predicate:()=>boolean|Promise<boolean>){const end=Date.now()+3000;while(!await predicate()){assert.ok(Date.now()<end,'Expected credential pause');await new Promise(r=>setImmediate(r));}}

test('exact slot replacement and overlapping retry execute the rejected stage once through the owner store',async t=>{
 const f=await setup(t),running=f.product.run('mission','work','run',2,f.choice);void running.catch(()=>{});
 await until(()=>f.manager.canRetryCredential('mission','work','run:executor'));
 const revision=(await f.store.load('mission'))!.revision,input={commandId:'retry',missionId:'mission',workId:'work',expectedRevision:revision,connectionId:f.target.id,expectedConfigHash:f.target.configHash,effectId:'run:executor',replacementCommandId:'replace'};
 assert.equal((await f.service.read()).connections[0]!.observation!.status,'invalid');
 await assert.rejects(f.service.retry(input),/completed credential|completed replacement/);assert.equal(f.calls(),1);
 assert.equal((await f.service.replaceKey({commandId:'replace',connectionId:f.target.id,expectedConfigHash:f.target.configHash,apiKey:'sentinel-new-key'})).status,'completed');assert.equal(f.writes(),1);
 const replies=await Promise.all([f.service.retry(input),f.service.retry(input)]);assert.ok(replies.every(r=>r.status==='completed'));
 const result=await running;assert.equal(result.snapshot.value.works[0]!.acceptance,'accepted');assert.equal(f.calls(),2);assert.equal(f.checks(),1);
 assert.equal((await f.service.retry(input)).status,'completed');assert.equal(f.calls(),2);
 assert.doesNotThrow(()=>validateMissionJournalLineage(f.store.inspect()));assert.doesNotMatch(JSON.stringify([f.store.inspect(),await f.service.read(),result]),/sentinel-/);
});

test('an uncertain transport response has no credential retry path or second dispatch',async t=>{
 const f=await setup(t,true),result=await f.product.run('mission','work','run',2,f.choice);
 assert.equal(result.snapshot.value.works[0]!.effects[0]!.status,'unknown');assert.equal(f.manager.canRetryCredential('mission','work','run:executor'),false);
 assert.equal((await f.service.read()).connections[0]!.observation,null);assert.equal(f.calls(),1);assert.doesNotMatch(JSON.stringify(f.store.inspect()),/sentinel-/);
});

test('rechecking a rejected key cannot reuse a replacement receipt from before that rejection',async t=>{
 const f=await setup(t);await f.service.replaceKey({commandId:'older-replacement',connectionId:f.target.id,expectedConfigHash:f.target.configHash,apiKey:'sentinel-old-key'});
 const running=f.product.run('mission','work','run',2,f.choice);void running.catch(()=>{});await until(()=>f.manager.canRetryCredential('mission','work','run:executor'));
 const revision=(await f.store.load('mission'))!.revision;await f.service.recheck({commandId:'newer-observation',connectionId:f.target.id,expectedConfigHash:f.target.configHash});
 await assert.rejects(f.service.retry({commandId:'retry-old-key',missionId:'mission',workId:'work',expectedRevision:revision,connectionId:f.target.id,expectedConfigHash:f.target.configHash,effectId:'run:executor',replacementCommandId:'older-replacement'}),/continuation|replacement/);
 f.manager.beginDrain();await running.catch(()=>{});assert.equal(f.calls(),2,'One inference and one explicit discovery; no inference retry');
});

test('an unknown key write cannot unlock a continuation and is not resent',async t=>{
 const f=await setup(t),running=f.product.run('mission','work','run',2,f.choice);void running.catch(()=>{});await until(()=>f.manager.canRetryCredential('mission','work','run:executor'));
 const {ConnectionWorkbench}=await import('../src/connection-workbench.ts');assert.ok(f.manager instanceof ConnectionWorkbench);
 const original=f.manager.replaceKey.bind(f.manager);f.manager.replaceKey=async()=>{throw Error('sentinel-unresolved-key-write');};
 const replacement={commandId:'unknown-key',connectionId:f.target.id,expectedConfigHash:f.target.configHash,apiKey:'sentinel-new-key'};
 assert.equal((await f.service.replaceKey(replacement)).status,'unknown');assert.equal((await f.service.replaceKey(replacement)).status,'unknown');f.manager.replaceKey=original;
 await assert.rejects(f.service.retry({commandId:'retry-unknown',missionId:'mission',workId:'work',expectedRevision:(await f.store.load('mission'))!.revision,connectionId:f.target.id,expectedConfigHash:f.target.configHash,effectId:'run:executor',replacementCommandId:'unknown-key'}),/completed credential|completed replacement/);
 f.manager.beginDrain();await running.catch(()=>{});assert.equal(f.calls(),1);assert.doesNotMatch(JSON.stringify(f.store.inspect()),/sentinel-/);
});

test('a drain-aware owner store can reject retry before any second provider dispatch',async t=>{
 const f=await setup(t),running=f.product.run('mission','work','run',2,f.choice);void running.catch(()=>{});await until(()=>f.manager.canRetryCredential('mission','work','run:executor'));
 await f.service.replaceKey({commandId:'replacement',connectionId:f.target.id,expectedConfigHash:f.target.configHash,apiKey:'sentinel-new-key'});
 const {DomainError}=await import('../src/domain.ts'),guarded=new Proxy(f.store,{get(target,key){if(key==='commit')return async()=>{throw new DomainError('Owner store rejected during drain');};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
 await assert.rejects(new ConnectionLifecycle(guarded,f.manager).retry({commandId:'retry',missionId:'mission',workId:'work',expectedRevision:(await f.store.load('mission'))!.revision,connectionId:f.target.id,expectedConfigHash:f.target.configHash,effectId:'run:executor',replacementCommandId:'replacement'}),/Owner store rejected/);
 f.manager.beginDrain();await running.catch(()=>{});assert.equal(f.calls(),1);
});

test('a newer unknown replacement racing retry admission invalidates the older completed receipt',async t=>{
 const f=await setup(t),running=f.product.run('mission','work','run',2,f.choice);void running.catch(()=>{});await until(()=>f.manager.canRetryCredential('mission','work','run:executor'));
 await f.service.replaceKey({commandId:'first-replacement',connectionId:f.target.id,expectedConfigHash:f.target.configHash,apiKey:'sentinel-new-key'});
 let started!:()=>void,release!:()=>void;const held=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>started=r),retry=f.manager.retryCredential.bind(f.manager);
 f.manager.retryCredential=async(...args)=>{started();await held;return retry(...args);};
 const input={commandId:'retry-race',missionId:'mission',workId:'work',expectedRevision:(await f.store.load('mission'))!.revision,connectionId:f.target.id,expectedConfigHash:f.target.configHash,effectId:'run:executor',replacementCommandId:'first-replacement'},attempt=f.service.retry(input);void attempt.catch(()=>{});await entered;
 f.manager.replaceKey=async()=>{throw Error('sentinel-unknown-second-write');};assert.equal((await f.service.replaceKey({commandId:'second-replacement',connectionId:f.target.id,expectedConfigHash:f.target.configHash,apiKey:'sentinel-another-key'})).status,'unknown');
 release();await assert.rejects(attempt,/completed credential|completed replacement/);f.manager.beginDrain();await running.catch(()=>{});assert.equal(f.calls(),1);
});


test('environment credentials fail promptly without opening an impossible live repair wait',async t=>{
 const f=await setup(t,false,true),running=f.product.run('mission','work','run',2,f.choice);void running.catch(()=>{});
 const result=await Promise.race([running,new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('Non-editable credential entered a repair wait')),500))]);
 assert.equal(result.status,'blocked');assert.equal(f.manager.hasActiveAdmission(),false);assert.equal(f.manager.canRetryCredential('mission','work','run:executor'),false);assert.equal(f.calls(),1);assert.equal(f.checks(),0);assert.equal((await f.service.read()).connections[0]!.observation!.status,'invalid');
 assert.deepEqual(JSON.parse(result.snapshot.value.works[0]!.effects[0]!.receipt!).credentialFailure,{kind:'invalid',code:'invalid_api_key'});
});
