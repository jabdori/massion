import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentBrowserEnvironment,AgentBrowserError,createAgentBrowserRunner} from '../src/agent-browser-environment.ts';
import type {AgentBrowserRunner} from '../src/agent-browser-environment.ts';
import {browserPageOriginRule} from '../src/browser-network.ts';
import {EnvironmentActions} from '../src/environment-actions.ts';
import {InMemoryStore} from '../src/storage.ts';

const origin='https://shop.example',signal=()=>new AbortController().signal;
const refs={e1:{name:'Next',role:'link'},e2:{name:'Submit',role:'button'},e3:{name:'Search',role:'textbox'},e4:{name:'Card number',role:'textbox'},e5:{name:'Choice',role:'combobox'},e6:{name:'One',role:'option'}};
const shellVersion=(version:string)=>['#!/bin/sh','echo "agent-browser '+version+'"'].join(String.fromCharCode(10));
type FakePage=Record<string,{name:string;role:string}>;
function fixture(options:{requestOrigin?:(origin:string,signal:AbortSignal)=>Promise<boolean>;refs?:FakePage}={}){
 const calls:{args:string[];stdin?:string}[]=[];let url=origin+'/start',page:FakePage=structuredClone(options.refs??refs),fail:string|undefined,dialog:{type:string;message:string}|undefined,landing:string|undefined;
 const runner:AgentBrowserRunner=async(args,input)=>{
  calls.push({args:[...args],stdin:input?.stdin});
  const cmd=args[0]!;
  if(fail&&cmd!=='snapshot'&&!(cmd==='get'&&args[1]==='url')&&cmd!=='dialog')throw new AgentBrowserError(fail.startsWith('Unknown ref')?'unknown-ref':fail.includes('covered')?'covered':'stale-ref',fail);
  if(cmd==='snapshot')return {refs:structuredClone(page)};
  if(cmd==='get'&&args[1]==='url')return {url};
  if(cmd==='dialog'&&args[1]==='status')return dialog?{hasDialog:true,...dialog}:{hasDialog:false};
  if(cmd==='dialog')return {handled:true};
  if(cmd==='batch')return [{success:true,index:0,result:{filled:'@e3'}}];
  if(cmd==='click'&&landing!==undefined){url=landing;return {clicked:'@e2'};}
  if(cmd==='open'){url=String(args[1]);return {url};}
  if(cmd==='back'){url=origin+'/start';return {};}
  if(cmd==='select')return {selected:[args[2]]};
  return {};
 };
 const adapter=new AgentBrowserEnvironment({environment:'agent-fixture',session:'member-fixture',runner,origins:[origin],requestOrigin:options.requestOrigin});
 return {adapter,calls,offList:()=>{url='https://evil.example/landing';},offListHttp:()=>{url='http://evil.example/landing';},landHttp:()=>{landing='http://evil.example/landing';},growSensitive:()=>{page={...structuredClone(page),e65:{name:'Password',role:'textbox'}};},offListAfterClick:()=>{landing='https://evil.example/landing';},reflect:(needle:string)=>{page=structuredClone(page);for(const key of Object.keys(page))page[key]!.name=String(page[key]!.name)+' '+needle;},drop:(ref:string)=>{page=structuredClone(page);delete page[ref];},urlWithSecret:(needle:string)=>{url=origin+'/start?token='+needle;},dialog:(next:{type:string;message:string}|undefined)=>{dialog=next;},fail:(next?:string)=>{fail=next;}};
}
const argvOf=(calls:ReturnType<typeof fixture>['calls'])=>calls.map(call=>call.args);
const context=()=>({signal:signal()});

test('observations map snapshot refs to bounded structure with the password/card click floor',async()=>{
 const s=fixture(),o=await s.adapter.observe(signal());
 const byId=Object.fromEntries(o.structure.map(node=>[node.id,node]));
 assert.deepEqual(byId.e1,{id:'e1',role:'link',label:'Next',operations:['click','scroll'],gates:[]});
 assert.deepEqual(byId.e3,{id:'e3',role:'textbox',label:'Search',operations:['type','key','scroll'],gates:[{kind:'personal-data-submission'},{kind:'irreversible-submit'}]});
 assert.deepEqual(byId.e5,{id:'e5',role:'combobox',label:'Choice',operations:['select','scroll'],gates:[]});
 assert.ok(!byId.e6);
 assert.deepEqual(byId.e2!.gates,[{kind:'personal-data-submission'},{kind:'irreversible-submit'}]);
 assert.equal(o.binding.origin,origin+':443');assert.deepEqual(o.facts,{});
});

test('act dispatches native verbs by ref and never re-implements input',async()=>{
 const s=fixture(),o=await s.adapter.observe(signal());
 const act=(element:string,input:any)=>s.adapter.act({binding:o.binding,element,input,gates:[]},context());
 await act('e2',{kind:'click'});await act('e5',{kind:'select',option:'one'});await act('e3',{kind:'key',key:'Enter'});await act('e1',{kind:'scroll',x:-120,y:300});
 assert.deepEqual(argvOf(s.calls).filter(a=>a[0]!=='snapshot'&&!(a[0]==='get'&&a[1]==='url')&&a[0]!=='dialog'&&a[0]!=='wait'),[['click','@e2'],['select','@e5','one'],['focus','@e3'],['press','Enter'],['scroll','down','300'],['scroll','left','120']]);
});

test('secret fills ride batch stdin, keep argv clean, erase bytes and taint the environment',async()=>{
 const s=fixture(),o=await s.adapter.observe(signal()),store=new InMemoryStore();let bytes:Uint8Array|undefined;
 const service=new EnvironmentActions(store,store,s.adapter,{owner:'local-owner',environment:'agent-fixture',resolveSecret:async()=>bytes=new TextEncoder().encode('synthetic-secret-value')});
 const entry=await service.propose('fill','e3',{kind:'type',secret:{owner:'local-owner',slot:'card'}});
 assert.equal(entry.status,'waiting');assert.deepEqual(entry.request.type==='action'?entry.request.action.gates:[],[{kind:'personal-data-submission'},{kind:'irreversible-submit'}]);
 await service.answer('approve-fill','fill',entry.hash,'approve');
 assert.equal((await service.execute('fill',entry.hash)).status,'delivered');
 assert.ok(bytes?.every(byte=>byte===0));
 assert.ok(s.calls.every(call=>!JSON.stringify(call.args).includes('synthetic-secret-value')));
 assert.equal(s.calls.find(call=>call.args[0]==='batch')?.stdin,JSON.stringify([['fill','@e3','synthetic-secret-value']]));
 assert.equal(s.adapter.isPrivate(),true);
});

test('unknown and stale refs fail typed with a fresh snapshot attached; covered is typed',async()=>{
 for(const [message,code] of [['Unknown ref: e2','unknown-ref'],['Could not locate element with role=button name=Submit','stale-ref']] as const){
  const s=fixture(),o=await s.adapter.observe(signal());s.fail(message);
  await assert.rejects(s.adapter.act({binding:o.binding,element:'e2',input:{kind:'click'},gates:[]},context()),(error:AgentBrowserError)=>{
   assert.equal(error.code,code);assert.ok(error.snapshot?.refs.some(node=>node.ref==='e2'));return true;});
 }
 const s=fixture(),o=await s.adapter.observe(signal());s.fail("Element '@e2' is covered by <div#ov> at its click point");
 await assert.rejects(s.adapter.act({binding:o.binding,element:'e2',input:{kind:'click'},gates:[]},context()),(error:AgentBrowserError)=>error.code==='covered');
});

test('dialogs are answered by policy only: alert accepted, others dismissed and reported',async()=>{
 for(const [type,verb] of [['alert','accept'],['confirm','dismiss'],['prompt','dismiss'],['beforeunload','dismiss']] as const){
  const s=fixture(),o=await s.adapter.observe(signal());s.dialog({type,message:'sure?'});
  await s.adapter.act({binding:o.binding,element:'e2',input:{kind:'click'},gates:[]},context());
  s.dialog(undefined);
  assert.deepEqual(s.adapter.report().dialogs,[{type,message:'sure?'}]);
  assert.ok(argvOf(s.calls).some(a=>a[0]==='dialog'&&a[1]===verb),type);
 }
});

test('new origins need owner approval; refusals block navigation and off-list landings are left and reported',async()=>{
 let approve=false;
 const s=fixture({requestOrigin:async()=>approve});
 await assert.rejects(s.adapter.navigate({url:'https://other.example/x'},signal()),(error:AgentBrowserError)=>error.code==='origin-blocked');
 assert.ok(!argvOf(s.calls).some(a=>a[0]==='open'));
 approve=true;
 await s.adapter.navigate({url:'https://other.example/x'},signal());
 assert.ok(s.adapter.allowedOrigins.has('https://other.example:443'));
 const o=await s.adapter.observe(signal());
 s.offListAfterClick();
 await s.adapter.act({binding:o.binding,element:'e1',input:{kind:'click'},gates:[]},context());
 assert.ok(s.adapter.report().deviations.some(entry=>entry.startsWith('left-origin:https://evil.example')));
 assert.ok(argvOf(s.calls).some(a=>a[0]==='back'));
});

test('takeover waits ride the existing owner-wait ledger',async()=>{
 const s=fixture(),store=new InMemoryStore(),service=new EnvironmentActions(store,store,s.adapter,{owner:'local-owner',environment:'agent-fixture'});
 const entry=await service.wait('handoff',{kind:'takeover',reason:'captcha',who:'Owner',what:'인간 확인이 필요합니다',where:'shop.example',timeoutMs:60000});
 assert.equal(entry.status,'waiting');
  await service.answer('approve-handoff','handoff',entry.hash,'approve');
 assert.equal((await service.state()).entries.find(e=>e.id==='handoff')!.status,'completed');
 const invalid={kind:'takeover',reason:'nope',who:'Owner',what:'x',where:'y',timeoutMs:60000} as unknown as Parameters<typeof service.wait>[1];
 await assert.rejects(service.wait('handoff2',invalid),/Invalid takeover reason/);
});

test('the runner refuses any agent-browser version other than the pinned one',async()=>{
 const root=await mkdtemp(join(tmpdir(),'massion-agent-browser-'));
 try{
  await writeFile(join(root,'agent-browser'),shellVersion('0.42.0'),{mode:0o700});
  await assert.rejects(createAgentBrowserRunner({session:'member-fixture',binary:join(root,'agent-browser'),namespace:join(root,'ns')}),(error:AgentBrowserError)=>error.code==='version');
  await writeFile(join(root,'agent-browser'),shellVersion('0.41.2'),{mode:0o700});
  const {runner}=await createAgentBrowserRunner({session:'member-fixture',binary:join(root,'agent-browser'),namespace:join(root,'ns')});
  await assert.rejects(runner(['snapshot','-i']),(error:AgentBrowserError)=>error.code==='command');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('off-list pages are never read into observations or acted on',async()=>{
 const s=fixture();s.offList();
 await assert.rejects(s.adapter.observe(signal()),(error:AgentBrowserError)=>error.code==='origin-blocked');
 assert.ok(s.adapter.report().deviations.some(entry=>entry.startsWith('left-origin:https://evil.example')));
 const second=fixture(),o=await second.adapter.observe(signal());second.offList();let resolved=0;
 await assert.rejects(second.adapter.act({binding:o.binding,element:'e3',input:{kind:'type',secret:{owner:'local-owner',slot:'x'}},gates:[]},{signal:signal(),secret:async()=>{resolved++;return new TextEncoder().encode('never-delivered');}}),(error:AgentBrowserError)=>error.code==='origin-blocked');
 assert.equal(resolved,0);
 assert.ok(!argvOf(second.calls).some(a=>['click','batch','select','focus','press'].includes(a[0]!)));
});

test('secret fills re-validate binding and origin after secret resolution',async()=>{
 for(const mode of ['off-list','page-changed'] as const){
  const s=fixture(),o=await s.adapter.observe(signal());
  await assert.rejects(s.adapter.act({binding:o.binding,element:'e3',input:{kind:'type',secret:{owner:'local-owner',slot:'x'}},gates:[]},{signal:signal(),secret:async()=>{
   if(mode==='off-list')s.offList();else s.reflect('Renamed');
   return new TextEncoder().encode('synthetic-secret-value');
  }}),mode==='off-list'?(error:AgentBrowserError)=>error.code==='origin-blocked':/binding changed/);
  assert.ok(!argvOf(s.calls).some(a=>a[0]==='batch'),mode);
  assert.equal(s.adapter.isPrivate(),true);
 }
});

test('private taint scrubs labels, urls, dialog reports and error snapshots',async()=>{
 const s=fixture(),o=await s.adapter.observe(signal()),secret='synthetic-secret-value';
 await s.adapter.act({binding:o.binding,element:'e3',input:{kind:'type',secret:{owner:'local-owner',slot:'x'}},gates:structuredClone(o.structure.find(node=>node.id==='e3')!.gates)},{signal:signal(),secret:async()=>new TextEncoder().encode(secret)});
 s.reflect(secret);s.urlWithSecret(secret);s.dialog({type:'confirm',message:'typed '+secret});
 const fresh=await s.adapter.observe(signal());
 assert.ok(!JSON.stringify(fresh.structure).includes(secret));
 assert.ok(!s.adapter.observedUrl().includes(secret));
 await s.adapter.act({binding:fresh.binding,element:'e2',input:{kind:'click'},gates:[]},{signal:signal()});
 assert.ok(s.adapter.report().dialogs.every(dialog=>!dialog.message.includes(secret)));
 s.fail('Could not locate element with role=textbox name='+secret);
 await assert.rejects(s.adapter.act({binding:fresh.binding,element:'e3',input:{kind:'key',key:'Enter'},gates:[]},{signal:signal()}),(error:AgentBrowserError)=>{
  assert.ok(!error.message.includes(secret));
  assert.ok(!error.snapshot?.url.includes(secret)&&error.snapshot!.refs.every(node=>!node.name.includes(secret)));
  return true;});
});

test('page sensitivity is computed from the complete snapshot before truncation',async()=>{
 const crowded:FakePage={e1:{name:'Submit',role:'button'},e65:{name:'Password',role:'textbox'}};
 for(let index=2;index<65;index++)crowded['e'+index]={name:'Filler '+index,role:'button'};
 const s=fixture({refs:crowded}),o=await s.adapter.observe(signal());
 assert.equal(o.structure.length,64);
 assert.deepEqual(o.structure.find(node=>node.id==='e1')!.gates,[{kind:'personal-data-submission'},{kind:'irreversible-submit'}]);
});

test('the page origin rule accepts HTTPS anywhere and HTTP on loopback only',()=>{
 assert.equal(browserPageOriginRule('https://shop.example'),'https://shop.example:443');
 assert.equal(browserPageOriginRule('http://127.0.0.1:8080'),'http://127.0.0.1:8080');
 assert.equal(browserPageOriginRule('http://localhost:3000'),'http://localhost:3000');
 assert.equal(browserPageOriginRule('http://[::1]:8080'),'http://[::1]:8080');
 for(const bad of ['http://shop.example','http://10.0.0.1:8080','ftp://127.0.0.1'])assert.throws(()=>browserPageOriginRule(bad),/HTTPS/);
});

test('Enter-capable textboxes on a sensitive page carry the irreversible-submit gate',async()=>{
 const sensitive=await fixture().adapter.observe(signal());
 const textbox=sensitive.structure.find(node=>node.id==='e3')!;
 assert.ok(textbox.operations.includes('key'));
 assert.deepEqual(textbox.gates,[{kind:'personal-data-submission'},{kind:'irreversible-submit'}]);
 const plain=fixture({refs:{e1:{name:'Search',role:'textbox'},e2:{name:'Go',role:'button'}}});
 const clean=await plain.adapter.observe(signal());
 assert.deepEqual(clean.structure.find(node=>node.id==='e1')!.gates,[{kind:'personal-data-submission'}]);
});

test('key presses target the approved ref and a gone ref refuses without dispatch',async()=>{
 const s=fixture(),o=await s.adapter.observe(signal());
 await s.adapter.act({binding:o.binding,element:'e3',input:{kind:'key',key:'Enter'},gates:[]},{signal:signal()});
 assert.deepEqual(argvOf(s.calls).filter(a=>a[0]==='focus'||a[0]==='press'),[['focus','@e3'],['press','Enter']]);
 const second=fixture(),fresh=await second.adapter.observe(signal());
 await assert.rejects(second.adapter.act({binding:fresh.binding,element:'e99',input:{kind:'key',key:'Enter'},gates:[]},{signal:signal()}),(error:AgentBrowserError)=>{
  assert.equal(error.code,'unknown-ref');
  assert.ok(!argvOf(second.calls).some(a=>a[0]==='focus'||a[0]==='press'));
  return true;});
});

test('a page that becomes sensitive between observation and delivery is refused',async()=>{
 const s=fixture({refs:{e1:{name:'Submit',role:'button'},e2:{name:'Search',role:'textbox'}}});
 const o=await s.adapter.observe(signal());
 assert.deepEqual(o.structure.find(node=>node.id==='e1')!.gates,[]);
 s.growSensitive();
 await assert.rejects(s.adapter.act({binding:o.binding,element:'e1',input:{kind:'click'},gates:[]},{signal:signal()}),/binding changed/);
 assert.ok(!argvOf(s.calls).some(a=>a[0]==='click'));
 const next=await s.adapter.observe(signal());
 assert.deepEqual(next.structure.find(node=>node.id==='e1')!.gates,[{kind:'personal-data-submission'},{kind:'irreversible-submit'}]);
});

test('rule-rejected HTTP landings are left and reported before refusing',async()=>{
 const s=fixture();s.offListHttp();
 await assert.rejects(s.adapter.observe(signal()),(error:AgentBrowserError)=>error.code==='origin-blocked');
 assert.ok(s.adapter.report().deviations.some(entry=>entry==='left-origin:http://evil.example'));
 assert.ok(argvOf(s.calls).some(a=>a[0]==='back'));
 const second=fixture(),o=await second.adapter.observe(signal());second.landHttp();
 await second.adapter.act({binding:o.binding,element:'e1',input:{kind:'click'},gates:[]},{signal:signal()});
 assert.ok(second.adapter.report().deviations.some(entry=>entry==='left-origin:http://evil.example'));
 assert.ok(argvOf(second.calls).some(a=>a[0]==='back'));
 await assert.rejects(second.adapter.navigate({url:'http://plain.example/x'},signal()),(error:AgentBrowserError)=>error.code==='origin-blocked');
 assert.ok(!argvOf(second.calls).some(a=>a[0]==='open'&&a[1]==='http://plain.example/x'));
});
