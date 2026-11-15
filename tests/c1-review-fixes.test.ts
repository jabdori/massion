import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadHostStartup,createHostConnections,parseHostManifest} from '../src/host-connections.ts';
import {BUILTIN_RESERVED_MODEL_ID} from '../src/connection-workbench.ts';
import {ConnectionLifecycle} from '../src/connection-lifecycle.ts';
import {CONNECTION_ACTIVATION_ID} from '../src/connection-activation.ts';
import type {ConnectionActivationState} from '../src/connection-activation.ts';
import {LoginConnections} from '../src/connection-logins.ts';
import {subscriptionCliHost,subscriptionCliSelections} from '../src/subscription-cli-host.ts';
import {scheduleWorkProducer} from '../src/schedules.ts';
import {AssistantService} from '../src/assistant-service.ts';
import {ProductService} from '../src/product.ts';
import {segmentId} from '../src/assistant-conversation.ts';
import {InMemoryHostSettings,InMemoryStore} from '../src/storage.ts';
import type {Store} from '../src/storage.ts';
import {InMemorySecretSlots} from '../src/secret-slots.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';
import type {Mission} from '../src/domain.ts';
import type {CliRunner} from '../src/cli-agent-providers.ts';

const turn=(reply:string)=>JSON.stringify({reply,work:null});
const activations=async(store:Store<Mission>)=>((await store.load(CONNECTION_ACTIVATION_ID))?.value as unknown as ConnectionActivationState|undefined)?.activations??[];

async function fixture(t:test.TestContext,models=['fixture-a']){
 const root=await mkdtemp(join(tmpdir(),'c1-fixes-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new InMemoryStore<Mission>(),secrets=new InMemorySecretSlots(),settings=new InMemoryHostSettings();
 const cliCalls:string[]=[],inferences:string[]=[];
 const cliRunner:CliRunner=async call=>{cliCalls.push(call.command);return {spawned:true,exitCode:0,stdout:JSON.stringify({type:'result',subtype:'success',is_error:false,result:turn('4'),num_turns:1,usage:{input_tokens:2,cache_creation_input_tokens:972,cache_read_input_tokens:0,output_tokens:4},modelUsage:{'claude-sonnet-5-5':{}}}),stderr:'',timedOut:false,aborted:false,overflow:false};};
 const transport=async(url:string|URL|Request,init?:RequestInit)=>{inferences.push(String(url));if(String(url).endsWith('/models'))return new Response(JSON.stringify({data:models.map(id=>({id}))}),{headers:{'content-type':'application/json'}});return new Response(JSON.stringify({id:'fixture',object:'chat.completion',created:1,model:'fixture',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:turn('ok')}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}),{headers:{'content-type':'application/json'}});};
 const startup=await loadHostStartup([]);
 const host=()=>createHostConnections(store,new TextArtifactStore(join(root,'artifacts')),startup,{secrets,readEnvironment:()=>undefined,transport,settings,cliRunner,loginStatus:async(providerType:string)=>providerType==='claude-code-cli'?'detected' as const:'absent' as const});
 return {root,store,secrets,settings,startup,cliCalls,inferences,host,cliRunner,transport};
}

test('a scheduled send never counts as the owner\'s first message',async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const assistant=new AssistantService(f.store,new ProductService(f.store,undefined,connections),connections);
 const scheduled=await assistant.send({commandId:'sched-1',segment:1,expectedRevision:0,text:'Scheduled fixture request.'},undefined,'scheduled');
 assert.equal(scheduled.turn?.status,'not_started');
 const producer=scheduleWorkProducer(assistant);
 await assert.rejects(producer({commandId:'sched-2',scheduleId:'schedule:x',runId:'run:1',kind:'weekend-groceries',request:'Fixture request'}),/not admitted/);
 assert.deepEqual(await activations(f.store),[]);
 assert.equal(connections.connectionOn(connections.list().connections.find(c=>c.providerType==='claude-code-cli')!.id),false);
 assert.deepEqual(f.cliCalls,[]);assert.deepEqual(f.inferences,[]);
 // The same message, owner-typed, is what turns the connection on.
 const view=await assistant.read();
 const owner=await assistant.send({commandId:'q-1',segment:1,expectedRevision:view.segment!.revision,text:'2+2? Reply with just the numeral.'},undefined,'owner-typed');
 assert.equal(owner.turn?.status,'answered');assert.deepEqual(f.cliCalls,['claude']);
});

test('a detected login does not pick for the owner when a connection is already on',async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const openai=connections.list().connections.find(c=>c.id.includes(':openai:'))!;
 const service=new ConnectionLifecycle(f.store,connections);
 assert.equal((await service.replaceKey({commandId:'key-one',connectionId:openai.id,expectedConfigHash:openai.configHash,apiKey:'fixture-key-value'})).status,'completed');
 assert.equal(connections.connectionOn(openai.id),true);
 const assistant=new AssistantService(f.store,new ProductService(f.store,undefined,connections),connections);
 const result=await assistant.send({commandId:'q-1',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'},undefined,'owner-typed');
 assert.equal(result.turn?.status,'not_started');
 assert.deepEqual((await activations(f.store)).map(a=>a.connectionId),[openai.id]);
 assert.equal(connections.list().representative,null);
 assert.deepEqual(f.cliCalls,[]);assert.deepEqual(f.inferences,[]);
});

test('an empty or whitespace message turns nothing on',async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const assistant=new AssistantService(f.store,new ProductService(f.store,undefined,connections),connections);
 for(const [index,text] of ['','   '].entries())await assert.rejects(assistant.send({commandId:'blank-'+index,segment:1,expectedRevision:0,text},undefined,'owner-typed'),/owner message/);
 assert.deepEqual(await activations(f.store),[]);
 assert.equal(connections.connectionOn(connections.list().connections.find(c=>c.providerType==='claude-code-cli')!.id),false);
 assert.deepEqual(f.cliCalls,[]);assert.deepEqual(f.inferences,[]);
 assert.equal((await f.store.load(segmentId(1)))?.revision??0,0);
});

test('the production assembly provides checked launchers for both subscription CLIs',async()=>{
 const environment:Record<string,string>={'MASSION_CLAUDE_CLI_COMMAND':'/opt/claudes/claude','MASSION_CLAUDE_CLI_TEAM_ID':'CLAUDETEAM','MASSION_CLAUDE_CLI_IDENTIFIER':'com.anthropic.claude','MASSION_CODEX_CLI_COMMAND':'/opt/codex/codex','MASSION_CODEX_CLI_TEAM_ID':'CODEXTEAM','MASSION_CODEX_CLI_IDENTIFIER':'com.openai.codex'};
 const host=subscriptionCliHost(name=>environment[name],new InMemorySecretSlots());
 assert.deepEqual(Object.keys(host.run).sort(),['claude-code-cli/v1','codex-cli/v1']);
 assert.equal(host.run['claude-code-cli/v1']!.command,'/opt/claudes/claude');
 assert.equal(host.run['codex-cli/v1']!.command,'/opt/codex/codex');
 assert.deepEqual(host.logins['claude-code-cli'],{command:'/opt/claudes/claude',teamId:'CLAUDETEAM',identifier:'com.anthropic.claude'});
 assert.deepEqual(subscriptionCliHost(()=>undefined,new InMemorySecretSlots()),{run:{},logins:{}});
 assert.throws(()=>subscriptionCliSelections(name=>name==='MASSION_CLAUDE_CLI_COMMAND'?'/opt/claudes/claude':undefined),/incomplete/);
});

test('an unchecked or missing subscription executable yields the existing typed unavailable result',async t=>{
 const f=await fixture(t),environment:Record<string,string>={'MASSION_CLAUDE_CLI_COMMAND':'/bin/echo','MASSION_CLAUDE_CLI_TEAM_ID':'NEVERTHISTEAM','MASSION_CLAUDE_CLI_IDENTIFIER':'never.this.identifier'};
 const cliHost=subscriptionCliHost(name=>environment[name],f.secrets);
 assert.equal(cliHost.run['claude-code-cli/v1']!.command,'/bin/echo');
 const connections=createHostConnections(f.store,new TextArtifactStore(join(f.root,'artifacts-live')),f.startup,{secrets:f.secrets,readEnvironment:()=>undefined,transport:f.transport,settings:f.settings,cliLaunchers:cliHost.run,loginStatus:async(providerType:string)=>providerType==='claude-code-cli'?'detected' as const:'absent' as const});
 await connections.restoreSettings();
 const assistant=new AssistantService(f.store,new ProductService(f.store,undefined,connections),connections);
 const result=await assistant.send({commandId:'q-1',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'},undefined,'owner-typed');
 assert.equal(result.turn?.status,'failed');
 const segment=(await f.store.load(segmentId(1)))!.value as any;
 assert.match(segment.turns[0].receipt,/cli_unavailable_not_started/);
 assert.deepEqual(f.cliCalls,[]);
});

test('login detection resolves only the checked executable, never a bare PATH name',async()=>{
 const commands:string[]=[];
 const runner=async(call:any)=>{commands.push(call.command);const codex=call.command.includes('codex');return {spawned:true,exitCode:codex?1:0,stdout:codex?'':JSON.stringify({loggedIn:true,authMethod:'claude.ai'}),stderr:codex?'Not logged in':'',timedOut:false,aborted:false,overflow:false};};
 const selection={command:'/opt/checked/claude',teamId:'CLAUDETEAM',identifier:'com.anthropic.claude'};
 const verified=new LoginConnections(runner,{subscriptions:{'claude-code-cli':selection},verify:async command=>command});
 assert.deepEqual((await verified.list()).map(s=>s.status),['detected','absent']);assert.deepEqual([...commands].sort(),['/opt/checked/claude','codex'].sort());
 commands.length=0;
 const rejected=new LoginConnections(async()=>{throw new Error('no spawn');},{subscriptions:{'claude-code-cli':selection},verify:async()=>{throw new Error('unchecked');}});
 assert.deepEqual((await rejected.list()).map(s=>s.status),['unknown','unknown']);
 const unconfigured=new LoginConnections();
 assert.deepEqual((await unconfigured.list()).map(s=>s.status),['unknown','unknown']);
 await assert.rejects(unconfigured.start({providerType:'claude-code-cli',commandId:'login:1'}),/unavailable/);
 assert.equal(commands.length,0);
});

test('the built-in list and a look-alike host file never share a settings scope',async t=>{
 const f=await fixture(t);
 const builtin=f.host();await builtin.restoreSettings();
 assert.match(builtin.list().persistence!.scope!,/^builtin:/);
 const lookalike=parseHostManifest({version:1,revision:'builtin-v1',mode:'https',connections:[
  {id:'claude',label:'Claude Code',providerType:'claude-code-cli',baseUrl:'cli://claude-code/',models:['claude-sonnet-5-5']},
  {id:'codex',label:'Codex',providerType:'codex-cli',baseUrl:'cli://codex/',models:['gpt-6.1-terra']},
  {id:'anthropic',label:'Anthropic API',providerType:'anthropic',baseUrl:'https://api.anthropic.com/v1/',models:['lookalike-model'],credential:{ref:'anthropic-key',slot:'api-key',source:{kind:'own'}}},
  {id:'openai',label:'OpenAI API',providerType:'openai',baseUrl:'https://api.openai.com/v1/',models:['lookalike-model'],credential:{ref:'openai-key',slot:'api-key',source:{kind:'own'}}},
  {id:'zai',label:'Z.ai GLM Coding Plan',providerType:'zai',baseUrl:'https://api.z.ai/api/coding/paas/v4/',models:['lookalike-model'],credential:{ref:'zai-key',slot:'api-key',source:{kind:'own'}}}]});
 const fileHost=createHostConnections(f.store,new TextArtifactStore(join(f.root,'artifacts-file')),{manifest:lookalike,allowLiveExecution:false},{secrets:f.secrets,readEnvironment:()=>undefined,transport:f.transport,settings:f.settings});
 assert.match(fileHost.list().persistence!.scope!,/^manifest:/);
 assert.notEqual(fileHost.list().persistence!.scope,builtin.list().persistence!.scope);
 const fileOpenai=fileHost.list().connections.find(c=>c.id.includes(':openai:'))!;
 await fileHost.save(()=>fileHost.selectModel(fileOpenai.id,{model:'lookalike-model',label:'Lookalike',expectedConfigHash:fileOpenai.configHash}));
 assert.equal(fileHost.list().persistence!.revision,1);
 // The built-in list on the same database reads none of the file's stored settings.
 const freshBuiltin=f.host();await freshBuiltin.restoreSettings();
 assert.equal(freshBuiltin.list().persistence!.revision,0);
 assert.equal((freshBuiltin.list().runtime.connections as any[]).some(p=>p.model==='lookalike-model'),false);
});

test('activation conflicts leave the connection off with no committed record',async t=>{
 const f=await fixture(t),seed=f.host();await seed.restoreSettings();
 const claude=seed.list().connections.find(c=>c.providerType==='claude-code-cli')!;
 const override=(get:(key:string)=>unknown)=>new Proxy(f.store,{get(target,key){const intercepted=typeof key==='string'?get(key):undefined;if(intercepted!==undefined)return intercepted;const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const cases=[[override(key=>key==='commit'?async(input:any)=>input.id===CONNECTION_ACTIVATION_ID?{status:'conflict' as const,reason:'revision' as const,revision:0}:f.store.commit(input):undefined),/could not be recorded/],[override(key=>key==='lookupOperation'?async(identity:any)=>identity.id===CONNECTION_ACTIVATION_ID?{status:'conflict' as const,revision:0,reason:'idempotency' as const}:f.store.lookupOperation(identity):undefined),/record mismatch/]] as const;
 for(const [store,message] of cases){
  const onConflict=createHostConnections(store,new TextArtifactStore(join(f.root,'conflict-'+Math.random().toString(36).slice(2))),f.startup,{secrets:f.secrets,readEnvironment:()=>undefined,transport:f.transport,settings:f.settings,cliRunner:f.cliRunner,loginStatus:async()=>'absent'});
  await assert.rejects(onConflict.turnOnConnection('conflict-command',claude.id,'key-added'),message);
  assert.equal(onConflict.connectionOn(claude.id),false);
 }
 assert.deepEqual(await activations(f.store),[]);
});

test('the reserved placeholder model id is refused everywhere a model id is accepted',async t=>{
 assert.equal(BUILTIN_RESERVED_MODEL_ID,'unset');
 const f=await fixture(t,['unset','fixture-a']),connections=f.host();await connections.restoreSettings();
 const openai=connections.list().connections.find(c=>c.id.includes(':openai:'))!;
 await new ConnectionLifecycle(f.store,connections).replaceKey({commandId:'key-first',connectionId:openai.id,expectedConfigHash:openai.configHash,apiKey:'fixture-key-value'});
 const discovered=await connections.discover(openai.id,openai.configHash);
 assert.deepEqual(discovered.models!.map(m=>m.id),['fixture-a']);
 await assert.rejects(connections.save(()=>connections.selectModel(openai.id,{model:'unset',label:'Placeholder',expectedConfigHash:openai.configHash})),/not selectable/);
 assert.equal((connections.list().runtime.connections as any[]).some(p=>p.model==='unset'),false);
});

