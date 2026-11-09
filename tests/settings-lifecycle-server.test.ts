import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {InMemoryStore} from '../src/storage.ts';
import {createWorkbench} from '../src/server.ts';
import {createHostConnections,parseHostManifest} from '../src/host-connections.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';
import {InMemorySecretSlots} from '../src/secret-slots.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';
import {Application} from '../src/application.ts';
import type {ConnectionWorkbench} from '../src/connection-workbench.ts';
import {DomainError} from '../src/domain.ts';

test('lifecycle HTTP routes retain feed admission and never return secret bytes',async t=>{
 const root=await mkdtemp(join(tmpdir(),'settings-lifecycle-http-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new InMemoryStore<any>(),secrets=new InMemorySecretSlots(),manifest=parseHostManifest({version:1,revision:'fixture',mode:'https',connections:[{id:'api',label:'API',providerType:'openai',baseUrl:'https://api.openai.com/v1/',models:['fixture'],credential:{ref:'fixture-key',slot:'api-key'}}]});
 let writes=0;const set=secrets.set.bind(secrets);secrets.set=async(slot,value)=>{writes++;await set(slot,value);};
 const connections=createHostConnections(store,new TextArtifactStore(root),{manifest,allowLiveExecution:false},{secrets,readEnvironment:()=>{throw Error('No environment access');},transport:async()=>{throw Error('No network');}}),server=createWorkbench(store,root,{connections,scheduleIntervalMs:0});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.drain());const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const request=(path:string,body?:unknown,feed?:string)=>fetch(origin+path,body?{method:'POST',headers:{'Content-Type':'application/json',...(feed?{'X-Massion-Feed':feed}:{})},body:JSON.stringify(body)}:undefined);
 for(const path of ['/assistant/members','/assistant/devices','/connections/lifecycle']){const response=await request(path);assert.equal(response.status,200,path);assert.equal(typeof (await response.json()).feedId,'string');}
 const target=connections.list().connections[0]!,path='/connections/'+encodeURIComponent(target.id)+'/key',hash=target.configHash,body={commandId:'replace',expectedConfigHash:hash,apiKey:'fixture-http-secret'},old=await request(path,body,'old-feed');assert.equal(old.status,409);assert.equal(writes,0);
 const response=await request(path,body);const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));assert.equal(result.status,'completed');assert.equal(writes,1);
 assert.doesNotMatch(JSON.stringify([result,await (await request('/connections/lifecycle')).json(),store.inspect()]),/fixture-http-secret/);
 await request(path,body);assert.equal(writes,1);validateMissionJournalLineage(store.inspect());
 const replace=connections.replaceKey.bind(connections);connections.replaceKey=async()=>{throw new DomainError('Active conversation prevents this key write','conflict');};
 const refusedKey=await request(path,{...body,commandId:'refused-key'}),refusal=await refusedKey.json();assert.equal(refusedKey.status,409);assert.equal(refusal.outcome,'rejected');assert.equal(writes,1);
 connections.replaceKey=replace;assert.equal((await request(path,{...body,commandId:'deliberate-new-key'})).status,200);assert.equal(writes,2);validateMissionJournalLineage(store.inspect());
 const refused=await request('/assistant/devices',{commandId:'unknown-device',deviceId:'unknown',action:'connect'});assert.equal(refused.status,403);
});

test('remote device HTTP commands retain the external-member decision and never replay its uncertain Work',async t=>{
 const root=await mkdtemp(join(tmpdir(),'settings-device-http-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new InMemoryStore<any>(),app=new Application(store,[{id:'local-owner',roles:['owner']}]);
 await app.create({id:'intake',purpose:'Remote fixture',scope:'fixture',constraints:[],criteria:{version:1,description:'Check independently',oracle:'fixture/v1'}},'local-owner','create-device-intake');
 await app.dispatch({missionId:'intake',commandId:'admit-device-work',expectedRevision:1,actorId:'local-owner',command:{type:'admit-work',workId:'remote',title:'Read repository',budget:8}});
 await app.dispatch({missionId:'intake',commandId:'assign-device-work',expectedRevision:2,actorId:'local-owner',command:{type:'assign',workId:'remote',assignment:{id:'remote:executor',taskId:'remote:root',role:'executor',actorId:'executor',model:{provider:'fixture',model:'none',configVersion:'v1',reason:'Device HTTP fixture',evidenceClass:'fixture'},extensionVersion:'v1'}}});
 let deliveries=0,connects=0,connected=false;
 const connections={list:()=>({representative:{intakeMissionId:'intake'}})} as unknown as ConnectionWorkbench;
 const server=createWorkbench(store,root,{connections,scheduleIntervalMs:0,effectAdapters:[{id:'remote-adapter',kind:'external-member',async send(input){deliveries++;return {idempotencyKey:input.idempotencyKey,remoteId:'arrival',outcome:'received',detail:'Arrival only'};}}],deviceAdapters:[{id:'remote-adapter',async inspect(){return {status:connected?'connected':'offline'};},async connect(){connects++;connected=true;return {status:'connected'};},async disconnect(){connected=false;return {status:'offline'};}}]});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.drain());const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 await server.effectDecisions.propose({missionId:'intake',workId:'remote',taskId:'remote:root',stepId:'handoff',request:{kind:'external-member',adapterId:'remote-adapter',deviceId:'laptop',deviceName:'Laptop',agentId:'codex',agentName:'Codex',instruction:'Read repository',scope:'fixture repository'}});
 const decisionId=(await server.effectDecisions.decisions())[0]!.id,post=(path:string,body:unknown)=>fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await post('/assistant/devices',{commandId:'early-connect',deviceId:'laptop',action:'connect'})).status,403);
 assert.equal((await post('/assistant/decisions',{commandId:'approve-remote',decisionId,answer:'act'})).status,200);assert.equal(deliveries,1);
 const input={commandId:'connect-laptop',deviceId:'laptop',action:'connect'},responses=await Promise.all([post('/assistant/devices',input),post('/assistant/devices',input)]);assert.ok(responses.every(r=>r.status===200));assert.equal(connects,1);
 assert.equal((await (await fetch(origin+'/assistant/devices')).json()).devices[0].status,'connected');
 assert.equal((await post('/assistant/devices',{commandId:'disconnect-laptop',deviceId:'laptop',action:'disconnect'})).status,200);assert.equal(connected,false);
 assert.equal(deliveries,1);assert.equal((await store.load('intake'))!.value.works[0].effects[0].status,'unknown');validateMissionJournalLineage(store.inspect());
});
