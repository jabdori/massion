import {BINARY_MAX_BYTES,validateBinary} from './binary-artifacts.ts';
import {clarificationInput,requireAnswered} from './work-clarification.ts';
import {conversationSourceInput,validateConversationSources} from './conversation-work.ts';
import {correctionInput} from './work-correction.ts';
import {validateProviderDispatchClaims} from './provider-dispatch.ts';
import {validateRuntimeOwnership} from './runtime-lifetime.ts';
import {resolvedPrerequisites} from './work-prerequisites.ts';
import {createHash} from 'node:crypto';
import {hash,pinnedOrganization,pinnedWorkSources} from './domain.ts';
import {validateAssistantSource} from './assistant-conversation.ts';
import type {Artifact,Mission,AcceptedRecord,Work} from './domain.ts';
import type {Store} from './storage.ts';
import {EventCursorError} from './storage.ts';
export interface ArtifactReader {read(artifact:Artifact):Promise<string>;readBytes?(artifact:Artifact):Promise<Uint8Array>}
export interface BinaryArtifactReader {readBytes(artifact:Artifact):Promise<Uint8Array>}
export type BinaryRecordArtifactRead=RecordArtifactRead&{encoding:'base64';source?:{segment:number;turnId:string;memberId:string|null}};
export interface RecordArtifactInput {recordId:string;artifactVersion:number;artifactSha256:string;feedId?:string}
export interface RecordArtifactRead {missionId:string;workId:string;recordId:string;recordChecksum:string;evidenceClass:AcceptedRecord['evidenceClass'];artifact:Pick<Artifact,'id'|'version'|'sha256'|'kind'>;criteriaVersion:number;revision:number;feedId:string;byteLength:number;content:string}
export class RecordArtifactError extends Error {readonly status:409|422|503;constructor(status:409|422|503,message:string){super(message);this.status=status;this.name='RecordArtifactError';}}
const conflict=()=>{throw new RecordArtifactError(409,'The exact accepted Record or artifact identity no longer matches. Refresh and choose the exact result deliberately.');};
function record(mission:Mission,work:Work,input:RecordArtifactInput,binary=false):AcceptedRecord {
 const r=work.record;
 if(work.acceptance!=='accepted'||!r||r.id!==input.recordId||r.workId!==work.id||r.artifact.version!==input.artifactVersion||r.artifact.sha256!==input.artifactSha256)conflict();
 try{const records=resolvedPrerequisites(mission,work);if(hash(r!.prerequisites??null)!==hash(work.prerequisites??null)||hash(r!.prerequisiteRecords??null)!==hash(records??null))throw Error();}catch{throw new RecordArtifactError(503,'Exact prerequisite evidence is unavailable; no artifact fallback.');}
 try{requireAnswered(work);if(hash(r!.questions??null)!==hash(clarificationInput(work)??null))conflict();validateConversationSources(mission);if(hash(r!.conversationSource??null)!==hash(conversationSourceInput(work)??null))conflict();if(hash(r!.correction??null)!==hash(correctionInput(work)??null))conflict();validateProviderDispatchClaims(work);if(Object.hasOwn(work.runtimeRun??{},'ownership'))validateRuntimeOwnership(work.runtimeRun!.ownership!);}catch{conflict();}
 try{if(hash(r!.assistantSource??null)!==hash(work.assistantSource??null))conflict();if(r!.assistantSource)validateAssistantSource(r!.assistantSource,work.id);}catch{conflict();}
 if(hash(r!.team??null)!==hash(work.team??null))conflict();
 const edits=work.tasks.filter(t=>t.procedureEdit).map(t=>({taskId:t.id,edit:t.procedureEdit}));if(hash(r!.procedureEdits??[])!==hash(edits))conflict();
 if(hash(r!.runtimeOwnership??null)!==hash(work.runtimeRun?.ownership??null))conflict();
 const {checksum,...bundle}=r!;
 if(checksum!==hash(bundle)||work.execution!=='settled'||!work.artifact||!work.verdict||hash(work.artifact)!==hash(r!.artifact)||hash(work.criteria)!==hash(r!.criteria)||hash(work.verdict)!==hash(r!.verdict)||hash(work.effects)!==hash(r!.receipts)||hash(work.assignments)!==hash(r!.assignments)||hash(work.appliedMemoryVersions)!==hash(r!.memoryVersions)||r!.verdict.status!=='passed'||r!.verdict.artifactSha256!==r!.artifact.sha256||r!.verdict.artifactVersion!==r!.artifact.version||r!.verdict.criteriaVersion!==r!.criteria.version||!r!.receipts.length||r!.receipts.some(e=>!['succeeded','failed'].includes(e.status))||!r!.receipts.some(e=>e.status==='succeeded')||!['fixture','real-provider'].includes(r!.evidenceClass))conflict();
 try{const sources=pinnedWorkSources(mission,work);if(sources){if(!r!.sourceDocuments||hash(r!.sourceDocuments)!==hash(sources))conflict();}else if(Object.hasOwn(r!,'sourceDocuments'))conflict();}catch{conflict();}
 try{const organization=pinnedOrganization(mission,work);if(organization){if(!r!.organizationSnapshot||hash(r!.organizationSnapshot)!==hash(organization)||r!.assignments.some(a=>a.organizationVersion!==organization.version))conflict();}else if(Object.hasOwn(r!,'organizationSnapshot')||r!.assignments.some(a=>Object.hasOwn(a,'organizationVersion')))conflict();}catch{conflict();}
 const verifier=r!.assignments.find(a=>a.id===r!.verdict.verifierAssignmentId&&a.role==='verifier');if(!verifier||r!.assignments.some(a=>a.role==='executor'&&a.actorId===verifier.actorId))conflict();
 if(binary?!['application/pdf','image/png'].includes(r!.artifact.kind):r!.artifact.kind!=='text')throw new RecordArtifactError(422,binary?'Only bounded static PDF and PNG artifacts are readable through this port.':'Only exact accepted UTF-8 text artifacts are readable through this host.');
 if(!r!.artifactSnapshot||r!.artifactSnapshot.sha256!==r!.artifact.sha256||r!.artifactSnapshot.path!==r!.artifact.path)conflict();
 return r!;
}
/** A query only: no filesystem path input, initialization, writes, replay or new acceptance. */
async function readExactArtifact(store:Store<Mission>,missionId:string,workId:string,input:RecordArtifactInput,read:(artifact:Artifact)=>Promise<{content:string;byteLength:number;encoding?:'base64'}>,binary=false):Promise<RecordArtifactRead|null> {
 input=structuredClone(input);
 if(!input.recordId||!Number.isSafeInteger(input.artifactVersion)||input.artifactVersion<1||!/^[a-f0-9]{64}$/.test(input.artifactSha256))throw new TypeError('Exact Record and artifact identity required');
 const state=await store.readState(missionId);
 if(input.feedId!==undefined&&state.feedId!==input.feedId)throw new EventCursorError(0,state.cursor);
 const work=state.snapshot?.value.works.find(w=>w.id===workId);if(!work)return null;
 const pinned=record(state.snapshot!.value,work,input,binary);
 const payload=await read(structuredClone(pinned.artifact));
 const current=await store.readState(missionId);if(current.feedId!==state.feedId)throw new EventCursorError(0,current.cursor);
 const latest=current.snapshot?.value.works.find(w=>w.id===workId);if(!latest||hash(record(current.snapshot!.value,latest,input,binary))!==hash(pinned))conflict();
 return {missionId,workId,recordId:pinned.id,recordChecksum:pinned.checksum,evidenceClass:pinned.evidenceClass,artifact:{id:pinned.artifact.id,version:pinned.artifact.version,sha256:pinned.artifact.sha256,kind:pinned.artifact.kind},criteriaVersion:pinned.criteria.version,revision:state.snapshot!.revision,feedId:state.feedId,...(binary&&pinned.assistantSource?{source:{segment:Number(pinned.assistantSource.segmentId.slice('assistant-conversation:'.length)),turnId:pinned.assistantSource.turnId,memberId:pinned.assistantSource.memberId??null}}:{}),...payload};
}

/** 기존 텍스트 조회의 형식과 오류 계약을 유지합니다. */
export async function readRecordArtifact(store:Store<Mission>,reader:ArtifactReader|undefined,missionId:string,workId:string,input:RecordArtifactInput):Promise<RecordArtifactRead|null> {
 return readExactArtifact(store,missionId,workId,input,async artifact=>{
  if(artifact.kind!=='text')throw new RecordArtifactError(422,'Only exact accepted UTF-8 text artifacts are readable through this host.');
  if(!reader)throw new RecordArtifactError(503,'Accepted text access is not enabled by this host. No filesystem fallback is used.');
  let content:string;try{content=await reader.read(artifact);}catch{throw new RecordArtifactError(503,'Exact accepted text is unavailable or failed integrity checks. No other artifact is substituted.');}
  if(typeof content!=='string'||!content.isWellFormed()||!content.length||Buffer.byteLength(content,'utf8')>32768||createHash('sha256').update(content,'utf8').digest('hex')!==artifact.sha256)throw new RecordArtifactError(503,'Accepted text did not match its pinned SHA-256 or UTF-8 byte bound.');
  return {content,byteLength:Buffer.byteLength(content,'utf8')};
 });
}
/** 바이너리 조회도 승인 검증을 공유하며 파일 경로나 승인 권한을 노출하지 않습니다. */
export async function readBinaryRecordArtifact(store:Store<Mission>,reader:BinaryArtifactReader|ArtifactReader|undefined,missionId:string,workId:string,input:RecordArtifactInput):Promise<BinaryRecordArtifactRead|null> {
 return readExactArtifact(store,missionId,workId,input,async artifact=>{
  if(!['application/pdf','image/png'].includes(artifact.kind))throw new RecordArtifactError(422,'Only bounded static PDF and PNG artifacts are readable through this port.');
  if(!reader?.readBytes)throw new RecordArtifactError(503,'Accepted binary access is not enabled by this host.');
  try{
   const content=await reader.readBytes(artifact);
   if(!(content instanceof Uint8Array)||!content.byteLength||content.byteLength>BINARY_MAX_BYTES)throw Error();
   const bytes=Buffer.from(content);if(createHash('sha256').update(bytes).digest('hex')!==artifact.sha256)throw Error();validateBinary(artifact.kind,bytes);
   return {content:bytes.toString('base64'),byteLength:bytes.length,encoding:'base64'};
  }catch{throw new RecordArtifactError(503,'Exact accepted binary is unavailable or failed integrity checks. No other artifact is substituted.');}
 },true) as Promise<BinaryRecordArtifactRead|null>;
}
