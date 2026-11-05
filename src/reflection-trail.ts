import {DomainError,canonical,hash} from './domain.ts';
import type {Mission,Work} from './domain.ts';
import type {Store} from './storage.ts';
import {pinnedMemoryInput} from './memory-input.ts';
import {readRecordArtifact,RecordArtifactError} from './record-artifact.ts';
import type {ArtifactReader} from './record-artifact.ts';
import {readRejectedText} from './rejected-text.ts';
export const TRAIL_BYTE_LIMIT=16384;
export type Bounded={text:string;truncated?:true;originalBytes?:number};
export interface ReflectionTrail {
 format:'massion.reflection-trail/v1';missionId:string;
 work:{ref:string;title:string;execution:'settled'|'blocked'|'cancelled';acceptance:Work['acceptance'];quarantined:boolean};
 input:{instructions:{ref:string;actorId:string;text:Bounded}[];criteria:Work['criteria'];missionSnapshot?:NonNullable<Work['missionSnapshot']>;appliedMemory:{ref:string;authority:'explicit'|'learned';content:string}[];sources:{ref:string;contentSha256:string}[]};
 attempts:{ref:string;number:number;criteriaVersion:number;status:string;results:{taskId:string;result:Bounded}[]}[];
 assignments:{role:'executor'|'verifier';provider:string;model:string;evidenceClass:'fixture'|'real-provider'}[];
 effects:{ref:string;status:Work['effects'][number]['status']}[];
 verdict?:{ref:string;status:'passed'|'failed'|'stale';evidence:{ref:string;kind:string;detail:Bounded;source?:string}[]};
 artifact?:{ref:string;sha256:string;kind:string;text?:Bounded;textUnavailable?:true};
 correction?:{workId:string;verdictHash:string};
 recordChecksum?:string;trailHash:string;
}
const conflict=(message:string)=>new DomainError(message,'conflict');
function eligible(w:Work):asserts w is Work&{execution:'settled'|'blocked'|'cancelled'}{
 if(!w.runtimeRun||!w.effects.length||!(w.execution==='settled'&&['accepted','failed','stale'].includes(w.acceptance)||w.execution==='blocked'||w.execution==='cancelled'))throw conflict('Work has no finished run to reflect on');
}
/** Cuts at a UTF-8 code-point boundary. */
function cut(bytes:Buffer,n:number):string{n=Math.max(0,n);while(n>0&&n<bytes.length&&(bytes[n]!&0xc0)===0x80)n--;return bytes.subarray(0,n).toString('utf8');}
function shorten(trail:Omit<ReflectionTrail,'trailHash'>){
 const over=()=>Buffer.byteLength(canonical({...trail,trailHash:'0'.repeat(64)}),'utf8')-TRAIL_BYTE_LIMIT;
 const fields=[trail.artifact?.text,...trail.attempts.flatMap(a=>a.results.map(r=>r.result)),...(trail.verdict?.evidence.map(e=>e.detail)??[])].filter(b=>b!==undefined);
 for(const b of fields){
  for(let excess=over();excess>0&&b.text;excess=over()){const bytes=Buffer.from(b.text,'utf8');b.originalBytes??=bytes.length;b.truncated=true;b.text=cut(bytes,bytes.length-excess);}
  if(over()<=0)return;
 }
}
/** Pure projection of one finished Work. `text` is the hash-checked artifact text, or undefined when no reader confirmed it. */
export function buildReflectionTrail(mission:Mission,w:Work,text:string|undefined):ReflectionTrail{
 eligible(w);const v=w.verdict,a=w.artifact;
 const trail:Omit<ReflectionTrail,'trailHash'>=structuredClone({
  format:'massion.reflection-trail/v1',missionId:mission.id,
  work:{ref:'work:'+w.id,title:w.title,execution:w.execution,acceptance:w.acceptance,quarantined:!!w.runtimeRecovery},
  input:{instructions:(w.instructions??[]).map((i,n)=>({ref:`instruction:${n+1}`,actorId:i.actorId,text:{text:i.text}})),criteria:{version:w.criteria.version,description:w.criteria.description,oracle:w.criteria.oracle},...(w.missionSnapshot?{missionSnapshot:w.missionSnapshot}:{}),appliedMemory:pinnedMemoryInput(mission,w).map(m=>({ref:`memory:${m.id}@${m.version}`,authority:m.authority,content:m.content})),sources:(w.sourceDocuments??[]).map(s=>({ref:`source:${s.document.id}@${s.document.version}`,contentSha256:s.document.contentSha256}))},
  attempts:w.attempts.map(t=>({ref:'attempt:'+t.id,number:t.number,criteriaVersion:t.criteria.version,status:t.status,results:(t.results??[]).map(r=>({taskId:r.taskId,result:{text:r.result}}))})),
  assignments:w.assignments.map(s=>({role:s.role,provider:s.model.provider,model:s.model.model,evidenceClass:s.model.evidenceClass})),
  effects:w.effects.map(e=>({ref:'effect:'+e.id,status:e.status})),
  // The readback source is the host artifact path, which never enters a trail.
  ...(v?{verdict:{ref:'verdict:'+v.id,status:v.status,evidence:v.evidence.map((e,n)=>({ref:`evidence:${v.id}#${n+1}`,kind:e.kind,detail:{text:e.detail},...(e.kind==='artifact-readback'?{}:{source:e.source})}))}}:{}),
  ...(a?{artifact:{ref:`artifact:${a.id}@${a.version}`,sha256:a.sha256,kind:a.kind,...(text===undefined?{textUnavailable:true as const}:{text:{text}})}}:{}),
  ...(w.correction?{correction:{workId:w.correction.workId,verdictHash:w.correction.verdictHash}}:{}),
  ...(w.record?{recordChecksum:w.record.checksum}:{}),
 });
 shorten(trail);return {...trail,trailHash:hash(trail)};
}
/** Query only: no transition, journal entry or stored field. Artifact text comes only from the existing hash-checked readers. */
export async function readReflectionTrail(store:Store<Mission>,reader:ArtifactReader|undefined,missionId:string,workId:string,revision?:number,feedId?:string):Promise<ReflectionTrail|null>{
 const state=await store.readState(missionId),snapshot=state.snapshot;
 if(feedId!==undefined&&state.feedId!==feedId)throw conflict('Event feed identity no longer matches this database; read the trail against refreshed state');
 if(!snapshot)return null;
 if(revision!==undefined&&snapshot.revision!==revision)throw conflict('Mission revision changed; read the trail against refreshed state');
 const w=snapshot.value.works.find(w=>w.id===workId);if(!w)return null;eligible(w);
 // Only a reader refusal (unavailable, failed integrity, non-text) becomes textUnavailable; storage and feed failures propagate.
 let text:string|undefined;
 if(w.artifact)try{
  if(w.acceptance==='accepted'&&w.record)text=(await readRecordArtifact(store,reader,missionId,workId,{recordId:w.record.id,artifactVersion:w.artifact.version,artifactSha256:w.artifact.sha256}))?.content;
  else if(w.execution==='settled'&&w.acceptance==='failed')text=(await readRejectedText(store,reader,missionId,workId,{binding:hash(w),artifactVersion:w.artifact.version,artifactSha256:w.artifact.sha256}))?.content;
 }catch(error){if(!(error instanceof RecordArtifactError))throw error;text=undefined;}
 const current=await store.readState(missionId);if(current.feedId!==state.feedId||hash(current.snapshot?.value.works.find(w=>w.id===workId)??null)!==hash(w))throw conflict('Work changed while its trail was read');
 return buildReflectionTrail(snapshot.value,w,text);
}
