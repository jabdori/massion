/** Explicitly authorized live smoke. Importing this module never launches a host or model. */
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,mkdtemp,realpath,writeFile,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnCliRunner,parseCodexEvents} from '../src/cli-agent-providers.ts';
import type {CliRunner} from '../src/cli-agent-providers.ts';
import {ConnectionWorkbench} from '../src/connection-workbench.ts';
import {compileHostBindings,parseHostManifest} from '../src/host-connections.ts';
import {createWorkbench} from '../src/server.ts';
import {createHttpRpcTransport,initializeSurrealSchema,SurrealHostSettings,SurrealStore} from '../src/storage.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';
import {createProtocolClient,createHttpTransport} from '../src/client-protocol.ts';
import type {Mission,Work} from '../src/domain.ts';

const EXECUTOR='gpt-6.1-terra',CHECKER='zai/glm-5.3',CAP=8,OUTPUT_CAP=2048;
interface Call {number:number;role:'representative'|'executor'|'checker'|'discriminator';model:string;modelIdentity:'requested';startedAt:string;durationMs:number|null;status:'completed'|'failed'|'unknown';inputTokens:number|null;outputTokens:number|null;reason:string;exitCode:number|null;diagnostic:string|null}
export interface SmokeReport {startedAt:string;finishedAt:string|null;durationMs:number|null;status:'running'|'passed'|'failed';stage:string;callCap:number;capReached:boolean;calls:Call[];verdicts:{status:string;relation:string|null}[];directAnswer:boolean;readback:{recordId:string;sha256:string;byteLength:number}|null;drain:string|null}
export const newReport=(callCap:8|120=CAP):SmokeReport=>({startedAt:new Date().toISOString(),finishedAt:null,durationMs:null,status:'running',stage:'startup',callCap,capReached:false,calls:[],verdicts:[],directAnswer:false,readback:null,drain:null});

export async function writeReport(root:string,report:SmokeReport){
 const unknown=report.calls.filter(c=>c.status==='unknown').map(c=>c.number);
 const rows=report.calls.map(c=>`| ${c.number} | ${c.role} | ${c.model} | ${c.inputTokens??'unknown'} | ${c.outputTokens??'unknown'} | ${c.durationMs??'unknown'} | ${c.status} (${c.reason}; ${c.diagnostic??'no diagnostic'}) |`).join('\n');
 const markdown=`# Real-model smoke\n\nStatus: ${report.status}; stage: ${report.stage}.\nStarted: ${report.startedAt}; duration: ${report.durationMs??'unknown'} ms.\nCalls: ${report.calls.length}/${report.callCap}; cap reached: ${report.capReached}.\nModel identities: requested, not independently attested. CLI transport/stream retries are disabled; the cap counts single-shot CLI invocations. Upstream service-internal attempts are not observable.\n\n| Call | Role | Model | Input tokens | Output tokens | Duration ms | Outcome |\n| --- | --- | --- | --- | --- | --- | --- |\n${rows}\n\nDirect answer: ${report.directAnswer}.\nVerdicts: ${report.verdicts.map(v=>v.status+' / '+v.relation).join(', ')||'none'}.\nReadback: ${report.readback?report.readback.sha256+' ('+report.readback.byteLength+' bytes)':'none'}.\nUnknown outcomes: ${unknown.join(', ')||'none'}.\nHost drain: ${report.drain??'unknown'}.\n`;
 await writeFile(join(root,'report.json'),JSON.stringify({...report,unknownOutcomes:unknown},null,2)+'\n',{mode:0o600});
 await writeFile(join(root,'report.md'),markdown,{mode:0o600});
}

/** Reserve before awaiting: concurrent dispatches cannot pass the cap together. */
export function createSmokeRunner(report:SmokeReport,checkpoint:()=>Promise<void>,runner:CliRunner=spawnCliRunner,clock=Date.now,routerUrl:string):CliRunner {
 assert.ok([8,120].includes(report.callCap),'Only smoke or evaluation call caps are authorized');const cap=report.callCap;
 const router=new URL(routerUrl);assert.ok(router.protocol==='http:'&&router.hostname==='127.0.0.1'&&router.port&&router.pathname==='/v1'&&!router.username&&!router.password&&!router.search&&!router.hash,'Explicit loopback router /v1 URL required');
 let fenced=false;
 return async invocation=>{
  if(report.calls.length>=cap){report.capReached=true;fenced=true;throw new Error('Smoke call cap reached');}
  if(fenced)throw new Error('Smoke dispatch fenced');
  const model=invocation.args[invocation.args.indexOf('-m')+1];
  if(invocation.command!=='codex'||![EXECUTOR,CHECKER].includes(model!)){fenced=true;throw new Error('Smoke model refused');}
  const prompt=JSON.parse(invocation.stdin),role=prompt.discriminator===true?'discriminator':model===CHECKER?'checker':Object.hasOwn(prompt,'currentMessage')?'representative':'executor';
  const started=clock(),call:Call={number:report.calls.length+1,role,model:model!,modelIdentity:'requested',startedAt:new Date(started).toISOString(),durationMs:null,status:'unknown',inputTokens:null,outputTokens:null,reason:'intent-checkpoint',exitCode:null,diagnostic:null};
  report.calls.push(call);
  try{
   await checkpoint();
   const settings=['model_provider="smoke"','model_providers.smoke.name="Massion smoke router"',`model_providers.smoke.base_url=${JSON.stringify(routerUrl)}`,'model_providers.smoke.wire_api="responses"','model_providers.smoke.requires_openai_auth=false','model_providers.smoke.request_max_retries=0','model_providers.smoke.stream_max_retries=0'];
   const result=await runner({...invocation,args:[...invocation.args.slice(0,-1),...settings.flatMap(s=>['-c',s]),invocation.args.at(-1)!]});
   // Retain measured usage even when exit/timeout/parse rules make the outcome unknown.
   const usage=[];for(const line of result.stdout.split('\n'))try{const e=JSON.parse(line);if(e?.type==='turn.completed')usage.push(e.usage);}catch{}
   if(usage.length===1)for(const [field,key] of [['inputTokens','input_tokens'],['outputTokens','output_tokens']] as const){const n=usage[0]?.[key];if(Number.isSafeInteger(n)&&n>=0)call[field]=n;}
   const parsed=parseCodexEvents(result.stdout,OUTPUT_CAP);call.exitCode=result.exitCode;
   call.reason=!result.spawned?'not-started':result.timedOut?'timeout':result.aborted?'aborted':result.overflow?'overflow':result.exitCode!==0?'cli-nonzero-exit':parsed.reason;
   const diagnostic=result.stderr+'\n'+result.stdout;
   for(const [pattern,label] of [[/reserved built-in provider IDs/i,'unsupported-provider-override'],[/reasoning.{0,60}(unsupported|not supported|invalid)/i,'unsupported-reasoning'],[/(401|unauthorized|authentication|not logged in)/i,'authentication'],[/(429|rate.limit)/i,'rate-limit'],[/(model.{0,60}(not found|not available|unsupported))/i,'model-unavailable'],[/(connection refused|connection reset|connect error)/i,'connection'],[/(unknown variant|invalid type|missing field|deserializ|failed to parse)/i,'cli-schema']] as const)if(pattern.test(diagnostic)){call.diagnostic=label;break;}
   call.status=!result.spawned?'failed':result.exitCode!==0||result.timedOut||result.aborted||result.overflow?'unknown':parsed.status==='completed'?'completed':'unknown';
   if(call.status!=='completed')fenced=true;
   return result;
  }catch{fenced=true;throw new Error('Smoke CLI or checkpoint failed; dispatch fenced');}
  finally{call.durationMs=Math.max(0,clock()-started);await checkpoint();}
 };
}

async function freePort(){const s=createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const a=s.address();assert.ok(a&&typeof a==='object');await new Promise<void>(r=>s.close(()=>r()));return a.port;}
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));

async function runFlow(root:string,report:SmokeReport,endpoint:string,signal:AbortSignal){
 const rpc=createHttpRpcTransport({endpoint,namespace:'real_smoke',database:'real_smoke'});
 signal.throwIfAborted();await initializeSurrealSchema(rpc,signal);
 const store=new SurrealStore<Mission>(rpc),artifacts=new TextArtifactStore(join(root,'artifacts'));
 const manifest=parseHostManifest({version:1,revision:'real-smoke-v1',mode:'https',connections:[{id:'codex',label:'Smoke Codex',providerType:'codex-cli',baseUrl:'cli://codex/',models:[EXECUTOR,CHECKER]}]});
 const {bindings}=compileHostBindings(manifest,()=>{throw new Error('No credential lookup permitted');});
 const connections=new ConnectionWorkbench(store,artifacts,{hostBindings:bindings,settings:new SurrealHostSettings(rpc),allowLiveExecution:true,transport:async()=>{throw new Error('HTTP provider calls forbidden');},cliRunner:createSmokeRunner(report,()=>writeReport(root,report),spawnCliRunner,Date.now,process.env.MASSION_SMOKE_ROUTER_URL!)});
 await connections.restoreSettings();
 const server=createWorkbench(store,join(root,'workspaces'),{connections,artifacts,scheduleIntervalMs:0});
 server.listen(0,'127.0.0.1');await once(server,'listening');const a=server.address();assert.ok(a&&typeof a==='object');
 const stop=()=>{void server.drain();};signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();
 const base=`http://127.0.0.1:${a.port}`,client=createProtocolClient(createHttpTransport((path,init)=>fetch(new URL(String(path),base),init)));
 async function query(path:string){const r=await client.query(path,{scope:path},10000);assert.ok(r.response.ok,'Protocol query rejected');return r.body;}
 async function command(path:string,payload:Record<string,unknown>){const r=await client.dispatch(path,{body:JSON.stringify(payload)},90000);assert.ok(r.response.ok,'Protocol command rejected');return r.body;}
 try{
  report.stage='configure';assert.equal((await client.connection()).state,'ready');
  await command('/missions',{id:'smoke-intake',commandId:'smoke-create',purpose:'Synthetic real-model smoke',scope:'smoke-only',constraints:['Return only the requested bounded text; use no tools.'],criteria:{version:1,description:'The artifact answers the original owner request exactly, without extra text.',oracle:'bounded-text-review/v1'}});
  let config=await query('/connections');const profiles=config.runtime.connections as {id:string;model:string}[];
  const executor=profiles.find(p=>p.model===EXECUTOR)!,checker=profiles.find(p=>p.model===CHECKER)!;assert.ok(executor&&checker);
  config=await command('/connection-authorizations',{id:'smoke-grant',scope:'smoke-only',executorProfileId:executor.id,verifierProfileId:checker.id,maxOutputTokensPerCall:OUTPUT_CAP,expectedConfigHash:config.configHash});
  config=await command('/connection-defaults',{authorizationId:'smoke-grant',outputTokenCap:OUTPUT_CAP,expectedConfigHash:config.configHash});
  assert.equal(config.runtime.defaultRoutes[0].check,'different-family');
  await command('/assistant-settings',{profileId:executor.id,outputTokenCap:OUTPUT_CAP,intakeMissionId:'smoke-intake',expectedConfigHash:config.configHash});
  async function say(text:string,commandId:string){const v=await query('/assistant/conversation');return command('/assistant/messages',{commandId,segment:v.head||1,expectedRevision:v.segment?.revision??0,text});}
  report.stage='direct-answer';
  const direct=await say('What is 2 + 2? Reply with just the numeral.','smoke-question');
  assert.equal(direct.turn?.status,'answered');assert.equal(direct.turn.reply.trim(),'4');assert.equal(direct.turn.outcome,undefined);
  assert.equal((await query('/missions/smoke-intake')).value.works.length,0);report.directAnswer=true;
  report.stage='work';
  const reply=await say('Produce a text artifact containing exactly SMOKE_OK (no other text). Have it independently checked before accepting it.','smoke-work');
  assert.equal(reply.turn?.status,'answered');assert.equal(reply.turn.outcome?.work.status,'admitted');assert.equal(reply.turn.outcome?.run.status,'requested');
  const deadline=Date.now()+150000;let work:Work|undefined;
  while(Date.now()<deadline){
   const mission=(await query('/missions/smoke-intake')).value as Mission;assert.equal(mission.works.length,1);work=mission.works[0]!;
   if(work.acceptance==='accepted'||work.execution==='settled'&&work.verdict?.status==='failed'||work.effects.some(e=>e.status==='unknown')||report.calls.some(c=>c.durationMs!==null&&c.status!=='completed'))break;
   await pause(100);
  }
  assert.ok(work);if(work.verdict)report.verdicts.push({status:work.verdict.status,relation:work.verdict.check?.relation??null});
  assert.equal(work.acceptance,'accepted');assert.equal(work.record?.evidenceClass,'real-provider');assert.equal(work.record.verdict.check?.relation,'different-family');
  report.stage='readback';
  const record=work.record,params=new URLSearchParams({work:work.id,record:record.id,version:String(record.artifact.version),sha256:record.artifact.sha256});
  const result=await query('/missions/smoke-intake/record-artifact?'+params);
  assert.equal(result.recordChecksum,record.checksum);assert.equal(result.content,'SMOKE_OK');
  assert.equal(createHash('sha256').update(result.content).digest('hex'),record.artifact.sha256);
  report.readback={recordId:record.id,sha256:result.artifact.sha256,byteLength:result.byteLength};report.status='passed';report.stage='complete';
 }finally{report.drain=(await server.drain()).status;signal.removeEventListener('abort',stop);if(report.drain!=='drained'||signal.aborted)report.status='failed';}
}

async function main(){
 const [major,minor]=process.versions.node.split('.').map(Number);assert.ok(major===24&&minor!>=19,'Use Node >=24.19.0 <25');
 assert.equal(process.argv.length,2,'No smoke options supported');
 await mkdir(resolve('.runtime/smoke'),{recursive:true,mode:0o700});
 const root=await mkdtemp(join(await realpath('.runtime/smoke'),'run-')),report=newReport();await writeReport(root,report);
 const controller=new AbortController(),stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
 const deadline=setTimeout(stop,240000);let database:ReturnType<typeof spawn>|undefined,closed:Promise<unknown>|undefined;
 try{
  report.stage='database';
  const binary=process.env.MASSION_SURREAL_BINARY??'surreal',version=spawnSync(binary,['version'],{encoding:'utf8',timeout:5000});
  assert.equal(version.status,0,'SurrealDB unavailable');assert.equal(version.stdout.trim().split(' ')[0],'3.3.0','Use SurrealDB 3.3.0');
  const path=join(root,'database'),port=await freePort();await mkdir(join(path,'tmp'),{recursive:true,mode:0o700});
  // Same disposable loopback service flags as with-surreal.py / install-smoke.sh.
  database=spawn(binary,['start','surrealkv://'+join(path,'data'),'--bind',`127.0.0.1:${port}`,'--unauthenticated','--no-banner','--log','error','--temporary-directory',join(path,'tmp'),'--default-namespace','real_smoke','--default-database','real_smoke','--deny-net','--deny-scripting'],{stdio:['ignore','pipe','pipe'],env:{PATH:'/usr/bin:/bin'}});
  let exited=false;database.on('error',()=>{});closed=new Promise<void>(r=>database!.once('close',()=>{exited=true;r();}));database.stdout!.resume();database.stderr!.resume();
  const until=Date.now()+30000;
  for(;;){
   controller.signal.throwIfAborted();assert.ok(!exited&&Date.now()<until,'Database startup failed');
   try{if((await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(500)})).ok)break;}catch{}
   await pause(100);
  }
  await runFlow(root,report,`http://127.0.0.1:${port}/rpc`,controller.signal);
 }catch{report.status='failed';}
 finally{
  if(database&&closed){if(database.exitCode===null&&database.signalCode===null)database.kill('SIGTERM');const timer=setTimeout(()=>database!.kill('SIGKILL'),10000);await closed;clearTimeout(timer);await rm(join(root,'database'),{recursive:true,force:true});}
  clearTimeout(deadline);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
  report.finishedAt=new Date().toISOString();report.durationMs=Date.now()-Date.parse(report.startedAt);await writeReport(root,report);
 }
 console.log(JSON.stringify({status:report.status,stage:report.stage,calls:report.calls.length,report:join(root,'report.json')}));process.exitCode=report.status==='passed'?0:1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
