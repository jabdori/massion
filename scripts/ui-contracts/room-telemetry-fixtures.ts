import {readFile,writeFile} from 'node:fs/promises';
import {apply,createMission,hash,canonical,workInputHash,observesWork,endsWork} from '../../src/domain.ts';
import type {Actor,Command,Mission,Work} from '../../src/domain.ts';
import {ownerMessageId,assistantTurnId,assistantWorkId,assistantRunId} from '../../src/assistant-conversation.ts';
import {applySkills} from '../../src/skills.ts';
import {memberProcedures,parseTeamPlan} from '../../src/internal-teams.ts';
import {validateMissionLineage} from '../../src/backup-lineage.ts';
import {loadFixture} from './fixture-host.ts';
import {workCardFacts} from '../../src/assistant-service.ts';

const directory=new URL('./fixtures/',import.meta.url),owner:Actor={id:'local-owner',roles:['owner']},host:Actor={id:'runtime-representative',roles:['representative']};
const time=(clock:string)=>Date.parse('2026-11-05T'+clock+':00+09:00');
const pricing=[
 {role:'조사',title:'출처 고르기',dependsOn:[],start:'10:30',end:'10:32',done:3,total:3,result:'출처 3곳'},
 {role:'조사',title:'가격 모으기',dependsOn:[0],instruction:'세 곳 요금제 페이지에서 월 요금만 모아 줘.',start:'10:32',end:'10:40',done:3,total:3,result:'A사 2개, B사 3개 요금제예요. C사는 연간 요금만 있어요.',note:{label:'C사',text:'연간 요금만 공개'}},
 {role:'요약',title:'요약',dependsOn:[1],skipReason:'표만 요청',end:'10:40',result:'Skipped · 표만 요청'},
 {role:'표 정리',title:'표 만들기',dependsOn:[1],instruction:'C사는 연간 요금을 12로 나눠 적어 줘. 금액은 원 단위로.',start:'10:42',end:'10:47',done:1,total:1,result:'표 1개, 요금제 6개예요.'}
];
const coding=[{role:'읽기',title:'읽기',dependsOn:[],start:'10:40',done:4,total:11},{role:'테스트',title:'테스트 돌리기',dependsOn:[0]}];

/** Observed units are controlled fixture inputs, never parsed from a model's prose. */
export function roomTelemetryWork(mission:Mission,kind:'pricing'|'coding'){
 const stamp=(clock:string)=>time(clock)+(kind==='pricing'?200*60000:0);
 const spec:typeof pricing|typeof coding=kind==='pricing'?pricing:coding,memberId=kind==='pricing'?'member-quill':'member-juno',title=kind==='pricing'?'경쟁사 가격':'PR #84 검토',start=kind==='pricing'?'10:30':'10:40';
 const messageId=ownerMessageId('room-telemetry-'+kind),turnId=assistantTurnId(messageId),workId=assistantWorkId(turnId),runId=assistantRunId(turnId),message={id:messageId,ordinal:1,actorId:owner.id,role:'owner' as const,turnId:null,text:kind==='pricing'?'경쟁사 가격도 확인해 줘.':'PR #84 검토해 줘.',at:stamp(start)};
 const source={segmentId:'assistant-conversation:1',turnId,messageId,messageHash:hash(message),message,representative:{provider:'fixture',model:'fixture-representative'},memberId};
 const skills=applySkills(null,{type:'write-skill',memberId,kind:'procedure',name:title,body:{description:title,steps:spec.map(s=>s.title),verify:mission.criteria.description}},owner,{observedAt:stamp(start)}).value,team=memberProcedures(skills,memberId,1);
 let state=createMission({id:mission.id,purpose:mission.purpose,scope:mission.scope,constraints:mission.constraints,criteria:mission.criteria},owner),at=stamp(start);
 const send=(command:Command,actor:Actor=host,clock?:string)=>{if(clock)at=stamp(clock);state=apply(state,command,actor,observesWork(command.type)?{observedAt:at,telemetryVersion:1,...(endsWork(command.type)?{workEndVersion:2 as const}:{})}:undefined).value;};
 send({type:'admit-work',workId,title,budget:64,assistantSource:source,team},{id:'fixture-assistant',roles:['assistant']});
 const current=()=>state.works[0]!;
 send({type:'activate-runtime',workId,run:{id:runId,authorizationId:'fixture-only',criteriaHash:hash(current().criteria),inputHash:workInputHash(current()),mode:'mock-http',outputTokenCap:1,...(kind==='coding'?{ownership:{hostSessionId:'fixture-room',dispatchId:'fixture-'+kind,startedAt:at,deadlineAt:at+300000}}:{})}},owner);
 const model={provider:'fixture',model:'bounded-fixture',reason:'Controlled fixture, no provider invocation',configVersion:'v1',evidenceClass:'fixture' as const};
 for(const role of ['executor','verifier'] as const){send({type:'delegate',workId,taskId:workId+':'+role,parentId:workId+':root'});send({type:'assign',workId,assignment:{id:role,actorId:role,role,taskId:workId+':'+role,model,extensionVersion:'fixture-v1'}});}
 const plan=parseTeamPlan(JSON.stringify({steps:spec.map(s=>({role:s.role,title:s.title,dependsOn:s.dependsOn,...('instruction' in s&&s.instruction?{instruction:s.instruction}:{}),...('skipReason' in s&&s.skipReason?{skipReason:s.skipReason}:{})}))}),current());
 for(const [index,step] of plan.entries()){const taskId=workId+':step:'+index;send({type:'delegate',workId,taskId,parentId:workId+':executor',step});send({type:'assign',workId,assignment:{id:taskId,actorId:'worker-'+index,role:'executor',taskId,model,extensionVersion:'fixture-v1'}});}
 for(const [index,raw] of spec.entries()){
  const s=raw as typeof pricing[number]&{start?:string;end?:string},taskId=workId+':step:'+index,actor:Actor={id:'worker-'+index,roles:['executor']};
  if(s.start){send({type:'admit-effect',workId,effect:{id:taskId+':effect',taskId,status:'pending',target:'controlled fixture units',authority:'fixture-only'},reserve:0},actor,s.start);
   send({type:'record-step-progress',workId,taskId,progress:{done:s.done!,total:s.total!,...(s.note?{note:s.note}:{})}},actor,s.end??s.start);
   if(s.end)send({type:'receipt',workId,effectId:taskId+':effect',outcome:'succeeded',receipt:s.result!,usage:0},actor,s.end);
  }
  if(s.end)send({type:'settle-task',workId,taskId,result:s.result!},actor,s.end);
 }
 if(kind==='coding')send({type:'append-work-message',workId,messageId:'procedure-note',replyTo:null,text:'이번에도 테스트부터 돌려 줘.',stepNote:{taskId:workId+':step:1',title:'테스트 먼저 돌리기'}},owner,'10:44');
 validateMissionLineage(state);return {work:current(),conversation:state.conversations?.[0],source};
}

export async function regenerateRoomScreens(){
 for(const [screen,base,kind,legacyId] of [['B18-room-b','B7-churn','pricing','pricing'],['B22-room-steps','B22-room','coding','pr84']] as const){
  const fixture=await loadFixture(base,['regeneration-source']),mission=structuredClone((fixture.routes['/missions/intake']!.body as any).value) as Mission,{work,conversation,source}=roomTelemetryWork(mission,kind),now=kind==='pricing'?fixture.now:time('10:44'),previous=mission.works.find(w=>kind==='pricing'?w.title==='경쟁사 가격':w.id===legacyId)!,previousId=previous.id;
  mission.works=mission.works.map(w=>w.id===previousId?work:w);if(conversation)mission.conversations=[...(mission.conversations??[]).filter(c=>c.workId!==previousId),conversation];
  const previousTurn=previous.assistantSource?.turnId??'assistant-turn:m:'+previousId,previousMessage=previous.assistantSource?.messageId??'m:'+previousId;
  for(const route of Object.values(fixture.routes) as any[]){const body=route.body;
   if(body?.value?.id===mission.id)body.value=JSON.parse(canonical(mission));if(body?.snapshot?.value?.id===mission.id)body.snapshot.value=JSON.parse(canonical(mission));
   for(const row of [...(body?.works??[]),...(body?.turns??[]).flatMap((t:any)=>t.work?[t.work]:[])])if(row.workId===previousId){Object.assign(row,{workId:work.id,execution:work.execution,startedAt:work.runtimeRun?.ownership?.startedAt??work.tasks.find(t=>t.startedAt!==undefined)?.startedAt??null,endedAt:null,turnId:source.turnId,steps:{done:work.tasks.filter(t=>t.step&&t.status==='settled').length,total:work.tasks.filter(t=>t.step).length},progress:{make:{done:work.tasks.filter(t=>t.step&&t.status==='settled').length,total:work.tasks.filter(t=>t.step).length},check:{done:0,total:1}}});}
   for(const row of [...(body?.works??[]),...(body?.turns??[]).flatMap((t:any)=>t.work?[t.work]:[])]){const current=mission.works.find(w=>w.id===row.workId);if(current)Object.assign(row,workCardFacts(current));}
   for(const turn of body?.turns??[])if(turn.id===previousTurn){turn.id=source.turnId;turn.messageId=source.messageId;turn.at=work.admittedAt;}
   for(const m of body?.segment?.messages??[]){if(m.id===previousMessage){m.id=source.messageId;m.at=work.admittedAt;}if(m.turnId===previousTurn){m.turnId=source.turnId;m.at=work.admittedAt;}}
  }
  const steps=kind==='pricing'?[{selector:'#side-member-member-quill',action:'click',readySelector:'#chat-log .chat-reply'},{selector:'[id="side-line-intake/'+work.id+'"]',action:'click',readySelector:'#work-heading-'+work.id}]:[{selector:'#side-member-member-juno',action:'click',readySelector:'#chat-log .chat-reply'},{selector:'[id="chat-card-'+source.turnId+'"] .chat-card-open',action:'click',readySelector:'#work-heading-'+work.id}];
  const parent=await loadFixture(base,['regeneration-source']),routes=Object.fromEntries(Object.entries(fixture.routes).filter(([key,value])=>JSON.stringify(value)!==JSON.stringify(parent.routes[key])));
  const output={screen,extends:base,description:'Selected room observations produced by domain commands; no injected challenge transcript or external calls.',now,readySelector:kind==='pricing'?'#side-member-member-quill':'#side-member-member-juno',steps,gaps:kind==='pricing'?['The monthly pricing table has no typed business-result producer; the memory-candidate row belongs to R-D. No table is inferred from worker text.']:[],reuse:['scripts/ui-contracts/room-telemetry-fixtures.ts: owner procedure, validated plan, assigned progress, receipts and pending procedure note commands'],routes};
  await writeFile(new URL(screen+'.json',directory),JSON.stringify(output,null,2)+'\n');
 }
}
