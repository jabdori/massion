import test from 'node:test';
import {Application} from '../src/application.ts';
import {InMemoryStore} from '../src/storage.ts';
import assert from 'node:assert/strict';
import {memberProcedures,parseTeamPlan,validateTeamProcedure} from '../src/internal-teams.ts';
import {apply,createMission,hash,workProducers} from '../src/domain.ts';
import {familyCheck} from '../src/model-family.ts';
import {applySkills} from '../src/skills.ts';
import type {SkillsState} from '../src/skills.ts';

const owner={id:'owner',roles:['owner'] as const},rep={id:'rep',roles:['representative'] as const};
function work(){let m=createMission({id:'m',purpose:'p',scope:'s',constraints:[],criteria:{version:1,description:'d',oracle:'manual'}},owner);m=apply(m,{type:'admit-work',workId:'w',title:'t',budget:50},owner).value;const w=m.works[0]!;w.team=memberProcedures(null,'member');return {m,w};}

test('a plan cannot omit steps, add authority fields, cycles or blank skip reasons',()=>{
 const {w}=work(),step={role:'Read',title:'Read evidence',dependsOn:[],instruction:'Read the pinned evidence'};
 for(const steps of [[step],[step,step,step],[{...step,dependsOn:[1]},step],[step,{...step,dependsOn:[1]}],[step,{...step,skipReason:' '}],[step,{...step,actorId:'checker'}]])assert.throws(()=>parseTeamPlan(JSON.stringify({steps}),w),/Invalid internal team/);
 const parsed=parseTeamPlan(JSON.stringify({steps:[step,{...step,role:'Write',dependsOn:[0],skipReason:'No new source'}]}),w);assert.deepEqual(parsed[1]!.dependsOn,['w:step:0']);assert.equal(parsed[0]!.instruction,step.instruction);assert.throws(()=>parseTeamPlan(JSON.stringify({steps:[{...step,instruction:' '},step]}),w),/Invalid internal team/);
});

test('procedure load excludes other members, skills and archives, and refuses tampering and excess steps',()=>{
 let state:SkillsState|null=null;
 const body={description:'Read',steps:['Read inputs'],verify:'Compare output'};
 for(const [i,memberId,kind] of [[0,'member','procedure'],[1,'other','procedure'],[2,'member','skill']] as const)state=applySkills(state,{type:'write-skill',memberId,kind,name:'Read '+i,body},owner,{observedAt:1}).value;
 const selected=memberProcedures(state,'member');assert.equal(selected.procedures.length,1);assert.equal(selected.procedures[0]!.id,state!.skills[0]!.id);
 state!.skills[0]!.versions[0]!.body.steps[0]='Changed';assert.throws(()=>memberProcedures(state,'member'),/content changed/);
 state!.skills[0]!.archivedAt=2;assert.equal(memberProcedures(state,'member').procedures[0]!.id,'host-default-v1');
 assert.throws(()=>validateTeamProcedure({...selected,memberId:'other'},'member'),/Invalid/);
 const huge=structuredClone(selected);huge.procedures[0]!.body.steps=Array(13).fill('Read');huge.procedures[0]!.hash=hash(huge.procedures[0]!.body);assert.throws(()=>validateTeamProcedure(huge,'member'),/Invalid/);
});

test('worker effects respect dependencies and skips and cannot publish the team artifact',()=>{
 let {m}=work();
 m=apply(m,{type:'delegate',workId:'w',taskId:'w:executor',parentId:'w:root'},rep).value;
 for(const [i,step] of [{role:'Read',title:'Read',dependsOn:[]},{role:'Write',title:'Write',dependsOn:['w:step:0']}].entries()){
  m=apply(m,{type:'delegate',workId:'w',taskId:'w:step:'+i,parentId:'w:executor',step},rep).value;
  m=apply(m,{type:'assign',workId:'w',assignment:{id:'a'+i,actorId:'worker'+i,role:'executor',taskId:'w:step:'+i,model:{provider:'fixture',model:'m',configVersion:'v1',reason:'test',evidenceClass:'fixture'},extensionVersion:'v1'}},rep).value;
 }
 assert.throws(()=>apply(m,{type:'admit-effect',workId:'w',effect:{id:'e',taskId:'w:step:1',status:'pending',target:'text',authority:'g'},reserve:1},{id:'worker1',roles:['executor']}),/dependencies/);
 assert.throws(()=>apply(m,{type:'assign',workId:'w',assignment:{...m.works[0]!.assignments[0]!,id:'escape',taskId:'w:executor'}},rep),/worker/);
 assert.throws(()=>apply(m,{type:'publish-artifact',workId:'w',artifact:{id:'a',version:1,sha256:'a'.repeat(64),path:'p',kind:'text'}},{id:'worker0',roles:['executor']}),/assigned/);
 m.works[0]!.tasks.find(t=>t.id==='w:step:0')!.step!.skipReason='Already supplied';
 assert.throws(()=>apply(m,{type:'admit-effect',workId:'w',effect:{id:'skip',taskId:'w:step:0',status:'pending',target:'text',authority:'g'},reserve:1},{id:'worker0',roles:['executor']}),/skipped/);
 assert.throws(()=>apply(m,{type:'settle-task',workId:'w',taskId:'w:step:0',result:'Done'},{id:'worker0',roles:['executor']}),/Skipped step/);
});


test('overlapping identical team delegates replay the stored result and create one step',async()=>{
 const {m}=work(),store=new InMemoryStore<typeof m>();await store.commit({id:'m',commandId:'seed',expectedRevision:0,fingerprint:hash(m),value:m,events:[],outbox:[]});
 const app=new Application(store,[rep]);await app.dispatch({missionId:'m',commandId:'parent',expectedRevision:1,actorId:rep.id,command:{type:'delegate',workId:'w',taskId:'w:executor',parentId:'w:root'}});
 const envelope={missionId:'m',commandId:'step',expectedRevision:2,actorId:rep.id,command:{type:'delegate' as const,workId:'w',taskId:'w:step:0',parentId:'w:executor',step:{title:'Read sources',role:'Reading',dependsOn:[]}}};
 const results=await Promise.all([app.dispatch(envelope),app.dispatch(envelope)]);assert.deepEqual(results.map(r=>r.status).sort(),['committed','replayed']);assert.equal((await store.load('m'))!.value.works[0]!.tasks.filter(t=>t.step).length,1);
});


test('the check family includes a worker even when the lead is from another family',()=>{
 const {w}=work();w.assignments=['openai','anthropic'].map((provider,i)=>({id:'a'+i,actorId:'actor'+i,role:'executor',taskId:i?'w:step:0':'w:executor',model:{provider,model:'model',configVersion:'v1',reason:'fixture',evidenceClass:'fixture'},extensionVersion:'v1'}));
 const check=familyCheck(workProducers(w),{provider:'anthropic',model:'checker'});assert.equal(check.producers.length,2);assert.equal(check.relation,'same-family');
});
