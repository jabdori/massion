import {DomainError,pinnedWorkSources,documentContentHash,DOCUMENT_CONTENT_BYTES} from './domain.ts';
import type {Mission,DocumentVersion} from './domain.ts';
import type {Store} from './storage.ts';
import {MissionCatalogChangedError} from './mission-catalog.ts';
import type {MissionCatalogReader} from './mission-catalog.ts';

export interface GithubTarget {repository:string;number:number;headSha:string;url:string}
export interface GithubFile {path:string;content:string}
export interface FileInput {documentId:string;path:string;sha256:string}
export function validateGithubFiles(value:unknown):asserts value is GithubFile[] {
 if(!Array.isArray(value)||value.length<1||value.length>11||!value.every(f=>f&&typeof f==='object'&&Object.keys(f).length===2&&typeof f.path==='string'&&f.path.length<=512&&f.path.isWellFormed()&&!/[\p{Cc}\p{Cf}]/u.test(f.path)&&f.path.split('/').every((p:string)=>p&&p!=='.'&&p!=='..')&&typeof f.content==='string'&&f.content.isWellFormed()&&!f.content.includes('\0'))||new Set(value.map(f=>f.path)).size!==value.length||Buffer.byteLength(JSON.stringify(value),'utf8')>12000)throw new DomainError('Invalid bounded GitHub file sources');
}
export function githubSource(content:string):{target:GithubTarget;files:GithubFile[]}|null {
 let v;try{v=JSON.parse(content);}catch{return null;}if(!v||typeof v!=='object'||!['github-review/v1','github-review/v2'].includes(v.format))return null;
 const {format,files,...target}=v;if(!validGithubTarget(target))return null;
 if(format==='github-review/v1')return Object.hasOwn(v,'files')?null:{target,files:[]};
 try{validateGithubFiles(files);}catch{return null;}return {target,files};
}
export function workFileInputs(work:import('./domain.ts').Work):FileInput[] {
 return (work.sourceDocuments??[]).flatMap(({document:d})=>{const source=githubSource(d.content);return source&&d.source===source.target.url?source.files.map(f=>({documentId:d.id,path:f.path,sha256:documentContentHash(f.content)})):[];});
}
export interface GithubReview {missionId:string;workId:string;title:string;memberId:string|null;progress:{done:number;total:number};reading:boolean;deadlineAt:number}
/** 대화 출처와 무관하게 같은 피드의 카탈로그 페이지에서 작업이 있는 미션을 읽습니다. */
export async function readGithubReviewMissions(store:Store<Mission>,catalog:MissionCatalogReader,feedId:string):Promise<Mission[]> {
 const missions:Mission[]=[];let page=await catalog.readCatalog({feedId}),after='';const cursor=page.cursor;
 for(;;){
  if(page.feedId!==feedId)throw new MissionCatalogChangedError('feed');if(page.cursor!==cursor)throw new MissionCatalogChangedError('cursor');
  for(const item of page.items)if(item.workCount>0){const read=await store.readState(item.missionId);if(read.feedId!==feedId)throw new MissionCatalogChangedError('feed');if(read.snapshot)missions.push(read.snapshot.value);}
  if(page.nextAfter===null)return missions;
  if(page.nextAfter<=after)throw new MissionCatalogChangedError('cursor');after=page.nextAfter;page=await catalog.readCatalog({after,cursor,feedId});
 }
}
export function validGithubTarget(value:unknown):value is GithubTarget {
 const v=value as GithubTarget;
 return !!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===4&&Object.keys(v).every(k=>['repository','number','headSha','url'].includes(k))&&typeof v.repository==='string'&&/^[A-Za-z0-9_-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(v.repository)&&!v.repository.split('/').some(x=>/^\.+$/.test(x))&&Number.isSafeInteger(v.number)&&v.number>0&&v.number<1e9&&typeof v.headSha==='string'&&/^[a-f0-9]{40}$/.test(v.headSha)&&v.url==='https://github.com/'+v.repository+'/pull/'+v.number;
}
export function githubReviewDocument(target:GithubTarget,id:string,files?:GithubFile[]):Pick<DocumentVersion,'id'|'version'|'title'|'source'|'content'> {
 if(!validGithubTarget(target))throw new DomainError('Exact GitHub review identity required');
 if(files!==undefined)validateGithubFiles(files);
 const content=JSON.stringify({format:files?'github-review/v2':'github-review/v1',...target,...files?{files}:{}});if(Buffer.byteLength(content,'utf8')>DOCUMENT_CONTENT_BYTES)throw new DomainError('GitHub source exceeds document bound');
 return {id,version:1,title:target.repository+' #'+target.number,source:target.url,content};
}
/** 고정한 원본 자료와 현재 커밋이 일치하는 실행만 검토 중으로 표시합니다. */
export function githubReviews(mission:Mission,target:GithubTarget,now:number):GithubReview[] {
 if(!validGithubTarget(target))return [];
 return mission.works.flatMap(w=>{
  const deadlineAt=w.runtimeRun?.ownership?.deadlineAt;
  if(w.execution!=='active'||w.acceptance==='accepted'||w.runtimeInterruption||w.runtimeRecovery||deadlineAt===undefined||deadlineAt<=now||w.effects.some(e=>e.status==='unknown'))return [];
  let matches=false;try{matches=(pinnedWorkSources(mission,w)??[]).some(pin=>{const source=githubSource(pin.document.content);return source&&pin.document.source===target.url&&source.target.url===target.url&&source.target.headSha===target.headSha;});}catch{return [];}
  if(!matches)return [];
  const tasks=w.tasks.filter(t=>t.step&&!t.step.skipReason);
  return [{missionId:mission.id,workId:w.id,title:w.title,memberId:w.assistantSource?.memberId??null,progress:{done:tasks.filter(t=>t.status==='settled').length,total:tasks.length},reading:w.effects.some(e=>e.status==='pending'&&!!e.providerDispatch?.fileInputs?.length),deadlineAt}];
 });
}
