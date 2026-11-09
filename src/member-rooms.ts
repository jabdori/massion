import {createHash} from 'node:crypto';
import {DomainError,hash} from './domain.ts';
import type {Actor,Work} from './domain.ts';
import type {ModerationInput} from './discriminator.ts';
export interface RoomMessage {ordinal:number;authorId:string;assignmentId:string;effectId:string|null;kind:'proposal'|'challenge'|'answer'|'concede';replyTo:number|null;text:string;quote:string;inferred:true;status:'admitted'|'returned'}
// shortcut: one artifact and one challenge round; widen after multi-member routing and revision leases are pinned.
export interface MemberRoom {version:1;artifact:{version:number;sha256:string;content:string};producerAssignmentId:string;challengerAssignmentId:string;sameModel:boolean;messages:RoomMessage[];issue:{opener:string;status:'open'|'escalated'}|null}
export type RoomCommand={type:'open-room';workId:string;content:string;producerAssignmentId:string;challengerAssignmentId:string}|{type:'record-room-turn';workId:string;effectId:string};
function requireRoom(ok:unknown,message:string):asserts ok {if(!ok)throw new DomainError('Room: '+message);}
const exact=(v:any,keys:string[])=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const text=(v:unknown,max=4000):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=max&&v.isWellFormed();
export const normalizeQuote=(s:string)=>s.normalize('NFC').replace(/\s+/gu,' ').trim();
export const containsQuote=(content:string,quote:string)=>normalizeQuote(quote).length>0&&normalizeQuote(content).includes(normalizeQuote(quote));
function roomStart(w:Work,c:Extract<RoomCommand,{type:'open-room'}>):MemberRoom {
 requireRoom(w.team&&w.team.procedures.flatMap(p=>p.body.steps).length>1&&w.artifact?.version===1,'multi-step team artifact required');
 requireRoom(typeof c.content==='string'&&Buffer.byteLength(c.content)<=32768&&c.content.isWellFormed()&&createHash('sha256').update(c.content).digest('hex')===w.artifact.sha256,'artifact content mismatch');
 const producer=w.assignments.find(a=>a.id===c.producerAssignmentId),challenger=w.assignments.find(a=>a.id===c.challengerAssignmentId);
 requireRoom(producer?.role==='executor'&&producer.taskId===w.id+':executor'&&challenger?.role==='executor'&&challenger.taskId===w.id+':challenge'&&producer.actorId!==challenger.actorId,'separate producing and challenger assignments required');
 requireRoom(!w.assignments.some(a=>a.actorId===challenger.actorId&&a.id!==challenger.id)&&w.tasks.some(t=>t.id===challenger.taskId&&t.parentId===w.id+':root'),'challenger must be outside producing subtree');
 requireRoom(!w.assignments.some(a=>a.role==='verifier'&&[producer.actorId,challenger.actorId].includes(a.actorId)),'checking identity cannot participate');
 return {version:1,artifact:{version:1,sha256:w.artifact.sha256,content:c.content},producerAssignmentId:producer.id,challengerAssignmentId:challenger.id,sameModel:producer.model.provider===challenger.model.provider&&producer.model.model===challenger.model.model,messages:[{ordinal:1,authorId:producer.actorId,assignmentId:producer.id,effectId:null,kind:'proposal',replyTo:null,text:c.content,quote:'',inferred:true,status:'admitted'}],issue:null};
}
function appendTurn(w:Work,room:MemberRoom,effectId:string){
 requireRoom(room.messages.length<3,'bounded round already ended');
 const challenge=room.messages.length===1,assignment=w.assignments.find(a=>a.id===(challenge?room.challengerAssignmentId:room.producerAssignmentId))!;
 requireRoom(challenge||room.issue?.status==='open','an admitted open challenge is required');
 const effect=w.effects.find(e=>e.id===effectId),taskId=w.id+(challenge?':challenge':':answer');
 requireRoom(effect?.status==='succeeded'&&effect.taskId===taskId&&w.assignments.some(a=>a.taskId===taskId&&a.actorId===assignment.actorId),'settled assigned turn receipt required');
 let output:any,receipt:any;try{receipt=JSON.parse(effect.receipt!);output=JSON.parse(receipt.output);}catch{output=null;}
 const shape=receipt?.status==='completed'&&exact(output,['kind','text','quote'])&&text(output.text)&&typeof output.quote==='string'&&output.quote.length<=4000&&output.quote.isWellFormed()&&(challenge?output.kind==='challenge':['answer','concede'].includes(output.kind));
 const grounded=shape&&(output.kind==='concede'?output.quote==='':containsQuote(room.artifact.content,output.quote));
 room.messages.push({ordinal:room.messages.length+1,authorId:assignment.actorId,assignmentId:w.assignments.find(a=>a.taskId===taskId&&a.actorId===assignment.actorId)!.id,effectId,kind:challenge?'challenge':shape?output.kind:'answer',replyTo:room.messages.length,text:shape?output.text:'',quote:shape?output.quote:'',inferred:true,status:grounded?'admitted':'returned'});
 if(challenge&&grounded)room.issue={opener:assignment.actorId,status:'open'};
 if(!challenge)room.issue!.status='escalated';
}
export function validateRoom(w:Work){
 if(w.room===undefined){requireRoom(!w.runtimeRun?.roomVersion||!w.verdict,'checking requires a room');return;}const r=w.room;requireRoom(!w.verdict||r.messages.length>=2&&r.issue?.status!=='open','unfinished challenge cannot be checked');
 requireRoom(exact(r,['version','artifact','producerAssignmentId','challengerAssignmentId','sameModel','messages','issue'])&&r.version===1&&exact(r.artifact,['version','sha256','content'])&&Array.isArray(r.messages)&&r.messages.length>=1&&r.messages.length<=3,'invalid retained room');
 const rebuilt=roomStart(w,{type:'open-room',workId:w.id,content:r.artifact.content,producerAssignmentId:r.producerAssignmentId,challengerAssignmentId:r.challengerAssignmentId});
 for(const m of r.messages.slice(1)){requireRoom(typeof m.effectId==='string','turn receipt required');appendTurn(w,rebuilt,m.effectId);}
 requireRoom(hash(rebuilt)===hash(r),'transcript provenance mismatch');
}
export function applyRoom(w:Work,c:RoomCommand,actor:Actor){
 requireRoom(actor.id==='runtime-representative'&&actor.roles.includes('representative'),'host authority required');
 requireRoom(w.execution==='active'&&w.acceptance==='pending'&&!w.runtimeRecovery&&!w.runtimeInterruption&&!w.blocker&&!w.effects.some(e=>e.status==='pending'||e.status==='unknown'),'active settled effects required');
 if(c.type==='open-room'){requireRoom(exact(c,['type','workId','content','producerAssignmentId','challengerAssignmentId'])&&!w.room,'fresh room required');w.room=roomStart(w,c);}
 else {requireRoom(exact(c,['type','workId','effectId'])&&w.room,'room required');validateRoom(w);appendTurn(w,w.room,c.effectId);}
 validateRoom(w);
}
export function roomModerationInput(w:Work,revision:number,moment:2|3|4):ModerationInput {
 const room=w.room!,messages=room.messages.slice(-2),last=messages.at(-1)!;
 return {workId:w.id,turnOrdinal:room.messages.length,moment,questionVersion:1,language:/[가-힣]/u.test(room.artifact.content)?(/[A-Za-z]/.test(room.artifact.content)?'mixed':'ko'):'en',boardRevision:revision,messageOrdinals:messages.map(m=>m.ordinal),features:{candidates:[],openIssues:room.issue?.status==='open'?1:0,settledTasks:w.tasks.filter(t=>t.status==='settled').length,newEvidence:last.quote?1:0,artifactChanged:room.messages.length===1,hostChallengePassed:room.messages[1]?.status==='admitted',hostFlag:last.status==='returned',hostStall:false,exceptionCard:false},quotes:messages.map(m=>({author:m.authorId,ordinal:m.ordinal,quoted:m.text.slice(0,2048)}))};
}
