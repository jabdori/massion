import type {ScreenFixture} from './fixture-host.ts';
import {apply,hash,canonical} from '../../src/domain.ts';
import type {Mission} from '../../src/domain.ts';
import {githubReviewDocument,workFileInputs} from '../../src/github-review.ts';
import {githubFixture} from '../../src/app-catalog.ts';
import {applySkills} from '../../src/skills.ts';
import {memberProcedures} from '../../src/internal-teams.ts';
import {workCardFacts} from '../../src/assistant-service.ts';
import {produceWork} from './regenerate-work-telemetry.ts';

/** Fixture inputs use the same exact pins, claims and timed receipts as runtime. */
export function fileReadActivityFixture(template:ScreenFixture):ScreenFixture {
 const fixture=structuredClone(template),mission=(fixture.routes['/missions/intake']?.body as any)?.value as Mission|undefined;
 const original=mission?.works.find(w=>w.title==='PR #84 검토');if(!mission||!original)return fixture;
 const owner={id:'local-owner',roles:['owner'] as const},pull=JSON.parse(githubFixture('https://api.github.com/repos/jabdori/massion/pulls/84').body),listed=JSON.parse(githubFixture('https://api.github.com/repos/jabdori/massion/pulls/84/files').body);
 const files=listed.map((f:{filename:string})=>{const d=JSON.parse(githubFixture('https://api.github.com/repos/jabdori/massion/contents/'+f.filename+'?ref='+pull.head.sha).body);return {path:f.filename,content:Buffer.from(d.content,'base64').toString('utf8')};});
 const document=githubReviewDocument({repository:'jabdori/massion',number:84,headSha:pull.head.sha,url:pull.html_url},'document:activity-files',files);
 mission.documents=apply(mission,{type:'capture-document',document},owner).value.documents;
 const pin=mission.documents!.find(d=>d.id===document.id)!,source=structuredClone(original),taskId=original.id+':step:0',actorId='fixture-worker-'+taskId,assignmentId=taskId+':assignment',model=source.assignments.find(a=>a.role==='executor')!.model,run=source.runtimeRun!,ownership=run.ownership!;
 const skills=applySkills(null,{type:'write-skill',memberId:source.assistantSource!.memberId!,kind:'procedure',name:'파일 읽기',body:{description:'고정한 파일 읽기',steps:['읽기'],verify:source.criteria.description}},owner,{observedAt:ownership.startedAt}).value;
 source.team=memberProcedures(skills,source.assistantSource!.memberId!,1);source.sourceDocuments=[{document:pin,actorId:owner.id,reason:'Controlled exact file delivery'}];
 source.tasks.push({id:taskId,parentId:original.id+':executor',status:'settled',result:'고정한 파일 전달',step:{role:'읽기',title:'읽기',dependsOn:[],sourceFiles:files.map((f:{path:string})=>f.path)}});
 source.effects.push({id:taskId+':files',taskId,status:'succeeded',target:model.provider+'/'+model.model,authority:run.authorizationId,receipt:'Controlled fixture delivery; no provider invocation',providerDispatch:{id:'file-activity-claim',runId:run.id,hostSessionId:ownership.hostSessionId,dispatchId:ownership.dispatchId,actorId,assignmentId,provider:model.provider,model:model.model,configVersion:model.configVersion,claimedAt:ownership.startedAt,requestHash:hash(files),fileInputs:workFileInputs(source)}});
 const {work}=produceWork(source,mission,fixture.now);mission.works=mission.works.map(w=>w.id===original.id?work:w);
 for(const route of Object.values(fixture.routes) as any[]){const body=route.body;
  if(body?.value?.id===mission.id)body.value=JSON.parse(canonical(mission));if(body?.snapshot?.value?.id===mission.id)body.snapshot.value=JSON.parse(canonical(mission));
  for(const row of [...(body?.works??[]),...(body?.turns??[]).flatMap((t:any)=>t.work?[t.work]:[])])if(row.workId===work.id)Object.assign(row,workCardFacts(work));
  if(body?.recordId===work.record?.id&&body?.recordChecksum)body.recordChecksum=work.record!.checksum;
 }
 fixture.reuse.push('scripts/ui-contracts/file-read-activity-fixture.ts: exact file claims and successful host-timed receipts');return fixture;
}
