import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadHostStartup,createHostConnections} from '../src/host-connections.ts';
import {CONNECTION_ACTIVATION_ID,firstRouteDecision} from '../src/connection-activation.ts';
import type {ConnectionActivationState,FirstRouteFacts} from '../src/connection-activation.ts';
import {AssistantService} from '../src/assistant-service.ts';
import {AssistantConversation,assistantTurnId,ownerMessageId,segmentId} from '../src/assistant-conversation.ts';
import type {AssistantSegment} from '../src/assistant-conversation.ts';
import {ProductService} from '../src/product.ts';
import {Application} from '../src/application.ts';
import {ConnectionLifecycle} from '../src/connection-lifecycle.ts';
import {exportPortableBackup,parsePortableBackup} from '../src/portable-backup.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';
import {InMemoryHostSettings,InMemoryStore} from '../src/storage.ts';
import type {PortableJournal} from '../src/storage.ts';
import {InMemorySecretSlots} from '../src/secret-slots.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';
import type {Mission} from '../src/domain.ts';
import type {CliRunner} from '../src/cli-agent-providers.ts';

const turn=(reply:string)=>JSON.stringify({reply,work:null});
const claudeReply=turn('4');
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};
const activationState=async(store:InMemoryStore<Mission>)=>(await store.load(CONNECTION_ACTIVATION_ID))?.value as unknown as ConnectionActivationState|undefined;
function memoryJournal(store:InMemoryStore<Mission>):PortableJournal<Mission>{const operations=structuredClone(store.inspect());return {schemaVersion:2,head:operations.length,operations:[...operations]};}
type Workbench=ReturnType<Awaited<ReturnType<typeof fixture>>['host']>;
const profileProvider=(connections:Workbench,profileId?:string)=>profileId?(connections.list().runtime.connections as Array<{id:string;providerKind:string}>).find(p=>p.id===profileId)?.providerKind??null:null;
const profileForModel=(connections:Workbench,model:string)=>(connections.list().runtime.connections as Array<{id:string;model:string}>).find(p=>p.model===model)!;

async function fixture(t:test.TestContext,options:{detect?:(pt:string)=>'detected'|'absent'|'unknown'}={}){
 const root=await mkdtemp(join(tmpdir(),'c1-fix3-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new InMemoryStore<Mission>(),secrets=new InMemorySecretSlots(),settings=new InMemoryHostSettings(),artifacts=new TextArtifactStore(join(root,'artifacts'));
 const cliCalls:string[]=[];
 const cliRunner:CliRunner=async call=>{cliCalls.push(call.command);return {spawned:true,exitCode:0,stdout:JSON.stringify({type:'result',subtype:'success',is_error:false,result:claudeReply,num_turns:1,usage:{input_tokens:2,cache_creation_input_tokens:972,cache_read_input_tokens:0,output_tokens:4},modelUsage:{'claude-sonnet-5-5':{}}}),stderr:'',timedOut:false,aborted:false,overflow:false};};
 const transport=async(url:string|URL|Request)=>new Response(JSON.stringify({data:String(url).endsWith('/models')?[{id:'gpt-5'}]:[]}),{headers:{'content-type':'application/json'}});
 const startup=await loadHostStartup([]);
 let loginGate=deferred(),loginHeld=false,detect=options.detect??((pt:string)=>(pt==='claude-code-cli'?'detected' as const:'absent' as const));
 const host=(customStore:InMemoryStore<Mission>=store)=>createHostConnections(customStore,artifacts,startup,{secrets,readEnvironment:()=>undefined,transport,settings,cliRunner,loginStatus:async pt=>{if(loginHeld)await loginGate.promise;return detect(pt);}});
 return {root,store,secrets,settings,artifacts,host,cliCalls,setDetect:(fn:typeof detect)=>{detect=fn;},holdLogin:()=>{loginHeld=true;},releaseLogin:()=>{loginHeld=false;loginGate.resolve();loginGate=deferred();}};
}

test('firstRouteDecision chooses the first route at most once across all activation ways',()=>{
 const base:FirstRouteFacts={way:'first-message',messageAccepted:true,origin:'owner-typed',onConnections:[],detectedLogins:['anthropic-subscription'],routePresent:false,routeClosedByOwner:false,loginWaitingForRoute:null};
 assert.deepEqual(firstRouteDecision(base),{activate:true,connectionId:'anthropic-subscription'});
 assert.deepEqual(firstRouteDecision({...base,way:'login-started',connectionId:'anthropic-subscription'}),{activate:true,connectionId:'anthropic-subscription'});
 assert.deepEqual(firstRouteDecision({...base,way:'login-started',connectionId:'openai-subscription',onConnections:['anthropic-subscription'],routePresent:true}),{activate:false});
 assert.deepEqual(firstRouteDecision({...base,way:'login-started',connectionId:'openai-subscription',onConnections:['openai-api']}),{activate:false});
 assert.deepEqual(firstRouteDecision({...base,way:'login-started',connectionId:'openai-subscription',routeClosedByOwner:true}),{activate:false});
 assert.deepEqual(firstRouteDecision({...base,way:'key-added',connectionId:'openai-api'}),{activate:false});
 assert.deepEqual(firstRouteDecision({...base,origin:'scheduled'}),{activate:false});
 assert.deepEqual(firstRouteDecision({...base,messageAccepted:false}),{activate:false});
});

test('first route is chosen once: Claude login then Codex login keeps Claude across restarts and backup lineage',async t=>{
 const f=await fixture(t),connections=f.host();
 await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!;
 const codex=connections.list().connections.find(c=>c.providerType==='codex-cli')!;
 await connections.turnOnConnection('login:claude',claude.id,'login-started');
 const afterClaude=connections.list();
 assert.equal(afterClaude.connections.find(c=>c.id===claude.id)!.on,true);
 assert.equal(profileProvider(connections,afterClaude.representative?.route.profileId),'claude-code-cli');

 await connections.turnOnConnection('login:codex',codex.id,'login-started');
 const afterCodex=connections.list();
 assert.equal(afterCodex.connections.find(c=>c.id===codex.id)!.on,true);
 assert.equal(profileProvider(connections,afterCodex.representative?.route.profileId),'claude-code-cli');
 assert.equal((await activationState(f.store))?.routeChoice?.connectionId,claude.id);
 assert.equal((await activationState(f.store))?.routeChoice?.source,'first-route');

 // Choosing a model on a second connection via firstRepresentativeFromSelection never overwrites the existing first-route choice.
 const api=connections.list().connections.find(c=>c.providerType==='openai')!;
 await new ConnectionLifecycle(f.store,connections).replaceKey({commandId:'key-api',connectionId:api.id,expectedConfigHash:api.configHash,apiKey:'fixture-key-value'});
 await connections.save(()=>connections.selectModel(api.id,{model:'gpt-5',label:'GPT-5',expectedConfigHash:connections.list().connections.find(c=>c.id===api.id)!.configHash}));
 const apiProfile=profileForModel(connections,'gpt-5');
 assert.equal(await connections.firstRepresentativeFromSelection(apiProfile.id),false);
 assert.equal(profileProvider(connections,connections.list().representative?.route.profileId),'claude-code-cli');
 assert.equal((await activationState(f.store))?.routeChoice?.connectionId,claude.id);
 assert.equal((await activationState(f.store))?.routeChoice?.source,'first-route');

 const restarted=f.host();
 await restarted.restoreSettings();
 assert.equal(profileProvider(restarted,restarted.list().representative?.route.profileId),'claude-code-cli');
 assert.equal(restarted.list().connections.find(c=>c.id===codex.id)!.on,true);

 const ops=f.store.inspect();
 validateMissionJournalLineage(ops);
 const bundle=parsePortableBackup(await exportPortableBackup({exportJournal:async()=>memoryJournal(f.store)},f.artifacts));
 assert.ok(bundle.journal.operations.some(op=>op.aggregateId===CONNECTION_ACTIVATION_ID));
});

test('API connection turned on first prevents a later login-started from setting a Representative route',async t=>{
 const f=await fixture(t),connections=f.host();
 await connections.restoreSettings();
 const api=connections.list().connections.find(c=>c.providerType==='openai')!;
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!;

 const lifecycle=new ConnectionLifecycle(f.store,connections);
 await lifecycle.replaceKey({commandId:'key-1',connectionId:api.id,expectedConfigHash:api.configHash,apiKey:'fixture-key-value'});
 assert.equal(connections.list().connections.find(c=>c.id===api.id)!.on,true);
 assert.equal(connections.list().representative,null);

 await connections.turnOnConnection('login:claude',claude.id,'login-started');
 assert.equal(connections.list().connections.find(c=>c.id===claude.id)!.on,true);
 assert.equal(connections.list().representative,null);
 assert.equal((await activationState(f.store))?.routeChoice,null);

 const restarted=f.host();
 await restarted.restoreSettings();
 assert.equal(restarted.list().representative,null);
});

test('owner removal stays removed when another login starts later and across restarts',async t=>{
 const f=await fixture(t),connections=f.host();
 await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!;
 const codex=connections.list().connections.find(c=>c.providerType==='codex-cli')!;

 await connections.turnOnConnection('login:claude',claude.id,'login-started');
 assert.equal(profileProvider(connections,connections.list().representative?.route.profileId),'claude-code-cli');
 await connections.save(()=>connections.removeRepresentative({expectedConfigHash:connections.list().configHash}));
 assert.equal(connections.list().representative,null);

 await connections.turnOnConnection('login:codex',codex.id,'login-started');
 assert.equal(connections.list().connections.find(c=>c.id===codex.id)!.on,true);
 assert.equal(connections.list().representative,null);
 assert.equal((await activationState(f.store))?.routeChoice,null);
 assert.notEqual((await activationState(f.store))?.routeClosedAt,null);

 const restarted=f.host();
 await restarted.restoreSettings();
 assert.equal(restarted.list().representative,null);
});

test('owner selecting another connection model between firstMessageCandidate read and commit prevents activating detected subscription',async t=>{
 const f=await fixture(t);
 await new Application(f.store,[{id:'owner',roles:['owner']}]).create({id:'intake',purpose:'Intake',scope:'local',constraints:[],criteria:{version:1,description:'Intake',oracle:'fixture/v1'}},'owner','create-intake');
 const enteredCommit=deferred(),releaseCommit=deferred();
 const rawCommit=f.store.commit.bind(f.store);
 let intercepted=false;
 const storeProxy=new Proxy(f.store,{get(target,key){if(key==='commit')return async(input:Parameters<typeof target.commit>[0])=>{if(!intercepted&&input.id===segmentId(1)){intercepted=true;enteredCommit.resolve();await releaseCommit.promise;}return rawCommit(input);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const firstHost=f.host(storeProxy);
 await firstHost.restoreSettings();
 const assistant=new AssistantService(storeProxy,new ProductService(storeProxy,undefined,firstHost),firstHost);
 const secondHost=f.host();
 await secondHost.restoreSettings();
 const api=secondHost.list().connections.find(c=>c.providerType==='openai')!;
 const claude=secondHost.list().connections.find(c=>c.providerType==='claude-code-cli')!;

 const pendingSend=assistant.send({commandId:'q-race',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'},undefined,'owner-typed');
 await enteredCommit.promise;

 const lifecycle=new ConnectionLifecycle(f.store,secondHost);
 await lifecycle.replaceKey({commandId:'key-race',connectionId:api.id,expectedConfigHash:api.configHash,apiKey:'fixture-key-value'});
 await secondHost.save(()=>secondHost.selectModel(api.id,{model:'gpt-5',label:'GPT-5',expectedConfigHash:secondHost.list().connections.find(c=>c.id===api.id)!.configHash}));
 const apiProfile=profileForModel(secondHost,'gpt-5');
 assert.equal(await secondHost.firstRepresentativeFromSelection(apiProfile.id),true);

 releaseCommit.resolve();
 await pendingSend;

 const stored=await activationState(f.store);
 assert.equal(stored?.activations.some(a=>a.connectionId===claude.id),false);
 assert.equal(f.cliCalls.length,0);
 assert.equal(stored?.routeChoice?.connectionId,api.id);
 assert.equal(stored?.routeChoice?.source,'owner-choice');
 await firstHost.restoreSettings();
 assert.equal(profileProvider(firstHost,firstHost.list().representative?.route.profileId),'openai');
});

test('activateFromMessage re-evaluates fresh login detection at commit instead of trusting a stale candidate',async t=>{
 const f=await fixture(t);
 const connections=f.host();
 await connections.restoreSettings();
 const candidate=await connections.firstMessageCandidate();
 assert.ok(candidate,'expected single detected subscription candidate initially');

 const msgId=ownerMessageId('q-stale');
 const conversation=new AssistantConversation(f.store,[{id:'owner',roles:['owner']}]);
 await conversation.dispatch({segment:1,commandId:'q-stale',expectedRevision:0,actorId:'owner',command:{type:'open-assistant-segment',recordMessageTime:true,segment:1,previous:null,messageId:msgId,origin:'owner-typed',text:'Hello',turn:{status:'not_started',id:assistantTurnId(msgId),diagnostics:[{code:'assistant_route_missing',message:'No Representative route is set.'}]}}});

 // Between reading candidate and committing activation, a second login appears.
 f.setDetect(()=>'detected');
 const outcome=await connections.activateFromMessage({commandId:'q-stale',segment:1,messageId:msgId});
 assert.deepEqual(outcome,{activated:false});
 assert.equal((await activationState(f.store))?.activations.length??0,0);
 assert.equal(connections.list().representative,null);
});

test('rejected setRepresentative does not mutate CONNECTION_ACTIVATION_ID, and settings stay at version 3',async t=>{
 const f=await fixture(t);
 const connections=f.host();
 await connections.restoreSettings();
 const api=connections.list().connections.find(c=>c.providerType==='openai')!;
 const lifecycle=new ConnectionLifecycle(f.store,connections);
 await lifecycle.replaceKey({commandId:'key-v3',connectionId:api.id,expectedConfigHash:api.configHash,apiKey:'fixture-key-value'});
 await connections.save(()=>connections.selectModel(api.id,{model:'gpt-5',label:'GPT-5',expectedConfigHash:connections.list().connections.find(c=>c.id===api.id)!.configHash}));
 const apiProfile=profileForModel(connections,'gpt-5');

 await new Application(f.store,[{id:'owner',roles:['owner']}]).create({id:'intake',purpose:'Intake',scope:'local',constraints:[],criteria:{version:1,description:'Intake',oracle:'fixture/v1'}},'owner','create-intake');
 await assert.rejects(connections.save(()=>connections.setRepresentative({profileId:apiProfile.id,outputTokenCap:64,intakeMissionId:'intake',expectedConfigHash:'stale-hash'})),/Configuration changed/);
 assert.equal((await activationState(f.store))?.routeChoice??null,null);

 await connections.save(()=>connections.setRepresentative({profileId:apiProfile.id,outputTokenCap:64,intakeMissionId:'intake',expectedConfigHash:connections.list().configHash}));
 const row=[...f.settings.rows.values()][0]!;
 assert.equal((row.value as {version:number}).version,3);
 assert.equal((await activationState(f.store))?.routeChoice?.connectionId,api.id);
 assert.equal((await activationState(f.store))?.routeChoice?.source,'owner-choice');
});

test('activateFromMessage requires an existing committed owner-typed message stored on the segment',async t=>{
 const f=await fixture(t);
 const connections=f.host();
 await connections.restoreSettings();

 const uncommitted=await connections.activateFromMessage({commandId:'missing-cmd',segment:1,messageId:ownerMessageId('missing-cmd')});
 assert.deepEqual(uncommitted,{activated:false});
 assert.equal(connections.list().representative,null);

 const schedId=ownerMessageId('sched-cmd');
 const conversation=new AssistantConversation(f.store,[{id:'owner',roles:['owner']}]);
 await conversation.dispatch({segment:1,commandId:'sched-cmd',expectedRevision:0,actorId:'owner',command:{type:'open-assistant-segment',recordMessageTime:true,segment:1,previous:null,messageId:schedId,origin:'scheduled',text:'Scheduled prompt',turn:{status:'not_started',id:assistantTurnId(schedId),diagnostics:[{code:'assistant_route_missing',message:'No Representative route is set.'}]}}});
 const seg=(await f.store.load(segmentId(1)))?.value as unknown as AssistantSegment;
 assert.equal(seg.messages[0]!.origin,'scheduled');

 const fromScheduled=await connections.activateFromMessage({commandId:'sched-cmd',segment:1,messageId:schedId});
 assert.deepEqual(fromScheduled,{activated:false});
 assert.equal((await activationState(f.store))?.activations.length??0,0);
 assert.equal(connections.list().representative,null);

 const ownerId=ownerMessageId('owner-cmd');
 await conversation.dispatch({segment:1,commandId:'owner-cmd',expectedRevision:1,actorId:'owner',command:{type:'append-assistant-message',recordMessageTime:true,messageId:ownerId,origin:'owner-typed',text:'Owner prompt',turn:{status:'not_started',id:assistantTurnId(ownerId),diagnostics:[{code:'assistant_route_missing',message:'No Representative route is set.'}]}}});
 validateMissionJournalLineage(f.store.inspect());
 const bundle=parsePortableBackup(await exportPortableBackup({exportJournal:async()=>memoryJournal(f.store)},f.artifacts));
 assert.ok(bundle.journal.operations.some(op=>op.aggregateId===segmentId(1)));
});
