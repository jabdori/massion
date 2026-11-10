import type {ScreenFixture} from './fixture-host.ts';
import type {Mission,Work} from '../../src/domain.ts';
import {canonical} from '../../src/domain.ts';
import {workCardFacts} from '../../src/assistant-service.ts';
import {roomTelemetryWork} from './room-telemetry-fixtures.ts';
import {churnSource,produceWork} from './regenerate-work-telemetry.ts';

export const RESULT_FACT_SCREENS=['B2','B3-run','B5','B6','B6-token','B7','B7-churn','B7-done','B7-fail','B7-unknown','B8','B8-done','B8-fail','B8-unknown','B9','B9-restart','B9-update','B15','B18','B18-room-b'];

/** Controlled business inputs pass the same procedure/task commands as runtime. */
export function resultFactsFixture(template:ScreenFixture):ScreenFixture {
 const fixture=structuredClone(template),mission=(fixture.routes['/missions/intake']?.body as any)?.value as Mission|undefined;
 if(!mission)return fixture;
 for(const original of [...mission.works]){
  const kind=original.title==='이탈 원인 조사'?'churn':original.title==='경쟁사 가격'?'pricing':null;if(!kind)continue;
  let work:Work,conversation:NonNullable<Mission['conversations']>[number]|undefined;
  if(original.assistantSource){
   const source=kind==='churn'?churnSource(original):roomTelemetryWork(mission,'pricing').work;
   ({work,conversation}=produceWork(original,mission,fixture.now,source));
  }else ({work,conversation}=roomTelemetryWork(mission,kind));
  const previousTurn=original.assistantSource?.turnId??'assistant-turn:m:'+original.id,previousMessage=original.assistantSource?.messageId??'m:'+original.id,source=work.assistantSource!;
  mission.works=mission.works.map(w=>w.id===original.id?work:w);
  if(conversation)mission.conversations=[...(mission.conversations??[]).filter(c=>c.workId!==original.id),conversation];
  for(const route of Object.values(fixture.routes) as any[]){const body=route.body;
   if(body?.value?.id===mission.id)body.value=JSON.parse(canonical(mission));
   if(body?.snapshot?.value?.id===mission.id)body.snapshot.value=JSON.parse(canonical(mission));
   for(const row of [...(body?.works??[]),...(body?.turns??[]).flatMap((t:any)=>t.work?[t.work]:[])])if(row.workId===original.id)Object.assign(row,{workId:work.id,missionRevision:body?.snapshot?.revision??row.missionRevision,started:true,startedAt:work.runtimeRun?.ownership?.startedAt??work.admittedAt,execution:work.execution,acceptance:work.acceptance,turnId:source.turnId,...workCardFacts(work)});
   for(const turn of body?.turns??[]){if(turn.id===previousTurn){turn.id=source.turnId;turn.messageId=source.messageId;}if(turn.steer?.workId===original.id)turn.steer.workId=work.id;}
   for(const message of body?.segment?.messages??[]){if(message.id===previousMessage)message.id=source.messageId;if(message.turnId===previousTurn)message.turnId=source.turnId;}
   if(body?.conversation?.workId===original.id&&conversation)body.conversation=structuredClone(conversation);
  }
 }
 fixture.gaps=fixture.gaps.map(gap=>gap==='These text-only Works have no named business procedure or browser/page-read telemetry.'?'Business procedures and typed counts exist for churn/pricing; browser/page-read telemetry is absent.':gap);
 fixture.reuse.push('scripts/ui-contracts/result-facts-fixtures.ts: command-produced procedures and explicit fixture business counts; no external evidence');
 return fixture;
}
