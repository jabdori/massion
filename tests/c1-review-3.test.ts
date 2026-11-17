import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadHostStartup,createHostConnections} from '../src/host-connections.ts';
import {CONNECTION_ACTIVATION_ID,activationState as parseActivationState,applyActivation,firstRouteDecision,replayConnectionActivation} from '../src/connection-activation.ts';
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
import type {Operation,PortableJournal} from '../src/storage.ts';
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
 const host=(customStore:InMemoryStore<Mission>=store,customSettings:InMemoryHostSettings=settings)=>createHostConnections(customStore,artifacts,startup,{secrets,readEnvironment:()=>undefined,transport,settings:customSettings,cliRunner,loginStatus:async pt=>{if(loginHeld)await loginGate.promise;return detect(pt);}});
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

 // Between reading candidate and committing activation, the login disappears; the fresh read at commit, not the stale candidate, decides.
 f.setDetect(()=>'absent');
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
 assert.equal((row.value as {version:number;representative:unknown}).version,3);
 assert.equal((row.value as {version:number;representative:unknown}).representative,null);
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
 const fromOwner=await connections.activateFromMessage({commandId:'owner-cmd',segment:1,messageId:ownerId});
 assert.deepEqual(fromOwner,{activated:true});
 const afterFirst=await activationState(f.store);
 assert.equal(afterFirst?.activations.length,1);
 assert.equal(afterFirst?.routeChoice?.source,'first-route');
 const opsBeforeReplay=f.store.inspect().filter(op=>op.aggregateId===CONNECTION_ACTIVATION_ID).length;
 assert.equal(opsBeforeReplay,1);

 // Replaying activateFromMessage with the same commandId must not activate twice or add duplicate entries.
 const replayed=await connections.activateFromMessage({commandId:'owner-cmd',segment:1,messageId:ownerId});
 assert.deepEqual(replayed,{activated:false});
 assert.equal(f.store.inspect().filter(op=>op.aggregateId===CONNECTION_ACTIVATION_ID).length,1);
 assert.deepEqual(await activationState(f.store),afterFirst);

 validateMissionJournalLineage(f.store.inspect());
 const bundle=parsePortableBackup(await exportPortableBackup({exportJournal:async()=>memoryJournal(f.store)},f.artifacts));
 assert.ok(bundle.journal.operations.some(op=>op.aggregateId===segmentId(1)));
});

test('C1-fix-4 Test 1: failed removeRepresentative leaves explicit route unchanged; committed removal stays gone across restart, login, and first message',async t=>{
 const f=await fixture(t);
 await new Application(f.store,[{id:'owner',roles:['owner']}]).create({id:'intake',purpose:'Intake',scope:'local',constraints:[],criteria:{version:1,description:'Intake',oracle:'fixture/v1'}},'owner','create-intake');
 let failNextActivationCommit=false;
 const rawCommit=f.store.commit.bind(f.store);
 const storeProxy=new Proxy(f.store,{get(target,key){if(key==='commit')return async(input:Parameters<typeof target.commit>[0])=>{if(failNextActivationCommit&&input.id===CONNECTION_ACTIVATION_ID){failNextActivationCommit=false;return {status:'conflict' as const,reason:'revision' as const,actualRevision:input.expectedRevision+1};}return rawCommit(input);};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});

 const connections=f.host(storeProxy);
 await connections.restoreSettings();
 const api=connections.list().connections.find(c=>c.providerType==='openai')!;
 await new ConnectionLifecycle(f.store,connections).replaceKey({commandId:'key-rm',connectionId:api.id,expectedConfigHash:api.configHash,apiKey:'fixture-key-value'});
 await connections.save(()=>connections.selectModel(api.id,{model:'gpt-5',label:'GPT-5',expectedConfigHash:connections.list().connections.find(c=>c.id===api.id)!.configHash}));
 const apiProfile=profileForModel(connections,'gpt-5');

 await connections.setRepresentative({profileId:apiProfile.id,outputTokenCap:64,intakeMissionId:'intake',expectedConfigHash:connections.list().configHash});
 const explicitBefore=structuredClone(connections.list().representative);
 assert.equal(explicitBefore?.route.profileId,apiProfile.id);

 // Commit failure/conflict during removal keeps the explicit route unchanged in both store and memory.
 failNextActivationCommit=true;
 await assert.rejects(connections.removeRepresentative({expectedConfigHash:connections.list().configHash}),/changed elsewhere/i);
 assert.deepEqual(connections.list().representative,explicitBefore);
 assert.equal((await activationState(f.store))?.routeChoice?.profileId,apiProfile.id);
 assert.equal((await activationState(f.store))?.routeClosedAt,null);

 // Successful removal clears the route atomically in CONNECTION_ACTIVATION_ID.
 await connections.removeRepresentative({expectedConfigHash:connections.list().configHash});
 assert.equal(connections.list().representative,null);
 assert.equal((await activationState(f.store))?.routeChoice,null);
 assert.notEqual((await activationState(f.store))?.routeClosedAt,null);

 // Restart, later login-started, and owner-typed first message must not resurrect the route.
 const restarted=f.host();
 await restarted.restoreSettings();
 assert.equal(restarted.list().representative,null);
 const claude=restarted.list().connections.find(c=>c.providerType==='claude-code-cli')!;
 await restarted.turnOnConnection('login:claude-after-remove',claude.id,'login-started');
 assert.equal(restarted.list().representative,null);
 const assistant=new AssistantService(f.store,new ProductService(f.store,undefined,restarted),restarted);
 const sendRes=await assistant.send({commandId:'q-after-remove',segment:1,expectedRevision:0,text:'Should not auto-route'},undefined,'owner-typed');
 assert.equal(sendRes.message.status,'committed');
 assert.equal(sendRes.turn?.status,'not_started');
 assert.equal(restarted.list().representative,null);
 assert.equal((await activationState(f.store))?.routeChoice,null);
});

test('C1-fix-4 Test 2: choosing another model survives immediate crash without writing settings store for the route',async t=>{
 const f=await fixture(t);
 await new Application(f.store,[{id:'owner',roles:['owner']}]).create({id:'intake',purpose:'Intake',scope:'local',constraints:[],criteria:{version:1,description:'Intake',oracle:'fixture/v1'}},'owner','create-intake');
 let settingsWrites=0;
 const countedSettings=new Proxy(f.settings,{get(target,key){if(key==='save')return async(...args:Parameters<typeof target.save>)=>{settingsWrites++;return target.save(...args);};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}}) as InMemoryHostSettings;

 const connections=f.host(f.store,countedSettings);
 await connections.restoreSettings();
 const api=connections.list().connections.find(c=>c.providerType==='openai')!;
 await new ConnectionLifecycle(f.store,connections).replaceKey({commandId:'key-crash',connectionId:api.id,expectedConfigHash:api.configHash,apiKey:'fixture-key-value'});
 await connections.save(()=>connections.selectModel(api.id,{model:'gpt-5',label:'GPT-5',expectedConfigHash:connections.list().connections.find(c=>c.id===api.id)!.configHash}));
 await connections.save(()=>connections.selectModel(api.id,{model:'gpt-5-mini',label:'GPT-5 Mini',expectedConfigHash:connections.list().connections.find(c=>c.id===api.id)!.configHash}));

 const firstProfile=profileForModel(connections,'gpt-5');
 const secondProfile=profileForModel(connections,'gpt-5-mini');
 const writesAfterSetup=settingsWrites;

 await connections.setRepresentative({profileId:firstProfile.id,outputTokenCap:64,intakeMissionId:'intake',expectedConfigHash:connections.list().configHash});
 await connections.setRepresentative({profileId:secondProfile.id,outputTokenCap:256,intakeMissionId:'intake',expectedConfigHash:connections.list().configHash});

 // Choosing/switching the Representative route must not write to HostSettingsStore.
 assert.equal(settingsWrites,writesAfterSetup);

 // Simulate crash right after commit by discarding the workbench instance and reloading from stores.
 const crashedAndReloaded=f.host(f.store,countedSettings);
 await crashedAndReloaded.restoreSettings();
 const rep=crashedAndReloaded.list().representative!;
 assert.equal(rep.route.profileId,secondProfile.id);
 assert.equal(rep.route.outputTokenCap,256);
 assert.equal(crashedAndReloaded.configuration().representative?.route.profileId,secondProfile.id);
 assert.equal((await activationState(f.store))?.routeChoice?.model,'gpt-5-mini');
 assert.equal((await activationState(f.store))?.routeChoice?.outputTokenCap,256);
});

test('C1-fix-4 Test 3: legacy v3/v2 settings with representative and v1 load cleanly with route null and zero commits on load',async t=>{
 const f=await fixture(t);
 // Capture the scope key used by the host without storing any route.
 let hostScope='';
 const scopeProbe=new Proxy(f.settings,{get(target,key){if(key==='load')return async(s:string)=>{hostScope=s;return target.load(s);};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}}) as InMemoryHostSettings;
 await f.host(new InMemoryStore<Mission>(),scopeProbe).restoreSettings();

 const base={selections:[],authorizations:[],defaultRoutes:[],revokedAuthorizationIds:[]};
 const legacyRep={route:{profileId:'legacy-profile',configHash:'0'.repeat(64),outputTokenCap:128},intakeMissionId:'intake'};

 // v3 as origin/main wrote it (with non-null representative) + empty store (no CONNECTION_ACTIVATION_ID).
 const v3Settings=new InMemoryHostSettings(),v3Store=new InMemoryStore<Mission>();
 await v3Settings.save(hostScope,0,'legacy-v3',{version:3,...base,modelGroups:[],representative:legacyRep});
 const v3Host=f.host(v3Store,v3Settings);
 await v3Host.restoreSettings();
 assert.equal(v3Store.inspect().length,0);
 assert.equal(v3Host.list().representative,null);
 assert.equal(v3Host.configuration().representative,null);

 // Saving an unrelated settings change writes representative: null.
 const api=v3Host.list().connections.find(c=>c.providerType==='openai')!;
 await v3Host.save(()=>v3Host.selectModel(api.id,{model:'gpt-5',label:'GPT-5',expectedConfigHash:api.configHash}));
 assert.equal((await v3Settings.load(hostScope) as any).value.representative,null);

 // v2 (with non-null representative) and v1 (without representative/modelGroups) load cleanly with zero commits and route null.
 const v2Settings=new InMemoryHostSettings(),v2Store=new InMemoryStore<Mission>();
 await v2Settings.save(hostScope,0,'legacy-v2',{version:2,...base,representative:legacyRep});
 const v2Host=f.host(v2Store,v2Settings);
 await v2Host.restoreSettings();
 assert.equal(v2Store.inspect().length,0);
 assert.equal(v2Host.list().representative,null);

 const v1Settings=new InMemoryHostSettings(),v1Store=new InMemoryStore<Mission>();
 await v1Settings.save(hostScope,0,'legacy-v1',{version:1,...base});
 const v1Host=f.host(v1Store,v1Settings);
 await v1Host.restoreSettings();
 assert.equal(v1Store.inspect().length,0);
 assert.equal(v1Host.list().representative,null);
});

test('C1-fix-4 Test 4: exported journal replays first-route -> explicit model -> removal -> login-started identically to live state',async t=>{
 const f=await fixture(t);
 await new Application(f.store,[{id:'owner',roles:['owner']}]).create({id:'intake',purpose:'Intake',scope:'local',constraints:[],criteria:{version:1,description:'Intake',oracle:'fixture/v1'}},'owner','create-intake');
 const connections=f.host();
 await connections.restoreSettings();
 const api=connections.list().connections.find(c=>c.providerType==='openai')!;
 const codex=connections.list().connections.find(c=>c.providerType==='codex-cli')!;

 // Step 1: first-route via owner-typed first message.
 const assistant=new AssistantService(f.store,new ProductService(f.store,undefined,connections),connections);
 await assistant.send({commandId:'q-replay-1',segment:1,expectedRevision:0,text:'Hello'},undefined,'owner-typed');
 const liveStep1=structuredClone(await activationState(f.store))!;
 assert.equal(liveStep1.routeChoice?.source,'first-route');

 // Step 2: configure API connection and make explicit owner choice of another model and output cap.
 await new ConnectionLifecycle(f.store,connections).replaceKey({commandId:'key-replay',connectionId:api.id,expectedConfigHash:api.configHash,apiKey:'fixture-key-value'});
 const liveAfterKey=structuredClone(await activationState(f.store))!;
 await connections.save(()=>connections.selectModel(api.id,{model:'gpt-5',label:'GPT-5',expectedConfigHash:connections.list().connections.find(c=>c.id===api.id)!.configHash}));
 const gpt5Profile=profileForModel(connections,'gpt-5');
 await connections.setRepresentative({profileId:gpt5Profile.id,outputTokenCap:512,intakeMissionId:'intake',expectedConfigHash:connections.list().configHash});
 const liveStep2=structuredClone(await activationState(f.store))!;
 assert.equal(liveStep2.routeChoice?.source,'owner-choice');
 assert.equal(liveStep2.routeChoice?.model,'gpt-5');
 assert.equal(liveStep2.routeChoice?.outputTokenCap,512);

 // Step 3: explicit removal.
 await connections.removeRepresentative({expectedConfigHash:connections.list().configHash});
 const liveStep3=structuredClone(await activationState(f.store))!;
 assert.equal(liveStep3.routeChoice,null);
 assert.notEqual(liveStep3.routeClosedAt,null);

 // Step 4: later login-started leaves route removed.
 await connections.turnOnConnection('login:codex-replay',codex.id,'login-started');
 const liveStep4=structuredClone(await activationState(f.store))!;
 assert.equal(liveStep4.routeChoice,null);
 assert.equal(liveStep4.activations.some(a=>a.connectionId===codex.id),true);

 const ops=f.store.inspect();
 validateMissionJournalLineage(ops);
 const bundle=parsePortableBackup(await exportPortableBackup({exportJournal:async()=>memoryJournal(f.store)},f.artifacts));
 const activationOps=bundle.journal.operations.filter(op=>op.aggregateId===CONNECTION_ACTIVATION_ID) as unknown as Operation<ConnectionActivationState>[];
 assert.equal(activationOps.length,5);

 let replayed=parseActivationState(undefined);
 const replayedSteps:ConnectionActivationState[]=[];
 for(let i=0;i<activationOps.length;i++){
  const op=activationOps[i]!,prior=i>0?activationOps[i-1]:undefined;
  replayConnectionActivation(op,prior);
  const cmd=(op.events[0] as {command:Parameters<typeof applyActivation>[1]}).command;
  replayed=applyActivation(replayed,cmd).value;
  replayedSteps.push(structuredClone(replayed));
 }
 assert.deepEqual(replayedSteps,[liveStep1,liveAfterKey,liveStep2,liveStep3,liveStep4]);
 assert.equal(replayedSteps[2]!.routeChoice?.model,'gpt-5');
 assert.equal(replayedSteps[2]!.routeChoice?.outputTokenCap,512);
});
