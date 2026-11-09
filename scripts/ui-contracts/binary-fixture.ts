import {mkdtemp,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Application} from '../../src/application.ts';
import {InMemoryStore} from '../../src/storage.ts';
import {hash} from '../../src/domain.ts';
import type {Mission,Command} from '../../src/domain.ts';
import {ASSISTANT_ACTOR_ID,assistantTurnId,assistantWorkId,ownerMessageId} from '../../src/assistant-conversation.ts';
import {BinaryArtifactStore,producePdf,producePng,binaryArtifactText} from '../../src/binary-artifacts.ts';
import {readBinaryRecordArtifact} from '../../src/record-artifact.ts';
import {copy} from '../../src/ui-copy.ts';
import type {ScreenFixture} from './fixture-host.ts';

/** 승인된 B10 데이터 예시처럼 한 이미지 안에 서로 다른 세 시안을 그립니다. */
function logoPixels():Uint8Array {
 const pixels=new Uint8Array(96*32*3);
 for(let y=0;y<32;y++)for(let x=0;x<96;x++){
  const section=Math.floor(x/32),dx=x%32-16,dy=y-16,mark=section===0?Math.abs(dx)+Math.abs(dy)<11:section===1?dx*dx+dy*dy<100:Math.abs(dx)<4||Math.abs(dy)<4;
  pixels.set(mark?[48,74,60]:[248,246,240],(y*96+x)*3);
 }
 return pixels;
}
/** 원래 텍스트 행은 유지하고 정상 명령 경로로 승인한 파일만 덧붙입니다. */
export async function binaryScreenFixture(template:ScreenFixture):Promise<ScreenFixture> {
 const fixture=structuredClone(template);if(!['B10','B10-preview'].includes(fixture.screen))return fixture;
 const root=await mkdtemp(join(await realpath(tmpdir()),'massion-binary-screen-'));
 try{
  const store=new InMemoryStore<Mission>(),app=new Application(store,[{id:'local-owner',roles:['owner']},{id:ASSISTANT_ACTOR_ID,roles:['assistant']},{id:'binary-executor',roles:['executor']},{id:'binary-verifier',roles:['verifier']}],()=>fixture.now);
  const artifacts=new BinaryArtifactStore(join(root,'artifacts')),baseline=(fixture.routes['/read-state?mission=intake']!.body as any).snapshot.value as Mission;
  await app.create({id:'intake',purpose:baseline.purpose,scope:baseline.scope,constraints:baseline.constraints,criteria:baseline.criteria},'local-owner','binary-fixture-create');
  let revision=1;const send=async(command:Command,actorId='local-owner')=>{
   const result=await app.dispatch({missionId:'intake',commandId:'binary-fixture-'+revision,expectedRevision:revision++,actorId,command});if(result.status!=='committed')throw Error('Binary fixture command was not committed');
  };
  const results=(fixture.routes['/assistant/results']!.body as any).results;
  const generated=[];
  for(const [index,kind] of (['application/pdf','image/png'] as const).entries()){
   // 이름과 담당자는 승인된 B10 아트보드의 데이터 예시입니다.
   const title=index===0?copy('sidebar.link.14'):'로고 시안 3종.png',at=fixture.now-(index+5)*86_400_000,messageId=ownerMessageId('binary-screen:'+kind),turnId=assistantTurnId(messageId),workId=assistantWorkId(turnId);
   const message={id:messageId,ordinal:100+index,actorId:'local-owner',role:'owner' as const,turnId:null,text:title,at},assistantSource={segmentId:'assistant-conversation:1',turnId,messageId,messageHash:hash(message),message,representative:{provider:'fixture',model:'deterministic'}};
   await send({type:'admit-work',workId,title,budget:2,assistantSource},ASSISTANT_ACTOR_ID);
   for(const role of ['executor','verifier'] as const)await send({type:'assign',workId,assignment:{id:workId+':'+role,actorId:'binary-'+role,role,taskId:workId+':root',model:{provider:'fixture',model:'deterministic-'+role,configVersion:'v1',reason:'Data-only binary screen fixture; no provider invocation',evidenceClass:'fixture'},extensionVersion:'binary-screen/v1'}});
   const effectId=workId+':artifact';await send({type:'admit-effect',workId,effect:{id:effectId,taskId:workId+':root',status:'pending',target:title,authority:'fixture-only'},reserve:1},'binary-executor');
   const bytes=kind==='application/pdf'?producePdf('Meeting notes\n\n1. Scope reviewed.\n2. Budget approved.\n3. Follow-up: prepare three logo drafts.'):producePng(96,32,logoPixels());
   const artifact=await artifacts.write(workId,1,kind,bytes);
   await send({type:'receipt',workId,effectId,outcome:'succeeded',receipt:'Bounded local binary file written',usage:1},'binary-executor');
   await send({type:'publish-artifact',workId,artifact},'binary-executor');
   const readback=await artifacts.readBytes(artifact),evidence=binaryArtifactText(kind,readback);
   if(!readback.equals(bytes)||!evidence.length)throw Error('Binary fixture independent readback failed');
   await send({type:'verify',workId,verdict:{id:workId+':verdict',verifierAssignmentId:workId+':verifier',artifactSha256:artifact.sha256,artifactVersion:1,criteriaVersion:baseline.criteria.version,status:'passed',evidence:[{kind:'fixture',detail:evidence,source:'binary-verifier'}]}},'binary-verifier');
   await send({type:'settle-task',workId,taskId:workId+':root',result:'Fixture bytes independently read back'},'binary-executor');
   await send({type:'accept',workId,recordId:workId+':record',artifactSnapshot:await artifacts.snapshot(artifact)});
   const state=await store.readState('intake'),work=state.snapshot!.value.works.find(w=>w.id===workId)!,record=work.record!;
   const body=await readBinaryRecordArtifact(store,artifacts,'intake',workId,{recordId:record.id,artifactVersion:artifact.version,artifactSha256:artifact.sha256,feedId:state.feedId});if(!body)throw Error('Accepted binary fixture read failed');
   const row={missionId:'intake',workId,recordId:record.id,version:artifact.version,sha256:artifact.sha256,kind,title,memberId:null,at,segment:1,turnId};
   results.push(row);fixture.routes['/missions/intake/record-binary-artifact?work='+encodeURIComponent(workId)+'&record='+encodeURIComponent(record.id)+'&version=1&sha256='+artifact.sha256]={status:200,body};
   generated.push({row,message,work:structuredClone(work)});
  }
  const state=await store.readState('intake');
  // 피드 식별자는 실제 조회 응답과 화면의 모든 현재 읽기 경계가 일치해야 합니다.
  for(const response of Object.values(fixture.routes)){const body=response.body as any;if(body&&typeof body==='object'&&typeof body.feedId==='string')body.feedId=state.feedId;}
  for(const path of ['/read-state?mission=intake','/missions/intake']){
   const packet=fixture.routes[path]?.body as any,snapshot=path.startsWith('/read-state')?packet?.snapshot:packet;
   if(snapshot?.value?.works){snapshot.value.works.push(...generated.map(g=>structuredClone(g.work)));snapshot.revision=Math.max(snapshot.revision,state.snapshot!.revision);}
  }
  const summaries=generated.map(({row})=>({missionId:'intake',missionRevision:state.snapshot!.revision,workId:row.workId,title:row.title,memberId:null,execution:'settled',acceptance:'accepted',unknown:false,started:true,startedAt:row.at,endedAt:row.at,turnId:row.turnId,segment:1}));
  const works=fixture.routes['/assistant/works']?.body as any;if(Array.isArray(works?.works))works.works.push(...structuredClone(summaries));
  for(const path of ['/assistant/conversation','/assistant/conversation?segment=1']){
   const conversation=fixture.routes[path]?.body as any;if(!conversation?.segment||conversation.segment.number!==1)continue;
   for(const [index,{row,message}] of generated.entries()){
    const work=structuredClone(summaries[index]);
    conversation.segment.messages.push(structuredClone(message));conversation.turns.push({id:row.turnId,messageId:message.id,status:'answered',displayStatus:'answered',at:row.at,proposal:{title:row.title},work});
   }
  }
  fixture.reuse.push('scripts/ui-contracts/binary-fixture.ts: BinaryArtifactStore, Application acceptance and readBinaryRecordArtifact; local fixture bytes only');
  return fixture;
 }finally{await rm(root,{recursive:true,force:true});}
}
