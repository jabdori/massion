import {DomainError,hash,workInputHash} from './domain.ts';
import type {Mission,Work,Artifact} from './domain.ts';
export interface CorrectionSelection {workId:string;workHash:string;reason:string}
export interface CorrectionPin extends CorrectionSelection {actorId:string;inputHash:string;criteriaHash:string;verdictHash:string;artifact:Pick<Artifact,'id'|'version'|'sha256'|'kind'>}
const sha=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function ensure(v:unknown,message:string):asserts v{if(!v)throw new DomainError(message);}
export function validateCorrectionPin(pin:CorrectionPin){
 ensure(pin&&typeof pin==='object'&&!Array.isArray(pin)&&Object.keys(pin).length===8&&Object.keys(pin).every(k=>['workId','workHash','reason','actorId','inputHash','criteriaHash','verdictHash','artifact'].includes(k)),'Exact correction provenance required');
 ensure(typeof pin.workId==='string'&&/^[A-Za-z0-9:_-]{1,128}$/.test(pin.workId)&&typeof pin.actorId==='string'&&/^[A-Za-z0-9:_-]{1,128}$/.test(pin.actorId),'Exact owner correction identity required');
 ensure([pin.workHash,pin.inputHash,pin.criteriaHash,pin.verdictHash].every(sha),'Exact correction hashes required');
 ensure(typeof pin.reason==='string'&&pin.reason.trim().length>0&&pin.reason.length<=2000&&pin.reason.isWellFormed(),'Bounded owner correction reason required');
 const a=pin.artifact;ensure(a&&Object.keys(a).length===4&&Object.keys(a).every(k=>['id','version','sha256','kind'].includes(k))&&typeof a.id==='string'&&a.id.length>0&&Number.isSafeInteger(a.version)&&a.version>0&&sha(a.sha256)&&a.kind==='text','Exact failed text artifact required');
}
/** Admission-time decision, not a prerequisite requiring the rejected Work to pass. */
export function captureCorrection(mission:Mission,selection:CorrectionSelection,actorId:string):CorrectionPin {
 ensure(selection&&Object.keys(selection).length===3&&Object.keys(selection).every(k=>['workId','workHash','reason'].includes(k)),'Only exact correction selection fields accepted');
 const source=mission.works.find(w=>w.id===selection.workId);
 ensure(source&&hash(source)===selection.workHash&&source.execution==='settled'&&source.acceptance==='failed'&&source.verdict?.status==='failed'&&!source.record&&!source.runtimeRecovery&&!source.runtimeInterruption&&source.runtimeRun&&source.runtimeRun.inputHash===workInputHash(source)&&source.runtimeRun.criteriaHash===hash(source.criteria)&&source.artifact?.kind==='text'&&source.verdict.artifactSha256===source.artifact.sha256&&source.verdict.artifactVersion===source.artifact.version&&source.verdict.criteriaVersion===source.criteria.version&&source.tasks.every(t=>t.status==='settled')&&source.attempts.at(-1)?.status==='settled'&&source.effects.length>=2&&source.effects.every(e=>['succeeded','failed'].includes(e.status)&&e.receipt?.trim())&&source.budget.measured!==null,'Exact known settled rejected Work required; unknown, cancelled or changed evidence cannot authorize a correction');
 const {id,version,sha256,kind}=source.artifact;
 const pin={...selection,actorId,inputHash:workInputHash(source),criteriaHash:hash(source.criteria),verdictHash:hash(source.verdict),artifact:{id,version,sha256,kind}};validateCorrectionPin(pin);return structuredClone(pin);
}
export function correctionInput(work:Work){if(!Object.hasOwn(work,'correction'))return undefined;validateCorrectionPin(work.correction!);return structuredClone(work.correction);}
