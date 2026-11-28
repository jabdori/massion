import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tempRoot} from './support/temp-root.ts';
import {loadHostStartup,createHostConnections,BUILTIN_CLI_RECOMMENDED_MODELS} from '../src/host-connections.ts';
import type {HostStartup} from '../src/host-connections.ts';
import {CONNECTION_ACTIVATION_ID,FIRST_MESSAGE_LOGIN_ORDER,applyActivation,activationCommandId,activationFingerprint,replayConnectionActivation,activationState as parseActivation} from '../src/connection-activation.ts';
import type {ConnectionActivationState,RouteSnapshot} from '../src/connection-activation.ts';
import {MODEL_PROVIDER_TYPES,isCliProvider} from '../src/connection-workbench.ts';
import {LoginConnections} from '../src/connection-logins.ts';
import {Application} from '../src/application.ts';
import {InMemoryHostSettings,InMemoryStore} from '../src/storage.ts';
import {InMemorySecretSlots} from '../src/secret-slots.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';
import type {Mission} from '../src/domain.ts';
import type {CliRunner} from '../src/cli-agent-providers.ts';
import {codexProbeResult} from './support/codex-probes.ts';

const turn=(reply:string)=>JSON.stringify({reply,work:null});
const NOT_SENT_NOTHING='This message turned nothing on and was not sent.',NOT_SENT_AFTER_TURN_ON='This message turned the connection on, but was not sent.',NOT_SENT_ALREADY_ON='The connection was already on, but this message was not sent.';
const claudeResult=JSON.stringify({type:'result',subtype:'success',is_error:false,result:turn('4'),num_turns:1,usage:{input_tokens:2,cache_creation_input_tokens:972,cache_read_input_tokens:0,output_tokens:4},modelUsage:{[BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli']]:{}}});
// The codex runner answers in the codex CLI's own JSONL shape (parseCodexEvents); a claude-shaped stub would hide that provider's real contract.
const codexResult=[{type:'thread.started',thread_id:'t'},{type:'item.completed',item:{id:'item_0',type:'agent_message',text:turn('4')}},{type:'turn.completed',usage:{input_tokens:11,cached_input_tokens:0,output_tokens:3}}].map(line=>JSON.stringify(line)).join('\n');
const aggregate=async(store:InMemoryStore<Mission>)=>(await store.load(CONNECTION_ACTIVATION_ID))?.value as unknown as ConnectionActivationState|undefined;

async function fixture(t:test.TestContext,options:{detect?:(providerType:string)=>'detected'|'absent'|'unknown'}={}){
 const root=await mkdtemp(join(tempRoot(),'first-message-picks-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new InMemoryStore<Mission>(),secrets=new InMemorySecretSlots(),settings=new InMemoryHostSettings();
 let detect=options.detect??(()=>'detected' as const);
 const cliCalls:string[]=[];
 const cliRunner:CliRunner=async call=>{const probe=call.command==='codex'?codexProbeResult(call):undefined;if(probe)return probe;cliCalls.push(call.command);return {spawned:true,exitCode:0,stdout:call.command==='codex'?codexResult:claudeResult,stderr:'',timedOut:false,aborted:false,overflow:false};};
 const loginRunner:CliRunner=async call=>{
  const codex=call.command==='codex',state=detect(codex?'codex-cli':'claude-code-cli');
  if(state==='unknown')return {spawned:true,exitCode:0,stdout:codex?'':'claude status unreadable',stderr:codex?'Unexpected account data':'',timedOut:false,aborted:false,overflow:false};
  const detected=state==='detected';
  if(codex)return {spawned:true,exitCode:detected?0:1,stdout:'',stderr:detected?'Logged in using ChatGPT':'Not logged in',timedOut:false,aborted:false,overflow:false};
  return {spawned:true,exitCode:0,stdout:JSON.stringify(detected?{loggedIn:true,authMethod:'claude.ai'}:{loggedIn:false}),stderr:'',timedOut:false,aborted:false,overflow:false};
 };
 const logins=new LoginConnections(loginRunner);
 const transport=async()=>new Response(JSON.stringify({data:[]}),{headers:{'content-type':'application/json'}});
 const startup=await loadHostStartup([]);
 const host=(store_:InMemoryStore<Mission>=store,startup_:HostStartup=startup)=>createHostConnections(store_,new TextArtifactStore(join(root,'artifacts')),startup_,{secrets,readEnvironment:()=>undefined,transport,settings,cliRunner,loginStatus:(providerType:string,signal?:AbortSignal)=>logins.recheck(providerType,signal).then(status=>status.status)});
 return {root,store,secrets,settings,startup,host,cliCalls,setDetect:(next:(providerType:string)=>'detected'|'absent'|'unknown')=>{detect=next;}};
}

test('the transition orders by provider type and refuses what main never stored',()=>{
 const base=parseActivation(undefined);
 const route:RouteSnapshot={model:'claude-sonnet-5-5',profileId:'profile:claude',configHash:'a'.repeat(64),outputTokenCap:4,intakeMissionId:'assistant-intake'};
  const command={kind:'turn-on' as const,commandId:'t:bare',connectionId:'c-claude',way:'first-message' as const,at:1,messageId:'m:'+'a'.repeat(32),messageOrigin:'owner-typed' as const,detectedLogins:['c-claude','c-codex'],route};
  // The first bare id names the command's own connection: only the exactly-one rule (not a mismatch) refuses it, so this row pins the fallback's width.
  assert.throws(()=>applyActivation(base,command),/First-message activation not permitted/,'two bare ids activate nothing, so no such record can ever be stored for the lineage path to replay');
  const ordered=applyActivation(base,{...command,commandId:'t:ordered',detectedLogins:['c-codex','c-claude'],detectedProviders:['codex-cli','claude-code-cli']});
 assert.deepEqual(ordered.value.activations.map(a=>[a.connectionId,a.way]),[['c-claude','first-message']],'the transition itself orders by the fixed order');
 assert.equal(ordered.value.routeChoice?.connectionId,'c-claude');
 assert.throws(()=>applyActivation(base,{...command,commandId:'t:mismatch',connectionId:'c-codex',detectedLogins:['c-codex','c-claude'],detectedProviders:['codex-cli','claude-code-cli']}),/First-message activation not permitted/,'a command naming a connection the ordered decision does not pick is refused inside the transition');
 assert.throws(()=>applyActivation(base,{...command,commandId:'t:malformed',detectedProviders:['claude-code-cli']}),/Invalid connection activation/,'the provider array must stay parallel to the ids');
 assert.doesNotThrow(()=>applyActivation(base,{...command,commandId:'t:legacy',detectedLogins:['c-claude']}),'main-shaped commands (exactly one bare id) still derive their stored result');
});

test('a model-selected turn-on records the first route only when its command says it is the automatic pick',()=>{
 const base=parseActivation(undefined);
 const route:RouteSnapshot={model:'claude-sonnet-5-5',profileId:'profile:claude',configHash:'a'.repeat(64),outputTokenCap:4,intakeMissionId:'assistant-intake'};
 const command={kind:'turn-on' as const,commandId:'t:selection',connectionId:'c-claude',way:'model-selected' as const,at:1,messageOrigin:'owner-typed' as const,detectedLogins:['c-claude'],route};
 const recorded=(value:ConnectionActivationState)=>[value.routeChoice?.source,value.routeChoice?.connectionId,value.activations.map(a=>[a.connectionId,a.way]),value.routeClosedAt];
 assert.deepEqual(recorded(applyActivation(base,command).value),['owner-choice','c-claude',[['c-claude','model-selected']],null],'a command without the flag is the shape every journal has stored since PR #304');
 assert.deepEqual(recorded(applyActivation(base,{...command,commandId:'t:automatic',automaticPick:true}).value),['first-route','c-claude',[['c-claude','model-selected']],null],'the automatic pick changes the source and nothing else');
 for(const value of [false,'true',1]){
  const invalid={...command,commandId:'t:invalid',automaticPick:value} as unknown as Parameters<typeof applyActivation>[1];
  assert.throws(()=>applyActivation(base,invalid),/Invalid connection activation/,'only the literal true is a stored value, never '+JSON.stringify(value));
 }
 // The flag belongs to the model-selected way: with any other way the command is one the product cannot produce, so the transition (and the replay behind a backup) refuse it.
 for(const [way,extra] of [['key-added',{}],['login-started',{}],['first-message',{messageId:'m:'+'a'.repeat(32)}]] as const){
  const other={...command,commandId:'t:other-way',way,...extra} as unknown as Parameters<typeof applyActivation>[1];
  assert.doesNotThrow(()=>applyActivation(base,other),way+' without the flag derives its stored result');
  assert.throws(()=>applyActivation(base,{...other,automaticPick:true} as Parameters<typeof applyActivation>[1]),/Invalid connection activation/,way+' with the flag is refused');
 }
});

test('the transition refuses a second activation for the same connection',()=>{
 const command={kind:'turn-on' as const,commandId:'key:first',connectionId:'api-key',way:'key-added' as const,at:1};
 const {value}=applyActivation(parseActivation(undefined),command);
 assert.throws(()=>applyActivation(value,{...command,commandId:'key:second',at:2}),{code:'conflict',message:'Connection already on'});
});

test('a route command records first-route only when it requires the route to be unset',()=>{
 const base=parseActivation(undefined);
 const route:RouteSnapshot={model:'claude-sonnet-5-5',profileId:'profile:claude',configHash:'a'.repeat(64),outputTokenCap:4,intakeMissionId:'assistant-intake'};
 const command={kind:'record-route' as const,commandId:'t:first-from-selection',connectionId:'c-claude',...route,at:1,source:'first-route' as const};
 assert.throws(()=>applyActivation(base,command),/Invalid route choice/,'a route command that may replace a route never claims to be the first one');
 assert.deepEqual(applyActivation(base,{...command,requireUnset:true}).value.routeChoice,{...route,connectionId:'c-claude',at:1,source:'first-route'},'the automatic pick on a connection that is already on is the first route');
});

test('the three not-sent sentences are written in exactly one place each',()=>{
 const source=readFileSync(new URL('../src/assistant-service.ts',import.meta.url),'utf8');
 assert.equal(source.split(NOT_SENT_NOTHING).length-1,1,'the nothing-turned-on sentence appears exactly once: its definition, referenced by name everywhere else');
 assert.equal(source.split(NOT_SENT_AFTER_TURN_ON).length-1,1,'the this-message-turned-on sentence appears exactly once');
 assert.equal(source.split(NOT_SENT_ALREADY_ON).length-1,1,'the already-on sentence appears exactly once');
});

test('a manipulated journal record with two bare ids is rejected by the lineage replay',()=>{
 const route:RouteSnapshot={model:'claude-sonnet-5-5',profileId:'profile:claude',configHash:'a'.repeat(64),outputTokenCap:4,intakeMissionId:'assistant-intake'};
 const command={kind:'turn-on' as const,commandId:'j:two-bare',connectionId:'c-claude',way:'first-message' as const,at:1,messageId:'m:'+'a'.repeat(32),messageOrigin:'owner-typed' as const,detectedLogins:['c-claude','c-codex'],route};
 const value={kind:'connection-activation',id:CONNECTION_ACTIVATION_ID,activations:[{connectionId:'c-claude',at:1,way:'first-message',messageId:command.messageId}],routeChoice:{...route,connectionId:'c-claude',at:1,source:'first-route' as const},routeClosedAt:null};
 const operation={aggregateId:CONNECTION_ACTIVATION_ID,commandId:'j:two-bare',fingerprint:activationFingerprint(command),expectedRevision:0,revision:1,value,events:[{type:'connection-activation',actor:'local-owner',command}],outbox:[]} as unknown as Parameters<typeof replayConnectionActivation>[0];
 assert.throws(()=>replayConnectionActivation(operation,undefined),/First-message activation not permitted/,'the lineage replay re-derives through the transition, so a record the transition refuses cannot pass as stored');
});

test('after the pick, selecting the other provider in Settings turns it on and never replaces the route',async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!,codex=connections.list().connections.find(c=>c.providerType==='codex-cli')!;
 assert.equal((await connections.turnOnConnection('login:1',claude.id,'login-started')).status,'on');
 const picked=(await aggregate(f.store))?.routeChoice!;
 const {profileId}=await connections.save(()=>connections.selectModel(codex.id,{model:BUILTIN_CLI_RECOMMENDED_MODELS['codex-cli'],label:BUILTIN_CLI_RECOMMENDED_MODELS['codex-cli'],expectedConfigHash:codex.configHash}));
 assert.deepEqual(await connections.activateFromSelection({connectionId:codex.id,profileId,origin:'owner-typed'}),{status:'turned-on',reason:null,routeSet:false});
 assert.equal(connections.connectionOn(codex.id),true);
 assert.equal((await aggregate(f.store))?.routeChoice?.profileId,picked.profileId,'an existing route is never replaced silently');
 // The screens have no switch path (PR finding): after the owner closes the route, a selection still sets no route.
 await connections.save(()=>connections.removeRepresentative({expectedConfigHash:connections.list().configHash}));
 assert.deepEqual(await connections.activateFromSelection({connectionId:codex.id,profileId,origin:'owner-typed'}),{status:'already-on',reason:null,routeSet:false});
 assert.equal(connections.list().representative,null);
 validateMissionJournalLineage(f.store.inspect());
});

test('a stale workbench refuses to remove a route replaced by another workbench and refreshes its route',{timeout:5000},async t=>{
 const f=await fixture(t),writer=f.host(),stale=f.host();
 await writer.restoreSettings();
 const codex=writer.list().connections.find(c=>c.providerType==='codex-cli')!;
 assert.equal((await writer.turnOnConnection('login:first',codex.id,'login-started')).status,'on');
 await stale.restoreSettings();
 const before=stale.list();
 assert.ok(before.representative);
 const {route:{profileId},intakeMissionId}=before.representative;
 await writer.setRepresentative({profileId,outputTokenCap:128,intakeMissionId,expectedConfigHash:writer.list().configHash});
 const saved=await f.store.load(CONNECTION_ACTIVATION_ID);

 await assert.rejects(stale.removeRepresentative({expectedConfigHash:before.configHash}),{code:'conflict',message:/Representative route changed elsewhere/});
 assert.deepEqual(await f.store.load(CONNECTION_ACTIVATION_ID),saved);
 assert.equal(stale.list().representative?.route.outputTokenCap,128);
});

test('a duplicate model-selection conflict answers already-on, never that this request turned the connection on',async t=>{
 const f=await fixture(t);
 let staleNextActivationLoad=false;
 const gatedStore=new Proxy(f.store,{
  get(target,property){
   if(property==='load')return async(id:string)=>{if(id===CONNECTION_ACTIVATION_ID&&staleNextActivationLoad){staleNextActivationLoad=false;return null;}return await target.load(id);};
   const v=Reflect.get(target,property);return typeof v==='function'?v.bind(target):v;
  }
 }) as InMemoryStore<Mission>;
 const connections=f.host(),secondConnections=f.host(gatedStore);
 await connections.restoreSettings();await secondConnections.restoreSettings();
 const codex=connections.list().connections.find(c=>c.providerType==='codex-cli')!,codexAgain=secondConnections.list().connections.find(c=>c.providerType==='codex-cli')!;
 const {profileId}=await connections.save(()=>connections.selectModel(codex.id,{model:BUILTIN_CLI_RECOMMENDED_MODELS['codex-cli'],label:BUILTIN_CLI_RECOMMENDED_MODELS['codex-cli'],expectedConfigHash:codex.configHash}));
 await secondConnections.save(()=>secondConnections.selectModel(codexAgain.id,{model:BUILTIN_CLI_RECOMMENDED_MODELS['codex-cli'],label:BUILTIN_CLI_RECOMMENDED_MODELS['codex-cli'],expectedConfigHash:codexAgain.configHash}));
 // The first selection commits and turns the connection on.
 const first=await connections.activateFromSelection({connectionId:codex.id,profileId,origin:'owner-typed'});
 assert.deepEqual(first,{status:'turned-on',reason:null,routeSet:true});
 // The second selection reads the state as it was before the first commit (as two racing requests would), derives the same command id, and its commit conflicts with the first's different fingerprint.
 staleNextActivationLoad=true;
 const second=await secondConnections.activateFromSelection({connectionId:codexAgain.id,profileId,origin:'owner-typed'});
 assert.deepEqual(second,{status:'already-on',reason:null,routeSet:true},'the first request turned it on; this one did not');
 assert.deepEqual((await aggregate(f.store))?.activations.map(a=>[a.connectionId,a.way]),[[codex.id,'model-selected']],'exactly one activation exists');
 validateMissionJournalLineage(f.store.inspect());
});

test('a model-selection conflict with the connection absent from the stored state is refused',async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const codex=connections.list().connections.find(c=>c.providerType==='codex-cli')!;
 const {profileId}=await connections.save(()=>connections.selectModel(codex.id,{model:BUILTIN_CLI_RECOMMENDED_MODELS['codex-cli'],label:BUILTIN_CLI_RECOMMENDED_MODELS['codex-cli'],expectedConfigHash:codex.configHash}));
 // The derived selection command id is already used by an operation on another aggregate (a Mission holds it); no path turned the connection on.
 await new Application(f.store,[{id:'owner',roles:['owner']}]).create({id:'selection-collision',purpose:'Holds a used command identity',scope:'local',constraints:[],criteria:{version:1,description:'Collision holder',oracle:'fixture/v1'}},'owner',activationCommandId('model-selected:'+profileId,codex.id));
 const outcome=await connections.activateFromSelection({connectionId:codex.id,profileId,origin:'owner-typed'});
 assert.deepEqual(outcome,{status:'not-turned-on',reason:'duplicate-command-not-on',routeSet:false});
 assert.equal(connections.connectionOn(codex.id),false);
 assert.equal((await aggregate(f.store))?.activations.length??0,0);
 validateMissionJournalLineage(f.store.inspect());
});

test('the first-message login order is a release-fixed table: Claude Code CLI, then Codex CLI',()=>{
 assert.deepEqual([...FIRST_MESSAGE_LOGIN_ORDER],['claude-code-cli','codex-cli']);
 assert.deepEqual(MODEL_PROVIDER_TYPES.filter(provider=>isCliProvider(provider.id)).map(provider=>provider.id),[...FIRST_MESSAGE_LOGIN_ORDER],'no subscription CLI provider exists outside the order; a future one must join it or it can never be picked');
});
