import test from 'node:test';
import '../src/server.ts';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import type {AssistantSegment} from '../src/assistant-conversation.ts';
import {segmentId} from '../src/assistant-conversation.ts';
import type {Mission} from '../src/domain.ts';
import {createHostConnections,loadHostStartup} from '../src/host-connections.ts';
import {InMemorySecretSlots} from '../src/secret-slots.ts';
import {createHttpRpcTransport,initializeSurrealSchema,SurrealHostSettings,SurrealStore} from '../src/storage.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';
import {tempRoot} from './support/temp-root.ts';

const entry=fileURLToPath(new URL('../src/server.ts',import.meta.url));
const preload=fileURLToPath(new URL('./support/restore-cli-host.mjs',import.meta.url));
const rpc=process.env.MASSION_TEST_SURREAL_RPC;
const namespace=process.env.MASSION_TEST_SURREAL_NAMESPACE!;
const options={skip:!rpc,timeout:20000};
type Mode='never'|'late'|'throws'|'empty'|'timed-out';
type Route='claude-code-cli'|'zai'|'external'|null;

async function fixture(t:TestContext,mode:Mode,route:Route){
 const root=await mkdtemp(join(tempRoot(),'massion-restore-cli-'));
 let stop:(()=>Promise<void>)|undefined;
 t.after(async()=>{try{await stop?.();}finally{await rm(root,{recursive:true,force:true});}});
 const database='restore_cli_'+crypto.randomUUID().replaceAll('-','');
 const transport=createHttpRpcTransport({endpoint:rpc!,namespace,database});
 const store=new SurrealStore<Mission>(transport);
 const claude=join(root,'claude');
 if(mode!=='empty'){
  const answer=JSON.stringify({type:'result',subtype:'success',is_error:false,result:JSON.stringify({reply:'4',work:null}),num_turns:1,usage:{input_tokens:2,cache_creation_input_tokens:0,cache_read_input_tokens:0,output_tokens:4},modelUsage:{'claude-sonnet-5-5':{}}});
  await writeFile(claude,`#!/bin/sh
case "$1" in
 auth) printf '%s\\n' '{"loggedIn":true,"authMethod":"claude.ai"}';;
 *) printf '%s\\n' '${answer}';;
esac
`,{mode:0o700});
 }
 const args:string[]=[];
 if(route==='external'){
  const file=join(root,'host.json');
  await writeFile(file,JSON.stringify({version:1,revision:'restore-external',mode:'https',connections:[{id:'cli',label:'External CLI',providerType:'claude-code-cli',baseUrl:'cli://claude-code/',models:['claude-sonnet-5-5']}]}));
  args.push('--host-config',file,'--allow-live-model-calls');
 }
 await transport.query('DEFINE DATABASE '+database+';',{});await initializeSurrealSchema(transport);
 const settings=new SurrealHostSettings(transport),startup=await loadHostStartup(args);
 const connections=createHostConnections(store,new TextArtifactStore(join(root,'artifacts')),startup,{
  settings,secrets:new InMemorySecretSlots(),readEnvironment:()=>undefined,
  transport:async()=>{throw new Error('Unexpected HTTP provider call');},
  loginStatus:async()=> 'detected'
 });
 await connections.restoreSettings();
 let model:string|undefined;
 if(route){
  const provider=route==='external'?'claude-code-cli':route;
  const connection=connections.list().connections.find(c=>c.providerType===provider)!;
  if(route==='zai'){
   const {profileId}=await connections.save(()=>connections.selectModel(connection.id,{model:'glm-fixture',label:'API fixture',expectedConfigHash:connection.configHash}));
   await connections.turnOnConnection('seed-key',connection.id,'key-added');
   assert.equal(await connections.firstRepresentativeFromSelection(profileId),true);
  }else{
   const profile=connections.list().runtime.connections.find(p=>p.providerKind===provider)!;
   if(route==='external')await connections.setRepresentative({profileId:profile.id,outputTokenCap:8,intakeMissionId:'external-intake',expectedConfigHash:connections.list().configHash});
   else assert.equal((await connections.activateFromSelection({connectionId:connection.id,profileId:profile.id,origin:'owner-typed'})).routeSet,true);
  }
  const catalog=connections.list();
  assert.equal(catalog.representative?.status,'active');
  model=catalog.runtime.connections.find(p=>p.id===catalog.representative?.route.profileId)?.model;
 }
 const reservation=createServer();
 reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
 const address=reservation.address();assert.ok(address&&typeof address==='object');
 const port=address.port;await new Promise<void>(resolve=>reservation.close(()=>resolve()));
 const base='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['--unhandled-rejections=strict','--import',preload,entry,...args],{cwd:root,env:{
  MASSION_SURREAL_RPC:rpc,MASSION_SURREAL_NAMESPACE:namespace,MASSION_SURREAL_DATABASE:database,MASSION_PORT:String(port),
  MASSION_CLAUDE_CLI_COMMAND:claude,MASSION_CODEX_CLI_COMMAND:join(root,'codex'),RESTORE_CLI_CASE:mode
 },stdio:['ignore','pipe','pipe','ipc']});
 const closed=once(child,'close');
 stop=async()=>{
  if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
  const kill=setTimeout(()=>child.kill('SIGKILL'),3000);
  try{await closed;}finally{clearTimeout(kill);}
 };
 assert.ok(child.stdout&&child.stderr);
 const events:unknown[]=[];
 let logs='',checkpoints=0;
 createInterface({input:child.stdout}).on('line',(line:string)=>{
  logs+=line+'\n';
  if(line.startsWith('restore-test ')){
   const event=JSON.parse(line.slice('restore-test '.length));
   if(event==='checkpoint')checkpoints++;else events.push(event);
  }
 });
 child.stderr.on('data',chunk=>logs+=chunk);
 const waitFor=async(check:()=>void)=>await t.waitFor(()=>{
  assert.equal(child.exitCode,null,logs);check();
 },{timeout:10000});
 const started=()=>waitFor(()=>assert.ok(logs.includes('Massion development workbench:'),'server is listening\n'+logs));
 const checkpoint=async()=>{
  const next=checkpoints+1;child.send('checkpoint');
  await waitFor(()=>assert.equal(checkpoints,next));
 };
 const send=(expectedRevision=0)=>fetch(base+'/assistant/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
  commandId:expectedRevision===0?'first-after-restart':'after-late-discovery',segment:1,expectedRevision,text:'2+2?'
 }),signal:AbortSignal.timeout(5000)});
 const list=()=>fetch(base+'/connections',{signal:AbortSignal.timeout(5000)});
 return {child,claude,store,model,events,waitFor,started,checkpoint,send,list};
}

async function sendWithoutExecutable(f:Awaited<ReturnType<typeof fixture>>){
 const response=await f.send();
 assert.equal(response.status,200);
 const answer=await response.json();
 assert.equal(answer.message.status,'committed');
 assert.deepEqual(answer.turn.settlement,{status:'failed',reason:'cli_unavailable_not_started',provider:'claude-code-cli',model:f.model,warnings:0,usage:{inputTokens:null,outputTokens:null,known:false}});
 const snapshot=(await f.store.load(segmentId(1)))!;
 const segment=snapshot.value as unknown as AssistantSegment;
 assert.equal(segment.turns[0]!.receipt,'{"status":"failed","reason":"cli_unavailable_not_started","outputSha256":null,"warnings":0}');
 return snapshot.revision;
}

const claudeDiscovery='discover:claude-code-cli',codexDiscovery='discover:codex-cli';
const pendingDiscovery=[claudeDiscovery,'shell','version'];

test('restore listens with discovery pending forever and preserves the send result',options,async t=>{
 const f=await fixture(t,'never','claude-code-cli');
 await f.waitFor(()=>assert.deepEqual(f.events,pendingDiscovery,'restore started discovery'));
 await f.started();
 await sendWithoutExecutable(f);
 await f.checkpoint();
 assert.deepEqual(f.events,pendingDiscovery,'no model executable ran while discovery was pending');
});

test('discovery completed after listening serves the next message with one CLI call',options,async t=>{
 const f=await fixture(t,'late','claude-code-cli');
 await f.started();
 await f.waitFor(()=>assert.deepEqual(f.events,pendingDiscovery,'restore started discovery'));
 const revision=await sendWithoutExecutable(f);
 await f.checkpoint();
 assert.deepEqual(f.events,pendingDiscovery,'no model executable ran before discovery settled');
 f.child.send('release');
 await f.waitFor(()=>assert.deepEqual(f.events,[...pendingDiscovery,'discovery-turn-ended']));
 const response=await f.send(revision);
 assert.equal(response.status,200);
 const answer=await response.json();
 assert.equal(answer.turn.status,'answered',JSON.stringify(answer.turn));
 assert.equal(answer.turn.reply,'4');
 await f.checkpoint();
 assert.deepEqual(f.events,[...pendingDiscovery,'discovery-turn-ended',await realpath(f.claude)],'one model call used the executable from the original discovery');
});

test('the first GET /connections shares discovery while it is pending',options,async t=>{
 const f=await fixture(t,'late','claude-code-cli');
 await f.started();
 await f.waitFor(()=>assert.deepEqual(f.events,pendingDiscovery,'restore started discovery'));
 const listDiscovery=[...pendingDiscovery,claudeDiscovery,codexDiscovery,'shell'];
 const [list]=await Promise.all([f.list(),(async()=>{
  await f.waitFor(()=>assert.ok(f.events.includes(codexDiscovery)));
  await f.checkpoint();
  assert.deepEqual(f.events,listDiscovery,'only the other provider starts a shell for the first list');
  f.child.send('release');
 })()]);
 assert.equal(list.status,200);
 assert.equal((await list.json()).logins.find((login:{providerType:string})=>login.providerType==='claude-code-cli').status,'detected');
 await f.waitFor(()=>assert.deepEqual(f.events,[...listDiscovery,'discovery-turn-ended']));
});

test('a discovery rejection after listening is handled and the first list retries',options,async t=>{
 const f=await fixture(t,'throws','claude-code-cli');
 await f.started();
 await f.waitFor(()=>assert.deepEqual(f.events,pendingDiscovery,'restore started discovery'));
 f.child.send('reject');
 const rejected=[...pendingDiscovery,'rejection-turn-ended'];
 await f.waitFor(()=>assert.deepEqual(f.events,rejected,'the server survived the rejection turn'));
 await sendWithoutExecutable(f);
 await f.checkpoint();
 assert.deepEqual(f.events,rejected,'no model executable ran');
 const list=await f.list();
 assert.equal(list.status,200);
 const selected=(await list.json()).logins.find((login:{providerType:string})=>login.providerType==='claude-code-cli');
 assert.equal(selected.state,'logged-in','the first ordinary list retries the rejected startup discovery');
 await f.checkpoint();
 assert.deepEqual(f.events,[...rejected,claudeDiscovery,'shell',codexDiscovery,'shell','version'],'the selected provider ran its shell and version check twice, and the other provider ran its shell once');
});

test('discovery empty preserves the send result and is cached for the first list',options,async t=>{
 const f=await fixture(t,'empty','claude-code-cli');
 await f.started();
 const attempts=[claudeDiscovery,'shell'];
 await f.waitFor(()=>assert.deepEqual(f.events,attempts,'restore started discovery'));
 await sendWithoutExecutable(f);
 await f.checkpoint();
 assert.deepEqual(f.events,attempts,'no model executable ran');
 const list=await f.list();
 assert.equal(list.status,200);
 await list.json();
 await f.checkpoint();
 assert.deepEqual(f.events,[...attempts,claudeDiscovery,codexDiscovery,'shell'],'the first list starts a shell only for the other provider');
});

test('discovery timed-out preserves the send result and the first list searches that provider again',options,async t=>{
 const f=await fixture(t,'timed-out','claude-code-cli');
 await f.started();
 const attempts=[claudeDiscovery,'shell','version-timed-out'];
 await f.waitFor(()=>assert.deepEqual(f.events,attempts,'restore started discovery'));
 await sendWithoutExecutable(f);
 await f.checkpoint();
 assert.deepEqual(f.events,attempts,'no model executable ran');
 const list=await f.list();
 assert.equal(list.status,200);
 await list.json();
 await f.checkpoint();
 assert.deepEqual(f.events,[...attempts,claudeDiscovery,'shell',codexDiscovery,'shell','version-timed-out'],'the first list searches the provider whose check ended by waiting again, and the other provider runs its shell once');
});

for(const route of [null,'zai','external'] as const){
 test('restore starts no discovery with '+(route??'no route'),options,async t=>{
  const f=await fixture(t,'empty',route);
  await f.started();
  assert.deepEqual(f.events,[],'restore calls neither discovery nor the shell starter');
 });
}
