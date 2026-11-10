import {InMemoryStore} from '../../src/storage.ts';
import {InMemorySecretSlots} from '../../src/secret-slots.ts';
import {TextArtifactStore} from '../../src/text-artifacts.ts';
import {createHostConnections,parseHostManifest} from '../../src/host-connections.ts';
import {ProductService} from '../../src/product.ts';
import {ProviderRegistry} from '../../src/providers.ts';
import {TEXT_REVIEW_ORACLE} from '../../src/configured-runtime.ts';
import {ConnectionLifecycle} from '../../src/connection-lifecycle.ts';
import {validateMissionJournalLineage} from '../../src/backup-lineage.ts';
import type {Mission} from '../../src/domain.ts';
import type {ScreenFixture} from './fixture-host.ts';

/** The credential card comes from an actual rejected provider stage; background captures stay intact. */
export async function credentialRepairFixture(template:ScreenFixture):Promise<ScreenFixture>{
 const fixture=structuredClone(template),conversation=fixture.routes['/assistant/conversation']!.body as any;
 const prior=conversation.turns.find((t:any)=>t.work?.memberId==='member-quill'&&t.work.acceptance==='failed')?.work;if(!prior)throw Error('Credential fixture Work missing');
 const store=new InMemoryStore<Mission>(),secrets=new InMemorySecretSlots();
 const manifest=parseHostManifest({version:1,revision:'credential-fixture',mode:'https',connections:[{id:'zai',label:'Z.ai',providerType:'zai',baseUrl:'https://api.z.ai/api/coding/paas/v4/',models:['glm-fixture'],credential:{ref:'fixture-key',slot:'api-key'}}]});
 await secrets.set({owner:'zai',slot:'api-key'},'fixture-only-key');
 const connections=createHostConnections(store,new TextArtifactStore('/fixture-artifacts'),{manifest,allowLiveExecution:true},{secrets,readEnvironment:()=>{throw Error('No fixture environment credentials');},transport:async()=>Response.json({error:{code:'1003',message:'Fixture token expired'}},{status:401})});
 const profile=(connections.configuration() as any).connections[0];connections.authorize({id:'fixture-grant',scope:'fixture',executorProfileId:profile.id,verifierProfileId:profile.id,maxOutputTokensPerCall:32,expectedConfigHash:connections.list().configHash});
 const product=new ProductService(store,new ProviderRegistry(),connections),missionId=prior.missionId,workId=prior.workId;
 await product.create({id:missionId,purpose:'Credential repair fixture',scope:'fixture',constraints:[],criteria:{version:1,description:'Checked result',oracle:TEXT_REVIEW_ORACLE}},'fixture-create');
 await product.admit(missionId,{commandId:'fixture-admit',expectedRevision:1,workId,title:prior.title,budget:128});
 const running=product.run(missionId,workId,'fixture-credential-run',2,{executorProfileId:profile.id,verifierProfileId:profile.id,authorizationId:'fixture-grant',outputTokenCap:32});void running.catch(()=>{});
 try{
  const deadline=Date.now()+3000;while(!connections.canRetryCredential(missionId,workId,'fixture-credential-run:executor')){if(Date.now()>deadline)throw Error('Credential fixture did not pause');await new Promise(r=>setImmediate(r));}
  const snapshot=(await store.load(missionId))!,work=snapshot.value.works[0]!,credentialRepair={...work.blocker!.credential!,canRetry:true};
  validateMissionJournalLineage(store.inspect());
  for(const [path,response] of Object.entries(fixture.routes)){
   const body=response.body as any;
   if(path.startsWith('/assistant/conversation'))for(const turn of body.turns??[])if(turn.work?.workId===workId)turn.work={...turn.work,missionRevision:snapshot.revision,execution:work.execution,acceptance:work.acceptance,credentialRepair};
   if(path==='/assistant/works')for(const row of body.works??[])if(row.workId===workId)Object.assign(row,{missionRevision:snapshot.revision,execution:work.execution,acceptance:work.acceptance,credentialRepair});
   if(path==='/missions/'+missionId){const index=body.value.works.findIndex((w:any)=>w.id===workId);if(index>=0)body.value.works[index]=work;body.revision=snapshot.revision;}
  }
  fixture.routes['/connections']={status:200,body:connections.list()};fixture.routes['/connections/lifecycle']={status:200,body:{...await new ConnectionLifecycle(store,connections).read(),feedId:conversation.feedId}};
  fixture.steps=[];fixture.readySelector='.chat-exception';
  fixture.description='Provider-confirmed Z.ai token expiry and exact Work connection repair controls.';
  fixture.gaps=[];
  return fixture;
 }finally{connections.beginDrain();await running;}
}
