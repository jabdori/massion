/** Explicitly authorized local smoke. Importing this module never launches a browser. */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:https';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {once} from 'node:events';
import {AgentBrowserEnvironment,AgentBrowserError,createAgentBrowserRunner} from '../src/agent-browser-environment.ts';

const exec=promisify(execFile),session='massion-smoke',secret='synthetic-smoke-secret';
async function main(){
 const root=await mkdtemp(join(tmpdir(),'massion-smoke-agent-browser-')),signal=AbortSignal.timeout(180000);
 let server:ReturnType<typeof createServer>|undefined,second:ReturnType<typeof createServer>|undefined,closer:(()=>Promise<void>)|undefined;
 try{
  await exec('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(root,'key.pem'),'-out',join(root,'cert.pem'),'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1']);
  const key=await readFile(join(root,'key.pem')),cert=await readFile(join(root,'cert.pem'));
  let posted='';const page=(url:string)=>'<!doctype html><title>Smoke form</title><form method="post" action="'+url+'"><label>Password <input type=password name=secret></label><select name=choice><option value=one>One</option><option value=two>Two</option></select><button type=submit id=go>Submit</button></form><button id="confirm" onclick="confirm(&quot;sure?&quot;)">Confirm</button>';
  const listen=async(handler:(req:IncomingMessage,res:ServerResponse)=>void)=>{const s=createServer({key,cert},handler);s.listen(0,'127.0.0.1');await once(s,'listening');return s;};
  server=await listen((req,res)=>{
   res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','text/html; charset=utf-8');
   if(req.method==='POST'){req.on('data',(chunk:Buffer)=>posted+=chunk);req.on('end',()=>res.end());return;}
   res.end(page('/received'));
  });
  second=await listen((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Second origin</title><a href="#">Back</a>');});
  const origin='https://127.0.0.1:'+(server.address() as any).port,other='https://127.0.0.1:'+(second.address() as any).port;
  // Test-only wrapper: the fixture certificate is self-signed; the production runner adds no such flag.
  const real=(await exec('which',['agent-browser'])).stdout.trim(),newLine=String.fromCharCode(10);
  await writeFile(join(root,'agent-browser'),'#!/bin/sh'+newLine+'exec '+real+' "$@" --ignore-https-errors'+newLine,{mode:0o700});
  const {runner,close}=await createAgentBrowserRunner({session,binary:join(root,'agent-browser'),namespace:await mkdtemp('/tmp/massion-ab-')});
  closer=close;
  const decisions:string[]=[];
  const adapter=new AgentBrowserEnvironment({environment:'smoke-agent-browser',session,runner,origins:[origin],requestOrigin:async(requested)=>{decisions.push(requested);return requested===other;}});
  await runner(['open',origin+'/']);
  const observation=await adapter.observe(signal);
  assert.ok(observation.structure.some(node=>node.label==='Submit'&&node.gates.some(g=>g.kind==='personal-data-submission')));
  const textbox=observation.structure.find(node=>node.role==='textbox')!;
  let bytes:Uint8Array|undefined;
  const {EnvironmentActions}=await import('../src/environment-actions.ts');
  const {InMemoryStore}=await import('../src/storage.ts');
  const store=new InMemoryStore(),ledger=new EnvironmentActions(store,store,adapter,{owner:'local-owner',environment:'smoke-agent-browser',resolveSecret:async()=>bytes=new TextEncoder().encode(secret)});
  const fill=await ledger.propose('fill',textbox.id,{kind:'type',secret:{owner:'local-owner',slot:'smoke'}});
  await ledger.answer('approve','fill',fill.hash,'approve');
  assert.equal((await ledger.execute('fill',fill.hash)).status,'delivered');
  assert.ok(bytes?.every(byte=>byte===0));assert.equal(adapter.isPrivate(),true);
  const choice=observation.structure.find(node=>node.role==='combobox')!,submit=observation.structure.find(node=>node.label==='Submit')!;
  await adapter.act({binding:(await adapter.observe(signal)).binding,element:choice.id,input:{kind:'select',option:'two'},gates:[]},{signal});
  await adapter.act({binding:(await adapter.observe(signal)).binding,element:submit.id,input:{kind:'click'},gates:structuredClone(submit.gates)},{signal});
  for(let round=0;round<50&&!posted;round++)await new Promise(done=>setTimeout(done,100));
  assert.ok(new URLSearchParams(posted).get('secret')===secret&&new URLSearchParams(posted).get('choice')==='two');
  assert.ok(!adapter.report().dialogs.length,'no dialog expected on the submit path');
  await runner(['open',origin+'/']);
  const fresh=await adapter.observe(signal),confirm=fresh.structure.find(node=>node.label==='Confirm');
  if(confirm){await adapter.act({binding:fresh.binding,element:confirm.id,input:{kind:'click'},gates:[]},{signal});
   const report=adapter.report();assert.ok(report.dialogs.some(dialog=>dialog.type==='confirm'&&dialog.message.includes('sure')),'confirm dismissed and reported');}
  await adapter.navigate({url:other+'/second'},signal);
  assert.deepEqual(decisions,[other]);
  await assert.rejects(adapter.navigate({url:'https://example.invalid/x'},signal),(error:AgentBrowserError)=>error.code==='origin-blocked');
  console.log(JSON.stringify({status:'passed',origin,decisions,dialogPolicy:'alert-accept-others-dismiss'}));
 }finally{
  await closer?.().catch(()=>{});
  await rm(join(root,'agent-browser'),{force:true}).catch(()=>{});
  for(const s of [server,second]){if(s){s.closeAllConnections();await new Promise(done=>s.close(done));}}
  await rm(root,{recursive:true,force:true});
 }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main().catch(error=>{console.error(String(error));process.exitCode=1;});
