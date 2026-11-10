import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {runInContext} from 'node:vm';
import {ConfiguredTextRuntime,TEXT_REVIEW_ORACLE} from '../src/configured-runtime.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';
import {InMemoryStore} from '../src/storage.ts';
import type {Mission} from '../src/domain.ts';
import type {ProviderAdapter,ProviderRequest} from '../src/providers.ts';
import {harness,reply,settle} from './support/workbench-client.ts';
import type {Node} from './support/workbench-client.ts';
import {ASSISTANT_ACTOR_ID,ownerMessageId,assistantTurnId,assistantWorkId} from '../src/assistant-conversation.ts';
import {hash} from '../src/domain.ts';
import {applySkills} from '../src/skills.ts';
import {memberProcedures} from '../src/internal-teams.ts';
import {workCardFacts} from '../src/assistant-service.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';

const table={format:'massion-table/v1',caption:'Controlled prices',columns:['Plan','Monthly'],rows:[['<img src=x onerror=alert(1)>','9,900원'],['javascript:alert(1)','19,900원']]};
const original=' \n'+JSON.stringify(table,null,2)+'\n';
const descendants=(node:Node):Node[]=>[node,...node.children.flatMap(descendants)];
const tables=async()=>import('../src/table-results.ts');

test('only an exact bounded rectangular table envelope receives table semantics',async()=>{
 const {parseTableResult}=await tables();assert.deepEqual(parseTableResult(original),table);
 for(const text of ['ordinary text','| Plan | Price |',JSON.stringify({...table,format:'other/v1'}),'null','[]','{"format":"massion-table/v1",'])assert.equal(parseTableResult(text),null);
 const invalid=[{...table,extra:true},{...table,caption:''},{...table,columns:[]},{...table,rows:[]},{...table,rows:[['one']]},{...table,rows:[[1,'2']]},{...table,rows:[[{html:'x'},'2']]},{...table,columns:Array(13).fill('x')},{...table,rows:Array(101).fill(['a','b'])},{...table,caption:'x'.repeat(129)},{...table,columns:['x'.repeat(129),'b']},{...table,rows:[['x'.repeat(1025),'b']]},{...table,rows:[['\ud800','b']]},{...table,columns:Array(12).fill('x'),rows:Array(51).fill(Array(12).fill('x'))},{...table,rows:Array(20).fill(['가'.repeat(1000),'b'])}];
 for(const value of invalid)assert.equal(parseTableResult(JSON.stringify(value)),null,JSON.stringify(value).slice(0,160));
 assert.equal(parseTableResult(' '.repeat(32769)+JSON.stringify(table)),null);
 assert.ok(parseTableResult(JSON.stringify({...table,columns:Array(12).fill('x'),rows:Array(50).fill(Array(12).fill('x'))})));
 assert.ok(parseTableResult(JSON.stringify({...table,rows:Array(100).fill(['','b'])})));
});

async function preview(){
 const row={missionId:'mission',workId:'work',recordId:'record',version:1,sha256:createHash('sha256').update(original).digest('hex'),kind:'text',title:'Controlled table',memberId:null,segment:1,turnId:'turn',at:0};
 const state={content:original,hold:null as Promise<void>|null,rows:[row]};
 const app=harness(async path=>{
  if(path==='/assistant/results')return reply({feedId:'feed',results:state.rows});
  if(path.startsWith('/missions/mission/record-artifact')){const content=state.content;if(state.hold)await state.hold;return reply({content});}
  if(path.startsWith('/read-state'))return reply({feedId:'feed',cursor:0,snapshot:null});
  if(path.startsWith('/events'))return reply({feedId:'feed',cursor:1,events:[]});
  if(path.startsWith('/assistant/conversation'))return reply({feedId:'feed',cursor:1,head:1,members:[],turns:[],segment:{number:1,revision:1,closed:false,full:false,previous:null,messages:[]}});
  return reply({},503);
 },{'massion.workbench.feed':'feed'});await settle();await app.node('rail-results').fire('click');await settle();
 return {app,state,open:()=>runInContext('resultOpen(resultRows[0])',app.context) as Promise<void>};
}
test('accepted preview renders inert semantic cells and preserves exact Original and Copy',async()=>{
 const {app,open}=await preview();await open();const node=app.node('result-preview').children[0]!;
 assert.equal(node.tagName,'TABLE');assert.equal(node.children[0]!.tagName,'CAPTION');assert.equal(node.children[0]!.textContent,'Controlled prices');
 const nodes=descendants(node);assert.equal(nodes.filter(n=>n.tagName==='TH'&&n.attributes.get('scope')==='col').length,2);
 assert.deepEqual(nodes.filter(n=>n.tagName==='TD').map(n=>n.textContent),['<img src=x onerror=alert(1)>','9,900원','javascript:alert(1)','19,900원']);
 assert.equal(nodes.some(n=>['IMG','A','SCRIPT'].includes(n.tagName)),false);assert.equal(app.node('result-original').textContent,original);
 runInContext('navigator.clipboard={writeText:text=>globalThis.copied=text}',app.context);await app.node('result-copy').fire('click');assert.equal(runInContext('copied',app.context),original);
 await app.node('result-tab-original').fire('click');assert.equal(app.node('result-preview').hidden,true);assert.equal(app.node('result-original').hidden,false);
 assert.equal(app.calls.some(c=>c.options?.method==='POST'),false);
});
test('invalid tables remain literal text and a cleared preview cannot receive a late response',async()=>{
 const {app,state,open}=await preview();state.content=JSON.stringify({...table,rows:[['wrong width']]});await open();assert.equal(app.node('result-preview').children.some(n=>n.tagName==='TABLE'),false);assert.equal(app.node('result-original').textContent,state.content);
 state.content=original;let release!:()=>void;state.hold=new Promise<void>(r=>release=r);const pending=open();await settle();runInContext('resultsReset()',app.context);release();await pending;assert.equal(app.node('result-preview').children.length,0);
});
test('settled worker result tables are inert and worker instructions are never interpreted as tables',async()=>{
 const {app}=await preview(),work={tasks:[{id:'step',status:'settled',step:{role:'Table',title:'Table',instruction:original},result:original,startedAt:1,endedAt:2}]};
 const render=(value:unknown)=>runInContext('workWorkerMessages('+JSON.stringify(value)+',"Member")',app.context) as Node;
 const nodes=descendants(render(work));assert.equal(nodes.filter(n=>n.tagName==='TABLE').length,1);assert.ok(nodes.some(n=>n.tagName==='P'&&n.textContent===original));
 work.tasks[0]!.result=JSON.stringify({...table,rows:[[]]});assert.equal(descendants(render(work)).some(n=>n.tagName==='TABLE'),false);
 work.tasks[0]!.status='active';work.tasks[0]!.result=original;assert.equal(descendants(render(work)).some(n=>n.tagName==='TABLE'),false);
});

async function runtime(t:test.TestContext,output:string,team=false,workerOutput=output){
 const root=await mkdtemp(join(await realpath(tmpdir()),'massion-table-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const calls:any[]=[],store=new InMemoryStore<Mission>(),artifacts=new TextArtifactStore(join(root,'artifacts'));
 const adapter=(role:string):ProviderAdapter=>({descriptor:{provider:'fixture',model:role,configVersion:'v1',enabled:true,capabilities:['text-output'],evidenceClass:'fixture'},async invoke(request:ProviderRequest){const prompt=JSON.parse(request.instruction);calls.push({role,prompt});const result=role==='verifier'?JSON.stringify({artifactSha256:prompt.binding.artifactSha256,criteriaVersion:prompt.criteria.version,criteriaHash:prompt.binding.criteriaHash,verdict:'passed',checks:[{criterion:prompt.criteria.description,passed:true,quote:output.includes('9,900원')?'9,900원':'41',reason:'Controlled fixture evidence'}]}):prompt.teamPlanning?JSON.stringify({steps:[{role:'Table',title:'Table',dependsOn:[],instruction:'Create a table'}]}):prompt.step?workerOutput:output;return {status:'completed',output:result,usage:{inputTokens:1,outputTokens:1},reason:'Controlled fixture'};}});
 const executor=adapter('executor'),verifier=adapter('verifier'),options={enabled:true,outputTokenCap:32,authorization:{id:'fixture',scope:'local',mode:'mock-http' as const,executor:executor.descriptor,verifier:verifier.descriptor,maxOutputTokensPerCall:32},executor:{identity:'executor',adapter:executor},verifier:{identity:'verifier',adapter:verifier},artifacts};
 const instance=new ConfiguredTextRuntime(store,options);await instance.app.create({id:'mission',purpose:'Controlled table',scope:'local',constraints:[],criteria:{version:1,description:'Produce controlled prices',oracle:TEXT_REVIEW_ORACLE}},'local-owner','create');
 const owner={id:'local-owner',roles:['owner' as const]},skills=team?applySkills(null,{type:'write-skill',memberId:'member',kind:'procedure',name:'Table',body:{description:'Table',steps:['Table'],verify:'Controlled prices'}},owner,{observedAt:1}).value:null;
 const messageId=ownerMessageId('table-runtime'),turnId=assistantTurnId(messageId),workId=team?assistantWorkId(turnId):'work',message={id:messageId,ordinal:1,actorId:'local-owner',role:'owner' as const,turnId:null,text:'Produce a controlled table'},assistantSource={segmentId:'assistant-conversation:1',turnId,messageId,messageHash:hash(message),message,memberId:'member',representative:{provider:'fixture',model:'representative'}};
 await instance.app.dispatch({missionId:'mission',commandId:'admit',expectedRevision:1,actorId:team?ASSISTANT_ACTOR_ID:'local-owner',command:{type:'admit-work',workId,title:'Produce a table',budget:512,...(skills?{team:memberProcedures(skills,'member',1),assistantSource}:{})}});
 return {instance,store,artifacts,calls,options,workId};
}
test('runtime checks exact table JSON bytes independently and never replays an accepted run',async t=>{
 const f=await runtime(t,original),result=await f.instance.run('mission','work','run',2),work=result.snapshot.value.works[0]!;
 assert.equal(work.acceptance,'accepted');assert.equal(work.artifact!.kind,'text');assert.equal(await f.artifacts.read(work.artifact!),original);assert.equal(f.calls[1]!.prompt.artifact.content,original);assert.equal(work.artifact!.sha256,createHash('sha256').update(original).digest('hex'));
 assert.match(f.calls[0]!.prompt.instruction,/massion-table\/v1/);
 const reopened=new ConfiguredTextRuntime(f.store,f.options);assert.equal((await reopened.run('mission','work','another',result.snapshot.revision)).status,'already-started');assert.equal(f.calls.length,2);
});
for(const team of [false,true])test(`runtime refuses marked malformed ${team?'worker':'final'} tables before storing or checking`,async t=>{
 const f=await runtime(t,JSON.stringify({...table,rows:[['bad']]}),team),result=await f.instance.run('mission',f.workId,'run',2),work=result.snapshot.value.works[0]!;
 assert.equal(result.status,'blocked');assert.equal(work.artifact,undefined);assert.equal(work.record,undefined);assert.equal(f.calls.some(c=>c.role==='verifier'),false);assert.equal(work.effects.some(e=>e.id==='run:artifact'),false);
 if(team)assert.equal(work.tasks.find(task=>task.id===f.workId+':step:0')!.result,undefined);
});

const churnFacts={format:'massion-facts/v1',kind:'churn',reasons:41,business:9,other:32};
test('only settled explicit business facts reach list summaries without worker bodies or prose inference',async t=>{
 const f=await runtime(t,JSON.stringify(churnFacts),true),result=await f.instance.run('mission',f.workId,'run',2),work=result.snapshot.value.works[0]!;
 const facts=workCardFacts(work) as any;
 assert.deepEqual(facts.resultFacts,churnFacts);assert.equal(facts.tableCount,0);
 assert.equal(work.acceptance,'accepted');assert.equal(await f.artifacts.read(work.artifact!),JSON.stringify(churnFacts));
 assert.equal(f.calls.find(c=>c.role==='verifier')!.prompt.artifact.content,JSON.stringify(churnFacts));
 assert.ok(work.tasks.some(task=>!task.step&&task.result===JSON.stringify(churnFacts)),'final assembly facts survive the result projection');
 assert.equal(JSON.stringify(facts).includes('Create a table'),false);
 for(const task of work.tasks){task.status='active';task.result=JSON.stringify(churnFacts);}
 assert.equal((workCardFacts(work) as any).resultFacts,null,'unsettled results never acquire facts');
 for(const task of work.tasks){task.status='settled';task.result='41 reasons, business 9, other 32';}
 assert.equal((workCardFacts(work) as any).resultFacts,null,'ordinary prose never acquires counts');
});
for(const team of [false,true])test(`runtime refuses inconsistent ${team?'worker':'assembly'} business facts before writes or checking`,async t=>{
 const f=await runtime(t,JSON.stringify({...churnFacts,other:33}),team),result=await f.instance.run('mission',f.workId,'run',2),work=result.snapshot.value.works[0]!;
 assert.equal(result.status,'blocked');assert.equal(work.artifact,undefined);assert.equal(work.record,undefined);assert.equal(f.calls.some(c=>c.role==='verifier'),false);
 if(team)assert.equal(work.tasks.find(task=>task.step)!.result,undefined);
});

test('assembly facts survive canonical journal validation without a new storage shape',async t=>{
 const f=await runtime(t,JSON.stringify(churnFacts)),result=await f.instance.run('mission',f.workId,'run',2);
 assert.equal(result.snapshot.value.works[0]!.acceptance,'accepted');validateMissionJournalLineage(f.store.inspect());
});

for(const team of [false,true])test(`final marked pricing table supplies authoritative summary without counting ${team?'worker tables twice':'a missing team'}`,async t=>{
 const final=JSON.stringify({...table,business:'pricing'}),worker=JSON.stringify({...table,business:'pricing',rows:[...table.rows,['Other','29,900원']]}),f=await runtime(t,final,team,worker),result=await f.instance.run('mission',f.workId,'run',2),work=result.snapshot.value.works[0]!,summary=workCardFacts(work) as any;
 assert.equal(work.acceptance,'accepted');assert.deepEqual(summary.resultFacts,{format:'massion-facts/v1',kind:'pricing',plans:2,tables:1});assert.equal(summary.tableCount,1);
 assert.equal(await f.artifacts.read(work.artifact!),final);assert.equal(f.calls.find(c=>c.role==='verifier')!.prompt.artifact.content,final);
 if(!team)validateMissionJournalLineage(f.store.inspect());
});
