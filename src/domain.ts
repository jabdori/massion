import { createHash } from 'node:crypto';

export type Role = 'owner' | 'representative' | 'executor' | 'verifier' | 'evaluator';
export interface Actor { id: string; roles: readonly Role[] }
export interface Criteria { version: number; description: string; oracle: string }
export interface Artifact { id: string; version: number; sha256: string; path: string; kind: string }
export interface Evidence { kind: string; detail: string; source: string }
export interface Assignment { id: string; actorId: string; role: 'executor' | 'verifier'; taskId: string; model: ModelSelection; extensionVersion: string }
export interface ModelSelection { provider: string; model: string; configVersion: string; reason: string; evidenceClass: 'fixture' | 'real-provider' }
export interface Effect { id: string; taskId: string; status: 'pending' | 'succeeded' | 'failed' | 'unknown'; target: string; authority: string; receipt?: string }
export interface Task { id: string; parentId: string | null; status: 'queued' | 'active' | 'settled'; result?: string }
export interface Verdict { id: string; verifierAssignmentId: string; artifactSha256: string; artifactVersion: number; criteriaVersion: number; status: 'passed' | 'failed' | 'stale'; evidence: Evidence[] }
export interface AcceptedRecord { id: string; workId: string; criteria: Criteria; artifact: Artifact; verdict: Verdict; receipts: Effect[]; assignments: Assignment[]; memoryVersions: string[]; evidenceClass: 'fixture' | 'real-provider'; checksum: string; artifactSnapshot?: {sha256:string;path:string} }
export interface Attempt { id: string; number: number; criteria: Criteria; status: 'queued' | 'active' | 'settled'; modelVersions: string[]; results?: {taskId:string;result:string}[] }
export interface ExecutionGate { code:'provider_unavailable'|'runtime_unavailable'|'provider_failed'|'budget_exceeded'|'verification_failed';detail:string }
export interface ConnectionBinding {profileId:string;configHash:string}
export interface RuntimeConnectionBindings {executor:ConnectionBinding;verifier:ConnectionBinding}
export interface RuntimeRun {connectionBindings?:RuntimeConnectionBindings;id:string;authorizationId:string;criteriaHash:string;inputHash:string;mode:'mock-http'|'live';outputTokenCap:number}
/** Owner decision only: never a provider receipt or proof that external work stopped. */
export interface RuntimeRecovery {runId:string;actorId:string;reason:string;pendingEffectIds:string[];unknownEffectIds:string[]}
export interface Work {
  id: string; title: string; runtimeRun?:RuntimeRun; runtimeRecovery?:RuntimeRecovery; blocker?:ExecutionGate; instructions?:{actorId:string;text:string}[]; missionVersion: number; missionSnapshot?:{version:number;purpose:string;scope:string;constraints:string[]}; criteria: Criteria;
  execution: 'queued' | 'active' | 'waiting' | 'blocked' | 'cancelled' | 'settled';
  acceptance: 'pending' | 'failed' | 'stale' | 'accepted';
  tasks: Task[]; attempts: Attempt[]; assignments: Assignment[]; effects: Effect[];
  artifact?: Artifact; verdict?: Verdict; record?: AcceptedRecord;
  appliedMemoryVersions: string[]; budget: { limit: number; reserved: number; measured: number | null; unit?:'output-tokens' };
}
export interface Memory { id: string; version: number; scope: string; authority: 'explicit' | 'learned'; content: string; source: string; effective: boolean }
export interface Growth { id: string; proposer: string; target: 'memory' | 'prompt' | 'policy' | 'organization'; baseline: string; candidate: string; counterevidence: string; evaluator?: string; scores?: { baseline: number; candidate: number; heldOut: string }; status: 'proposed' | 'evaluated' | 'adopted' | 'reverted'; observation?: { workId: string; metric: number }; previousEffective?: string[] }
export interface Relation { from: string; to: string; type: 'depends-on' | 'evidenced-by' | 'contains'; fromVersion: number; toVersion: number; provenance: string; inferred: boolean }
export interface Mission { id: string; version: number; purpose: string; scope: string; constraints: string[]; criteria: Criteria; works: Work[]; memories: Memory[]; growth: Growth[]; relations: Relation[] }
export type Command =
  | { type: 'revise-mission'; purpose: string; criteria: Criteria }
  | { type: 'admit-work'; workId: string; title: string; budget: number; executionGate?:ExecutionGate }
  | { type: 'assign'; workId: string; assignment: Assignment }
  | { type: 'revise-work'; workId: string }
  | { type: 'activate-runtime';workId:string;run:RuntimeRun }
  | { type:'quarantine-runtime';workId:string;runId:string;reason:string;acknowledgeUncertainOutcome:true }
  | { type: 'block-work';workId:string;blocker:ExecutionGate }
  | { type: 'delegate'; workId: string; taskId: string; parentId: string }
  | { type: 'settle-task'; workId: string; taskId: string; result: string }
  | { type: 'admit-effect'; workId: string; effect: Effect; reserve: number }
  | { type: 'receipt'; workId: string; effectId: string; outcome: 'succeeded' | 'failed' | 'unknown'; receipt: string; usage: number | null }
  | { type: 'reconcile-effect'; workId: string; effectId: string; outcome: 'succeeded' | 'failed'; receipt: string }
  | { type: 'publish-artifact'; workId: string; artifact: Artifact }
  | { type: 'verify'; workId: string; verdict: Verdict }
  | { type: 'accept'; workId: string; recordId: string; artifactSnapshot?: {sha256:string;path:string} }
  | { type: 'cancel'; workId: string }
  | { type: 'steer'; workId: string; instruction: string }
  | { type: 'save-memory'; memory: Memory }
  | { type: 'propose-growth'; proposal: Growth }
  | { type: 'evaluate-growth'; growthId: string; baseline: number; candidate: number; heldOut: string }
  | { type: 'adopt-growth'; growthId: string }
  | { type: 'observe-growth'; growthId: string; workId: string; metric: number }
  | { type: 'revert-growth'; growthId: string }
  | { type: 'relate'; relation: Relation };

export class DomainError extends Error {
  code: 'invalid' | 'denied';
  constructor(message: string, code: 'invalid' | 'denied' = 'invalid') { super(message); this.code = code; }
}
export function canonical(value: unknown): string {
  if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
  if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(typeof value==='object'&&value!==null)return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';
  throw new DomainError('Only finite JSON data can be hashed');
}
export function hash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function ensure(condition: unknown, message: string): asserts condition { if (!condition) throw new DomainError(message); }
function role(actor: Actor, ...roles: Role[]): void { if (!roles.some(r => actor.roles.includes(r))) throw new DomainError('Actor lacks required role', 'denied'); }
function text(value: unknown, name: string, limit=16000): asserts value is string { ensure(typeof value === 'string' && value.trim().length > 0 && value.length <= limit, `Invalid ${name}`); }
function finite(value: number): boolean { return Number.isFinite(value) && value >= 0; }
function criteriaValid(criteria: Criteria): void { ensure(Number.isSafeInteger(criteria.version) && criteria.version > 0, 'Invalid criteria version'); text(criteria.description, 'criteria'); text(criteria.oracle, 'oracle'); }
export function createMission(input: {id:string; purpose:string; scope:string; constraints:string[]; criteria:Criteria}, actor:Actor): Mission {
  role(actor, 'owner', 'representative'); text(input.id, 'id'); text(input.purpose, 'purpose'); text(input.scope, 'scope'); criteriaValid(input.criteria);
  ensure(Array.isArray(input.constraints) && input.constraints.every(x => typeof x === 'string'), 'Invalid constraints');
  return structuredClone({...input, version:1, works:[], memories:[], growth:[], relations:[]});
}
export function apply(current: Mission, command: Command, actor: Actor): { value: Mission; events: unknown[] } {
  text(actor.id, 'actor');
  const state = structuredClone(current);
  const work = 'workId' in command ? state.works.find(w => w.id === command.workId) : undefined;
  if ('workId' in command && command.type !== 'admit-work' && command.type !== 'observe-growth') ensure(work, 'Unknown work');
  const needWork = (): Work => { ensure(work, 'Unknown work'); return work; };
  const executor = (w: Work): void => { role(actor, 'executor'); ensure(w.assignments.some(a => a.role === 'executor' && a.actorId === actor.id), 'Executor not assigned'); };
  const performer=(w:Work,taskId:string):void=>{role(actor,'executor','verifier');ensure(w.assignments.some(a=>a.actorId===actor.id&&a.taskId===taskId&&actor.roles.includes(a.role)),'Not assigned to effect task');};
  const open = (w: Work): void => { ensure(w.execution !== 'cancelled' && w.acceptance !== 'accepted', 'Work no longer admits changes'); };
  const growth = (): Growth => { const g = state.growth.find(g => 'growthId' in command && g.id === command.growthId); ensure(g, 'Unknown growth'); return g; };
  switch (command.type) {
    case 'revise-mission':
      role(actor,'owner'); text(command.purpose,'purpose'); criteriaValid(command.criteria); ensure(command.criteria.version > state.criteria.version, 'Criteria version must advance'); state.version++; state.purpose=command.purpose; state.criteria=structuredClone(command.criteria); break;
    case 'admit-work': {
      role(actor,'owner','representative'); text(command.workId,'work id'); text(command.title,'title'); ensure(!work,'Work already exists'); ensure(finite(command.budget),'Invalid budget');
      if(command.executionGate){ensure(['provider_unavailable','runtime_unavailable'].includes(command.executionGate.code),'Invalid execution gate');text(command.executionGate.detail,'execution gate detail');} state.works.push({... (command.executionGate?{blocker:structuredClone(command.executionGate)}:{}),id:command.workId,title:command.title,missionVersion:state.version,missionSnapshot:{version:state.version,purpose:state.purpose,scope:state.scope,constraints:structuredClone(state.constraints)},criteria:structuredClone(state.criteria),execution:command.executionGate?'blocked':'queued',acceptance:'pending',tasks:[{id:`${command.workId}:root`,parentId:null,status:'queued'}],attempts:[{id:`${command.workId}:attempt:1`,number:1,criteria:structuredClone(state.criteria),status:'queued',modelVersions:[]}],assignments:[],effects:[],appliedMemoryVersions:state.memories.filter(m=>m.effective&&m.scope===state.scope).map(m=>`${m.id}@${m.version}`),budget:{limit:command.budget,reserved:0,measured:0}}); break;
    }
    case 'activate-runtime': {role(actor,'owner');const w=needWork();open(w);ensure(!w.runtimeRun&&!w.effects.length&&!w.assignments.length&&!w.artifact,'A run is already admitted; do not replay it');text(command.run.id,'run identity');text(command.run.authorizationId,'authorization identity');ensure(command.run.criteriaHash===hash(w.criteria),'Run criteria binding mismatch');ensure(w.missionSnapshot&&command.run.inputHash===hash({mission:w.missionSnapshot,title:w.title,instructions:w.instructions??[],memoryVersions:w.appliedMemoryVersions}),'Run input binding mismatch');ensure(['mock-http','live'].includes(command.run.mode),'Invalid runtime mode');ensure(Number.isSafeInteger(command.run.outputTokenCap)&&command.run.outputTokenCap>0,'Invalid output cap');ensure(w.budget.limit-w.budget.reserved>=command.run.outputTokenCap*2,'Budget cannot reserve executor and verifier');if(command.run.connectionBindings){for(const binding of [command.run.connectionBindings.executor,command.run.connectionBindings.verifier]){ensure(binding&&/^[a-zA-Z0-9:_-]{1,128}$/.test(binding.profileId)&&/^[a-f0-9]{64}$/.test(binding.configHash),'Invalid connection binding');}}w.runtimeRun=structuredClone(command.run);w.budget.unit='output-tokens';delete w.blocker;w.execution='queued';break;}
    case 'quarantine-runtime': {
      role(actor,'owner'); const w=needWork();
      ensure(Object.keys(command).length===5 && Object.keys(command).every(key=>['type','workId','runId','reason','acknowledgeUncertainOutcome'].includes(key)),'Invalid quarantine command fields');
      ensure(!w.runtimeRecovery,'Work is already quarantined');
      ensure(w.acceptance!=='accepted','Accepted Work cannot be quarantined');
      text(command.runId,'recovery run identity');
      ensure(w.runtimeRun?.id===command.runId,'Recovery must name the original configured run');
      ensure(command.acknowledgeUncertainOutcome===true,'Explicit acknowledgement of uncertain external outcome required');
      text(command.reason,'recovery reason'); ensure(command.reason.isWellFormed(),'Recovery reason must be well-formed Unicode');
      const pendingEffectIds=w.effects.filter(e=>e.status==='pending').map(e=>e.id);
      const unknownEffectIds=w.effects.filter(e=>e.status==='unknown').map(e=>e.id);
      ensure(pendingEffectIds.length+unknownEffectIds.length>0,'Quarantine requires unresolved effects');
      w.runtimeRecovery={runId:command.runId,actorId:actor.id,reason:command.reason,pendingEffectIds,unknownEffectIds};
      for(const effect of w.effects)if(effect.status==='pending')effect.status='unknown';
      // The owner supplies a handling decision, never a provider receipt or usage estimate.
      if(pendingEffectIds.length)w.budget.measured=null;
      w.execution='cancelled'; break;
    }
    case 'block-work': {role(actor,'owner','representative');const w=needWork();open(w);ensure(w.execution!=='waiting','Owner steering cannot be overwritten by a runtime blocker');text(command.blocker.detail,'blocker');ensure(['provider_unavailable','runtime_unavailable','provider_failed','budget_exceeded','verification_failed'].includes(command.blocker.code),'Invalid blocker');w.blocker=structuredClone(command.blocker);w.execution='blocked';break;}
    case 'revise-work': { role(actor,'owner','representative'); const w=needWork(); open(w); ensure(w.verdict?.status==='failed'||w.acceptance==='stale','Revision requires failed or stale assurance'); ensure(w.effects.every(e=>e.status==='succeeded'||e.status==='failed'),'Unsettled effects prohibit revision'); const number=w.attempts.length+1; w.attempts.push({id:`${w.id}:attempt:${number}`,number,criteria:structuredClone(w.criteria),status:'queued',modelVersions:w.assignments.map(a=>a.model.configVersion)}); for(const task of w.tasks) { task.status='queued'; delete task.result; } w.execution='queued'; w.acceptance='pending'; delete w.verdict; break; }
    case 'assign': {
      role(actor,'owner','representative'); const w=needWork(); open(w); const a=command.assignment; text(a.id,'assignment'); text(a.actorId,'assignee'); text(a.model.reason,'model selection reason'); text(a.model.configVersion,'model config');if(w.runtimeRun?.connectionBindings)ensure(a.model.configVersion===w.runtimeRun.connectionBindings[a.role].configHash,'Assignment does not match admitted connection binding'); text(a.extensionVersion,'extension'); ensure(a.role==='executor'||a.role==='verifier','Unknown responsibility'); ensure(a.model.evidenceClass==='fixture'||a.model.evidenceClass==='real-provider','Unknown evidence class'); ensure(w.tasks.some(t=>t.id===a.taskId),'Unknown task'); ensure(!w.assignments.some(x=>x.id===a.id),'Duplicate assignment'); ensure(!w.assignments.some(x=>x.actorId===a.actorId&&x.role!==a.role),'Executor and verifier must be independent identities'); w.assignments.push(structuredClone(a)); w.attempts.at(-1)!.modelVersions.push(a.model.configVersion); break;
    }
    case 'delegate': {
      role(actor,'representative'); const w=needWork(); open(w); ensure(w.tasks.some(t=>t.id===command.parentId),'Unknown parent task'); text(command.taskId,'task'); ensure(!w.tasks.some(t=>t.id===command.taskId),'Duplicate task'); w.tasks.push({id:command.taskId,parentId:command.parentId,status:'queued'}); break;
    }
    case 'settle-task': {
      const w=needWork(); performer(w,command.taskId); open(w); ensure(w.execution!=='waiting','Owner steering must be resolved before task progression'); const task=w.tasks.find(t=>t.id===command.taskId); ensure(task,'Unknown task'); ensure(w.assignments.some(a=>a.actorId===actor.id&&a.taskId===task.id),'Not assigned to task'); ensure(w.tasks.filter(t=>t.parentId===task.id).every(t=>t.status==='settled'),'Child result not settled'); ensure(w.effects.filter(e=>e.taskId===task.id).every(e=>e.status==='succeeded'||e.status==='failed'),'Task has unsettled effects'); text(command.result,'result'); task.status='settled'; task.result=command.result; if(w.tasks.every(t=>t.status==='settled')) { w.execution='settled'; w.attempts.at(-1)!.status='settled'; w.attempts.at(-1)!.results=w.tasks.map(t=>({taskId:t.id,result:t.result!})); } break;
    }
    case 'admit-effect': {
      const w=needWork(); performer(w,command.effect.taskId); open(w); ensure(w.execution!=='waiting','Owner steering must be resolved before effect admission'); ensure(!w.blocker,'Work execution gate is not satisfied'); const e=command.effect; text(e.id,'effect'); text(e.target,'effect target'); text(e.authority,'authority'); ensure(e.status==='pending'&&!e.receipt,'Effect intent must be pending'); ensure(w.tasks.some(t=>t.id===e.taskId&&t.status!=='settled'),'Unknown or settled task'); ensure(w.assignments.some(a=>a.taskId===e.taskId&&a.actorId===actor.id&&actor.roles.includes(a.role)),'Not assigned to effect task'); ensure(!w.effects.some(x=>x.id===e.id),'Effect already admitted; never blindly replay'); ensure(!w.effects.some(x=>x.status==='unknown'||x.status==='pending'),'Unresolved effect requires reconciliation; do not replay pending execution'); ensure(finite(command.reserve)&&w.budget.reserved+command.reserve<=w.budget.limit,'Budget exhausted'); w.budget.reserved+=command.reserve; w.effects.push(structuredClone(e)); w.execution='active'; w.attempts.at(-1)!.status='active'; w.tasks.find(t=>t.id===e.taskId)!.status='active'; break;
    }
    case 'receipt': {
      const w=needWork(); ensure(!w.runtimeRecovery,'Quarantined Work rejects late receipts'); const e=w.effects.find(e=>e.id===command.effectId); ensure(e&&e.status==='pending','Effect is not awaiting receipt'); performer(w,e.taskId); ensure(['succeeded','failed','unknown'].includes(command.outcome),'Invalid outcome'); ensure(command.usage===null||finite(command.usage),'Invalid usage'); text(command.receipt,'receipt',262144); e.status=command.outcome; e.receipt=command.receipt; w.budget.measured=command.usage===null||w.budget.measured===null?null:w.budget.measured+command.usage; if(command.outcome==='unknown'&&w.execution!=='cancelled'&&w.execution!=='waiting') w.execution='blocked'; break;
    }
    case 'reconcile-effect': {
      role(actor,'owner'); const w=needWork(); ensure(!w.runtimeRecovery,'Quarantined Work cannot be reconciled or reopened'); const e=w.effects.find(e=>e.id===command.effectId); ensure(e&&e.status==='unknown','Only unknown effects need reconciliation'); ensure(command.outcome==='succeeded'||command.outcome==='failed','Invalid reconciliation outcome'); text(command.receipt,'reconciliation evidence'); e.status=command.outcome; e.receipt=command.receipt; if(w.execution==='blocked'&&!w.effects.some(e=>e.status==='unknown')) w.execution='active'; break;
    }
    case 'publish-artifact': {
      const w=needWork(); executor(w); open(w); const a=command.artifact; ensure(/^[a-f0-9]{64}$/.test(a.sha256),'Invalid artifact hash'); ensure(Number.isSafeInteger(a.version)&&a.version>(w.artifact?.version??0),'Artifact version must advance'); text(a.id,'artifact'); text(a.path,'artifact path'); text(a.kind,'artifact kind'); w.artifact=structuredClone(a); if(w.verdict) w.acceptance='stale'; break;
    }
    case 'verify': {
      role(actor,'verifier'); const w=needWork(); open(w); const v=command.verdict; text(v.id,'verdict identity'); const a=w.assignments.find(a=>a.id===v.verifierAssignmentId&&a.role==='verifier'&&a.actorId===actor.id); ensure(a,'Verifier not independently assigned'); ensure(!w.assignments.some(a=>a.actorId===actor.id&&a.role==='executor'),'Self-verification prohibited'); ensure(w.artifact,'No candidate artifact'); ensure(v.artifactSha256===w.artifact.sha256&&v.artifactVersion===w.artifact.version&&v.criteriaVersion===w.criteria.version,'Stale verification binding'); ensure(['passed','failed','stale'].includes(v.status),'Invalid verdict'); ensure(Array.isArray(v.evidence)&&v.evidence.length>0&&v.evidence.every(e=>e.kind&&e.detail&&e.source),'Independent evidence required'); w.verdict=structuredClone(v); w.acceptance=v.status==='failed'?'failed':v.status==='stale'?'stale':'pending'; break;
    }
    case 'accept': {
      role(actor,'owner','representative'); const w=needWork(); open(w); ensure(w.execution==='settled','Execution is not settled'); ensure(w.artifact&&w.verdict&&w.verdict.status==='passed','Independent pass required'); ensure(w.verdict.artifactSha256===w.artifact.sha256&&w.verdict.artifactVersion===w.artifact.version&&w.verdict.criteriaVersion===w.criteria.version,'Stale evidence cannot be accepted'); ensure(w.effects.length>0&&w.effects.every(e=>e.status==='succeeded'||e.status==='failed'),'Required effect outcomes unresolved'); ensure(w.effects.some(e=>e.status==='succeeded'),'No successful effect evidence'); text(command.recordId,'record'); if(command.artifactSnapshot) { ensure(command.artifactSnapshot.sha256===w.artifact.sha256,'Snapshot hash mismatch'); text(command.artifactSnapshot.path,'snapshot path'); } const bundle={...(command.artifactSnapshot?{artifactSnapshot:command.artifactSnapshot}:{}),id:command.recordId,workId:w.id,criteria:w.criteria,artifact:w.artifact,verdict:w.verdict,receipts:w.effects,assignments:w.assignments,memoryVersions:w.appliedMemoryVersions,evidenceClass:w.assignments.some(a=>a.model.evidenceClass==='fixture')?'fixture' as const:'real-provider' as const}; w.record=structuredClone({...bundle,checksum:hash(bundle)}); w.acceptance='accepted'; break;
    }
    case 'cancel': { role(actor,'owner','representative'); const w=needWork(); open(w); w.execution='cancelled'; break; }
    case 'steer': { role(actor,'owner'); const w=needWork(); open(w); text(command.instruction,'instruction'); (w.instructions??=[]).push({actorId:actor.id,text:command.instruction}); if(!w.blocker)w.execution='waiting'; break; }
    case 'save-memory': {
      role(actor,'owner','representative'); const m=command.memory; text(m.id,'memory'); text(m.source,'memory provenance'); text(m.content,'memory'); ensure(m.scope===state.scope,'Memory scope mismatch'); ensure(Number.isSafeInteger(m.version)&&m.version>0,'Invalid memory version'); ensure(m.authority==='explicit'||m.authority==='learned','Invalid memory authority'); if(m.authority==='explicit') role(actor,'owner'); ensure(m.authority!=='learned'||!m.effective,'Learned memory requires evaluated adoption'); ensure(!state.memories.some(x=>x.id===m.id&&x.version===m.version),'Memory version immutable'); ensure(m.version>Math.max(0,...state.memories.filter(x=>x.id===m.id).map(x=>x.version)),'Memory version must advance'); if(m.effective) for(const old of state.memories) if(old.id===m.id) old.effective=false; state.memories.push(structuredClone(m)); break;
    }
    case 'propose-growth': {
      role(actor,'representative'); const g=command.proposal; text(g.id,'growth'); text(g.counterevidence,'counterevidence'); ensure(g.proposer===actor.id&&g.status==='proposed'&&!g.evaluator&&!g.scores&&!g.observation,'Invalid proposal'); ensure(g.target==='memory','Only memory adoption implemented in this slice'); ensure(state.memories.some(m=>`${m.id}@${m.version}`===g.candidate&&!m.effective),'Unknown candidate'); ensure(state.memories.some(m=>`${m.id}@${m.version}`===g.baseline&&m.effective),'Unknown effective baseline'); ensure(!state.growth.some(x=>x.id===g.id),'Growth exists'); state.growth.push(structuredClone(g)); break;
    }
    case 'evaluate-growth': {
      role(actor,'evaluator'); const g=growth(); ensure(g.status==='proposed'&&g.proposer!==actor.id,'Independent evaluation required'); ensure(finite(command.baseline)&&finite(command.candidate),'Invalid evaluation metrics'); text(command.heldOut,'held-out evidence'); g.evaluator=actor.id; g.scores={baseline:command.baseline,candidate:command.candidate,heldOut:command.heldOut}; g.status='evaluated'; break;
    }
    case 'adopt-growth': {
      role(actor,'owner'); const g=growth(); ensure(g.status==='evaluated'&&g.scores&&g.scores.candidate>g.scores.baseline,'Independently measured improvement required'); ensure(state.memories.some(m=>`${m.id}@${m.version}`===g.baseline&&m.effective),'Growth baseline is no longer effective'); g.previousEffective=state.memories.filter(m=>m.effective).map(m=>`${m.id}@${m.version}`); const candidate=state.memories.find(m=>`${m.id}@${m.version}`===g.candidate)!; for(const m of state.memories) if(m.id===candidate.id) m.effective=false; candidate.effective=true; g.status='adopted'; break;
    }
    case 'observe-growth': { role(actor,'evaluator'); const g=growth(); const w=state.works.find(w=>w.id===command.workId); ensure(g.status==='adopted'&&w?.appliedMemoryVersions.includes(g.candidate)&&w.acceptance==='accepted','Accepted later work under candidate required'); ensure(finite(command.metric),'Invalid observation'); g.observation={workId:command.workId,metric:command.metric}; break; }
    case 'revert-growth': { role(actor,'owner'); const g=growth(); ensure(g.status==='adopted'&&g.previousEffective,'No adoption to revert'); ensure(state.memories.some(m=>`${m.id}@${m.version}`===g.candidate&&m.effective),'Cannot revert a superseded adoption'); const candidate=state.memories.find(m=>`${m.id}@${m.version}`===g.candidate)!; for(const m of state.memories) if(m.id===candidate.id) m.effective=g.previousEffective.includes(`${m.id}@${m.version}`); g.status='reverted'; break; }
    case 'relate': { role(actor,'representative','verifier'); const r=command.relation; text(r.from,'relation source'); text(r.to,'relation target'); text(r.provenance,'provenance'); ensure(['depends-on','evidenced-by','contains'].includes(r.type),'Invalid relation type'); ensure(Number.isSafeInteger(r.fromVersion)&&r.fromVersion>0&&Number.isSafeInteger(r.toVersion)&&r.toVersion>0,'Invalid relation versions'); state.relations.push(structuredClone(r)); break; }
    default: throw new DomainError('Unknown command');
  }
  return { value:state,events:[{type:command.type,actor:actor.id,command:structuredClone(command)}] };
}
export function affectedBy(mission: Mission, id: string, version: number): string[] {
  const seen=new Set<string>(); const queue=[{id,version}];
  while(queue.length) { const item=queue.shift()!; for(const r of mission.relations) if(r.to===item.id&&r.toVersion===item.version&&!seen.has(`${r.from}@${r.fromVersion}`)) { seen.add(`${r.from}@${r.fromVersion}`); queue.push({id:r.from,version:r.fromVersion}); } }
  return [...seen].sort();
}
