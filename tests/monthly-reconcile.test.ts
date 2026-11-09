import test from 'node:test';
import assert from 'node:assert/strict';
import {createMission,apply,hash,workInputHash} from '../src/domain.ts';
import {MONTHLY_BUDGET_ID,reconcileMonthly} from '../src/monthly-budget.ts';
import type {MonthlySnapshot,MonthlyBudgetState,Reservation} from '../src/monthly-budget.ts';
const owner={id:'local-owner',roles:['owner'] as const};
function snapshot():MonthlySnapshot {
 let m=createMission({id:'m',purpose:'Fixture',scope:'s',constraints:[],criteria:{version:1,description:'Fixture',oracle:'bounded-text-review/v1'}},owner);m=apply(m,{type:'admit-work',workId:'w',title:'Fixture',budget:128},owner).value;const w=m.works[0]!;
 const r:Reservation={missionId:'m',workId:'w',runId:'original-run',amount:128,inputHash:workInputHash(w),revision:2,title:w.title,period:'2026-11',at:1,state:'reserved',decisionId:'decision',feedId:'feed:original',selection:{executorProfileId:'original-exec',verifierProfileId:'original-check',authorizationId:'original-grant',outputTokenCap:64}};
 const value:MonthlyBudgetState={kind:'monthly-budget',id:MONTHLY_BUDGET_ID,limit:128,timezone:'UTC',actorId:owner.id,reservations:[r],decisions:[{id:'decision',period:'2026-11',at:1,state:'done',limit:0,nextLimit:128}]};return {feedId:'feed:original',budget:{revision:1,value},missions:new Map([['m',{revision:2,value:m}]]),admitting:false};
}
test('the single planner obeys invariant laws across evidence, decisions and reservation states',()=>{
 for(const evidence of ['none','run','effect','both'])for(const closed of [false,true])for(const decision of ['open','later','done'] as const)for(const state of ['reserved','waiting','released','settled'] as const)for(const foreign of [false,true]){
  const s=snapshot(),w=s.missions.get('m')!.value.works[0]!,r=s.budget!.value.reservations[0]!,d=s.budget!.value.decisions[0]!;r.state=state;d.state=decision;if(foreign)s.feedId='feed:restored';w.execution=closed?'settled':evidence==='none'?'queued':'active';w.budget.measured=closed?4:0;
  if(evidence==='run'||evidence==='both')w.runtimeRun={id:r.runId,authorizationId:'fixture',criteriaHash:hash(w.criteria),inputHash:r.inputHash,mode:'mock-http',outputTokenCap:64};
  if(evidence==='effect'||evidence==='both')w.effects=[{id:'sent-effect',taskId:'w:root',target:'fixture',authority:'fixture',status:closed?'succeeded':'unknown',...(closed?{receipt:'Fixture usage recorded'}:{})}];
  const before=hash([s.budget,[...s.missions]]),p=reconcileMonthly(s)[0]!;assert.equal(hash([s.budget,[...s.missions]]),before,'planning cannot mutate authoritative evidence');
  if(foreign)assert.equal(p.kind,'hold');else if(evidence!=='none')assert.ok(['hold','settle'].includes(p.kind),'sent evidence cannot be released or dispatched');else if(!closed&&state==='reserved')assert.equal(p.kind,'release');
  if(p.kind==='run'){assert.equal(decision,'done');assert.equal(evidence,'none');assert.deepEqual(p.reservation.selection,r.selection);}if(p.kind==='settle'){assert.equal(closed,true);assert.equal(p.usage,4);}
 }
});
test('foreign-feed and missing-selection history cannot silently adopt the host default',()=>{
 const s=snapshot(),r=s.budget!.value.reservations[0]!;r.state='released';delete r.selection;assert.equal(reconcileMonthly(s)[0]!.kind,'hold');r.feedId='feed:backup';r.state='reserved';assert.equal(reconcileMonthly(s)[0]!.kind,'hold');
});
