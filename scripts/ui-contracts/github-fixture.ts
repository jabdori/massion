import {apply,createMission,documentContentHash,hash,workInputHash} from '../../src/domain.ts';
import type {Actor,Command} from '../../src/domain.ts';
import {assistantTurnId,assistantWorkId,ownerMessageId,ASSISTANT_ACTOR_ID} from '../../src/assistant-conversation.ts';
import {githubReviewDocument,githubReviews} from '../../src/github-review.ts';
import {GITHUB_APP,githubFixture} from '../../src/app-catalog.ts';
import {runInNewContext} from 'node:vm';
import {checkView} from '../../src/app-sandbox.ts';
import type {ScreenFixture} from './fixture-host.ts';

/** 추가된 검토 상태는 실제 전이로 만들고 GitHub 응답은 모의 네트워크로만 읽습니다. */
export async function githubScreenFixture(template:ScreenFixture){
 const fixture=structuredClone(template),owner:Actor={id:'local-owner',roles:['owner']},rep:Actor={id:'representative',roles:['representative']};
 for(const step of fixture.steps)if('selector' in step&&step.selector==='[id="pane-tab-app:app-github:84"]')step.selector='[id="pane-tab-app:app-github:84:intake/pr84"]';
 const handlers=new Map<string,(input:unknown)=>Promise<unknown>>();
 // 고정된 번들 코드만 실행합니다. fixture에는 실제 네트워크나 외부 패키지 입력이 없습니다.
 runInNewContext(GITHUB_APP.source,{massion:{handle:(name:string,fn:(input:unknown)=>Promise<unknown>)=>handlers.set(name,fn),fetch:async(url:string)=>githubFixture(url)}},{timeout:1000,contextCodeGeneration:{strings:false,wasm:false}});
 const page=checkView(await handlers.get('page')!({})),item=checkView(await handlers.get('item')!({ref:'84'}));
 let m=createMission({id:'intake',purpose:'맡긴 일',scope:'local',constraints:[],criteria:{version:1,description:'PR의 변경 내용 확인',oracle:'bounded-text-review/v1'}},owner);
 const messageId=ownerMessageId('github-review-fixture'),turnId=assistantTurnId(messageId),workId=assistantWorkId(turnId),message={id:messageId,ordinal:1,actorId:owner.id,role:'owner' as const,turnId:null,text:'PR #84 검토',at:fixture.now-60000};
 const body={description:'파일 읽기',steps:Array.from({length:11},(_,i)=>'파일 '+(i+1)+' 읽기'),verify:'변경 내용과 근거 확인'},team={memberId:'member-juno',skillsRevision:1,procedures:[{id:'review-files',version:1,hash:hash(body),body}]};
 const send=(command:Command,actor=owner)=>{m=apply(m,command,actor).value;};
 send({type:'admit-work',workId,title:'PR #84 검토',budget:1000,team,assistantSource:{segmentId:'assistant-conversation:1',turnId,messageId,messageHash:hash(message),message,representative:{provider:'fixture',model:'deterministic'},memberId:'member-juno'}},{id:ASSISTANT_ACTOR_ID,roles:['assistant']});
 const document=githubReviewDocument(item.github!,'document:github-review',item.sourceFiles);send({type:'capture-document',document});send({type:'attach-work-source',workId,documentId:document.id,version:1,contentSha256:documentContentHash(document.content),reason:'선택한 PR 커밋 검토'});
 const w=m.works[0]!;send({type:'activate-runtime',workId,run:{id:'github-fixture-run',authorizationId:'fixture',criteriaHash:hash(w.criteria),inputHash:workInputHash(w),mode:'mock-http',outputTokenCap:10,ownership:{hostSessionId:'fixture',dispatchId:'fixture-dispatch',startedAt:fixture.now-60000,deadlineAt:fixture.now+60000}}});
 send({type:'delegate',workId,taskId:workId+':executor',parentId:workId+':root'},rep);
 for(let i=0;i<11;i++){
  const taskId=workId+':step:'+i,actorId='fixture-reader-'+i;
  send({type:'delegate',workId,taskId,parentId:workId+':executor',step:{role:'읽기',title:body.steps[i]!,dependsOn:[]}},rep);
  send({type:'assign',workId,assignment:{id:'read-'+i,actorId,role:'executor',taskId,model:{provider:'fixture',model:'deterministic',configVersion:'v1',reason:'Data-only screen fixture',evidenceClass:'fixture'},extensionVersion:'v1'}},rep);
  if(i<5){const actor:Actor={id:actorId,roles:['executor']},file=item.sourceFiles![i]!,effectId='fixture-file-read-'+i,claimId='fixture-file-claim-'+i;
   send({type:'admit-effect',workId,effect:{id:effectId,taskId,status:'pending',target:'fixture/deterministic',authority:'fixture'},reserve:1},actor);
   send({type:'claim-provider-dispatch',workId,effectId,claim:{id:claimId,runId:'github-fixture-run',hostSessionId:'fixture',dispatchId:'fixture-dispatch',actorId,assignmentId:'read-'+i,provider:'fixture',model:'deterministic',configVersion:'v1',requestHash:hash({file,fixture:true}),claimedAt:fixture.now-60000+i,fileInputs:[{documentId:document.id,path:file.path,sha256:documentContentHash(file.content)}]}},actor);
   if(i<4){send({type:'receipt',workId,effectId,providerDispatchId:claimId,outcome:'succeeded',receipt:'Controlled fixture received '+file.path,usage:0},actor);send({type:'settle-task',workId,taskId,result:'Controlled file delivery completed'},actor);}
  }
 }
 item.reviews=fixture.screen==='B22'?githubReviews(m,item.github!,fixture.now):[];for(const group of page.groups)for(const row of group.rows)if(row.github)row.reviews=fixture.screen==='B22'?githubReviews(m,row.github,fixture.now):[];
 for(const v of fixture.appViews??[])if(v.request.app==='app-github'&&(v.request.handler==='page'||v.request.ref==='84'))v.body=v.request.handler==='page'?page:item;
 if(fixture.screen==='B22'){
  const snapshot={revision:1,value:m};fixture.routes['/missions/intake']={status:200,body:snapshot};const state=fixture.routes['/read-state?mission=intake']!.body as Record<string,unknown>;state.snapshot=snapshot;
  const list=fixture.routes['/assistant/works']!.body as {works:unknown[]};list.works=[{missionId:m.id,missionRevision:1,workId,title:m.works[0]!.title,memberId:'member-juno',execution:'active',acceptance:'pending',unknown:false,exception:{at:null,runId:'github-fixture-run',fact:null},started:true,startedAt:fixture.now-60000,endedAt:null,turnId,segment:1}];
 }
 if(fixture.screen==='B22-room'){
  const {roomTelemetryWork}=await import('./room-telemetry-fixtures.ts'),{workCardFacts}=await import('../../src/assistant-service.ts');
  const mission=(fixture.routes['/missions/intake']!.body as any).value,previous=mission.works.find((w:any)=>w.title==='PR #84 검토'),produced=roomTelemetryWork(mission,'coding',fixture.now),next=produced.work;
  mission.works=mission.works.map((w:any)=>w.id===previous.id?next:w);mission.documents=[...(mission.documents??[]).filter((d:any)=>!produced.documents?.some(n=>n.id===d.id)),...(produced.documents??[])];mission.conversations=[...(mission.conversations??[]).filter((c:any)=>c.workId!==previous.id),produced.conversation];
  for(const route of Object.values(fixture.routes) as any[]){const b=route.body;if(b?.snapshot?.value?.id===mission.id)b.snapshot.value=structuredClone(mission);for(const row of [...(b?.works??[]),...(b?.turns??[]).flatMap((t:any)=>t.work?[t.work]:[])])if(row.workId===previous.id)Object.assign(row,{...workCardFacts(next),startedAt:next.runtimeRun?.ownership?.startedAt,endedAt:null,workId:next.id,turnId:produced.source.turnId,missionRevision:(fixture.routes['/missions/intake']!.body as any).revision});for(const turn of b?.turns??[])if(turn.work?.workId===next.id){turn.id=produced.source.turnId;turn.messageId=produced.source.messageId;turn.at=next.admittedAt;}for(const message of b?.segment?.messages??[]){if(message.id==='m:pr84'){message.id=produced.source.messageId;message.at=produced.source.message.at;}if(message.turnId==='assistant-turn:m:pr84'){message.turnId=produced.source.turnId;message.at=next.admittedAt;}}}
  fixture.steps=fixture.steps.map(step=>'selector' in step?{...step,...(step.readySelector?{readySelector:step.readySelector.replaceAll('work-heading-pr84','work-heading-'+next.id)}:{}),selector:step.selector.replaceAll('assistant-turn:m:pr84',produced.source.turnId).replaceAll('work-heading-pr84','work-heading-'+next.id).replaceAll('app:app-github:84:intake/pr84','app:app-github:84:intake/'+next.id)}:step);
 }
 return fixture;
}
