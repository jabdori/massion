import {Application} from '../../src/application.ts';
import {InMemoryStore} from '../../src/storage.ts';
import {InMemorySecretSlots} from '../../src/secret-slots.ts';
import {TextArtifactStore} from '../../src/text-artifacts.ts';
import {createHostConnections,parseHostManifest} from '../../src/host-connections.ts';
import {MODEL_PROVIDER_TYPES,isCliProvider} from '../../src/connection-workbench.ts';
import {ConnectionLifecycle} from '../../src/connection-lifecycle.ts';
import {EffectDecisionsService} from '../../src/effect-decisions.ts';
import {DevicesService} from '../../src/devices.ts';
import {validateMissionJournalLineage} from '../../src/backup-lineage.ts';
import type {DeviceAdapter} from '../../src/devices.ts';
import type {Mission} from '../../src/domain.ts';
import type {ScreenFixture} from './fixture-host.ts';

export const CONNECTION_SCREENS=['B14','B14-expired','B14-restart','B14-update'];
/** Background fixtures remain; new lifecycle facts are actual command/read projections. */
export async function settingsLifecycleFixture(template:ScreenFixture):Promise<ScreenFixture>{
 const fixture=structuredClone(template),feedId=(fixture.routes['/assistant/conversation']!.body as {feedId:string}).feedId;
 if(CONNECTION_SCREENS.includes(fixture.screen)){
  const prior=fixture.routes['/connections']!.body as any,store=new InMemoryStore<any>(),secrets=new InMemorySecretSlots();
  const manifest=parseHostManifest({version:1,revision:'settings-fixture',mode:'https',connections:prior.connections.map((c:any)=>({id:c.id,label:c.label,providerType:c.providerType,baseUrl:MODEL_PROVIDER_TYPES.find(p=>p.id===c.providerType)!.baseUrl,models:[c.providerType==='claude-code-cli'?'claude-sonnet-5-5':c.providerType==='codex-cli'?'gpt-6.1-terra':'fixture'],...(!isCliProvider(c.providerType)?{credential:{ref:'credential-'+c.id,slot:'api-key'}}:{})}))});
  const connections=createHostConnections(store,new TextArtifactStore('/fixture-artifacts'),{manifest,allowLiveExecution:false},{secrets,readEnvironment:()=>{throw Error('Fixture environment is unavailable');},transport:async()=>{throw Error('Fixture network is unavailable');}});
  const service=new ConnectionLifecycle(store,connections,{clock:()=>fixture.now,observe:async target=>({status:fixture.screen==='B14-expired'&&target.providerType==='zai'?'expired':'detected',restart:fixture.screen==='B14-restart'&&isCliProvider(target.providerType)?'required':'not-required',update:fixture.screen==='B14-update'&&isCliProvider(target.providerType)?'available':'current',source:'host'})});
  const targets=connections.list().connections;
  for(const target of targets){const original=prior.connections.find((c:any)=>target.label===c.label);if(!isCliProvider(target.providerType)&&original?.credentialConfigured)await service.replaceKey({commandId:'fixture-key-'+original.id,connectionId:target.id,expectedConfigHash:target.configHash,apiKey:'fixture-secret'});await service.recheck({commandId:'fixture-check-'+original.id,connectionId:target.id,expectedConfigHash:target.configHash});}
  validateMissionJournalLineage(store.inspect());fixture.routes['/connections']={status:200,body:{...prior,connections:targets}};
  fixture.routes['/connections/lifecycle']={status:200,body:{...await service.read(),feedId}};
  fixture.gaps=fixture.screen==='B14-restart'?['A trusted host produces restart-required state; no restart executor is installed.']:[];
  return fixture;
 }
 if(fixture.screen!=='B13-devices')return fixture;
 const store=new InMemoryStore<Mission>(),app=new Application(store,[{id:'local-owner',roles:['owner']}],()=>fixture.now),effects=new EffectDecisionsService(store,store,()=>'intake',{clock:()=>fixture.now,adapters:[{id:'fixture-device',kind:'external-member',async send(input){return {idempotencyKey:input.idempotencyKey,remoteId:'arrival-'+input.request.adapterId,outcome:'received',detail:'Fixture arrival only'};}}]});
 await app.create({id:'intake',purpose:'Device admission',scope:'fixture',constraints:[],criteria:{version:1,description:'Independent check',oracle:'fixture/v1'}},'local-owner','device-fixture-create');
 const rows=[{id:'laptop',name:'내 노트북',agent:'Claude Code',status:'connected' as const},{id:'workstation',name:'작업실 PC',agent:'Codex',status:'offline' as const}];
 for(const row of rows){await app.dispatch({missionId:'intake',commandId:'device-work-'+row.id,expectedRevision:(await store.load('intake'))!.revision,actorId:'local-owner',command:{type:'admit-work',workId:row.id,title:'기기에서 저장소 확인',budget:8}});await app.dispatch({missionId:'intake',commandId:'device-assign-'+row.id,expectedRevision:(await store.load('intake'))!.revision,actorId:'local-owner',command:{type:'assign',workId:row.id,assignment:{id:row.id+':executor',taskId:row.id+':root',role:'executor',actorId:'executor',model:{provider:'fixture',model:'none',configVersion:'v1',reason:'Data-only device fixture',evidenceClass:'fixture'},extensionVersion:'v1'}}});
  await effects.propose({missionId:'intake',workId:row.id,taskId:row.id+':root',stepId:'handoff',request:{kind:'external-member',adapterId:'fixture-device',deviceId:row.id,deviceName:row.name,agentId:row.id+'-agent',agentName:row.agent,instruction:'Read the repository',scope:'fixture repository'}});const decision=(await effects.decisions()).find(d=>d.effect.workId===row.id)!;await effects.decide({commandId:'device-admit-'+row.id,decisionId:decision.id,answer:'act'});
 }
 const adapter:DeviceAdapter={id:'fixture-device',async inspect(input){return {status:rows.find(r=>r.id===input.deviceId)!.status};},async connect(){return {status:'connected'};},async disconnect(){return {status:'offline'};}};
 const devices=new DevicesService(store,store,()=>effects.decisions(),[adapter]);validateMissionJournalLineage(store.inspect());fixture.routes['/assistant/devices']={status:200,body:{feedId,...await devices.read()}};return fixture;
}
