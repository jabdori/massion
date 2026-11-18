import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tempRoot} from './support/temp-root.ts';
import {authenticatedFetch} from '../desktop/auth.ts';
import {loadHostStartup,createHostConnections,BUILTIN_CLI_RECOMMENDED_MODELS} from '../src/host-connections.ts';
import type {HostStartup} from '../src/host-connections.ts';
import {ConnectionLifecycle} from '../src/connection-lifecycle.ts';
import {CONNECTION_ACTIVATION_ID,FIRST_MESSAGE_LOGIN_ORDER,applyActivation,activationCommandId,activationFingerprint,replayConnectionActivation,activationState as parseActivation} from '../src/connection-activation.ts';
import type {ConnectionActivationState,RouteSnapshot} from '../src/connection-activation.ts';
import {MODEL_PROVIDER_TYPES,isCliProvider} from '../src/connection-workbench.ts';
import {LoginConnections} from '../src/connection-logins.ts';
import {AssistantService} from '../src/assistant-service.ts';
import {ProductService} from '../src/product.ts';
import {createWorkbench} from '../src/server.ts';
import {Application} from '../src/application.ts';
import {InMemoryHostSettings,InMemoryStore} from '../src/storage.ts';
import {InMemorySecretSlots} from '../src/secret-slots.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';
import {ownerMessageId,segmentId} from '../src/assistant-conversation.ts';
import type {AssistantSegment} from '../src/assistant-conversation.ts';
import type {Mission} from '../src/domain.ts';
import type {CliRunner} from '../src/cli-agent-providers.ts';

const turn=(reply:string)=>JSON.stringify({reply,work:null});
const NOT_SENT_NOTHING='This message turned nothing on and was not sent.',NOT_SENT_AFTER_TURN_ON='This message turned the connection on, but was not sent.',NOT_SENT_ALREADY_ON='The connection was already on, but this message was not sent.';
/** One consistency check shared by every not-sent scenario: the turn's sentence states exactly what THIS message did to the on state, never something else. */
function assertNotSentConsistent(answer:{turn?:{settlement?:{reason?:string}}|null;activation?:{status:string}}){
 assert.ok(answer.activation,'the activation view rides the response');
 const expected=answer.activation!.status==='turned-on'?NOT_SENT_AFTER_TURN_ON:answer.activation!.status==='already-on'?NOT_SENT_ALREADY_ON:NOT_SENT_NOTHING;
 assert.equal(answer.turn?.settlement?.reason,expected,'the status '+answer.activation!.status+' is never paired with a sentence that claims something else');
}
const claudeResult=JSON.stringify({type:'result',subtype:'success',is_error:false,result:turn('4'),num_turns:1,usage:{input_tokens:2,cache_creation_input_tokens:972,cache_read_input_tokens:0,output_tokens:4},modelUsage:{[BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli']]:{}}});
// The codex runner answers in the codex CLI's own JSONL shape (parseCodexEvents); a claude-shaped stub would hide that provider's real contract.
const codexResult=[{type:'thread.started',thread_id:'t'},{type:'item.completed',item:{id:'item_0',type:'agent_message',text:turn('4')}},{type:'turn.completed',usage:{input_tokens:11,cached_input_tokens:0,output_tokens:3}}].map(line=>JSON.stringify(line)).join('\n');
const aggregate=async(store:InMemoryStore<Mission>)=>(await store.load(CONNECTION_ACTIVATION_ID))?.value as unknown as ConnectionActivationState|undefined;
const firstMessageCommand=(store:InMemoryStore<Mission>)=>store.inspect().flatMap(operation=>operation.events as unknown as {command?:{kind?:string;way?:string;detectedLogins?:string[];detectedProviders?:string[]}}[]).flatMap(event=>event.command? [event.command]:[]).find(command=>command.kind==='turn-on'&&command.way==='first-message');

async function fixture(t:test.TestContext,options:{detect?:(providerType:string)=>'detected'|'absent'|'unknown'}={}){
 const root=await mkdtemp(join(tempRoot(),'first-message-picks-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new InMemoryStore<Mission>(),secrets=new InMemorySecretSlots(),settings=new InMemoryHostSettings();
 let detect=options.detect??(()=>'detected' as const);
 const cliCalls:string[]=[];
 const cliRunner:CliRunner=async call=>{cliCalls.push(call.command);return {spawned:true,exitCode:0,stdout:call.command==='codex'?codexResult:claudeResult,stderr:'',timedOut:false,aborted:false,overflow:false};};
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

test('two detected logins: the first owner message turns Claude Code on, answers through it and records the first route',async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!,codex=connections.list().connections.find(c=>c.providerType==='codex-cli')!;
 const assistant=new AssistantService(f.store,new ProductService(f.store,undefined,connections),connections);
 const answer=await assistant.send({commandId:'q-1',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'},undefined,'owner-typed');
 assert.equal(answer.turn?.status,'answered');assert.equal(answer.turn?.reply,'4');
 assert.deepEqual(answer.activation,{status:'turned-on',connectionId:claude.id,pickedBy:'first-message-order',reason:null});
 assert.deepEqual(f.cliCalls,['claude'],'the pick is Claude Code, not Codex and not both');
 assert.equal(connections.connectionOn(claude.id),true);assert.equal(connections.connectionOn(codex.id),false,'the other connection stays off');
 const state=await aggregate(f.store);
 assert.deepEqual(state?.activations.map(a=>[a.connectionId,a.way]),[[claude.id,'first-message']]);
 assert.equal(state?.routeChoice?.source,'first-route');
 assert.equal(state?.routeChoice?.model,BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli']);
 assert.equal(state?.routeChoice?.model,f.startup.manifest!.connections.find(c=>c.providerType==='claude-code-cli')!.models[0],'the route takes the manifest entry\'s first model, unchanged from main (#firstRouteProfile models[0])');
 assert.equal(connections.list().representative?.derived,true,'the route is marked as derived, so a screen can say it was chosen for the owner');
 // Reversing FIRST_MESSAGE_LOGIN_ORDER flips this stored order and the pick; these hardcoded expectations then fail (the constant's use, not only its value).
 assert.deepEqual(firstMessageCommand(f.store)?.detectedLogins,[claude.id,codex.id],'the stored detected set is in FIRST_MESSAGE_LOGIN_ORDER');
 validateMissionJournalLineage(f.store.inspect());
 // A replay of the same command and a later non-first message carry no activation view.
 const replay=await assistant.send({commandId:'q-1',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'},undefined,'owner-typed');
 assert.equal(replay.message.status,'replayed');assert.equal(replay.activation,undefined);
 const view=await assistant.read();
 const later=await assistant.send({commandId:'q-2',segment:1,expectedRevision:view.segment!.revision,text:'Again? Reply with just the numeral.'},undefined,'owner-typed');
 assert.equal(later.turn?.status,'answered');assert.equal(later.activation,undefined);
 assert.deepEqual(f.cliCalls,['claude','claude']);
});

test('a replayed first-message write returns the pending turn without attempting activation',async t=>{
 const f=await fixture(t),input={commandId:'lost-first-write',segment:1,expectedRevision:0,text:'2+2?'};
 let accepted:AssistantSegment|undefined,activationWrites=0;
 const store=new Proxy(f.store,{get(target,key){const value=Reflect.get(target,key);if(key==='commit')return async(command:Parameters<typeof target.commit>[0])=>{
  if(command.id===CONNECTION_ACTIVATION_ID){activationWrites++;return {status:'conflict',reason:'revision',revision:command.expectedRevision} as const;}
  const result=await target.commit(command);if(command.commandId!==input.commandId)return result;
  assert.ok(result.status==='committed');accepted=result.value as unknown as AssistantSegment;
  const replay=await target.reconcile(command);assert.ok(replay.status==='replayed');return replay;
 };return typeof value==='function'?value.bind(target):value;}});
 const connections=f.host(store);await connections.restoreSettings();
 const activate=t.mock.method(connections,'activateFromMessage');
 const daemonSecret='a'.repeat(64);
 const server=createWorkbench(store,f.root,{connections,secretSlots:f.secrets,daemonSecret,scheduleIntervalMs:0});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
 const port=(server.address() as {port:number}).port;
 const response=await authenticatedFetch(new URL('http://127.0.0.1:'+port+'/assistant/messages'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)},daemonSecret);
 const body=await response.json();
 assert.equal(response.status,200,`response after ${activationWrites} activation writes: ${JSON.stringify(body)}`);
 assert.ok(accepted);
 const stored=(await f.store.load(segmentId(1)))!.value as unknown as AssistantSegment;
 assert.deepEqual(stored,accepted);
 assert.equal(stored.turns[0]?.status,'pending');
 assert.deepEqual(body,{message:{status:'replayed',revision:1,value:accepted},turn:{id:stored.turns[0]!.id,status:'pending'},feedId:(await f.store.readState()).feedId});
 assert.equal(activate.mock.callCount(),0);
 assert.deepEqual(f.cliCalls,[]);
});

test('Claude Code installed but logged out, Codex logged in: the first message answers through Codex',async t=>{
 const f=await fixture(t,{detect:providerType=>providerType==='codex-cli'?'detected' as const:'absent' as const}),connections=f.host();await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!,codex=connections.list().connections.find(c=>c.providerType==='codex-cli')!;
 const assistant=new AssistantService(f.store,new ProductService(f.store,undefined,connections),connections);
 const answer=await assistant.send({commandId:'q-1',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'},undefined,'owner-typed');
 assert.equal(answer.turn?.status,'answered');assert.equal(answer.turn?.reply,'4');
 assert.deepEqual(f.cliCalls,['codex'],'only the logged-in login counts');
 assert.equal(connections.connectionOn(codex.id),true);assert.equal(connections.connectionOn(claude.id),false);
 assert.equal((await aggregate(f.store))?.routeChoice?.model,BUILTIN_CLI_RECOMMENDED_MODELS['codex-cli']);
 assert.deepEqual(answer.activation,{status:'turned-on',connectionId:codex.id,pickedBy:'first-message',reason:null});
 assert.deepEqual(firstMessageCommand(f.store)?.detectedLogins,[codex.id]);
 validateMissionJournalLineage(f.store.inspect());
});

test('a first message of any origin other than the owner\'s typing turns nothing on, through the whole send path',async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const assistant=new AssistantService(f.store,new ProductService(f.store,undefined,connections),connections);
 let revision=0;
 for(const origin of ['scheduled','member','imported','replayed','unattributed'] as const){
  const answer=await assistant.send({commandId:'q-'+origin,segment:1,expectedRevision:revision,text:'2+2? Reply with just the numeral.'},undefined,origin);
  assert.equal(answer.message.status,'committed',origin);
  assert.equal(answer.turn?.status,'not_started',origin);
  assert.equal(answer.turn?.diagnostics?.some(d=>d.code==='assistant_route_missing'),true,origin);
  assert.equal(answer.activation,undefined,origin);
  revision=answer.message.revision;
 }
 assert.equal(await aggregate(f.store),undefined);
 assert.equal(connections.list().connections.some(c=>c.on),false);
 assert.deepEqual(f.cliCalls,[]);
 validateMissionJournalLineage(f.store.inspect());
});

test('two detected logins, the first disappears before the commit: nothing is turned on and the turn settles as nothing chosen',async t=>{
 const f=await fixture(t);
 // The flip happens inside the message commit: after the candidate was read, before the activation transition reads detection again.
 const firstSegment=segmentId(1);let flipped=false;
 const gatedStore=new Proxy(f.store,{
  get(target,property){
   if(property!=='commit')return Reflect.get(target,property);
   return async(input:Parameters<InMemoryStore<Mission>['commit']>[0])=>{
    if(input.id===firstSegment&&!flipped){flipped=true;f.setDetect(providerType=>providerType==='codex-cli'?'detected' as const:'absent' as const);}
    return await target.commit(input);
   };
  }
 }) as InMemoryStore<Mission>;
 const connections=f.host(gatedStore);await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!,codex=connections.list().connections.find(c=>c.providerType==='codex-cli')!;
 const assistant=new AssistantService(gatedStore,new ProductService(gatedStore,undefined,connections),connections);
 const answer=await assistant.send({commandId:'q-1',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'},undefined,'owner-typed');
 assert.equal(answer.message.status,'committed');
 // The model allows a pending turn only to settle, so the turn settles failed with the sentence of its two facts; the why is a code in the response.
 assert.equal(answer.turn?.status,'failed');
 assertNotSentConsistent(answer);
 assert.deepEqual(answer.activation,{status:'not-turned-on',connectionId:null,pickedBy:null,reason:'decision-not-the-candidate'});
 assert.equal(await aggregate(f.store),undefined,'no activation record exists');
 assert.equal(connections.connectionOn(claude.id),false);
 assert.equal(connections.connectionOn(codex.id),false,'the still-detected other provider is never turned on');
 assert.deepEqual(f.cliCalls,[]);
 validateMissionJournalLineage(f.store.inspect());
 // The message can simply be sent again once the detection is stable: the next one answers.
 f.setDetect(()=>'detected');
 const view=await assistant.read();
 const again=await assistant.send({commandId:'q-2',segment:1,expectedRevision:view.segment!.revision,text:'2+2? Reply with just the numeral.'},undefined,'owner-typed');
 assert.equal(again.turn?.status,'answered');assert.deepEqual(f.cliCalls,['claude']);
});

test('a login appearing ahead of the candidate at the commit turns nothing on',async t=>{
 const f=await fixture(t,{detect:providerType=>providerType==='codex-cli'?'detected' as const:'absent' as const});
 const firstSegment=segmentId(1);let flipped=false;
 const gatedStore=new Proxy(f.store,{
  get(target,property){
   if(property!=='commit')return Reflect.get(target,property);
   return async(input:Parameters<InMemoryStore<Mission>['commit']>[0])=>{
    if(input.id===firstSegment&&!flipped){flipped=true;f.setDetect(()=>'detected');}
    return await target.commit(input);
   };
  }
 }) as InMemoryStore<Mission>;
 const connections=f.host(gatedStore);await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!,codex=connections.list().connections.find(c=>c.providerType==='codex-cli')!;
 const assistant=new AssistantService(gatedStore,new ProductService(gatedStore,undefined,connections),connections);
 const answer=await assistant.send({commandId:'q-1',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'},undefined,'owner-typed');
 assert.equal(answer.message.status,'committed');
 assert.equal(answer.turn?.status,'failed');
 assertNotSentConsistent(answer);
 assert.deepEqual(answer.activation,{status:'not-turned-on',connectionId:null,pickedBy:null,reason:'decision-not-the-candidate'});
 assert.equal(await aggregate(f.store),undefined);
 assert.equal(connections.connectionOn(claude.id),false);assert.equal(connections.connectionOn(codex.id),false,'not even the candidate is turned on');
 assert.deepEqual(f.cliCalls,[]);
 validateMissionJournalLineage(f.store.inspect());
});

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

test('discovery that returns Codex first still turns Claude Code on: the fixed order decides, not the collection order',async t=>{
 const f=await fixture(t);
 // A built-in host whose manifest enrolls Codex before Claude Code; nothing sorts the detected set on the way to the decision.
 const builtin=await loadHostStartup([]);
 const reversed:HostStartup={manifest:{...builtin.manifest!,connections:[builtin.manifest!.connections[1]!,builtin.manifest!.connections[0]!,...builtin.manifest!.connections.slice(2)]},builtin:true,allowLiveExecution:false};
 const connections=f.host(f.store,reversed);await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!,codex=connections.list().connections.find(c=>c.providerType==='codex-cli')!;
 const assistant=new AssistantService(f.store,new ProductService(f.store,undefined,connections),connections);
 const answer=await assistant.send({commandId:'q-1',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'},undefined,'owner-typed');
 assert.equal(answer.turn?.status,'answered');assert.equal(answer.turn?.reply,'4');
 assert.deepEqual(f.cliCalls,['claude']);
 assert.deepEqual((await aggregate(f.store))?.activations.map(a=>[a.connectionId,a.way]),[[claude.id,'first-message']]);
 // The stored set keeps the collection order (Codex first); the pick inside the decision is still Claude Code.
 assert.deepEqual(firstMessageCommand(f.store)?.detectedLogins,[codex.id,claude.id]);
 assert.deepEqual(firstMessageCommand(f.store)?.detectedProviders,['codex-cli','claude-code-cli']);
 assert.equal((await aggregate(f.store))?.routeChoice?.connectionId,claude.id);
 validateMissionJournalLineage(f.store.inspect());
});

test('an unreadable login is never picked: the second in the order answers',async t=>{
 const f=await fixture(t,{detect:providerType=>providerType==='claude-code-cli'?'unknown' as const:'detected' as const}),connections=f.host();await connections.restoreSettings();
 const codex=connections.list().connections.find(c=>c.providerType==='codex-cli')!;
 const assistant=new AssistantService(f.store,new ProductService(f.store,undefined,connections),connections);
 const answer=await assistant.send({commandId:'q-1',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'},undefined,'owner-typed');
 assert.equal(answer.turn?.status,'answered');assert.deepEqual(f.cliCalls,['codex']);
 assert.deepEqual(firstMessageCommand(f.store)?.detectedLogins,[codex.id],'only a detected status ever enters the set');
 assert.deepEqual(firstMessageCommand(f.store)?.detectedProviders,['codex-cli']);
 assert.equal((await aggregate(f.store))?.routeChoice?.connectionId,codex.id);
 assert.deepEqual(answer.activation,{status:'turned-on',connectionId:codex.id,pickedBy:'first-message',reason:null});
 validateMissionJournalLineage(f.store.inspect());
});

test('the connection was turned on but its route could not be read again: the turn says so, no call is made, and the resend answers through it',async t=>{
 const f=await fixture(t);
 // Sabotage the stored-settings read the moment the activation has committed (the path through #storedSettingsCheck the review names).
 let sabotaged=false;
 const settingsLoad=f.settings.load.bind(f.settings);
 (f.settings as unknown as {load:(scope:string)=>Promise<unknown>}).load=async(scope:string)=>{if(sabotaged)throw new Error('fixture: the stored settings could not be read');return await settingsLoad(scope);};
 const gatedStore=new Proxy(f.store,{
  get(target,property){
   if(property!=='commit')return Reflect.get(target,property);
   return async(input:Parameters<InMemoryStore<Mission>['commit']>[0])=>{
    if(input.id===CONNECTION_ACTIVATION_ID)sabotaged=true;
    return await target.commit(input);
   };
  }
 }) as InMemoryStore<Mission>;
 const connections=f.host(gatedStore);await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!;
 const assistant=new AssistantService(gatedStore,new ProductService(gatedStore,undefined,connections),connections);
 const first=await assistant.send({commandId:'q-1',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'},undefined,'owner-typed');
 assert.equal(first.turn?.status,'failed');
 assert.deepEqual(first.activation,{status:'turned-on',connectionId:claude.id,pickedBy:'first-message-order',reason:'turned-on-route-unusable'});
 assertNotSentConsistent(first);
 assert.deepEqual(f.cliCalls,[],'no model call was made');
 assert.equal(connections.connectionOn(claude.id),true,'the connection really is on');
 // The owner simply sends the same text again: it is answered through the connection that is already on.
 sabotaged=false;
 const view=await assistant.read();
 const again=await assistant.send({commandId:'q-2',segment:1,expectedRevision:view.segment!.revision,text:'2+2? Reply with just the numeral.'},undefined,'owner-typed');
 assert.equal(again.turn?.status,'answered');assert.equal(again.turn?.reply,'4');
 assert.deepEqual(f.cliCalls,['claude'],'one call, the same connection');
 validateMissionJournalLineage(f.store.inspect());
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

test('an API-key connection the owner turned on: the first message still chooses nothing',async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const openai=connections.list().connections.find(c=>c.id.includes(':openai:'))!,claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!,codex=connections.list().connections.find(c=>c.providerType==='codex-cli')!;
 assert.equal((await new ConnectionLifecycle(f.store,connections).replaceKey({commandId:'key-one',connectionId:openai.id,expectedConfigHash:openai.configHash,apiKey:'fixture-key-value'})).status,'completed');
 const assistant=new AssistantService(f.store,new ProductService(f.store,undefined,connections),connections);
 const answer=await assistant.send({commandId:'q-1',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'},undefined,'owner-typed');
 assert.equal(answer.turn?.status,'not_started');
 assert.deepEqual((await aggregate(f.store))?.activations.map(a=>[a.connectionId,a.way]),[[openai.id,'key-added']],'today\'s behaviour: a connection already on blocks the first-message pick');
 assert.equal(connections.connectionOn(claude.id),false);assert.equal(connections.connectionOn(codex.id),false);
 assert.deepEqual(f.cliCalls,[]);
 validateMissionJournalLineage(f.store.inspect());
});

test('a route the owner closed stays closed: the first message turns nothing on',async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!,codex=connections.list().connections.find(c=>c.providerType==='codex-cli')!;
 const {profileId}=await connections.save(()=>connections.selectModel(codex.id,{model:BUILTIN_CLI_RECOMMENDED_MODELS['codex-cli'],label:BUILTIN_CLI_RECOMMENDED_MODELS['codex-cli'],expectedConfigHash:codex.configHash}));
 assert.deepEqual(await connections.activateFromSelection({connectionId:codex.id,profileId,origin:'owner-typed'}),{status:'turned-on',reason:null,routeSet:true});
 await connections.save(()=>connections.removeRepresentative({expectedConfigHash:connections.list().configHash}));
 const assistant=new AssistantService(f.store,new ProductService(f.store,undefined,connections),connections);
 const answer=await assistant.send({commandId:'q-1',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'},undefined,'owner-typed');
 assert.equal(answer.turn?.status,'not_started');
 const state=await aggregate(f.store);
 assert.deepEqual(state?.activations.map(a=>[a.connectionId,a.way]),[[codex.id,'model-selected']],'no second activation for the closed route');
 assert.equal(state?.routeChoice,null);assert.equal(connections.connectionOn(claude.id),false);
 assert.deepEqual(f.cliCalls,[]);
 validateMissionJournalLineage(f.store.inspect());
});

test('two first messages racing on one revision: one activation, one route, one answer',async t=>{
 const f=await fixture(t);
 // Signal-based entry gate (issue #227): each request signals when it reaches the segment commit, and the gate opens only after BOTH signalled; no event-loop-turn counting.
 const firstSegment=segmentId(1);
 let opened=false,entered=0;
 let openGate!:()=>void,secondEntered!:()=>void;const gate=new Promise<void>(resolve=>openGate=resolve),bothEntered=new Promise<void>(resolve=>secondEntered=resolve);
 const gatedStore=new Proxy(f.store,{
  get(target,property){
   if(property!=='commit')return Reflect.get(target,property);
   return async(input:Parameters<InMemoryStore<Mission>['commit']>[0])=>{
   if(input.id===firstSegment&&!opened){if(++entered===2)secondEntered();await gate;}
    return await target.commit(input);
   };
  }
 }) as InMemoryStore<Mission>;
 const connections=f.host(gatedStore);await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!,codex=connections.list().connections.find(c=>c.providerType==='codex-cli')!;
 const assistant=new AssistantService(gatedStore,new ProductService(gatedStore,undefined,connections),connections);
 const racing=[assistant.send({commandId:'race-a',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'},undefined,'owner-typed'),assistant.send({commandId:'race-b',segment:1,expectedRevision:0,text:'3+3? Reply with just the numeral.'},undefined,'owner-typed')];
 await bothEntered;openGate();opened=true;
 const results=await Promise.all(racing);
 // The two answers are compared first: with the store's revision lane removed both messages commit and fail here, not on a later count.
 const committed=results.filter(result=>result.message.status==='committed'),refused=results.filter(result=>result.message.status!=='committed');
 assert.equal(committed.length,1,'exactly one first message was accepted');
 assert.equal(refused.length,1,'the racing second message lost at the segment revision');
 assert.equal(committed[0]!.turn?.status,'answered');assert.equal(committed[0]!.turn?.reply,'4');
 assert.equal(refused[0]!.turn,null);
 const state=await aggregate(f.store);
 assert.deepEqual(state?.activations.map(a=>[a.connectionId,a.way]),[[claude.id,'first-message']],'one activation');
 assert.equal(state?.routeChoice?.connectionId,claude.id,'one route');
 assert.equal(connections.connectionOn(codex.id),false);
 assert.deepEqual(f.cliCalls,['claude']);
 validateMissionJournalLineage(f.store.inspect());
});

test('after the pick, selecting the other provider in Settings turns it on and never replaces the route',async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!,codex=connections.list().connections.find(c=>c.providerType==='codex-cli')!;
 const assistant=new AssistantService(f.store,new ProductService(f.store,undefined,connections),connections);
 const first=await assistant.send({commandId:'q-1',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'},undefined,'owner-typed');
 assert.equal(first.turn?.status,'answered');
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

test('an idempotency conflict on the activation command with an empty stored state turns nothing on',async t=>{
 const f=await fixture(t);
 // The derived activation command id is already used by an operation on another aggregate (a Mission holds it), so the store itself refuses the commit with reason idempotency; no path ever turned a connection on.
 await new Application(f.store,[{id:'owner',roles:['owner']}]).create({id:'collision-probe',purpose:'Holds a used command identity',scope:'local',constraints:[],criteria:{version:1,description:'Collision holder',oracle:'fixture/v1'}},'owner',activationCommandId('q-1','first-message'));
 const connections=f.host();await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!;
 const assistant=new AssistantService(f.store,new ProductService(f.store,undefined,connections),connections);
 const answer=await assistant.send({commandId:'q-1',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'},undefined,'owner-typed');
 assert.equal(answer.message.status,'committed');
 assert.equal(answer.turn?.status,'failed');
 assertNotSentConsistent(answer);
 assert.deepEqual(answer.activation,{status:'not-turned-on',connectionId:null,pickedBy:null,reason:'duplicate-command-not-on'});
 assert.equal(await aggregate(f.store),undefined,'no activation record exists');
 assert.equal(connections.connectionOn(claude.id),false);
 assert.deepEqual(f.cliCalls,[],'no model call was made');
 validateMissionJournalLineage(f.store.inspect());
});

test('an idempotency conflict after the same command identity turned the candidate on answers already-on from the stored state',async t=>{
 const f=await fixture(t);
 const derived=activationCommandId('q-1','first-message');
 const rawCommit=f.store.commit.bind(f.store);
 let claudeId='',concurrentRoute:RouteSnapshot|undefined,duplicateLanded=false;
 const gatedStore=new Proxy(f.store,{
  get(target,property){
   if(property!=='commit')return Reflect.get(target,property);
   return async(input:Parameters<InMemoryStore<Mission>['commit']>[0])=>{
    if(input.id===CONNECTION_ACTIVATION_ID&&input.commandId===derived&&concurrentRoute&&!duplicateLanded){
     duplicateLanded=true;
     // The same command id lands first with a different fingerprint (a different at): it really turned the candidate on.
     const concurrent={kind:'turn-on' as const,commandId:derived,connectionId:claudeId,way:'first-message' as const,at:1,messageId:ownerMessageId('q-1'),messageOrigin:'owner-typed' as const,detectedLogins:[claudeId],route:concurrentRoute};
     const applied=applyActivation(parseActivation(undefined),concurrent);
     await rawCommit({id:CONNECTION_ACTIVATION_ID,commandId:derived,fingerprint:activationFingerprint(concurrent),expectedRevision:0,value:applied.value,events:applied.events,outbox:[]} as unknown as Parameters<InMemoryStore<Mission>['commit']>[0]);
    }
    return await target.commit(input);
   };
  }
 }) as InMemoryStore<Mission>;
 const connections=f.host(gatedStore);await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!;
 claudeId=claude.id;
 const candidate=await connections.firstMessageCandidate();assert.ok(candidate);
 concurrentRoute={model:candidate.route.model,profileId:candidate.route.profileId,configHash:candidate.route.configHash,outputTokenCap:candidate.route.outputTokenCap,intakeMissionId:'assistant-intake'};
 const assistant=new AssistantService(gatedStore,new ProductService(gatedStore,undefined,connections),connections);
 const answer=await assistant.send({commandId:'q-1',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'},undefined,'owner-typed');
 assert.equal(answer.turn?.status,'answered');assert.equal(answer.turn?.reply,'4');
 assert.deepEqual(answer.activation,{status:'already-on',connectionId:claude.id,pickedBy:null,reason:null});
 assert.deepEqual(f.cliCalls,['claude'],'the stored route answers; nothing is picked twice');
 assert.deepEqual((await aggregate(f.store))?.activations.map(a=>[a.connectionId,a.way]),[[claude.id,'first-message']]);
 assert.equal(f.store.inspect().filter(op=>op.aggregateId===CONNECTION_ACTIVATION_ID).length,1,'only the duplicate that landed first is recorded');
 validateMissionJournalLineage(f.store.inspect());
});

test('an idempotency conflict where the stored state shows another connection on turns nothing on',async t=>{
 const f=await fixture(t);
 const derived=activationCommandId('q-1','first-message');
 const rawCommit=f.store.commit.bind(f.store);
 let codexId='',duplicateLanded=false;
 const concurrentRoute:RouteSnapshot={model:BUILTIN_CLI_RECOMMENDED_MODELS['codex-cli'],profileId:'profile:codex-first',configHash:'b'.repeat(64),outputTokenCap:4,intakeMissionId:'assistant-intake'};
 const gatedStore=new Proxy(f.store,{
  get(target,property){
   if(property!=='commit')return Reflect.get(target,property);
   return async(input:Parameters<InMemoryStore<Mission>['commit']>[0])=>{
    if(input.id===CONNECTION_ACTIVATION_ID&&input.commandId===derived&&!duplicateLanded){
     duplicateLanded=true;
     // The command id was used first by a login start for the other provider: the stored aggregate holds Codex on, Claude not.
     const concurrent={kind:'turn-on' as const,commandId:derived,connectionId:codexId,way:'login-started' as const,at:1,route:concurrentRoute};
     const applied=applyActivation(parseActivation(undefined),concurrent);
     await rawCommit({id:CONNECTION_ACTIVATION_ID,commandId:derived,fingerprint:activationFingerprint(concurrent),expectedRevision:0,value:applied.value,events:applied.events,outbox:[]} as unknown as Parameters<InMemoryStore<Mission>['commit']>[0]);
    }
    return await target.commit(input);
   };
  }
 }) as InMemoryStore<Mission>;
 const connections=f.host(gatedStore);await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!,codex=connections.list().connections.find(c=>c.providerType==='codex-cli')!;
 codexId=codex.id;
 const assistant=new AssistantService(gatedStore,new ProductService(gatedStore,undefined,connections),connections);
 const answer=await assistant.send({commandId:'q-1',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'},undefined,'owner-typed');
 assert.equal(answer.message.status,'committed');
 assert.equal(answer.turn?.status,'failed');
 assertNotSentConsistent(answer);
 assert.deepEqual(answer.activation,{status:'not-turned-on',connectionId:null,pickedBy:null,reason:'duplicate-command-not-on'});
 assert.equal(connections.connectionOn(claude.id),false,'the candidate is not on');
 assert.equal(connections.connectionOn(codex.id),true,'the connection the store really holds stays reported on');
 assert.deepEqual(f.cliCalls,[],'no model call was made');
 assert.deepEqual((await aggregate(f.store))?.activations.map(a=>[a.connectionId,a.way]),[[codex.id,'login-started']]);
 validateMissionJournalLineage(f.store.inspect());
});

test('the connection was already on when the duplicate landed and its route cannot be read: the turn says only that',async t=>{
 const f=await fixture(t);
 // The stored-settings read fails the moment the activation aggregate is written, as in the route-unusable test; here the write is the concurrent duplicate, so this message did not turn the connection on.
 let sabotaged=false;
 const settingsLoad=f.settings.load.bind(f.settings);
 (f.settings as unknown as {load:(scope:string)=>Promise<unknown>}).load=async(scope:string)=>{if(sabotaged)throw new Error('fixture: the stored settings could not be read');return await settingsLoad(scope);};
 const derived=activationCommandId('q-1','first-message');
 const rawCommit=f.store.commit.bind(f.store);
 let claudeId='',concurrentRoute:RouteSnapshot|undefined,duplicateLanded=false;
 const gatedStore=new Proxy(f.store,{
  get(target,property){
   if(property!=='commit')return Reflect.get(target,property);
   return async(input:Parameters<InMemoryStore<Mission>['commit']>[0])=>{
    if(input.id===CONNECTION_ACTIVATION_ID&&input.commandId===derived&&concurrentRoute&&!duplicateLanded){
     duplicateLanded=true;sabotaged=true;
     const concurrent={kind:'turn-on' as const,commandId:derived,connectionId:claudeId,way:'first-message' as const,at:1,messageId:ownerMessageId('q-1'),messageOrigin:'owner-typed' as const,detectedLogins:[claudeId],route:concurrentRoute};
     const applied=applyActivation(parseActivation(undefined),concurrent);
     await rawCommit({id:CONNECTION_ACTIVATION_ID,commandId:derived,fingerprint:activationFingerprint(concurrent),expectedRevision:0,value:applied.value,events:applied.events,outbox:[]} as unknown as Parameters<InMemoryStore<Mission>['commit']>[0]);
    }
    return await target.commit(input);
   };
  }
 }) as InMemoryStore<Mission>;
 const connections=f.host(gatedStore);await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!;
 claudeId=claude.id;
 const candidate=await connections.firstMessageCandidate();assert.ok(candidate);
 concurrentRoute={model:candidate.route.model,profileId:candidate.route.profileId,configHash:candidate.route.configHash,outputTokenCap:candidate.route.outputTokenCap,intakeMissionId:'assistant-intake'};
 const assistant=new AssistantService(gatedStore,new ProductService(gatedStore,undefined,connections),connections);
 const answer=await assistant.send({commandId:'q-1',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'},undefined,'owner-typed');
 assert.equal(answer.message.status,'committed');
 assert.equal(answer.turn?.status,'failed');
 assertNotSentConsistent(answer);
 assert.deepEqual(answer.activation,{status:'already-on',connectionId:claude.id,pickedBy:null,reason:'turned-on-route-unusable'});
 assert.equal(connections.connectionOn(claude.id),true,'the connection really is on');
 assert.deepEqual(f.cliCalls,[],'no model call was made');
 validateMissionJournalLineage(f.store.inspect());
});

test('the first-message login order is a release-fixed table: Claude Code CLI, then Codex CLI',()=>{
 assert.deepEqual([...FIRST_MESSAGE_LOGIN_ORDER],['claude-code-cli','codex-cli']);
 assert.deepEqual(MODEL_PROVIDER_TYPES.filter(provider=>isCliProvider(provider.id)).map(provider=>provider.id),[...FIRST_MESSAGE_LOGIN_ORDER],'no subscription CLI provider exists outside the order; a future one must join it or it can never be picked');
});
