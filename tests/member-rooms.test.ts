import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {apply,createMission,hash} from '../src/domain.ts';
import type {Command,Mission} from '../src/domain.ts';
import {memberProcedures} from '../src/internal-teams.ts';
import {Application} from '../src/application.ts';
import {InMemoryStore} from '../src/storage.ts';
const owner={id:'owner',roles:['owner'] as const},host={id:'runtime-representative',roles:['representative'] as const};
const content='The café has two open blockers.';
function seed(){
 let m=createMission({id:'m',purpose:'p',scope:'s',constraints:[],criteria:{version:1,description:'Identify blockers',oracle:'manual'}},owner);
 m=apply(m,{type:'admit-work',workId:'w',title:'t',budget:20000},owner).value;
 const w=m.works[0]!;w.team=memberProcedures(null,'member');w.execution='active';
 w.artifact={id:'a',kind:'text',path:'a',version:1,sha256:createHash('sha256').update(content).digest('hex')};
 for(const [slot,actorId] of [['executor','producer'],['challenge','challenger'],['answer','producer'],['verifier','checker']]){
  w.tasks.push({id:'w:'+slot,parentId:'w:root',status:'active'});
  w.assignments.push({id:slot!,actorId:actorId!,role:slot==='verifier'?'verifier':'executor',taskId:'w:'+slot,model:{provider:'fixture',model:'small',configVersion:'v1',reason:'test',evidenceClass:'fixture'},extensionVersion:'v1'});
 }
 return m;
}
const open={type:'open-room',workId:'w',content,producerAssignmentId:'executor',challengerAssignmentId:'challenge'} as Command;
function turn(m:Mission,slot:string,output:unknown){const w=m.works[0]!;w.effects.push({id:slot,taskId:'w:'+slot,status:'succeeded',target:'fixture',authority:'test',receipt:JSON.stringify({status:'completed',output:JSON.stringify(output)})});return apply(m,{type:'record-room-turn',workId:'w',effectId:slot} as Command,host).value;}

test('challenge and counter-evidence are retained as inferred provenance, never a verdict',()=>{
 let m=apply(seed(),open,host).value;assert.ok(m.works[0]!.room);
 m=turn(m,'challenge',{kind:'challenge',text:'Name the blockers',quote:'cafe\u0301 has   two open blockers.'});
 assert.equal(m.works[0]!.room!.messages[1]!.status,'admitted');
 m=turn(m,'answer',{kind:'answer',text:'The count is stated, but names are missing',quote:'two open blockers'});
 const room=m.works[0]!.room!;assert.equal(room.issue?.status,'escalated');assert.equal(room.messages[2]!.replyTo,2);assert.equal(room.messages[2]!.inferred,true);assert.equal(room.messages[2]!.effectId,'answer');assert.equal(m.works[0]!.verdict,undefined);
 assert.throws(()=>turn(m,'answer2',{kind:'answer',text:'Again',quote:'two'}),/Room/);
});

test('unsupported challenges are returned and concessions cannot resolve an issue',()=>{
 const opened=apply(seed(),open,host).value;
 const returned=turn(structuredClone(opened),'challenge',{kind:'challenge',text:'Invented claim',quote:'not in this artifact'});
 assert.equal(returned.works[0]!.room!.messages[1]!.status,'returned');assert.equal(returned.works[0]!.room!.issue,null);
 let conceded=turn(opened,'challenge',{kind:'challenge',text:'Names missing',quote:'two open blockers'});
 conceded=turn(conceded,'answer',{kind:'concede',text:'The names are missing',quote:''});
 assert.equal(conceded.works[0]!.room!.issue?.status,'escalated');assert.equal(conceded.works[0]!.acceptance,'pending');
});

test('room commands cannot forge content, use checking identities or advance after interruption',()=>{
 const m=seed();assert.throws(()=>apply(m,{...open,content:'forged'} as Command,host),/Room/);
 assert.throws(()=>apply(m,{...open,challengerAssignmentId:'verifier'} as Command,host),/Room/);
 assert.throws(()=>apply(m,open,owner),/Room/);
 const opened=apply(m,open,host).value;opened.works[0]!.execution='waiting';assert.throws(()=>turn(opened,'challenge',{kind:'challenge',text:'x',quote:'two'}),/Room/);
});

test('overlapping identical room commands replay once after loading state',async()=>{
 const store=new InMemoryStore<Mission>(),m=seed();await store.commit({id:'m',commandId:'seed',expectedRevision:0,fingerprint:hash(m),value:m,events:[],outbox:[]});
 const app=new Application(store,[host]),envelope={missionId:'m',commandId:'open',expectedRevision:1,actorId:host.id,command:open};
 const results=await Promise.all([app.dispatch(envelope),app.dispatch(envelope)]);assert.deepEqual(results.map(r=>r.status).sort(),['committed','replayed']);assert.equal((await store.load('m'))!.value.works[0]!.room!.messages.length,1);
});

test('room artifact cannot be replaced after quote binding and an unfinished challenge cannot be checked',()=>{
 let m=apply(seed(),open,host).value;const producer={id:'producer',roles:['executor'] as const};
 assert.throws(()=>apply(m,{type:'publish-artifact',workId:'w',artifact:{...m.works[0]!.artifact!,version:2}},producer),/Room/);
 const verdict={id:'v',verifierAssignmentId:'verifier',artifactSha256:m.works[0]!.artifact!.sha256,artifactVersion:1,criteriaVersion:1,status:'passed' as const,evidence:[{kind:'test',detail:'test',source:'test'}]};
 assert.throws(()=>apply(m,{type:'verify',workId:'w',verdict},{id:'checker',roles:['verifier']}),/Room/);
 m=turn(m,'challenge',{kind:'challenge',text:'Names missing',quote:'two open blockers'});
 assert.throws(()=>apply(m,{type:'verify',workId:'w',verdict},{id:'checker',roles:['verifier']}),/Room/);
});

test('moderation quotes keep Unicode boundaries so optional shadow calls cannot stop valid Work',async()=>{
 const {roomModerationInput}=await import('../src/member-rooms.ts'),{buildQuestion}=await import('../src/discriminator.ts');
 const m=apply(seed(),open,host).value,w=m.works[0]!;w.room!.messages[0]!.text='a'.repeat(2047)+'😀';
 const input=roomModerationInput(w,1,2);assert.doesNotThrow(()=>buildQuestion(input));assert.equal(input.quotes[0]!.quoted,'a'.repeat(2047));
});
