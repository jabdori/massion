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
import {DomainError,hash as valueHash} from '../src/domain.ts';
import {APPS_ID} from '../src/apps.ts';
import {MEMBERS_ID,MembersService,applyMembers,PROPOSAL_PREFIX,proposalDecisionId,admittedMemberId} from '../src/members.ts';
import {ASSISTANT_ACTOR_ID} from '../src/assistant-conversation.ts';
import {DEVICES_ID} from '../src/devices.ts';
import {LoginConnections} from '../src/connection-logins.ts';

test('lifecycle HTTP routes retain feed admission and never return secret bytes',async t=>{
 const root=await mkdtemp(join(tmpdir(),'settings-lifecycle-http-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new InMemoryStore<any>(),secrets=new InMemorySecretSlots(),manifest=parseHostManifest({version:1,revision:'fixture',mode:'https',connections:[{id:'api',label:'API',providerType:'openai',baseUrl:'https://api.openai.com/v1/',models:['fixture'],credential:{ref:'fixture-key',slot:'api-key'}}]});
 let writes=0;const set=secrets.set.bind(secrets);secrets.set=async(slot,value)=>{writes++;await set(slot,value);};
 const connections=createHostConnections(store,new TextArtifactStore(root),{manifest,allowLiveExecution:false},{secrets,readEnvironment:()=>{throw Error('No environment access');},transport:async()=>{throw Error('No network');}}),server=createWorkbench(store,root,{connections,scheduleIntervalMs:0});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.drain());const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const request=(path:string,body?:unknown,feed?:string)=>fetch(origin+path,body?{method:'POST',headers:{'Content-Type':'application/json',...(feed?{'X-Massion-Feed':feed}:{})},body:JSON.stringify(body)}:undefined);
 for(const path of ['/assistant/members','/assistant/devices','/connections/lifecycle','/assistant/members?commandId=unknown-archive&memberId=member-fixture&action=archive']){const response=await request(path);assert.equal(response.status,200,path);assert.equal(typeof (await response.json()).feedId,'string');}
 assert.equal((await request('/assistant/members?commandId=x&commandId=y&action=archive')).status,400);
 const target=connections.list().connections[0]!,path='/connections/'+encodeURIComponent(target.id)+'/key',hash=target.configHash,body={commandId:'replace',expectedConfigHash:hash,apiKey:'fixture-http-secret'},old=await request(path,body,'old-feed');assert.equal(old.status,409);assert.equal(writes,0);
 const response=await request(path,body);const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));assert.equal(result.status,'completed');assert.equal(writes,1);
 const receiptInput={commandId:body.commandId,connectionId:target.id,expectedConfigHash:hash,kind:'replace-key'},receipt=await request('/connections/lifecycle?'+new URLSearchParams(receiptInput));assert.equal(receipt.status,200);assert.equal((await receipt.json()).status,'settled');
 const mismatched=await request('/connections/lifecycle?'+new URLSearchParams({...receiptInput,expectedConfigHash:'0'.repeat(64)}));assert.equal((await mismatched.json()).status,'conflict');assert.equal(writes,1);
 assert.equal((await request('/connections/lifecycle?'+new URLSearchParams({...receiptInput,apiKey:'must-not-be-accepted'}))).status,400);
 assert.doesNotMatch(JSON.stringify([result,await (await request('/connections/lifecycle')).json(),store.inspect()]),/fixture-http-secret/);
 await request(path,body);assert.equal(writes,1);validateMissionJournalLineage(store.inspect());
 const replace=connections.replaceKey.bind(connections);connections.replaceKey=async()=>{throw new DomainError('Active conversation prevents this key write','conflict');};
 const refusedKey=await request(path,{...body,commandId:'refused-key'}),refusal=await refusedKey.json();assert.equal(refusedKey.status,409);assert.equal(refusal.outcome,'rejected');assert.equal(writes,1);
 connections.replaceKey=replace;assert.equal((await request(path,{...body,commandId:'deliberate-new-key'})).status,200);assert.equal(writes,2);validateMissionJournalLineage(store.inspect());
 const refused=await request('/assistant/devices',{commandId:'unknown-device',deviceId:'unknown',action:'connect'});assert.equal(refused.status,403);
 const proposalId=PROPOSAL_PREFIX+'http-refusal',decisionId=proposalDecisionId(proposalId),actor={id:ASSISTANT_ACTOR_ID,roles:['assistant' as const]},command={type:'propose-member' as const,decisionId,topic:'분석',works:[{title:'First'},{title:'Second'}],count:2};
 await store.commit({id:MEMBERS_ID,expectedRevision:0,commandId:proposalId,fingerprint:valueHash({actorId:actor.id,command}),...applyMembers(null,command,actor,{observedAt:1}),outbox:[]});
 const members=new MembersService(store,()=>undefined);await members.decide({commandId:'admit-http',decisionId,answer:'act',member:{name:'하람',shape:'round'}});const memberId=admittedMemberId('admit-http');
 assert.equal((await request('/assistant/members',{commandId:'archive-other-tab',memberId,action:'archive'})).status,200);
 const stale=await request('/assistant/members',{commandId:'archive-stale-tab',memberId,action:'archive'});assert.equal(stale.status,409);assert.equal((await stale.json()).outcome,'rejected');
 assert.equal((await request('/assistant/members',{commandId:'restore-after-refusal',memberId,action:'unarchive'})).status,200);validateMissionJournalLineage(store.inspect());
});

test('remote device HTTP commands retain the external-member decision and never replay its uncertain Work',async t=>{
 const root=await mkdtemp(join(tmpdir(),'settings-device-http-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new InMemoryStore<any>(),app=new Application(store,[{id:'local-owner',roles:['owner']}]);
 await app.create({id:'intake',purpose:'Remote fixture',scope:'fixture',constraints:[],criteria:{version:1,description:'Check independently',oracle:'fixture/v1'}},'local-owner','create-device-intake');
 await app.dispatch({missionId:'intake',commandId:'admit-device-work',expectedRevision:1,actorId:'local-owner',command:{type:'admit-work',workId:'remote',title:'Read repository',budget:8}});
 await app.dispatch({missionId:'intake',commandId:'assign-device-work',expectedRevision:2,actorId:'local-owner',command:{type:'assign',workId:'remote',assignment:{id:'remote:executor',taskId:'remote:root',role:'executor',actorId:'executor',model:{provider:'fixture',model:'none',configVersion:'v1',reason:'Device HTTP fixture',evidenceClass:'fixture'},extensionVersion:'v1'}}});
 let deliveries=0,connects=0,connected=false,connectStarted:(()=>void)|undefined,heldConnect:Promise<void>|undefined,releaseLogin!:()=>void,startLogin!:()=>void;
 const loginStarted=new Promise<void>(resolve=>startLogin=resolve),loginHeld=new Promise<void>(resolve=>releaseLogin=resolve),logins=new LoginConnections(async()=>{startLogin();await loginHeld;return {spawned:true,exitCode:null,stdout:'',stderr:'',aborted:true,timedOut:false,overflow:false};});t.after(()=>releaseLogin());
 let intakeMissionId='intake';const connections={list:()=>({representative:{intakeMissionId}})} as unknown as ConnectionWorkbench;
 const server=createWorkbench(store,root,{connections,logins,scheduleIntervalMs:0,effectAdapters:[{id:'remote-adapter',kind:'external-member',async send(input){deliveries++;return {idempotencyKey:input.idempotencyKey,remoteId:'arrival',outcome:'received',detail:'Arrival only'};}}],deviceAdapters:[{id:'remote-adapter',async inspect(){return {status:connected?'connected':'offline'};},async connect(){connects++;connectStarted?.();await heldConnect;connected=true;return {status:'connected'};},async disconnect(){connected=false;return {status:'offline'};}}]});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.drain());const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 await server.effectDecisions.propose({missionId:'intake',workId:'remote',taskId:'remote:root',stepId:'handoff',request:{kind:'external-member',adapterId:'remote-adapter',deviceId:'laptop',deviceName:'Laptop',agentId:'codex',agentName:'Codex',instruction:'Read repository',scope:'fixture repository'}});
 const decisionId=(await server.effectDecisions.decisions())[0]!.id,post=(path:string,body:unknown)=>fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await post('/assistant/devices',{commandId:'early-connect',deviceId:'laptop',action:'connect'})).status,403);
 assert.equal((await post('/assistant/decisions',{commandId:'approve-remote',decisionId,answer:'act'})).status,200);assert.equal(deliveries,1);
 const input={commandId:'connect-laptop',deviceId:'laptop',action:'connect'};let initialRelease!:()=>void;const initialReady=new Promise<void>(r=>connectStarted=r);heldConnect=new Promise<void>(r=>initialRelease=r);
 const connecting=post('/assistant/devices',input);await initialReady;
 try{const refused=await post('/assistant/devices',{...input,commandId:'other-tab-connect'});assert.equal(refused.status,409);assert.equal((await refused.json()).outcome,'rejected');}finally{initialRelease();}
 assert.equal((await connecting).status,200);heldConnect=undefined;connectStarted=undefined;
 const refusedReceipt=await (await fetch(origin+'/assistant/devices?'+new URLSearchParams({...input,commandId:'other-tab-connect'}))).json();assert.equal(refusedReceipt.status,'unknown');
 const responses=await Promise.all([post('/assistant/devices',input),post('/assistant/devices',input)]);assert.ok(responses.every(r=>r.status===200));assert.equal(connects,1);
 const receipt=await fetch(origin+'/assistant/devices?'+new URLSearchParams(input));assert.equal(receipt.status,200);assert.equal((await receipt.json()).status,'settled');
 const mismatch=await (await fetch(origin+'/assistant/devices?'+new URLSearchParams({...input,action:'disconnect'}))).json();assert.equal(mismatch.status,'conflict');assert.equal(connects,1);
 assert.equal((await (await fetch(origin+'/assistant/devices')).json()).devices[0].status,'connected');
 await app.dispatch({missionId:'intake',commandId:'admit-next-device-work',expectedRevision:(await store.load('intake'))!.revision,actorId:'local-owner',command:{type:'admit-work',workId:'next-remote',title:'Another remote request',budget:8}});
 await app.dispatch({missionId:'intake',commandId:'assign-next-device-work',expectedRevision:(await store.load('intake'))!.revision,actorId:'local-owner',command:{type:'assign',workId:'next-remote',assignment:{id:'next-remote:executor',taskId:'next-remote:root',role:'executor',actorId:'executor',model:{provider:'fixture',model:'none',configVersion:'v1',reason:'Pending device fixture',evidenceClass:'fixture'},extensionVersion:'v1'}}});
 await server.effectDecisions.propose({missionId:'intake',workId:'next-remote',taskId:'next-remote:root',stepId:'handoff',request:{kind:'external-member',adapterId:'unapproved-adapter',deviceId:'laptop',deviceName:'Pending target',agentId:'other-agent',agentName:'Other agent',instruction:'Another request',scope:'another repository'}});
 const known=(await (await fetch(origin+'/assistant/devices')).json()).devices[0];assert.equal(known.admitted,true);assert.equal(known.decisionId,decisionId);assert.equal(known.agent,'Codex');
 intakeMissionId='replacement-intake';await app.create({id:intakeMissionId,purpose:'Replacement intake',scope:'fixture',constraints:[],criteria:{version:1,description:'Check independently',oracle:'fixture/v1'}},'local-owner','create-replacement-intake');
 const retained=(await (await fetch(origin+'/assistant/devices')).json()).devices[0];assert.equal(retained?.id,'laptop');assert.equal(retained?.admitted,true);assert.equal(retained?.decisionId,decisionId);
 assert.equal((await post('/assistant/devices',{commandId:'disconnect-laptop',deviceId:'laptop',action:'disconnect'})).status,200);assert.equal(connected,false);
 assert.equal(deliveries,1);assert.equal((await store.load('intake'))!.value.works[0].effects[0].status,'unknown');validateMissionJournalLineage(store.inspect());
 let release!:()=>void;const started=new Promise<void>(resolve=>{connectStarted=resolve;});heldConnect=new Promise<void>(resolve=>{release=resolve;});t.after(()=>release());
 const pending=post('/assistant/devices',{commandId:'connect-during-drain',deviceId:'laptop',action:'connect'});await started;
 const loginResponse=logins.recheck('codex-cli');await loginStarted;let drainFinished=false;const draining=server.drain().then(result=>{drainFinished=true;return result;});release();assert.equal((await pending).status,200);
 await new Promise(resolve=>setTimeout(resolve,30));assert.equal(drainFinished,false,'a rejected device drain must still wait for the login runner');releaseLogin();await loginResponse;
 assert.deepEqual(await draining,{status:'unsettled',timedOut:false});validateMissionJournalLineage(store.inspect());
});

test('shutdown reports an unconfirmed key write as unsettled instead of drained',{timeout:3000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'settings-key-drain-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new InMemoryStore<any>(),secrets=new InMemorySecretSlots(),set=secrets.set.bind(secrets);let start!:()=>void,release!:()=>void,writes=0;const started=new Promise<void>(resolve=>{start=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
 secrets.set=async(slot,key)=>{start();await held;writes++;await set(slot,key);};t.after(()=>release());
 const manifest=parseHostManifest({version:1,revision:'drain-fixture',mode:'https',connections:[{id:'api',label:'API',providerType:'openai',baseUrl:'https://api.openai.com/v1/',models:['fixture'],credential:{ref:'fixture-key',slot:'api-key'}}]}),connections=createHostConnections(store,new TextArtifactStore(root),{manifest,allowLiveExecution:false},{secrets,readEnvironment:()=>undefined,transport:async()=>{throw Error('No network');}}),server=createWorkbench(store,root,{connections,scheduleIntervalMs:0});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.drain());const origin='http://127.0.0.1:'+(server.address() as {port:number}).port,target=connections.list().connections[0]!;
 const pending=fetch(origin+'/connections/'+encodeURIComponent(target.id)+'/key',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({commandId:'write-before-drain',expectedConfigHash:target.configHash,apiKey:'drain-fixture-key'})});
 await started;const draining=server.drain();release();assert.equal((await (await pending).json()).status,'unknown');assert.equal(writes,1);assert.deepEqual(await draining,{status:'unsettled',timedOut:false});
 assert.ok(store.inspect().some(o=>o.value.kind==='connection-lifecycle'&&o.value.attempts.some((a:any)=>a.commandId==='write-before-drain'&&a.status==='pending')));assert.doesNotMatch(JSON.stringify(store.inspect()),/drain-fixture-key/);
});

test('app and member receipt reads cannot label replacement-database state with their original HTTP feed',async t=>{
 const root=await mkdtemp(join(tmpdir(),'settings-app-feed-'));t.after(()=>rm(root,{recursive:true,force:true}));const original=new InMemoryStore<any>(),replacement=new InMemoryStore<any>();let active=original,armed=false,flipLookup=false,flipDevice=false;
 const store=new Proxy(original,{get(_target,key){if(key==='load')return async(id:string)=>{if(flipDevice&&id===DEVICES_ID){active=replacement;flipDevice=false;}return active.load(id);};if(key==='lookupOperation')return async(input:any)=>{if(flipLookup){active=replacement;flipLookup=false;}return active.lookupOperation(input);};if(key==='readState')return async(id?:string)=>{if(armed&&id===APPS_ID){active=replacement;armed=false;}return active.readState(id);};const result=Reflect.get(active,key);return typeof result==='function'?result.bind(active):result;}}),server=createWorkbench(store,root,{scheduleIntervalMs:0});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.drain());armed=true;const response=await fetch('http://127.0.0.1:'+(server.address() as {port:number}).port+'/assistant/apps'),body=await response.json();assert.equal(response.status,503);assert.equal(body.reason,'feed');assert.equal(body.apps,undefined);
 active=original;flipLookup=true;const receipt=await fetch('http://127.0.0.1:'+(server.address() as {port:number}).port+'/assistant/members?commandId=lost-archive&action=archive&memberId=member-fixture');assert.equal(receipt.status,503);assert.equal((await receipt.json()).reason,'feed');
 active=original;flipDevice=true;const device=await fetch('http://127.0.0.1:'+(server.address() as {port:number}).port+'/assistant/devices?commandId=lost-connect&action=connect&deviceId=device-fixture');assert.equal(device.status,503);assert.equal((await device.json()).reason,'feed');
});
