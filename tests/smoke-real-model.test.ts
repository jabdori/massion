import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSmokeRunner,newReport,writeReport} from '../scripts/smoke-real-model.ts';
import type {CliInvocation,CliResult} from '../src/cli-agent-providers.ts';

const fixture:CliResult={spawned:true,exitCode:0,stdout:[{type:'item.completed',item:{type:'agent_message',text:'fixture answer'}},{type:'turn.completed',usage:{input_tokens:11,output_tokens:7}}].map(e=>JSON.stringify(e)).join('\n'),stderr:'secret-fixture-value',timedOut:false,aborted:false,overflow:false};
const invocation:CliInvocation={command:'codex',args:['exec','-m','gpt-6.1-terra','-'],stdin:'{"currentMessage":"fixture"}',cwd:tmpdir(),env:{SECRET:'secret-fixture-value'},timeoutMs:100,maxOutputBytes:10000,signal:new AbortController().signal};

test('the ninth concurrent dispatch is refused before the CLI and before a ninth report entry',async()=>{
 const report=newReport();let calls=0,checkpoints=0;
 const run=createSmokeRunner(report,async()=>{checkpoints++;},async inv=>{calls++;assert.ok(checkpoints>=calls);assert.equal(inv.command,'codex');assert.ok(inv.args.includes('model_providers.smoke.request_max_retries=0'));assert.ok(inv.args.includes('model_providers.smoke.stream_max_retries=0'));return fixture;},Date.now,'http://127.0.0.1:10100/v1');
 const results=await Promise.allSettled(Array.from({length:9},()=>run(invocation)));
 assert.equal(calls,8);assert.equal(report.calls.length,8);assert.equal(results.filter(r=>r.status==='rejected').length,1);assert.equal(report.capReached,true);
});

test('an uncertain started CLI fences later dispatches and retains measured usage without secret output',async()=>{
 const report=newReport();let calls=0;const run=createSmokeRunner(report,async()=>{},async()=>{calls++;return {...fixture,exitCode:1};},Date.now,'http://127.0.0.1:10100/v1');
 await run(invocation);await assert.rejects(run(invocation),/fenced/);assert.equal(calls,1);
 assert.equal(report.calls[0]!.status,'unknown');assert.equal(report.calls[0]!.inputTokens,11);assert.equal(report.calls[0]!.outputTokens,7);
 assert.doesNotMatch(JSON.stringify(report),/secret-fixture-value|fixture answer|currentMessage/);
});

test('reports preserve unknown tokens, durations, verdicts and private JSON/Markdown files',async t=>{
 const root=await mkdtemp(join(tmpdir(),'smoke-report-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const report=newReport();let now=100;
 const run=createSmokeRunner(report,async()=>{},async()=>{now=150;return {...fixture,stdout:'invalid-json',timedOut:true};},()=>now,'http://127.0.0.1:10100/v1');
 await run(invocation);report.status='failed';report.verdicts.push({status:'failed',relation:'different-family'});await writeReport(root,report);
 const json=JSON.parse(await readFile(join(root,'report.json'),'utf8')),md=await readFile(join(root,'report.md'),'utf8');
 assert.equal(json.calls[0].durationMs,50);assert.equal(json.calls[0].inputTokens,null);assert.equal(json.calls[0].outputTokens,null);
 assert.match(md,/unknown/);assert.match(md,/different-family/);assert.match(md,/50/);assert.doesNotMatch(md,/secret-fixture-value/);
 assert.equal((await stat(join(root,'report.json'))).mode&0o777,0o600);assert.equal((await stat(join(root,'report.md'))).mode&0o777,0o600);
});

test('output above the authorized cap is unknown in both report and adapter and fences later calls',async()=>{
 const report=newReport();const run=createSmokeRunner(report,async()=>{},async()=>({...fixture,stdout:fixture.stdout.replace('"output_tokens":7','"output_tokens":2049')}),Date.now,'http://127.0.0.1:10100/v1');
 await run(invocation);assert.equal(report.calls[0]!.status,'unknown');assert.equal(report.calls[0]!.reason,'invalid_or_unbounded_usage');assert.equal(report.calls[0]!.outputTokens,2049);await assert.rejects(run(invocation),/fenced/);
});

test('non-loopback routers and models outside the approved pair are refused before dispatch',async()=>{
 const report=newReport();let calls=0;const fixtureRunner=async()=>{calls++;return fixture;};
 for(const url of ['https://example.com/v1','http://127.0.0.1:10100/v1?key=secret','http://user:secret@127.0.0.1:10100/v1'])assert.throws(()=>createSmokeRunner(report,async()=>{},fixtureRunner,Date.now,url));
 const run=createSmokeRunner(report,async()=>{},fixtureRunner,Date.now,'http://127.0.0.1:10100/v1');
 await assert.rejects(run({...invocation,args:['exec','-m','anthropic/forbidden','-']}),/refused/);assert.equal(calls,0);assert.equal(report.calls.length,0);
});
