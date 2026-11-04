import {validateRuntimeOwnership} from './runtime-lifetime.ts';
import {pinnedMemoryInput} from './memory-input.ts';
import {DomainError,hash,workInputHash,pinnedWorkSources,pinnedOrganization} from './domain.ts';
import type {Mission,Work,WorkPrerequisite,PrerequisiteRecord} from './domain.ts';
function ensure(value:unknown,message:string):asserts value{if(!value)throw new DomainError(message);}
const exact=(value:unknown,fields:string[])=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===fields.length&&Object.keys(value).every(k=>fields.includes(k));
const digest=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
/** Validate retained declarations, including deliberately stale pins; never silently rebind. */
export function prerequisitePins(mission:Mission,work:Work):WorkPrerequisite[]|undefined {
 if(!Object.hasOwn(work,'prerequisites'))return undefined;
 const pins=work.prerequisites;ensure(Array.isArray(pins)&&pins.length>0&&pins.length<=3&&Object.keys(pins).length===pins.length,'Invalid prerequisite bound');const ids=new Set<string>();
 for(const p of pins){ensure(exact(p,['workId','criteriaHash','inputHash','actorId','reason']),'Invalid prerequisite fields');ensure(typeof p.workId==='string'&&/^[a-zA-Z0-9:_-]{1,128}$/.test(p.workId)&&p.workId!==work.id&&!ids.has(p.workId),'Self or duplicate prerequisite');ensure(digest(p.criteriaHash)&&digest(p.inputHash),'Exact prerequisite input and criteria hashes required');ensure(typeof p.actorId==='string'&&p.actorId.trim()&&p.actorId.length<=2000&&p.actorId.isWellFormed()&&typeof p.reason==='string'&&p.reason.trim()&&p.reason.length<=2000&&p.reason.isWellFormed(),'Invalid prerequisite owner decision');ensure(mission.works.filter(w=>w.id===p.workId).length===1,'Unknown same-Mission prerequisite');ids.add(p.workId);}
 const visiting=new Set<string>(),done=new Set<string>();
 const visit=(w:Work)=>{ensure(!visiting.has(w.id),'Cyclic Work prerequisites prohibited');if(done.has(w.id))return;ensure(visiting.size<32,'Prerequisite chain exceeds 32 Work depth');visiting.add(w.id);for(const p of w.prerequisites??[]){const next=mission.works.find(w=>w.id===p.workId);ensure(next,'Unknown same-Mission prerequisite');visit(next);}visiting.delete(w.id);done.add(w.id);};visit(work);
 return structuredClone(pins);
}
/** Accepted Record binding, not a new judgment or artifact-content access. */
function acceptedRecord(mission:Mission,w:Work):PrerequisiteRecord {
 const r=w.record;ensure(w.acceptance==='accepted'&&w.execution==='settled'&&r,'Prerequisite Work has no accepted Record');
 ensure(w.tasks.length>0&&w.tasks.every(t=>t.status==='settled')&&w.attempts.at(-1)?.status==='settled','Prerequisite task/attempt settlement unavailable');
 if(Object.hasOwn(w.runtimeRun??{},'ownership'))validateRuntimeOwnership(w.runtimeRun!.ownership!);
 const {checksum,...bundle}=r;ensure(digest(checksum)&&hash(bundle)===checksum&&r.workId===w.id,'Prerequisite Record checksum/binding unavailable');
 for(const [a,b] of [[r.runtimeOwnership??null,w.runtimeRun?.ownership??null],[r.criteria,w.criteria],[r.artifact,w.artifact],[r.verdict,w.verdict],[r.receipts,w.effects],[r.assignments,w.assignments],[r.memoryVersions,w.appliedMemoryVersions],[r.sourceDocuments??null,w.sourceDocuments??null],[r.organizationSnapshot??null,w.organizationSnapshot??null],[r.prerequisites??null,w.prerequisites??null],[r.prerequisiteRecords??null,w.prerequisiteRecords??null]])ensure(hash(a)===hash(b),'Prerequisite Record original Work binding mismatch');
 ensure(r.verdict.status==='passed'&&r.verdict.artifactSha256===r.artifact.sha256&&r.verdict.artifactVersion===r.artifact.version&&r.verdict.criteriaVersion===r.criteria.version&&r.receipts.length>0&&r.receipts.every(e=>['succeeded','failed'].includes(e.status))&&r.receipts.some(e=>e.status==='succeeded')&&r.receipts.every(e=>typeof e.receipt==='string'&&e.receipt.trim())&&Array.isArray(r.verdict.evidence)&&r.verdict.evidence.length>0,'Prerequisite accepted evidence unavailable');const verifier=r.assignments.find(a=>a.id===r.verdict.verifierAssignmentId&&a.role==='verifier');ensure(verifier&&!r.assignments.some(a=>a.role==='executor'&&a.actorId===verifier.actorId),'Prerequisite independent verifier unavailable');ensure(r.evidenceClass===(r.assignments.some(a=>a.model.evidenceClass==='fixture')?'fixture':'real-provider'),'Prerequisite evidence class mismatch');pinnedWorkSources(mission,w);pinnedMemoryInput(mission,w);const organization=pinnedOrganization(mission,w);ensure(r.assignments.every(a=>organization?a.organizationVersion===organization.version:!Object.hasOwn(a,'organizationVersion')),'Prerequisite assignment organization version mismatch');
 return {workId:w.id,recordId:r.id,checksum:r.checksum,criteriaVersion:r.criteria.version,evidenceClass:r.evidenceClass,artifact:{id:r.artifact.id,version:r.artifact.version,sha256:r.artifact.sha256,kind:r.artifact.kind}};
}
export function resolvedPrerequisites(mission:Mission,work:Work):PrerequisiteRecord[]|undefined {
 const pins=prerequisitePins(mission,work);if(!pins){ensure(!Object.hasOwn(work,'prerequisiteRecords'),'Unbound prerequisite Records prohibited');return undefined;}
 const done=new Map<string,PrerequisiteRecord>();
 const resolve=(w:Work):PrerequisiteRecord[]|undefined=>{const p=prerequisitePins(mission,w);if(!p)return undefined;return p.map(pin=>{const target=mission.works.find(w=>w.id===pin.workId)!;ensure(hash(target.criteria)===pin.criteriaHash&&workInputHash(target)===pin.inputHash,'Prerequisite exact input or criteria changed; original pin cannot be replaced');let result=done.get(target.id);if(!result){result=acceptedRecord(mission,target);const own=resolve(target);ensure(hash(own??null)===hash(target.prerequisiteRecords??null),'Prerequisite Record chain unavailable');done.set(target.id,result);}return result;});};
 const records=resolve(work)!;if(work.runtimeRun||work.effects.length||work.acceptance==='accepted')ensure(Object.hasOwn(work,'prerequisiteRecords'),'Started Work has no retained prerequisite Record binding');if(Object.hasOwn(work,'prerequisiteRecords'))ensure(hash(records)===hash(work.prerequisiteRecords),'Retained prerequisite Record binding mismatch');return records;
}
export function bindPrerequisiteRecords(mission:Mission,work:Work):void {const records=resolvedPrerequisites(mission,work);if(records)work.prerequisiteRecords=records;}
