import assert from 'node:assert/strict';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {apply,hash,canonical,workInputHash,observesWork,endsWork} from '../../src/domain.ts';
import type {Actor,Command,Mission,Work,Task} from '../../src/domain.ts';
import {Application} from '../../src/application.ts';
import {InMemoryStore} from '../../src/storage.ts';
import {parseTeamPlan,teamCallCount} from '../../src/internal-teams.ts';
import {loadFixture} from './fixture-host.ts';

const owner:Actor={id:'local-owner',roles:['owner']},host:Actor={id:'runtime-representative',roles:['representative']},assistant:Actor={id:'fixture-assistant',roles:['assistant']};
const directory=new URL('./fixtures/',import.meta.url);
const json=async(path:URL)=>JSON.parse(await readFile(path,'utf8'));

/** Existing fixture text is input; every added observation comes from a domain command. */
export function produceWork(original:Work,mission:Mission,now:number,teamSource?:Work){
 let state=structuredClone(mission);state.works=[];delete state.conversations;
 let observedAt=original.runtimeRun?.ownership?.startedAt??now-240000;
 const send=(command:Command,actor:Actor=host)=>{const time=observesWork(command.type)?{observedAt:observedAt++,telemetryVersion:1 as const,...(endsWork(command.type)?{workEndVersion:2 as const}:{})}:endsWork(command.type)?{observedAt:observedAt++,workEndVersion:2 as const}:undefined;state=apply(state,command,actor,time).value;};
 const source=structuredClone(teamSource??original),rawSteps=source.tasks.filter(t=>t.step),team=source.team??(rawSteps.length&&original.assistantSource?.memberId?{memberId:original.assistantSource.memberId,skillsRevision:0,procedures:[{id:'fixture-procedure',version:1,body:{description:original.title,steps:rawSteps.map(t=>t.step!.title),verify:original.criteria.description},hash:''}]}:undefined);
 if(team)for(const procedure of team.procedures)procedure.hash=hash(procedure.body);
 send({type:'admit-work',workId:original.id,title:original.title,budget:Math.max(original.budget.limit,(original.runtimeRun?.outputTokenCap??0)*teamCallCount(team)),...(original.assistantSource?{assistantSource:original.assistantSource}:{}),...(team?{team}:{})},original.assistantSource?assistant:owner);
 const work=()=>state.works[0]!;
 for(const field of ['sourceDocuments','questions','prerequisites','prerequisiteRecords','missionSnapshot','missionVersion','organizationSnapshot','criteria','appliedMemoryVersions'] as const)if(Object.hasOwn(original,field))(work() as any)[field]=structuredClone(original[field]);
 if(original.runtimeRun)send({type:'activate-runtime',workId:original.id,run:{...original.runtimeRun,inputHash:workInputHash(work())}},owner);
 const tasks:Task[]=structuredClone(original.tasks.filter(t=>!t.step));
 if(rawSteps.length){
  if(!tasks.some(t=>t.id===original.id+':executor'))tasks.push({id:original.id+':executor',parentId:original.id+':root',status:'queued'});
  const plan=parseTeamPlan(JSON.stringify({steps:rawSteps.map(task=>({...task.step,dependsOn:task.step!.dependsOn.map(id=>rawSteps.findIndex(t=>t.id===id))}))}),work());
  tasks.push(...rawSteps.map((task,index)=>({...task,id:original.id+':step:'+index,parentId:original.id+':executor',step:plan[index]})));
 }
 for(const task of tasks)if(task.parentId!==null)send({type:'delegate',workId:original.id,taskId:task.id,parentId:task.parentId,...(task.step?{step:task.step}:{})});
 const assignments=structuredClone(original.assignments),model=assignments.find(a=>a.role==='executor')!;
 for(const task of tasks)if(!assignments.some(a=>a.taskId===task.id))assignments.push({...model,id:task.id+':assignment',taskId:task.id,actorId:task.step?'fixture-worker-'+task.id: model.actorId});
 for(const assignment of assignments)send({type:'assign',workId:original.id,assignment});
 const actorFor=(taskId:string)=>{const assignment=assignments.find(a=>a.taskId===taskId)!;return {id:assignment.actorId,roles:[assignment.role]} as Actor;};
 // Workers run before their lead so dependency and child-settlement guards are exercised.
 const ordered=[...tasks.filter(t=>t.step),...tasks.filter(t=>!t.step&&t.parentId!==null),...tasks.filter(t=>t.parentId===null)];
 for(const task of ordered){
  const actor=actorFor(task.id),effects=original.effects.filter(e=>e.taskId===task.id);
  if(task.step&&!task.step.skipReason&&task.status!=='queued'&&!effects.length)effects.push({id:task.id+':fixture',taskId:task.id,status:'succeeded',target:'fixture text',authority:'data-only fixture',receipt:task.result||task.step.title});
  for(const effect of effects){
   assert.equal(effect.ownerDecision,undefined,'Owner effects are outside this generator');assert.equal(effect.providerDispatch,undefined,'Provider dispatch is outside this generator');
   send({type:'admit-effect',workId:original.id,effect:{id:effect.id,taskId:effect.taskId,status:'pending',target:effect.target,authority:effect.authority},reserve:0},actor);
   if(effect.status!=='pending')send({type:'receipt',workId:original.id,effectId:effect.id,outcome:effect.status,receipt:effect.receipt!,usage:0},actor);
  }
  if(task.status==='settled')send({type:'settle-task',workId:original.id,taskId:task.id,result:task.result!},actor);
 }
 if(original.artifact)send({type:'publish-artifact',workId:original.id,artifact:original.artifact},actorFor(original.assignments.find(a=>a.role==='executor')!.taskId));
 if(original.verdict){const {checkedAt,...verdict}=original.verdict;send({type:'verify',workId:original.id,verdict}, {id:assignments.find(a=>a.id===verdict.verifierAssignmentId)!.actorId,roles:['verifier']});}
 if(original.record)send({type:'accept',workId:original.id,recordId:original.record.id,...(original.record.artifactSnapshot?{artifactSnapshot:original.record.artifactSnapshot}:{})},owner);
 for(const instruction of original.instructions??[])send({type:'steer',workId:original.id,instruction:instruction.text},owner);
 for(const conversation of mission.conversations??[])if(conversation.workId===original.id)for(const message of conversation.messages)send({type:'append-work-message',workId:original.id,messageId:message.id,replyTo:message.replyTo,text:message.text},owner);
 work().budget={...original.budget,limit:work().budget.limit};for(const field of ['runtimeInterruption','runtimeRecovery','blocker'] as const)if(Object.hasOwn(original,field))(work() as any)[field]=structuredClone(original[field]);
 assert.ok(observedAt<=now,'Fixture observations must not be in the future');assert.equal(work().acceptance,original.acceptance);
 return {work:work(),conversation:(state as Mission).conversations?.find(c=>c.workId===original.id)};
}

export async function regenerate(screen:string){
 const fixture=await loadFixture(screen),inputs=await json(new URL('./work-telemetry-inputs.json',import.meta.url)),input=inputs[screen];
 for(const selected of [input,...(screen==='B7-churn'?[inputs['B18-room-b']]:[])]){
 const snapshot=fixture.routes['/missions/intake']!.body as any,original:Work=selected.work;
 const index=snapshot.value.works.findIndex((w:Work)=>w.id===original.id);assert.ok(index>=0);snapshot.value.works[index]=structuredClone(original);snapshot.value.conversations=[...(snapshot.value.conversations??[]).filter((c:any)=>c.workId!==original.id),...selected.conversations];
 const team=screen==='B7-churn'&&original.id===input.work.id?(await json(new URL('../../tests/fixtures/internal-teams/B7-teams.json',import.meta.url))).routes['/missions/intake'].body.value.works[0]:undefined;
 const result=produceWork(original,snapshot.value,fixture.now,team),mission=structuredClone(snapshot.value) as Mission;mission.works[index]=result.work;
 if(result.conversation){mission.conversations=mission.conversations?.filter(c=>c.workId!==original.id)??[];mission.conversations.push(result.conversation);}
 for(const route of Object.values(fixture.routes) as any[]){
  if(route.body?.value?.id===mission.id)route.body.value=JSON.parse(canonical(mission));
  if(route.body?.snapshot?.value?.id===mission.id)route.body.snapshot.value=JSON.parse(canonical(mission));
  for(const row of [...(route.body?.works??[]),...(route.body?.turns??[]).flatMap((turn:any)=>turn.work?[turn.work]:[])])if(row.workId===original.id){row.steps={done:result.work.tasks.filter(t=>(t.step||!result.work.tasks.some(x=>x.step)&&t.parentId!==null)&&t.status==='settled'&&!(t.id===result.work.assignments.find(a=>a.id===result.work.verdict?.verifierAssignmentId)?.taskId&&result.work.acceptance==='failed')).length,total:result.work.tasks.filter(t=>t.step||!result.work.tasks.some(x=>x.step)&&t.parentId!==null).length};}
  if(route.body?.artifact&&route.body?.recordChecksum){const record=mission.works.find(w=>w.record?.id===route.body.recordId||w.id===route.body.workId)?.record;if(record)route.body.recordChecksum=record.checksum;}
  if(route.body?.conversation?.workId===original.id&&result.conversation)route.body.conversation=structuredClone(result.conversation);
 }
 }
 fixture.gaps=input.gaps.filter((gap:string)=>!gap.startsWith('AssistantSource and pinned criteria')).map((gap:string)=>gap.startsWith('No host producer supplies named business steps')?(screen==='B7-churn'?'No browser/page-read telemetry is produced by these fixture text Works.':'These text-only Works have no named business procedure or browser/page-read telemetry.'):gap.replace('business procedure steps, per-step timestamps, typed pricing table','business procedure steps, typed pricing table'));
 fixture.description='Work telemetry generated through versioned domain commands; fixture text only, no external business evidence.';

 fixture.reuse=fixture.reuse.filter(text=>!text.startsWith('scripts/ui-contracts/regenerate-work-telemetry.ts:'));fixture.reuse.push('scripts/ui-contracts/regenerate-work-telemetry.ts: timed admission, task effects/settlement, independent check and owner discussion commands');
 if(input.extends){const parent=await loadFixture(input.extends);(fixture as any).extends=input.extends;fixture.routes=Object.fromEntries(Object.entries(fixture.routes).filter(([key,route])=>JSON.stringify(route)!==JSON.stringify(parent.routes[key])));}
 await writeFile(new URL(screen+'.json',directory),JSON.stringify(fixture,null,2)+'\n');
}
export async function regenerateException(){
 const fixture=await json(new URL('B5.json',directory)),snapshot=fixture.routes['/missions/intake'].body;
 const store=new InMemoryStore<Mission>(),app=new Application(store,[owner,{id:'executor',roles:['executor']},{id:'representative',roles:['representative']}],()=>fixture.now);
 const {id,purpose,scope,constraints,criteria}=snapshot.value;await app.create({id,purpose,scope,constraints,criteria},owner.id,'b5-create');let n=0;
 const send=async(command:Command,actorId=owner.id)=>{const result=await app.dispatch({missionId:id,commandId:'b5-'+(++n),expectedRevision:(await store.load(id))!.revision,actorId,command});assert.equal(result.status,'committed');};
 for(const original of snapshot.value.works as Work[]){
  await send({type:'admit-work',workId:original.id,title:original.title,budget:original.budget.limit});
  if(original.runtimeRun){const work=(await store.load(id))!.value.works.find(w=>w.id===original.id)!;await send({type:'activate-runtime',workId:work.id,run:{...original.runtimeRun,inputHash:workInputHash(work)}});}
  for(const assignment of original.assignments)await send({type:'assign',workId:original.id,assignment});
  for(const effect of original.effects){await send({type:'admit-effect',workId:original.id,effect:{id:effect.id,taskId:effect.taskId,status:'pending',target:effect.target,authority:effect.authority},reserve:original.budget.reserved},'executor');await send({type:'receipt',workId:original.id,effectId:effect.id,outcome:effect.status as 'unknown'|'succeeded',receipt:effect.receipt!,usage:original.budget.measured},'executor');}
  if(original.runtimeInterruption)await send({type:'expire-runtime',workId:original.id,runId:original.runtimeRun!.id,dispatchId:original.runtimeInterruption.dispatchId,observedAt:original.runtimeInterruption.observedAt},'representative');
 }
 const committed=(await store.load(id))!;
 for(const route of Object.values(fixture.routes) as any[]){if(route.body?.value?.id===id)route.body=committed;if(route.body?.snapshot?.value?.id===id)route.body.snapshot=committed;}
 await writeFile(new URL('B5.json',directory),JSON.stringify(fixture,null,2)+'\n');
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 await regenerateException();
 for(const screen of ['B7','B7-churn','B7-done','B7-fail','B7-unknown'])await regenerate(screen);
 const alias=(await json(new URL('./work-telemetry-inputs.json',import.meta.url)))['B18-room-b'].template;alias.gaps=alias.gaps.map((gap:string)=>gap.replace('business procedure steps, per-step timestamps, typed pricing table','business procedure steps, typed pricing table'));await writeFile(new URL('B18-room-b.json',directory),JSON.stringify(alias,null,2)+'\n');
 // Inherited readers must still name each descendant's own retained Record.
 for(const file of await readdir(directory))if(file.endsWith('.json')){
  const path=new URL(file,directory),raw=await json(path),fixture=await loadFixture(raw.screen),mission=(fixture.routes['/missions/intake']?.body as any)?.value;let changed=false;
  for(const [key,route] of Object.entries(fixture.routes) as [string,any][]){const record=mission?.works.find((w:Work)=>w.id===route.body?.workId)?.record;if(key.includes('/record-artifact?')&&record&&route.body.recordChecksum!==record.checksum){(raw.routes??={})[key]={...route,body:{...route.body,recordChecksum:record.checksum}};changed=true;}}
  if(changed)await writeFile(path,JSON.stringify(raw,null,2)+'\n');
 }
}
