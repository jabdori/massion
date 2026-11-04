import {validateRuntimeOwnership} from './runtime-lifetime.ts';
import {resolvedPrerequisites} from './work-prerequisites.ts';
import {createHash} from 'node:crypto';
import {hash,pinnedOrganization,pinnedWorkSources} from './domain.ts';
import type {Artifact,Mission,AcceptedRecord,Work} from './domain.ts';
import type {Store} from './storage.ts';
import {EventCursorError} from './storage.ts';
export interface ArtifactReader {read(artifact:Artifact):Promise<string>}
export interface RecordArtifactInput {recordId:string;artifactVersion:number;artifactSha256:string;feedId?:string}
export interface RecordArtifactRead {missionId:string;workId:string;recordId:string;recordChecksum:string;evidenceClass:AcceptedRecord['evidenceClass'];artifact:Pick<Artifact,'id'|'version'|'sha256'|'kind'>;criteriaVersion:number;revision:number;feedId:string;byteLength:number;content:string}
export class RecordArtifactError extends Error {readonly status:409|422|503;constructor(status:409|422|503,message:string){super(message);this.status=status;this.name='RecordArtifactError';}}
const conflict=()=>{throw new RecordArtifactError(409,'The exact accepted Record or artifact identity no longer matches. Refresh and choose the exact result deliberately.');};
function record(mission:Mission,work:Work,input:RecordArtifactInput):AcceptedRecord {
 const r=work.record;
 if(work.acceptance!=='accepted'||!r||r.id!==input.recordId||r.workId!==work.id||r.artifact.version!==input.artifactVersion||r.artifact.sha256!==input.artifactSha256)conflict();
 try{const records=resolvedPrerequisites(mission,work);if(hash(r!.prerequisites??null)!==hash(work.prerequisites??null)||hash(r!.prerequisiteRecords??null)!==hash(records??null))throw Error();}catch{throw new RecordArtifactError(503,'Exact prerequisite evidence is unavailable; no artifact fallback.');}
 try{if(Object.hasOwn(work.runtimeRun??{},'ownership'))validateRuntimeOwnership(work.runtimeRun!.ownership!);}catch{conflict();}
 if(hash(r!.runtimeOwnership??null)!==hash(work.runtimeRun?.ownership??null))conflict();
 const {checksum,...bundle}=r!;
 if(checksum!==hash(bundle)||work.execution!=='settled'||!work.artifact||!work.verdict||hash(work.artifact)!==hash(r!.artifact)||hash(work.criteria)!==hash(r!.criteria)||hash(work.verdict)!==hash(r!.verdict)||hash(work.effects)!==hash(r!.receipts)||hash(work.assignments)!==hash(r!.assignments)||hash(work.appliedMemoryVersions)!==hash(r!.memoryVersions)||r!.verdict.status!=='passed'||r!.verdict.artifactSha256!==r!.artifact.sha256||r!.verdict.artifactVersion!==r!.artifact.version||r!.verdict.criteriaVersion!==r!.criteria.version||!r!.receipts.length||r!.receipts.some(e=>!['succeeded','failed'].includes(e.status))||!r!.receipts.some(e=>e.status==='succeeded')||!['fixture','real-provider'].includes(r!.evidenceClass))conflict();
 try{const sources=pinnedWorkSources(mission,work);if(sources){if(!r!.sourceDocuments||hash(r!.sourceDocuments)!==hash(sources))conflict();}else if(Object.hasOwn(r!,'sourceDocuments'))conflict();}catch{conflict();}
 try{const organization=pinnedOrganization(mission,work);if(organization){if(!r!.organizationSnapshot||hash(r!.organizationSnapshot)!==hash(organization)||r!.assignments.some(a=>a.organizationVersion!==organization.version))conflict();}else if(Object.hasOwn(r!,'organizationSnapshot')||r!.assignments.some(a=>Object.hasOwn(a,'organizationVersion')))conflict();}catch{conflict();}
 const verifier=r!.assignments.find(a=>a.id===r!.verdict.verifierAssignmentId&&a.role==='verifier');if(!verifier||r!.assignments.some(a=>a.role==='executor'&&a.actorId===verifier.actorId))conflict();
 if(r!.artifact.kind!=='text')throw new RecordArtifactError(422,'Only exact accepted UTF-8 text artifacts are readable through this host.');
 if(!r!.artifactSnapshot||r!.artifactSnapshot.sha256!==r!.artifact.sha256||r!.artifactSnapshot.path!==r!.artifact.path)conflict();
 return r!;
}
/** A query only: no filesystem path input, initialization, writes, replay or new acceptance. */
export async function readRecordArtifact(store:Store<Mission>,reader:ArtifactReader|undefined,missionId:string,workId:string,input:RecordArtifactInput):Promise<RecordArtifactRead|null> {
 input=structuredClone(input);
 if(!input.recordId||!Number.isSafeInteger(input.artifactVersion)||input.artifactVersion<1||!/^[a-f0-9]{64}$/.test(input.artifactSha256))throw new TypeError('Exact Record and artifact identity required');
 const state=await store.readState(missionId);
 if(input.feedId!==undefined&&state.feedId!==input.feedId)throw new EventCursorError(0,state.cursor);
 const work=state.snapshot?.value.works.find(w=>w.id===workId);if(!work)return null;
 const pinned=record(state.snapshot!.value,work,input);
 if(!reader)throw new RecordArtifactError(503,'Accepted text access is not enabled by this host. No filesystem fallback is used.');
 let content:string;try{content=await reader.read(structuredClone(pinned.artifact));}catch{throw new RecordArtifactError(503,'Exact accepted text is unavailable or failed integrity checks. No other artifact is substituted.');}
 if(typeof content!=='string'||!content.isWellFormed()||!content.length||Buffer.byteLength(content,'utf8')>32768||createHash('sha256').update(content,'utf8').digest('hex')!==pinned.artifact.sha256)throw new RecordArtifactError(503,'Accepted text did not match its pinned SHA-256 or UTF-8 byte bound.');
 const current=await store.readState(missionId);if(current.feedId!==state.feedId)throw new EventCursorError(0,current.cursor);
 const latest=current.snapshot?.value.works.find(w=>w.id===workId);if(!latest||hash(record(current.snapshot!.value,latest,input))!==hash(pinned))conflict();
 return {missionId,workId,recordId:pinned.id,recordChecksum:pinned.checksum,evidenceClass:pinned.evidenceClass,artifact:{id:pinned.artifact.id,version:pinned.artifact.version,sha256:pinned.artifact.sha256,kind:pinned.artifact.kind},criteriaVersion:pinned.criteria.version,revision:state.snapshot!.revision,feedId:state.feedId,byteLength:Buffer.byteLength(content,'utf8'),content};
}
