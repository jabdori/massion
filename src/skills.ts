/** Self-made skills and procedures in a member's home folder (docs/architecture/self-made-skills.md, ADR 0003 §5, §7). Members make candidates; the host checks and adopts. Nothing is deleted. */
import {DomainError,familyRelation,hash} from './domain.ts';
import type {Actor,CheckFamily,Mission,ModelIdentity} from './domain.ts';
import {ASSISTANT_ACTOR_ID,ASSISTANT_CONVERSATION_PREFIX} from './assistant-conversation.ts';
import type {TimeObservation} from './memory-expiry.ts';
import {MEMBERS_ID} from './members.ts';
import type {MembersState} from './members.ts';
import {familyCheck,modelFamily,supportsAutomaticAdoption} from './model-family.ts';
import type {CommitResult,Operation,Snapshot,Store} from './storage.ts';

export const SKILLS_ID=ASSISTANT_CONVERSATION_PREFIX+'skills',MAX_SKILLS=64,MAX_VERSIONS=16,MAX_CANDIDATES=512,UNUSED_MS=30*86400000,TRIGGERS=['correction','dead-end','repeat'] as const,HOST_PREFIX='assistant-skill',DECISION_PREFIX='skill-decision:';
export type SkillKind='skill'|'procedure';
export interface SkillBody {description:string;steps:string[];verify:string}
export interface SkillVersion {version:number;hash:string;body:SkillBody;author:'owner'|'member';candidateId?:string;at:number}
export interface Skill {id:string;memberId:string;kind:SkillKind;name:string;path:string;versions:SkillVersion[];current:number|null;archivedAt?:number;usedAt:number}
export interface SkillEvaluation {check:CheckFamily;cases:number;baseline:number;candidate:number;heldOut:{cases:number;baseline:number;candidate:number};evidence:string}
export interface Candidate {id:string;at:number;memberId:string;skillId:string;kind:SkillKind;name:string;body:SkillBody;hash:string;base:number|null;trigger:typeof TRIGGERS[number];source:{missionId:string;workId:string;recordId:string;title:string};producer:ModelIdentity;state:'pending'|'rejected'|'unchecked'|'deciding'|'later'|'adopted'|'dropped';reason?:string;evaluation?:SkillEvaluation;answeredAt?:number}
export interface SkillChange {id:string;at:number;type:'adopted'|'reverted'|'archived'|'restored';skillId:string;from:number|null;to:number|null;candidateId?:string}
export interface SkillsState {kind:'skills';id:string;skills:Skill[];candidates:Candidate[];changes:SkillChange[]}
export type SkillsCommand =
 | {type:'propose-skill';candidate:Omit<Candidate,'at'|'skillId'|'hash'|'base'|'state'|'reason'|'evaluation'|'answeredAt'>}
 | {type:'check-skill';candidateId:string;evaluation:SkillEvaluation}
 | {type:'decide-skill';candidateId:string;answer:'act'|'later'|'ask'}
 | {type:'revert-skill'|'restore-skill'|'use-skill';skillId:string}
 | {type:'drop-candidate';candidateId:string}
 | {type:'write-skill';memberId:string;kind:SkillKind;name:string;body:SkillBody}
 | {type:'archive-unused'};
/** What the producer (the member's model) drafts from a pointer to the finished Work; what the evaluator returns: scores and the checker model it ran (null only for a host program). Neither writes, and neither states a family. */
export type SkillProducer=(pointer:{memberId:string;trigger:string;work:Candidate['source']})=>Promise<{kind:string;name:string;body:SkillBody;model:{provider:string;model:string}}>;
export type SkillEvaluator=(candidate:{id:string;memberId:string;kind:SkillKind;name:string;body:SkillBody;base:SkillBody|null;producer:ModelIdentity})=>Promise<Omit<SkillEvaluation,'check'>&{checker:{provider:string;model:string}|null}>;
export const isSkillsState=(value:unknown):value is SkillsState=>!!value&&typeof value==='object'&&(value as {kind?:unknown}).kind==='skills';
function ensure(condition:unknown,message:string,code:'invalid'|'denied'|'conflict'='invalid'):asserts condition {if(!condition)throw new DomainError(message,code);}
const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const id=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9:_-]{1,128}$/.test(v);
const line=(v:unknown,chars:number):v is string=>typeof v==='string'&&v.trim()===v&&v.length>0&&[...v].length<=chars&&v.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(v);
const count=(v:unknown,max=1000):v is number=>Number.isSafeInteger(v)&&(v as number)>=0&&(v as number)<=max;
// Locale-free slug and folding, so a host locale cannot change which names collide.
const slug=(name:string)=>name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||hash(name).slice(0,12);
export const skillId=(memberId:string,kind:SkillKind,name:string)=>'skill-'+hash({memberId,kind,name:name.toLowerCase()}).slice(0,16),candidateId=(commandId:string)=>'candidate-'+hash(commandId).slice(0,16);
export const bodyHash=(body:SkillBody)=>hash(body);

/** Host-owned scan rules. Changing them is an owner decision, never a candidate (ADR 0003 §5). */
const SCAN:[RegExp,string][]=[
 [/\bsk-[A-Za-z0-9_-]{16,}|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_-]?key|password|secret|token)\s*[:=]\s*\S{8,}/i,'Hard-coded secret'],
 [/\b(?:https?|ftp|file):\/\/|\b(?:curl|wget)\b|\bimport\s*\(/i,'Remote loading'],
 [/[​-‏‪-‮⁠-⁤﻿]|<!--|\bignore (?:all |any )?(?:previous|prior|above) instructions\b|[A-Za-z0-9+/]{80,}={0,2}/i,'Hidden instruction'],
 [/\bauto-?approve\b|\b(?:skip|disable|bypass) (?:the )?(?:check|checks|checking|sandbox|scan|review)\b|\bwithout asking\b/i,'Check bypass']];
/** The deterministic check: format first, then the static scan. Returns the reason, or null when it passes. */
/** Static scan of a name, which shows on screens and is loaded with the skill. */
export const scanName=(name:string)=>SCAN.find(([rule])=>rule.test(name))?.[1]??null;
export function scanSkill(body:unknown):string|null {
 if(!exact(body,['description','steps','verify'])||!line(body.description,200)||!Array.isArray(body.steps)||body.steps.length<1||body.steps.length>12||!body.steps.every(s=>line(s,200))||!line(body.verify,200))return 'Format: a description, 1 to 12 steps and a way to verify the result';
 const text=[body.description,...body.steps as string[],body.verify].join('\n');for(const [rule,reason] of SCAN)if(rule.test(text))return reason;return null;
}
const pathOf=(memberId:string,kind:SkillKind,name:string)=>'members/'+memberId+'/'+(kind==='skill'?'skills':'procedures')+'/'+slug(name);
// The family follows from the host family map, so a recorded identity cannot relabel its model (ADR 0003 §7).
const identity=(m:unknown):m is ModelIdentity=>exact(m,['provider','model','family'])&&line(m.provider,128)&&line(m.model,256)&&m.family===modelFamily(m.provider,m.model);

export function applySkills(current:SkillsState|null,command:SkillsCommand,actor:Actor,time:TimeObservation):{value:SkillsState;events:unknown[]} {
 ensure(actor&&id(actor.id),'Invalid actor');ensure(exact(time,['observedAt'])&&Number.isSafeInteger(time.observedAt)&&time.observedAt>=0,'Host clock observation unavailable');const at=time.observedAt;
 const state:SkillsState=current?structuredClone(current):{kind:'skills',id:SKILLS_ID,skills:[],candidates:[],changes:[]};
 const role=(needed:'owner'|'assistant')=>ensure(actor.roles.includes(needed),'Actor lacks required role','denied');
 const skill=(v:unknown)=>{const found=state.skills.find(s=>s.id===v);ensure(found,'Unknown skill');return found;},candidate=(v:unknown)=>{const found=state.candidates.find(c=>c.id===v);ensure(found,'Unknown candidate');return found;};
 const change=(type:SkillChange['type'],s:Skill,from:number|null,to:number|null,candidateId?:string)=>state.changes.push({id:'change-'+(state.changes.length+1),at,type,skillId:s.id,from,to,...(candidateId?{candidateId}:{})});
 const version=(s:Skill,body:SkillBody,author:'owner'|'member',candidateId?:string)=>{ensure(s.versions.length<MAX_VERSIONS,'Version bound reached','conflict');const v=s.versions.length+1;s.versions.push({version:v,hash:bodyHash(body),body:structuredClone(body),author,...(candidateId?{candidateId}:{}),at});const from=s.current;s.current=v;delete s.archivedAt;s.usedAt=at;return from;};
 const target=(memberId:string,kind:SkillKind,name:string)=>{const sid=skillId(memberId,kind,name);let s=state.skills.find(x=>x.id===sid);if(!s){ensure(state.skills.filter(x=>x.memberId===memberId).length<MAX_SKILLS,'Skill bound reached','conflict');s={id:sid,memberId,kind,name,path:pathOf(memberId,kind,name),versions:[],current:null,usedAt:at};state.skills.push(s);}return s;};
 const adopt=(c:Candidate)=>{const s=target(c.memberId,c.kind,c.name),from=version(s,c.body,'member',c.id);c.state='adopted';change('adopted',s,from,s.current,c.id);};
 switch(command?.type){
  case 'propose-skill': {
   role('assistant');ensure(exact(command,['type','candidate']),'Exact skill proposal fields required');const c=command.candidate;
   ensure(exact(c,['id','memberId','kind','name','body','trigger','source','producer'])&&id(c.id)&&id(c.memberId)&&line(c.name,64),'Exact candidate fields required');
   // Only the member's own skills/ or procedures/ have a path; evaluators, evaluation sets, the family map, scan rules and permissions are not candidates.
   ensure(c.kind==='skill'||c.kind==='procedure','Not a candidate: only skills and procedures are made by members');ensure((TRIGGERS as readonly string[]).includes(c.trigger),'Unknown trigger: candidates come from a correction, a dead end or repeated work');
   ensure(exact(c.source,['missionId','workId','recordId','title'])&&id(c.source.missionId)&&id(c.source.workId)&&id(c.source.recordId)&&line(c.source.title,512),'A finished Work source is required');ensure(identity(c.producer),'Producer identity required');
   // A body that fails the scan is still kept with its reason, so it is bounded before it is stored.
   ensure(!!c.body&&typeof c.body==='object'&&!Array.isArray(c.body)&&Buffer.byteLength(JSON.stringify(c.body),'utf8')<=8192,'Candidate body must be an object of at most 8192 bytes');
   ensure(!state.candidates.some(x=>x.id===c.id),'Candidate already exists');ensure(state.candidates.length<MAX_CANDIDATES,'Candidate bound reached','conflict');
   // ponytail: 512 candidates in all; prune rejected ones older than a year if members propose that often.
   const reason=scanName(c.name)??scanSkill(c.body),sid=skillId(c.memberId,c.kind,c.name),existing=state.skills.find(s=>s.id===sid),h=hash(c.body);
   ensure(!state.candidates.some(x=>x.skillId===sid&&x.hash===h),'Already proposed','conflict');
   state.candidates.push({...structuredClone(c),at,skillId:sid,hash:h,base:existing?.current??null,state:reason?'rejected':'pending',...(reason?{reason}:{})});break;
  }
  case 'check-skill': {
   role('assistant');ensure(exact(command,['type','candidateId','evaluation']),'Exact check fields required');const c=candidate(command.candidateId);ensure(c.state==='pending','Only a pending candidate is checked','conflict');const e=command.evaluation;
   ensure(exact(e,['check','cases','baseline','candidate','heldOut','evidence'])&&count(e.cases)&&e.cases>0&&count(e.baseline,e.cases)&&count(e.candidate,e.cases)&&exact(e.heldOut,['cases','baseline','candidate'])&&count(e.heldOut.cases)&&e.heldOut.cases>0&&count(e.heldOut.baseline,e.heldOut.cases)&&count(e.heldOut.candidate,e.heldOut.cases),'Exact evaluation scores required');
   ensure(line(e.evidence,2000),'A check without execution evidence is no evaluation');
   // The relation is recomputed here, so a recorded check cannot claim a family it does not have.
   const k=e.check;ensure(exact(k,['relation','producers','checker'])&&Array.isArray(k.producers)&&k.producers.length===1&&hash(k.producers[0])===hash(c.producer),'The check must name the candidate producer');
   ensure(k.relation==='deterministic'?k.checker===null:identity(k.checker)&&k.relation===familyRelation(k.producers,k.checker),'Check family relation mismatch');
   c.evaluation=structuredClone(e);const s=state.skills.find(x=>x.id===c.skillId);
   if(!supportsAutomaticAdoption(k)){c.state='unchecked';c.reason='No way to check';break;}
   if(!(e.candidate>e.baseline&&e.heldOut.candidate>=e.heldOut.baseline)){c.state='rejected';c.reason='No improvement';break;}
   if((s?.current??null)!==c.base){c.state='rejected';c.reason='The skill changed since';break;}
   // A bound is final, so it ends the candidate instead of failing the check and leaving it pending.
   if(s?s.versions.length>=MAX_VERSIONS:state.skills.filter(x=>x.memberId===c.memberId).length>=MAX_SKILLS){c.state='rejected';c.reason='Skill bound reached';break;}
   // A skill the owner ever wrote stays the owner's: each candidate for it waits for the owner, like explicit memory.
   if(s?.versions.some(x=>x.author==='owner')){c.state='deciding';break;}
   adopt(c);break;
  }
  case 'decide-skill': {
   role('owner');ensure(exact(command,['type','candidateId','answer']),'Exact decision fields required');const c=candidate(command.candidateId);
   if(command.answer==='later'){ensure(c.state==='deciding','Only an open decision is deferred','conflict');c.state='later';c.answeredAt=at;break;}
   if(command.answer==='ask'){ensure(c.state==='later','Only a deferred decision is asked again','conflict');c.state='deciding';delete c.answeredAt;break;}
   ensure(command.answer==='act','Unknown answer');ensure(c.state==='deciding','Only an open decision is answered','conflict');ensure(supportsAutomaticAdoption(c.evaluation?.check),'A same-family check never adopts');
   const s=state.skills.find(x=>x.id===c.skillId);if((s?.current??null)!==c.base){c.state='rejected';c.reason='The skill changed since';break;}c.answeredAt=at;adopt(c);break;
  }
  case 'revert-skill': {
   role('owner');ensure(exact(command,['type','skillId']),'Exact skill fields required');const s=skill(command.skillId);ensure(s.current!==null&&s.versions[s.current-1]!.author==='member'&&!s.archivedAt,'Only an adopted member version is reverted','conflict');
   // Back to the version in use before this one was adopted, so an earlier owner revert is never undone.
   const from=s.current,adopted=state.changes.findLast(x=>x.skillId===s.id&&x.type==='adopted'&&x.to===from);ensure(adopted,'Only an adopted member version is reverted','conflict');s.current=adopted.from;change('reverted',s,from,adopted.from);break;
  }
  case 'restore-skill': {role('owner');ensure(exact(command,['type','skillId']),'Exact skill fields required');const s=skill(command.skillId);ensure(s.archivedAt!==undefined,'Only an archived skill is restored','conflict');delete s.archivedAt;s.usedAt=at;change('restored',s,s.current,s.current);break;}
  case 'drop-candidate': {role('owner');ensure(exact(command,['type','candidateId']),'Exact candidate fields required');const c=candidate(command.candidateId);ensure(c.state==='unchecked','Only an unchecked candidate is dropped','conflict');c.state='dropped';c.answeredAt=at;break;}
  case 'write-skill': {
   role('owner');ensure(exact(command,['type','memberId','kind','name','body'])&&id(command.memberId)&&line(command.name,64)&&(command.kind==='skill'||command.kind==='procedure'),'Exact skill fields required');
   // The owner may write freely except the format and secrets: a secret would be stored in the journal and backups.
   // Body and name are checked separately, so an allowed warning in one cannot hide a secret in the other.
   const refused=[scanSkill(command.body),scanName(command.name)].find(r=>r!==null&&(r.startsWith('Format')||r==='Hard-coded secret'));ensure(!refused,refused??'');version(target(command.memberId,command.kind,command.name),command.body,'owner');break;
  }
  case 'use-skill': {
   // Checked again when a Work loads it: the body hash and the scan, so a changed or newly flagged skill is not loaded.
   role('assistant');ensure(exact(command,['type','skillId']),'Exact skill fields required');const s=skill(command.skillId);ensure(s.current!==null&&!s.archivedAt,'An archived or unused skill is not loaded','conflict');const v=s.versions[s.current-1]!;
   ensure(bodyHash(v.body)===v.hash,'Skill content changed after its check');const reason=scanSkill(v.body);ensure(v.author==='owner'||reason===null,'Skill failed the load check: '+reason);s.usedAt=at;break;
  }
  case 'archive-unused': {
   role('assistant');ensure(exact(command,['type']),'Exact archive fields required');
   for(const s of state.skills)if(s.current!==null&&!s.archivedAt&&s.versions[s.current-1]!.author==='member'&&s.usedAt<=at-UNUSED_MS){s.archivedAt=at;change('archived',s,s.current,s.current);}break;
  }
  default: throw new DomainError('Unknown command');
 }
 return {value:state,events:[{type:command.type,actor:actor.id,command:structuredClone(command),time:structuredClone(time)}]};
}
const HOST_STEPS=['propose-skill','check-skill','use-skill','archive-unused'];
const fingerprint=(actorId:string,command:SkillsCommand)=>hash({actorId,command});
/** Backup lineage: host steps carry the host's command IDs, owner answers never do, and a proposal's candidate ID follows from its command ID. */
export function replaySkills(operation:Operation<SkillsState>,prior:Operation<SkillsState>|undefined):void {
 ensure(operation.aggregateId===SKILLS_ID&&operation.value.id===SKILLS_ID,'skills aggregate mismatch');ensure(operation.expectedRevision===(prior?.revision??0)&&operation.revision===operation.expectedRevision+1,'operation revision lineage mismatch');
 const event=operation.events?.[0] as {type:string;actor:string;command:SkillsCommand;time:TimeObservation}|undefined;ensure(operation.events.length===1&&exact(event,['type','actor','command','time'])&&event.type===event.command?.type,'skills operation requires one typed event');
 const host=HOST_STEPS.includes(event.command.type);ensure((event.actor===ASSISTANT_ACTOR_ID)===host&&(host||event.actor===OWNER),'skills step actor mismatch');ensure(operation.fingerprint===fingerprint(event.actor,event.command),'command fingerprint mismatch');
 ensure(operation.commandId.startsWith(HOST_PREFIX)===host&&(host||!operation.commandId.startsWith('assistant-'))&&(event.command.type!=='propose-skill'||event.command.candidate?.id===candidateId(operation.commandId)),'skills command identity mismatch');
 const derived=applySkills(prior?prior.value:null,event.command,{id:event.actor,roles:[host?'assistant':'owner']},event.time);
 ensure(hash(derived.value)===hash(operation.value)&&hash(derived.events)===hash(operation.events)&&operation.outbox.length===0,'skills command/state transition');
}

const OWNER='local-owner';
const checkedBy=(e?:SkillEvaluation)=>!e?null:e.check.relation==='deterministic'?'Host check':e.check.relation==='different-family'?'Different family':'Same family';
const result=(e?:SkillEvaluation)=>e?e.baseline+' → '+e.candidate+' of '+e.cases:null;
export class SkillsService {
 readonly #store:Store<any>;readonly #producer?:SkillProducer;readonly #evaluator?:SkillEvaluator;readonly #hostEvaluator:boolean;readonly #clock:()=>number;
 /** `hostEvaluator`: the evaluator is a host program, so a result without a checker model counts as the deterministic check. */
 constructor(store:Store<any>,options:{producer?:SkillProducer;evaluator?:SkillEvaluator;hostEvaluator?:boolean;clock?:()=>number}={}){this.#store=store;this.#producer=options.producer;this.#evaluator=options.evaluator;this.#hostEvaluator=options.hostEvaluator===true;this.#clock=options.clock??Date.now;}
 async #state(){return await this.#store.load(SKILLS_ID) as Snapshot<SkillsState>|null;}
 /** The member page and Settings > Improvements read. */
 async read(){
  const s=await this.#state(),v=s?.value??{skills:[],candidates:[],changes:[]} as unknown as SkillsState,cand=(cid?:string)=>v.candidates.find(c=>c.id===cid);
  const skills=v.skills.map(k=>{const cur=k.current===null?k.versions.at(-1)!:k.versions[k.current-1]!;return {id:k.id,memberId:k.memberId,kind:k.kind,name:k.name,path:k.path,version:cur.version,author:cur.author,at:cur.at,state:k.archivedAt!==undefined?'archived':k.current===null?'off':'active',steps:[...cur.body.steps]};});
  const reverted=new Map<string,{to:number|null;at:number}>();
  for(const [i,c] of v.changes.entries()){if(c.type==='reverted'){const a=v.changes.slice(0,i).findLast(x=>x.skillId===c.skillId&&x.type==='adopted'&&x.to===c.from);if(a)reverted.set(a.id,{to:c.to,at:c.at});}}
  const improvements=v.changes.map(c=>{const k=v.skills.find(x=>x.id===c.skillId)!,e=cand(c.candidateId);
   return {id:c.id,at:c.at,type:c.type,skillId:k.id,memberId:k.memberId,name:k.name,kind:k.kind,from:c.from,to:c.to,source:e?.source.title??null,result:result(e?.evaluation),checkedBy:checkedBy(e?.evaluation),revertible:c.type==='adopted'&&k.current===c.to&&k.archivedAt===undefined,reverted:reverted.get(c.id)??null};}).reverse();
  const candidates=v.candidates.filter(c=>c.state!=='adopted').map(c=>({id:c.id,at:c.at,memberId:c.memberId,name:c.name,kind:c.kind,state:c.state,reason:c.reason??null,result:result(c.evaluation)})).reverse();
  return {revision:s?.revision??0,skills,improvements,candidates};
 }
 /** Decision cards for a member's 1:1 conversation (conversation-cards.md shape). */
 async decisions(memberId:string){
  const v=(await this.#state())?.value;if(!v)return [];
  return v.candidates.filter(c=>c.memberId===memberId&&['deciding','later'].includes(c.state)||c.memberId===memberId&&c.state==='adopted'&&c.answeredAt!==undefined).map(c=>{
   const s=v.skills.find(x=>x.id===c.skillId)!,now=c.base!==null?s.versions[c.base-1]!:undefined,next=c.state==='adopted'?s.versions.find(x=>x.candidateId===c.id)!.version:s.versions.length+1,cut=(now?.body.steps.length??0)-c.body.steps.length,changed=c.body.steps.find((step,i)=>step!==now?.body.steps[i])??(cut>0?'Removed '+cut+(cut===1?' step':' steps'):c.body.steps.at(-1)!);
   return {id:DECISION_PREFIX+c.id,at:c.at,title:c.name,question:'Replace your '+c.name+'?',rows:[['Now','v'+(c.base??0)+' · You'],['Change',changed],['Check',result(c.evaluation)+' · '+checkedBy(c.evaluation)]] as [string,string][],action:'Use v'+next,state:c.state==='adopted'?'done':c.state==='later'?'later':'open',...(c.state==='adopted'?{line:'Changed: v'+next}:{})};});
 }
 /** Host step: the producer drafts from a finished Work; the host runs the deterministic check in the same step. Asking again with the same draft replays. */
 async propose(input:unknown):Promise<CommitResult<SkillsState>>{
  ensure(exact(input,['memberId','missionId','workId','trigger'])&&id(input.memberId)&&id(input.missionId)&&id(input.workId),'Exact skill proposal fields required');ensure((TRIGGERS as readonly string[]).includes(input.trigger as string),'Unknown trigger: candidates come from a correction, a dead end or repeated work');
  ensure(this.#producer,'No skill producer on this host');const members=(await this.#store.load(MEMBERS_ID))?.value as MembersState|undefined;ensure(members?.members.some(m=>m.id===input.memberId),'Unknown member');
  const mission=(await this.#store.load(input.missionId as string))?.value as Mission|undefined,w=mission?.works?.find(x=>x.id===input.workId);ensure(w&&w.acceptance==='accepted'&&w.record,'Only an accepted Work with a Record is a source');
  // A Work title may be multiline and up to 16,000 characters; the source keeps a bounded one-line display title.
  const title=[...w.title.toWellFormed().replace(/[\s\u0000-\u001f\u007f]+/g,' ').trim()].slice(0,512).join('').trim()||w.id;
  const source={missionId:input.missionId as string,workId:w.id,recordId:w.record.id,title},draft=await this.#producer({memberId:input.memberId as string,trigger:input.trigger as string,work:structuredClone(source)});
  ensure(exact(draft,['kind','name','body','model'])&&line(draft.name,64)&&exact(draft.model,['provider','model'])&&line(draft.model.provider,128)&&line(draft.model.model,256),'Invalid draft');
  const commandId=HOST_PREFIX+'-proposal:'+hash({memberId:input.memberId,kind:draft.kind,name:draft.name.toLowerCase(),body:draft.body}).slice(0,64);
  return this.#dispatch(commandId,ASSISTANT_ACTOR_ID,{type:'propose-skill',candidate:{id:candidateId(commandId),memberId:input.memberId as string,kind:draft.kind as SkillKind,name:draft.name,body:draft.body,trigger:input.trigger as Candidate['trigger'],source,producer:{provider:draft.model.provider,model:draft.model.model,family:modelFamily(draft.model.provider,draft.model.model)}}});
 }
 /** Host step: the host evaluator (or a different-family model) compares baseline and candidate; the producer never judges. */
 async check(id:string):Promise<CommitResult<SkillsState>>{
  const v=(await this.#state())?.value,c=v?.candidates.find(x=>x.id===id);ensure(c,'Unknown candidate');ensure(c.state==='pending','Only a pending candidate is checked','conflict');ensure(this.#evaluator,'No skill evaluator on this host');
  const s=v!.skills.find(x=>x.id===c.skillId),base=c.base!==null&&s?s.versions[c.base-1]!.body:null;
  const out=await this.#evaluator({id:c.id,memberId:c.memberId,kind:c.kind,name:c.name,body:structuredClone(c.body),base:structuredClone(base),producer:structuredClone(c.producer)});
  // Exact fields, so an evaluator cannot slip in a `check` (or any other field) over the host-built one.
  ensure(exact(out,['checker','cases','baseline','candidate','heldOut','evidence']),'Exact evaluator output fields required');const {checker,cases,baseline,candidate,heldOut,evidence}=out;
  // The host builds the check from the models it ran; an evaluator claims neither a family nor a deterministic check.
  ensure(checker!==null||this.#hostEvaluator,'Only a host evaluator checks without a model');ensure(checker===null||exact(checker,['provider','model'])&&line(checker.provider,128)&&line(checker.model,256),'Checker model required');
  const check=checker?familyCheck([c.producer],checker):{relation:'deterministic' as const,producers:[structuredClone(c.producer)],checker:null};
  return this.#dispatch(HOST_PREFIX+'-check:'+c.id,ASSISTANT_ACTOR_ID,{type:'check-skill',candidateId:c.id,evaluation:{check,cases,baseline,candidate,heldOut:structuredClone(heldOut),evidence} as SkillEvaluation});
 }
 async use(skillId:string){return this.#dispatch(HOST_PREFIX+'-use:'+skillId+':'+this.#clock(),ASSISTANT_ACTOR_ID,{type:'use-skill',skillId});}
 async archiveUnused(){return this.#dispatch(HOST_PREFIX+'-archive:'+this.#clock(),ASSISTANT_ACTOR_ID,{type:'archive-unused'});}
 /** Owner actions from the member page and Settings > Improvements. */
 async act(input:unknown):Promise<CommitResult<SkillsState>>{
  const action=(input as {action?:unknown})?.action,fields:Record<string,string[]>={revert:['skillId'],restore:['skillId'],drop:['candidateId'],write:['memberId','kind','name','body']};
  ensure(typeof action==='string'&&Object.hasOwn(fields,action)&&exact(input,['commandId','action',...fields[action]!])&&id(input.commandId),'Exact skill action fields required');const commandId=this.#caller(input.commandId);
  if(action==='write'){const members=(await this.#store.load(MEMBERS_ID))?.value as MembersState|undefined;ensure(members?.members.some(m=>m.id===input.memberId),'Unknown member');}
  if(action==='write')return this.#dispatch(commandId,OWNER,{type:'write-skill',memberId:input.memberId as string,kind:input.kind as SkillKind,name:input.name as string,body:input.body as SkillBody});
  return this.#dispatch(commandId,OWNER,action==='drop'?{type:'drop-candidate',candidateId:input.candidateId as string}:{type:action==='revert'?'revert-skill':'restore-skill',skillId:input.skillId as string});
 }
 /** The owner's answer to a skill decision card. */
 async decide(input:unknown):Promise<CommitResult<SkillsState>>{
  ensure(exact(input,['commandId','decisionId','answer'])&&id(input.commandId)&&typeof input.decisionId==='string'&&input.decisionId.startsWith(DECISION_PREFIX)&&['act','later','ask'].includes(input.answer as string),'Exact decision answer fields required');
  return this.#dispatch(this.#caller(input.commandId),OWNER,{type:'decide-skill',candidateId:(input.decisionId as string).slice(DECISION_PREFIX.length),answer:input.answer as 'act'|'later'|'ask'});
 }
 #caller(commandId:unknown){ensure(id(commandId)&&!commandId.startsWith('assistant-'),'assistant- command identities are reserved for host steps');return commandId;}
 /** Lookup before and after the load, CAS on the revision read; a lost command replays by its ID. */
 async #dispatch(commandId:string,actorId:string,command:SkillsCommand):Promise<CommitResult<SkillsState>>{
  const identity={id:SKILLS_ID,commandId,fingerprint:fingerprint(actorId,command)},actor:Actor={id:actorId,roles:[actorId===ASSISTANT_ACTOR_ID?'assistant':'owner']};
  for(let attempt=0;attempt<3;attempt++){
   const prior=await this.#store.lookupOperation(identity);if(prior.status!=='unknown')return prior;
   const snapshot=await this.#state(),{value,events}=applySkills(snapshot?.value??null,command,actor,{observedAt:this.#clock()});
   const result=await this.#store.commit({id:SKILLS_ID,expectedRevision:snapshot?.revision??0,commandId,fingerprint:identity.fingerprint,value,events,outbox:[]});
   if(result.status!=='conflict'||result.reason!=='revision')return result;
  }
  return {status:'conflict',revision:(await this.#state())?.revision??0,reason:'revision'};
 }
}
