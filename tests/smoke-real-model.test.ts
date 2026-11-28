import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tempRoot} from './support/temp-root.ts';
import {join} from 'node:path';
import {createSmokeRunner,newReport,writeReport} from '../scripts/smoke-real-model.ts';
import {cliProfileFactory} from '../src/cli-agent-providers.ts';
import type {CliResult,CliRunner,CodexTextCall} from '../src/cli-agent-providers.ts';
import {codexFeatureListing,codexMcpServerListing,codexProbeResult} from './support/codex-probes.ts';

const fixture:CliResult={spawned:true,exitCode:0,stdout:[{type:'item.completed',item:{type:'agent_message',text:'fixture answer'}},{type:'turn.completed',usage:{input_tokens:11,output_tokens:7}}].map(e=>JSON.stringify(e)).join('\n'),stderr:'secret-fixture-value',timedOut:false,aborted:false,overflow:false};
const model='gpt-6.1-terra',prompt='{"currentMessage":"fixture"}',router='http://127.0.0.1:10100/v1';
const invocation=async(t:test.TestContext):Promise<CodexTextCall>=>{
 const cwd=await mkdtemp(join(tempRoot(),'smoke-invocation-'));
 t.after(()=>rm(cwd,{recursive:true,force:true}));
 return {command:'codex',stdin:prompt,cwd,env:{CODEX_HOME:cwd,SECRET:'secret-fixture-value'},timeoutMs:2500,maxOutputBytes:10000,signal:AbortSignal.timeout(5000)};
};
const withProbes=(runner:CliRunner):CliRunner=>async call=>codexProbeResult(call)??runner(call);

test('the directly called smoke runner refuses a nonempty MCP listing before a model call',{timeout:10000},async t=>{
 const report=newReport(),stages:string[]=[];
 const run=createSmokeRunner(report,async()=>{},async call=>{
  const probe=codexProbeResult(call);
  stages.push(call.args.at(-1)!);
  if(call.args.at(-1)==='--json')return {...probe!,stdout:codexMcpServerListing};
  return probe??fixture;
 },Date.now,router);
 const result=await run(model,await invocation(t));
 assert.deepEqual(stages,['--version','list','--json']);
 assert.equal(report.calls.length,0);
 assert.equal(result.status,'mcp_not_empty');
});

test('the ninth concurrent dispatch is refused before the CLI and before a ninth report entry',{timeout:10000},async t=>{
 const report=newReport();let calls=0,checkpoints=0;
 const run=createSmokeRunner(report,async()=>{checkpoints++;},withProbes(async inv=>{calls++;assert.ok(checkpoints>=calls);assert.equal(inv.command,'codex');assert.ok(inv.args.includes('model_providers.smoke.request_max_retries=0'));assert.ok(inv.args.includes('model_providers.smoke.stream_max_retries=0'));return fixture;}),Date.now,router);
 const inputs=await Promise.all(Array.from({length:9},()=>invocation(t)));
 const results=await Promise.allSettled(inputs.map(input=>run(model,input)));
 assert.equal(calls,8);assert.equal(report.calls.length,8);assert.equal(results.filter(r=>r.status==='fulfilled'&&r.value.status==='cap_reached').length,1);assert.equal(report.capReached,true);
});

test('an uncertain started CLI fences later dispatches and retains measured usage without secret output',{timeout:10000},async t=>{
 const report=newReport();let calls=0;const run=createSmokeRunner(report,async()=>{},withProbes(async()=>{calls++;return {...fixture,exitCode:1};}),Date.now,router);
 const input=await invocation(t);await run(model,input);assert.equal((await run(model,input)).status,'dispatch_fenced');assert.equal(calls,1);
 assert.equal(report.calls[0]!.status,'unknown');assert.equal(report.calls[0]!.inputTokens,11);assert.equal(report.calls[0]!.outputTokens,7);
 assert.doesNotMatch(JSON.stringify(report),/secret-fixture-value|fixture answer|currentMessage/);
});

test('reports preserve unknown tokens, durations, verdicts and private JSON/Markdown files',{timeout:10000},async t=>{
 const root=await mkdtemp(join(tempRoot(),'smoke-report-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const report=newReport();let now=100;
 const run=createSmokeRunner(report,async()=>{},withProbes(async()=>{now=150;return {...fixture,stdout:'invalid-json',timedOut:true};}),()=>now,router);
 await run(model,await invocation(t));report.status='failed';report.verdicts.push({status:'failed',relation:'different-family'});await writeReport(root,report);
 const json=JSON.parse(await readFile(join(root,'report.json'),'utf8')),md=await readFile(join(root,'report.md'),'utf8');
 assert.equal(json.calls[0].durationMs,50);assert.equal(json.calls[0].inputTokens,null);assert.equal(json.calls[0].outputTokens,null);
 assert.match(md,/unknown/);assert.match(md,/different-family/);assert.match(md,/50/);assert.doesNotMatch(md,/secret-fixture-value/);
 assert.equal((await stat(join(root,'report.json'))).mode&0o777,0o600);assert.equal((await stat(join(root,'report.md'))).mode&0o777,0o600);
});

test('output above the authorized cap is unknown in both report and adapter and fences later calls',{timeout:10000},async t=>{
 const report=newReport();const run=createSmokeRunner(report,async()=>{},withProbes(async()=>({...fixture,stdout:fixture.stdout.replace('"output_tokens":7','"output_tokens":2049')})),Date.now,router);
 const input=await invocation(t);await run(model,input);assert.equal(report.calls[0]!.status,'unknown');assert.equal(report.calls[0]!.reason,'invalid_or_unbounded_usage');assert.equal(report.calls[0]!.outputTokens,2049);assert.equal((await run(model,input)).status,'dispatch_fenced');
});

test('non-loopback routers and models outside the approved pair are refused before dispatch',{timeout:10000},async t=>{
 const report=newReport();let calls=0;const fixtureRunner=async()=>{calls++;return fixture;};
 for(const url of ['https://example.com/v1','http://127.0.0.1:10100/v1?key=secret','http://user:secret@127.0.0.1:10100/v1'])assert.throws(()=>createSmokeRunner(report,async()=>{},fixtureRunner,Date.now,url));
 const run=createSmokeRunner(report,async()=>{},fixtureRunner,Date.now,router);
 assert.equal((await run('anthropic/forbidden',await invocation(t))).status,'model_refused');assert.equal(calls,0);assert.equal(report.calls.length,0);
});

test('evaluation explicitly selects 120 calls while smoke stays at eight',{timeout:10000},async t=>{
 assert.equal(newReport().callCap,8);
 const report=newReport(120);let calls=0;
 const run=createSmokeRunner(report,async()=>{},withProbes(async()=>{calls++;return fixture;}),Date.now,router);
 const input=await invocation(t);
 for(let i=0;i<120;i++)await run(model,input);
 assert.equal((await run(model,input)).status,'cap_reached');assert.equal(calls,120);assert.equal(report.capReached,true);
 assert.throws(()=>createSmokeRunner({...newReport(),callCap:121},async()=>{},async()=>fixture,Date.now,router));
});

test('the routed smoke and eval transport checks each new turn and fences a tool event even on nonzero exit',{timeout:10000},async t=>{
 const {cwd}=await invocation(t);
 const previous=process.env.CODEX_HOME;
 process.env.CODEX_HOME=cwd;
 t.after(()=>{if(previous===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous;});
 for(const cap of [8,120] as const){
  const report=newReport(cap),commands:string[]=[],configArgs:string[][]=[];
  let lists=0;
  const runner=createSmokeRunner(report,async()=>{},async call=>{
   const command=call.args.at(-1)!;commands.push(command);
   if(command!=='--version')configArgs.push(call.args.flatMap((arg,i)=>arg==='-c'?[call.args[i+1]!]:[]));
   if(command==='list'&&lists++===1)return {...fixture,stdout:codexFeatureListing+'unknown_feature  under development  true\n'};
   const probe=codexProbeResult(call);if(probe)return probe;
   if(lists===3)return {...fixture,exitCode:1,stdout:'{"type":"tool_call","name":"example"}'};
   return fixture;
  },Date.now,router);
  const adapter=cliProfileFactory('codex-cli/v1',{mode:'https',codexRunner:runner}).create({
   id:'smoke',label:'Smoke',backend:'model-provider',providerKind:'codex-cli',protocol:'codex-cli/v1',model:'gpt-6.1-terra',
   endpoint:'cli://codex/',revision:'fixture',enabled:true,auth:{method:'cli-login'},capabilities:['text-output'],
   usage:{inputTokens:'reported',outputTokens:'reported',cost:'unknown'},
   limits:{maxInputBytes:256,maxOutputTokens:64,maxResponseBytes:16384,timeoutMs:2500},
  });
  const invoke=(invocationId:string)=>adapter.invoke({invocationId,workId:'work',instruction:prompt,inputReferences:[],maxOutputTokens:64,signal:AbortSignal.timeout(4000)});
  assert.equal((await invoke('clean')).status,'completed');
  assert.equal((await invoke('unknown-feature')).reason,'cli_unavailable_not_started');
  assert.equal(report.calls.length,1);
  const tool=await invoke('tool');
  assert.equal(tool.status,'failed');assert.equal(tool.reason,'unsupported_tool_output');
  assert.equal(report.calls[1]!.status,'failed');assert.equal(report.calls[1]!.reason,'unsupported_tool_output');
  assert.equal((await invoke('after-tool')).reason,'cli_unavailable_not_started');
  assert.deepEqual(commands,['--version','list','--json','-','--version','list','--version','list','--json','-']);
  assert.deepEqual(configArgs[0],configArgs[2]);
  assert.deepEqual(configArgs[1],configArgs[2]);
  assert.ok(configArgs[2]!.includes('model_providers.smoke.base_url="http://127.0.0.1:10100/v1"'));
 }
});
