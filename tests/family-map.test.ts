import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {lifetimeFixture} from './support/runtime-lifetime-fixture.ts';
import {createHostConnections,parseHostManifest} from '../src/host-connections.ts';
import {InMemoryHostSettings} from '../src/storage.ts';
import {ProductService} from '../src/product.ts';
import {createWorkbench} from '../src/server.ts';
import {apply,createMission,familyRelation} from '../src/domain.ts';
import type {Mission,Command,Actor,CheckFamily} from '../src/domain.ts';
import {modelFamily,familyCheck,supportsAutomaticAdoption} from '../src/model-family.ts';

/** Fixture-class only: local-http-mock manifests and a credential-free chat completion fixture. */
const manifest=(providerType:'compatible'|'openrouter',models:string[],revision='fixture-v1')=>parseHostManifest({version:1,revision,mode:'local-http-mock',connections:[{id:'fixture',label:'Fixture',providerType,baseUrl:'http://127.0.0.1:9999/v1/',models}]});
async function setup(t:test.TestContext,providerType:'compatible'|'openrouter'='compatible',models=['executor','verifier']){
 const f=await lifetimeFixture(t),calls:string[]=[],settings=new InMemoryHostSettings();
 const transport=async(_url:string|URL|Request,init?:RequestInit)=>{const body=JSON.parse(String(init!.body)),prompt=JSON.parse(body.messages[0].content);calls.push(body.model);const content=prompt.artifact?JSON.stringify({artifactSha256:prompt.binding.artifactSha256,criteriaVersion:prompt.criteria.version,criteriaHash:prompt.binding.criteriaHash,verdict:'passed',checks:[{criterion:prompt.criteria.description,passed:true,quote:'Original bounded',reason:'Controlled exact fixture'}]}):'Original bounded lifetime fixture';return new Response(JSON.stringify({id:'fixture',object:'chat.completion',created:1,model:body.model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}),{headers:{'content-type':'application/json'}});};
 const host=()=>createHostConnections(f.store,f.artifacts,{manifest:manifest(providerType,models),allowLiveExecution:false},{transport,readEnvironment:()=>assert.fail('No credential is read'),settings});
 const profile=(m:ReturnType<typeof host>,model:string)=>(m.list().runtime.connections as any[]).find(p=>p.model===model).id as string;
 async function route(m:ReturnType<typeof host>,executor:string,verifier:string){await m.save(()=>m.authorize({id:'grant',scope:'local',executorProfileId:profile(m,executor),verifierProfileId:profile(m,verifier),maxOutputTokensPerCall:4,expectedConfigHash:m.list().configHash}));await m.save(()=>m.setDefaultRoute({authorizationId:'grant',outputTokenCap:4,expectedConfigHash:m.list().configHash}));}
 return {...f,calls,settings,host,profile,route};
}

test('the host family map: first-party providers, OpenRouter vendors, and unknown counts as the same family',()=>{
 assert.equal(modelFamily('openai','gpt-test'),'openai');assert.equal(modelFamily('codex-cli','gpt-5'),'openai');assert.equal(modelFamily('anthropic','claude-test'),'anthropic');assert.equal(modelFamily('claude-code-cli','sonnet'),'anthropic');
 assert.equal(modelFamily('gemini','gemini-test'),'google');assert.equal(modelFamily('zai','glm-test'),'zhipu');assert.equal(modelFamily('openrouter','anthropic/claude-test'),'anthropic');assert.equal(modelFamily('openrouter','z-ai/glm-test'),'zhipu');
 for(const [provider,model] of [['openrouter','unknown/model'],['openrouter','claude-test'],['compatible','gpt-test'],['fixture','x'],['constructor','x'],['openrouter','constructor/x']] as const)assert.equal(modelFamily(provider,model),null,provider+' '+model);
 const id=(family:string|null)=>({provider:'p',model:'m',family});
 assert.equal(familyRelation([id('openai')],id('anthropic')),'different-family');assert.equal(familyRelation([id('openai'),id('anthropic')],id('anthropic')),'same-family');
 assert.equal(familyRelation([id(null)],id('anthropic')),'same-family');assert.equal(familyRelation([id('openai')],id(null)),'same-family');assert.equal(familyRelation([id('openai')],id('openai')),'same-family');
 const check=familyCheck([{provider:'openai',model:'gpt-test'}],{provider:'anthropic',model:'claude-test'});assert.deepEqual(check,{relation:'different-family',producers:[{provider:'openai',model:'gpt-test',family:'openai'}],checker:{provider:'anthropic',model:'claude-test',family:'anthropic'}});
});

test('a same-family check can accept Work but never supports automatic adoption',()=>{
 const same:CheckFamily={relation:'same-family',producers:[],checker:null};
 assert.equal(supportsAutomaticAdoption(same),false);assert.equal(supportsAutomaticAdoption(undefined),false);
 assert.equal(supportsAutomaticAdoption({...same,relation:'different-family'}),true);assert.equal(supportsAutomaticAdoption({...same,relation:'deterministic'}),true);
});

const owner:Actor={id:'user',roles:['owner']},rep:Actor={id:'representative',roles:['representative']},exec:Actor={id:'specialist',roles:['executor']},verifier:Actor={id:'assurance',roles:['verifier']};
const artifact={id:'text',version:1,sha256:'a'.repeat(64),path:'text.md',kind:'text'};
const send=(m:Mission,c:Command,a=owner)=>apply(m,c,a).value;
function ready(checkerModel:readonly [string,string]=['anthropic','claude-test']){
 let m=send(createMission({id:'m',purpose:'Checked text',scope:'sample',constraints:[],criteria:{version:1,description:'Reviewed',oracle:'review/v1'}},owner),{type:'admit-work',workId:'a',title:'Write',budget:2});
 for(const [id,actorId,role,provider,model] of [['author','specialist','executor','openai','gpt-test'],['check','assurance','verifier',...checkerModel]] as const)m=send(m,{type:'assign',workId:'a',assignment:{id,actorId,role,taskId:'a:root',model:{provider,model,configVersion:'1',reason:'Fixture',evidenceClass:role==='verifier'?'real-provider':'fixture'},extensionVersion:'builtin@1'}},rep);
 m=send(m,{type:'admit-effect',workId:'a',effect:{id:'write',taskId:'a:root',status:'pending',target:'text.md',authority:'builtin@1'},reserve:1},exec);m=send(m,{type:'receipt',workId:'a',effectId:'write',outcome:'succeeded',receipt:'ok',usage:0},exec);
 m=send(m,{type:'publish-artifact',workId:'a',artifact},exec);return send(m,{type:'settle-task',workId:'a',taskId:'a:root',result:'Written'},exec);
}
const verify=(check:unknown):Command=>({type:'verify',workId:'a',verdict:{id:'v',verifierAssignmentId:'check',artifactSha256:artifact.sha256,artifactVersion:1,criteriaVersion:1,status:'passed',evidence:[{kind:'review',detail:'Passed',source:'reviewer'}],check} as any});

test('domain: the pinned family check must name the Work producers and checker and follow from the families',()=>{
 const good=familyCheck([{provider:'openai',model:'gpt-test'}],{provider:'anthropic',model:'claude-test'});
 const m=send(ready(),verify(good),verifier);assert.deepEqual(m.works[0]!.verdict!.check,good);
 const accepted=send(m,{type:'accept',workId:'a',recordId:'r'},rep);assert.deepEqual(accepted.works[0]!.record!.verdict.check,good);
 for(const bad of [{...good,relation:'same-family'},{...good,relation:'deterministic'},{...good,checker:{...good.checker!,model:'other'}},{...good,producers:[]},{...good,producers:[...good.producers,good.producers[0]]},{...good,checker:{...good.checker!,family:'openai'}},{...good,extra:1},{...good,relation:'deterministic',checker:null}])
  assert.throws(()=>send(ready(),verify(bad),verifier),/family check/,JSON.stringify(bad));
 assert.equal(send(ready(),verify(undefined),verifier).works[0]!.verdict!.check,undefined);
 // One model cannot carry two families in a pin: relabelling the producer's own model never yields a different-family check.
 const own=['openai','gpt-test'] as const,forged={relation:'different-family',producers:[{provider:'openai',model:'gpt-test',family:'x'}],checker:{provider:'openai',model:'gpt-test',family:'y'}};
 assert.throws(()=>send(ready(own),verify(forged),verifier),/family check/);
 const honest=familyCheck([{provider:'openai',model:'gpt-test'}],{provider:'openai',model:'gpt-test'});assert.equal(send(ready(own),verify(honest),verifier).works[0]!.verdict!.check!.relation,'same-family');
});

test('a default route on one profile runs; the Record pins a same-family check with both identities',async t=>{
 const f=await setup(t),m=f.host();await f.route(m,'executor','executor');assert.equal(m.list().runtime.defaultRoutes[0]!.status,'active');assert.equal(m.list().runtime.defaultRoutes[0]!.check,'same-family');
 const product=new ProductService(f.store,undefined,m),result=await product.run('mission','fresh','run-same',(await f.current()).revision) as any;assert.equal(result.status,'settled');
 const work=(await f.current()).value.works.find(w=>w.id==='fresh')!;assert.deepEqual(work.record!.verdict.check,{relation:'same-family',producers:[{provider:'compatible',model:'executor',family:null}],checker:{provider:'compatible',model:'executor',family:null}});
 assert.deepEqual(f.calls,['executor','executor']);
});

test('an OpenAI producer checked by an Anthropic model records a different-family check',async t=>{
 const f=await setup(t,'openrouter',['openai/gpt-test','anthropic/claude-test']),m=f.host();await f.route(m,'openai/gpt-test','anthropic/claude-test');assert.equal(m.list().runtime.defaultRoutes[0]!.check,'different-family');
 const product=new ProductService(f.store,undefined,m),result=await product.run('mission','fresh','run-diff',(await f.current()).revision) as any;assert.equal(result.status,'settled');
 const check=(await f.current()).value.works.find(w=>w.id==='fresh')!.record!.verdict.check!;assert.equal(check.relation,'different-family');assert.deepEqual(check.producers,[{provider:'openrouter',model:'openai/gpt-test',family:'openai'}]);assert.equal(check.checker!.family,'anthropic');
 assert.equal(supportsAutomaticAdoption(check),true);
});

test('model groups: save, replace and remove under compare-and-set; restart restores them; the default group is derived',async t=>{
 const f=await setup(t,'openrouter',['openai/gpt-test','anthropic/claude-test','z-ai/glm-test']),m=f.host();await m.restoreSettings();
 const gpt=f.profile(m,'openai/gpt-test'),claude=f.profile(m,'anthropic/claude-test'),glm=f.profile(m,'z-ai/glm-test');
 assert.deepEqual(m.list().modelGroups.map((g:any)=>[g.id,g.models.length,g.editable]),[['default',0,false]]);
 const save=(input:Record<string,unknown>)=>m.save(()=>m.saveModelGroup({expectedConfigHash:m.list().configHash,...input}));
 await save({id:'research',name:'Research',description:'Finds and reads sources and summarizes them with evidence.',profileIds:[claude,gpt]});
 let group=m.list().modelGroups[1]!;assert.equal(group.name,'Research');assert.deepEqual(group.models.map((x:any)=>[x.model,x.family,x.status]),[['anthropic/claude-test','anthropic','available'],['openai/gpt-test','openai','available']]);
 await save({id:'coding',name:'Coding',description:'Writes and fixes code.',profileIds:[glm]});await save({id:'research',name:'Research',description:'Reads sources.',profileIds:[gpt]});
 assert.deepEqual(m.list().modelGroups.map((g:any)=>g.id),['default','research','coding']);assert.equal(m.list().modelGroups[1]!.description,'Reads sources.');
 for(const [bad,pattern] of [[{id:'default',name:'Mine',description:'x',profileIds:[gpt]},/reserved/],[{id:'other',name:'Coding',description:'x',profileIds:[gpt]},/name/],[{id:'other',name:'Other',description:'x',profileIds:['profile:missing']},/unavailable/],[{id:'other',name:'Other',description:'x',profileIds:[]},/models/],[{id:'other',name:'Other',description:'x',profileIds:[gpt,gpt]},/models/],[{id:'other',name:'Other',description:'two\nlines',profileIds:[gpt]},/description/],[{id:'other',name:'Other',description:'x',profileIds:[gpt],extra:1},/fields|Invalid/]] as const)
  await assert.rejects(save(bad as any),pattern,JSON.stringify(bad));
 await assert.rejects(m.save(()=>m.saveModelGroup({id:'late',name:'Late',description:'x',profileIds:[gpt],expectedConfigHash:'stale'})),/changed/);
 const restarted=f.host();await restarted.restoreSettings();assert.deepEqual(restarted.list().modelGroups,m.list().modelGroups);assert.equal(restarted.list().configHash,m.list().configHash);
 await m.save(()=>m.removeModelGroup({id:'coding',expectedConfigHash:m.list().configHash}));assert.deepEqual(m.list().modelGroups.map((g:any)=>g.id),['default','research']);
 await assert.rejects(m.save(()=>m.removeModelGroup({id:'default',expectedConfigHash:m.list().configHash})),/Unknown model group/);
 await f.route(m,'openai/gpt-test','anthropic/claude-test');assert.deepEqual(m.list().modelGroups[0]!.models.map((x:any)=>x.model),['openai/gpt-test','anthropic/claude-test']);assert.deepEqual(f.calls,[]);
});

test('stored model groups are validated exactly and version 2 documents still load',async t=>{
 const f=await setup(t),m=f.host();await m.save(()=>m.saveModelGroup({id:'g',name:'G',description:'Checks text.',profileIds:[f.profile(m,'executor')],expectedConfigHash:m.list().configHash}));
 const row=[...f.settings.rows.values()][0]!,original=structuredClone(row.value) as any;assert.equal(original.version,3);
 for(const bad of [{...original,modelGroups:[{...original.modelGroups[0],apiKey:'x'}]},{...original,modelGroups:[original.modelGroups[0],original.modelGroups[0]]},{...original,modelGroups:[{...original.modelGroups[0],id:'default'}]},{...original,modelGroups:[{...original.modelGroups[0],models:[]}]},{...original,version:2}]){row.value=bad;await assert.rejects(f.host().restoreSettings(),/stored document invalid/,JSON.stringify(bad));}
 const {modelGroups:_,...v2}=original;row.value={...v2,version:2};const old=f.host();await old.restoreSettings();assert.deepEqual(old.list().modelGroups.map((g:any)=>g.id),['default']);
});

test('the host chooses inside a group by availability, output budget and family, and never leaves the group',async t=>{
 const f=await setup(t,'openrouter',['openai/gpt-test','anthropic/claude-test','z-ai/glm-test']),m=f.host();
 const [gpt,claude,glm]=['openai/gpt-test','anthropic/claude-test','z-ai/glm-test'].map(x=>f.profile(m,x));
 await m.save(()=>m.saveModelGroup({id:'g',name:'G',description:'Checks text.',profileIds:[gpt,claude,glm],expectedConfigHash:m.list().configHash}));
 assert.equal((m.chooseGroupModel('g',{outputTokenCap:4}) as any).model,'openai/gpt-test');
 const checked=m.chooseGroupModel('g',{outputTokenCap:4,producers:[{provider:'openrouter',model:'openai/gpt-test'}]}) as any;assert.equal(checked.model,'anthropic/claude-test');assert.equal(checked.relation,'different-family');
 await m.save(()=>m.saveModelGroup({id:'g',name:'G',description:'Checks text.',profileIds:[gpt],expectedConfigHash:m.list().configHash}));
 const same=m.chooseGroupModel('g',{outputTokenCap:4,producers:[{provider:'openrouter',model:'openai/gpt-test'}]}) as any;assert.equal(same.model,'openai/gpt-test');assert.equal(same.relation,'same-family');
 const big=m.chooseGroupModel('g',{outputTokenCap:1_000_000}) as any;assert.equal(big.status,'unresolved');assert.equal(big.diagnostics[0].code,'model_group_unavailable');
 assert.equal((m.chooseGroupModel('missing',{outputTokenCap:4}) as any).diagnostics[0].code,'model_group_missing');
 const connection=m.list().connections[0]!;await m.save(()=>m.selectModel(connection.id,{model:'openai/gpt-test',label:'Relabelled',expectedConfigHash:connection.configHash}));
 assert.equal(m.list().modelGroups[1]!.models[0]!.status,'unavailable');assert.equal((m.chooseGroupModel('g',{outputTokenCap:4}) as any).status,'unresolved');assert.deepEqual(f.calls,[]);
});

test('HTTP: model group routes save through the settings path and refuse a stale hash',async t=>{
 const f=await setup(t),m=f.host(),server=createWorkbench(f.store,f.root,{connections:m});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const base='http://127.0.0.1:'+(server.address() as {port:number}).port,post=async(path:string,body:unknown)=>{const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 let catalog=await fetch(base+'/connections').then(r=>r.json());assert.equal(catalog.modelGroups[0].id,'default');
 const saved=await post('/model-groups',{id:'g',name:'G',description:'Checks text.',profileIds:[f.profile(m,'verifier')],expectedConfigHash:catalog.configHash});assert.equal(saved.status,200);assert.equal(saved.body.modelGroups[1].models[0].model,'verifier');assert.equal(saved.body.persistence.status,'saved');
 assert.equal((await post('/model-groups/remove',{id:'g',expectedConfigHash:catalog.configHash})).status,400);
 const removed=await post('/model-groups/remove',{id:'g',expectedConfigHash:saved.body.configHash});assert.equal(removed.status,200);assert.equal(removed.body.modelGroups.length,1);
});

test('a same-family check is refused while the model groups hold an available different family, and allowed when none is left',async t=>{
 const f=await setup(t,'openrouter',['openai/gpt-test','anthropic/claude-test']),m=f.host();const gpt=f.profile(m,'openai/gpt-test'),claude=f.profile(m,'anthropic/claude-test');
 await m.save(()=>m.saveModelGroup({id:'g',name:'G',description:'Checks text.',profileIds:[claude],expectedConfigHash:m.list().configHash}));
 await m.save(()=>m.authorize({id:'grant',scope:'local',executorProfileId:gpt,verifierProfileId:gpt,maxOutputTokensPerCall:4,expectedConfigHash:m.list().configHash}));
 // The route itself stays usable: whether another family is independent depends on the Work's producers.
 await m.save(()=>m.setDefaultRoute({authorizationId:'grant',outputTokenCap:4,expectedConfigHash:m.list().configHash}));assert.equal(m.list().runtime.defaultRoutes[0]!.status,'active');
 const product=new ProductService(f.store,undefined,m),choice={executorProfileId:gpt,verifierProfileId:gpt,authorizationId:'grant',outputTokenCap:4};
 assert.equal(m.resolveDefault((await f.current()).value).status,'resolved');
 const byDefault=await product.preflight('mission','fresh',(await f.current()).revision);assert.equal(byDefault!.ready,false);assert.equal(byDefault!.diagnostics.at(-1)!.code,'verifier_family_available');
 // A Representative-written Work already has an Anthropic producer, so no available model is independent and the same-family check is allowed.
 const snapshot=structuredClone(await f.current()),fresh=snapshot.value.works.find(w=>w.id==='fresh')!;fresh.assistantSource={representative:{provider:'openrouter',model:'anthropic/claude-test'}} as any;
 const written=m.preflight(snapshot,'fresh',snapshot.revision,choice);assert.ok(!written.diagnostics.some(d=>d.code==='verifier_family_available'),JSON.stringify(written.diagnostics));
 const refused=await product.preflight('mission','fresh',(await f.current()).revision,choice);assert.equal(refused!.ready,false);assert.equal(refused!.diagnostics.at(-1)!.code,'verifier_family_available');
 const run=await product.run('mission','fresh','run-refused',(await f.current()).revision,choice) as any;assert.notEqual(run.status,'settled');assert.deepEqual(f.calls,[]);
 await m.save(()=>m.removeModelGroup({id:'g',expectedConfigHash:m.list().configHash}));
 assert.equal((await product.preflight('mission','fresh',(await f.current()).revision))!.ready,true);
});

test('the default group keeps the usable pin when the Representative still holds a stale one for the same profile',async t=>{
 const f=await setup(t,'openrouter',['openai/gpt-test','anthropic/claude-test']),m=f.host(),claude=f.profile(m,'anthropic/claude-test');
 await m.save(()=>m.setRepresentative({profileId:claude,outputTokenCap:4,intakeMissionId:'intake',expectedConfigHash:m.list().configHash}));
 const connection=m.list().connections[0]!;await m.save(()=>m.selectModel(connection.id,{model:'anthropic/claude-test',label:'Relabelled',expectedConfigHash:connection.configHash}));
 await f.route(m,'openai/gpt-test','anthropic/claude-test');assert.equal(m.list().runtime.defaultRoutes[0]!.status,'active');
 const models=m.list().modelGroups[0]!.models as any[];assert.deepEqual(models.filter(x=>x.model==='anthropic/claude-test').map(x=>x.status),['available']);
 const checked=m.chooseGroupModel('default',{outputTokenCap:4,producers:[{provider:'openrouter',model:'openai/gpt-test'}]}) as any;assert.equal(checked.model,'anthropic/claude-test');assert.equal(checked.relation,'different-family');assert.deepEqual(f.calls,[]);
});
