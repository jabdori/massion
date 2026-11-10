import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {apply,hash,canonical,workInputHash,observesWork,endsWork} from '../../src/domain.ts';
import type {Actor,Command,Mission,Work,Task} from '../../src/domain.ts';
import {regenerateRoomScreens,roomTelemetryWork} from './room-telemetry-fixtures.ts';
import {parseTeamPlan,teamCallCount} from '../../src/internal-teams.ts';
import {loadFixture} from './fixture-host.ts';
import {applySkills} from '../../src/skills.ts';
import {memberProcedures} from '../../src/internal-teams.ts';
import {parseResultFacts} from '../../src/result-facts.ts';
import {workCardFacts} from '../../src/assistant-service.ts';

const owner:Actor={id:'local-owner',roles:['owner']},host:Actor={id:'runtime-representative',roles:['representative']},assistant:Actor={id:'fixture-assistant',roles:['assistant']};
const directory=new URL('./fixtures/',import.meta.url);
const json=async(path:URL)=>JSON.parse(await readFile(path,'utf8'));

export function churnSource(original:Work){
 const settled=original.acceptance==='failed',memberId=original.assistantSource!.memberId!,spec=[
  {title:'범위 정하기',role:'조사',dependsOn:[],status:'settled',result:'지난 90일 해지'},
  {title:'자료 모으기',role:'조사',dependsOn:[0],status:'settled',instruction:'지난 90일 해지 고객의 해지 사유와 문의 기록을 모아 줘.',result:'해지 사유 41건 모았어요.'},
  {title:'나누기',role:'분류',dependsOn:[0],status:'settled',instruction:'모은 건은 기업 고객과 그 외로 나눠 줘.',result:JSON.stringify({format:'massion-facts/v1',items:[{label:'해지 사유',value:41,unit:'건'},{label:'기업',value:9,unit:'건'},{label:'그 외',value:32,unit:'건'}]})},
  {title:'설문 다시 보내기',role:'설문',dependsOn:[],status:'settled',skipReason:'지난달 설문 있음',result:'Skipped · 지난달 설문 있음'},
  {title:'원인 정리',role:'요약',dependsOn:[2],status:settled?'settled':'active',instruction:'두 묶음 따로 원인을 정리해 줘.',result:settled?JSON.stringify({format:'massion-facts/v1',items:[{label:'기업 고객 원인',value:1,unit:'개'},{label:'근거',value:2,unit:'건'}]}):undefined}
 ];
 const skills=applySkills(null,{type:'write-skill',memberId,kind:'procedure',name:original.title,body:{description:original.title,steps:spec.map(s=>s.title),verify:original.criteria.description}},owner,{observedAt:original.admittedAt??0}).value;
 return {...original,team:memberProcedures(skills,memberId,1),tasks:spec.map((s,index)=>({id:original.id+':step:'+index,parentId:original.id+':executor',status:s.status as Task['status'],...(s.result?{result:s.result}:{}),step:{title:s.title,role:s.role,dependsOn:s.dependsOn.map(i=>original.id+':step:'+i),...(s.instruction?{instruction:s.instruction}:{}),...(s.skipReason?{skipReason:s.skipReason}:{})}}))};
}

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
 const assembly=source.tasks.find(t=>t.id===source.id+':executor'&&t.status==='settled'&&t.result&&parseResultFacts(t.result));
 if(assembly){const task=tasks.find(t=>t.id===original.id+':executor');if(task){task.status='settled';task.result=assembly.result;}}
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
 const effectsFor=(task:Task)=>{
  const effects=original.effects.filter(e=>e.taskId===task.id);
  if(task.step&&!task.step.skipReason&&task.status!=='queued'&&!effects.length)effects.push({id:task.id+':fixture',taskId:task.id,status:'succeeded',target:'fixture text',authority:'data-only fixture',receipt:task.result||task.step.title});
  return effects;
 };
 const admit=(task:Task)=>{for(const effect of effectsFor(task)){
  assert.equal(effect.ownerDecision,undefined,'Owner effects are outside this generator');
  send({type:'admit-effect',workId:original.id,effect:{id:effect.id,taskId:effect.taskId,status:'pending',target:effect.target,authority:effect.authority},reserve:0},actorFor(task.id));
  if(effect.providerDispatch)send({type:'claim-provider-dispatch',workId:original.id,effectId:effect.id,claim:effect.providerDispatch},actorFor(task.id));
  if(!task.step&&effect.status!=='pending')send({type:'receipt',workId:original.id,effectId:effect.id,outcome:effect.status,receipt:effect.receipt!,usage:0,...(effect.providerDispatch?{providerDispatchId:effect.providerDispatch.id}:{})},actorFor(task.id));
 }};
 const settle=(task:Task)=>{for(const effect of effectsFor(task))if(task.step&&effect.status!=='pending')send({type:'receipt',workId:original.id,effectId:effect.id,outcome:effect.status,receipt:effect.receipt!,usage:0,...(effect.providerDispatch?{providerDispatchId:effect.providerDispatch.id}:{})},actorFor(task.id));
  if(task.status==='settled')send({type:'settle-task',workId:original.id,taskId:task.id,result:task.result!},actorFor(task.id));
 };
 // Ready workers start together; their host observations preserve the message order.
 const pending=tasks.filter(t=>t.step&&t.status!=='queued');
 while(pending.length){const ready=pending.filter(t=>t.step!.dependsOn.every(id=>work().tasks.find(x=>x.id===id)?.status==='settled'));assert.ok(ready.length,'Unresolved fixture dependencies');
  for(const task of ready)admit(task);for(const task of ready){settle(task);pending.splice(pending.indexOf(task),1);}
 }
 for(const task of [...tasks.filter(t=>!t.step&&t.parentId!==null),...tasks.filter(t=>t.parentId===null)]){admit(task);settle(task);}

 if(original.artifact)send({type:'publish-artifact',workId:original.id,artifact:original.artifact},actorFor(original.assignments.find(a=>a.role==='executor')!.taskId));
 if(original.verdict){const {checkedAt,...verdict}=original.verdict;send({type:'verify',workId:original.id,verdict}, {id:assignments.find(a=>a.id===verdict.verifierAssignmentId)!.actorId,roles:['verifier']});}
 if(original.record)send({type:'accept',workId:original.id,recordId:original.record.id,...(original.record.artifactSnapshot?{artifactSnapshot:original.record.artifactSnapshot}:{})},owner);
 for(const instruction of original.instructions??[])send({type:'steer',workId:original.id,instruction:instruction.text},owner);
 for(const conversation of mission.conversations??[])if(conversation.workId===original.id)for(const message of conversation.messages)send({type:'append-work-message',workId:original.id,messageId:message.id,replyTo:message.replyTo,text:message.text},owner);
 work().budget={...original.budget,limit:work().budget.limit};for(const field of ['runtimeInterruption','runtimeRecovery','blocker'] as const)if(Object.hasOwn(original,field))(work() as any)[field]=structuredClone(original[field]);
 assert.ok(observedAt<=now,'Fixture observations must not be in the future');assert.equal(work().acceptance,original.acceptance);
 return {work:work(),conversation:(state as Mission).conversations?.find(c=>c.workId===original.id)};
}

// Persist inherited sources; read-time overlays must not be serialized back into them.
export async function regenerate(screen:string){
 const fixture=await loadFixture(screen,['regeneration-source']),inputs=await json(new URL('./work-telemetry-inputs.json',import.meta.url)),input=inputs[screen];
 for(const selected of [input,...(screen==='B7-churn'?[inputs['B18-room-b']]:[])]){
 const snapshot=fixture.routes['/missions/intake']!.body as any,original:Work=selected.work;
 const index=snapshot.value.works.findIndex((w:Work)=>w.id===original.id);assert.ok(index>=0);snapshot.value.works[index]=structuredClone(original);snapshot.value.conversations=[...(snapshot.value.conversations??[]).filter((c:any)=>c.workId!==original.id),...selected.conversations];
 const team=['B7-churn','B7-fail'].includes(screen)&&original.id===input.work.id?churnSource(original):screen==='B7-churn'&&original.title==='경쟁사 가격'?roomTelemetryWork(snapshot.value,'pricing').work:undefined;
 const result=produceWork(original,snapshot.value,fixture.now,team),mission=structuredClone(snapshot.value) as Mission;mission.works[index]=result.work;
 if(result.conversation){mission.conversations=mission.conversations?.filter(c=>c.workId!==original.id)??[];mission.conversations.push(result.conversation);}
 for(const route of Object.values(fixture.routes) as any[]){
  if(route.body?.value?.id===mission.id)route.body.value=JSON.parse(canonical(mission));
  if(route.body?.snapshot?.value?.id===mission.id)route.body.snapshot.value=JSON.parse(canonical(mission));
  for(const row of [...(route.body?.works??[]),...(route.body?.turns??[]).flatMap((turn:any)=>turn.work?[turn.work]:[])]){const work=mission.works.find(w=>w.id===row.workId);if(work)Object.assign(row,workCardFacts(work));}
  if(route.body?.artifact&&route.body?.recordChecksum){const record=mission.works.find(w=>w.record?.id===route.body.recordId||w.id===route.body.workId)?.record;if(record)route.body.recordChecksum=record.checksum;}
  if(route.body?.conversation?.workId===original.id&&result.conversation)route.body.conversation=structuredClone(result.conversation);
 }
 }
 fixture.gaps=input.gaps.filter((gap:string)=>!gap.startsWith('AssistantSource and pinned criteria')).map((gap:string)=>gap.startsWith('No host producer supplies named business steps')?(screen==='B7-churn'?'No browser/page-read telemetry is produced by these fixture text Works.':'These text-only Works have no named business procedure or browser/page-read telemetry.'):gap.replace('business procedure steps, per-step timestamps, typed pricing table','business procedure steps, typed pricing table'));
 fixture.description='Work telemetry generated through versioned domain commands; fixture text only, no external business evidence.';

 fixture.reuse=fixture.reuse.filter(text=>!text.startsWith('scripts/ui-contracts/regenerate-work-telemetry.ts:'));fixture.reuse.push('scripts/ui-contracts/regenerate-work-telemetry.ts: timed admission, task effects/settlement, independent check and owner discussion commands');
 if(input.extends){const parent=await loadFixture(input.extends,['regeneration-source']);(fixture as any).extends=input.extends;fixture.routes=Object.fromEntries(Object.entries(fixture.routes).filter(([key,route])=>JSON.stringify(route)!==JSON.stringify(parent.routes[key])));}
 await writeFile(new URL(screen+'.json',directory),JSON.stringify(fixture,null,2)+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 for(const screen of ['B7-churn','B7-fail'])await regenerate(screen);
 await regenerateRoomScreens();
}
