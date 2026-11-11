import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentBrowserEnvironment,AgentBrowserError,createAgentBrowserRunner} from '../src/agent-browser-environment.ts';
import type {AgentBrowserRunner} from '../src/agent-browser-environment.ts';
import {EnvironmentActions} from '../src/environment-actions.ts';
import {InMemoryStore} from '../src/storage.ts';

const origin='https://shop.example',signal=()=>new AbortController().signal;
const refs={e1:{name:'Next',role:'link'},e2:{name:'Submit',role:'button'},e3:{name:'Search',role:'textbox'},e4:{name:'Card number',role:'textbox'},e5:{name:'Choice',role:'combobox'},e6:{name:'One',role:'option'}};
const shellVersion=(version:string)=>['#!/bin/sh','echo "agent-browser '+version+'"'].join(String.fromCharCode(10));
function fixture(options:{requestOrigin?:(origin:string,signal:AbortSignal)=>Promise<boolean>}={}){
 const calls:{args:string[];stdin?:string}[]=[];let url=origin+'/start',page=structuredClone(refs),fail:string|undefined,dialog:{type:string;message:string}|undefined,landing:string|undefined;
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
 return {adapter,calls,offListAfterClick:()=>{landing='https://evil.example/landing';},dialog:(next:{type:string;message:string}|undefined)=>{dialog=next;},fail:(next?:string)=>{fail=next;}};
}
const argvOf=(calls:ReturnType<typeof fixture>['calls'])=>calls.map(call=>call.args);
const context=()=>({signal:signal()});

test('observations map snapshot refs to bounded structure with the password/card click floor',async()=>{
 const s=fixture(),o=await s.adapter.observe(signal());
 const byId=Object.fromEntries(o.structure.map(node=>[node.id,node]));
 assert.deepEqual(byId.e1,{id:'e1',role:'link',label:'Next',operations:['click','scroll'],gates:[]});
 assert.deepEqual(byId.e3,{id:'e3',role:'textbox',label:'Search',operations:['type','key','scroll'],gates:[{kind:'personal-data-submission'}]});
 assert.deepEqual(byId.e5,{id:'e5',role:'combobox',label:'Choice',operations:['select','scroll'],gates:[]});
 assert.ok(!byId.e6);
 assert.deepEqual(byId.e2!.gates,[{kind:'personal-data-submission'},{kind:'irreversible-submit'}]);
 assert.equal(o.binding.origin,origin+':443');assert.deepEqual(o.facts,{});
});

test('act dispatches native verbs by ref and never re-implements input',async()=>{
 const s=fixture(),o=await s.adapter.observe(signal());
 const act=(element:string,input:any)=>s.adapter.act({binding:o.binding,element,input,gates:[]},context());
 await act('e2',{kind:'click'});await act('e5',{kind:'select',option:'one'});await act('e3',{kind:'key',key:'Enter'});await act('e1',{kind:'scroll',x:-120,y:300});
 assert.deepEqual(argvOf(s.calls).filter(a=>a[0]!=='snapshot'&&!(a[0]==='get'&&a[1]==='url')&&a[0]!=='dialog'&&a[0]!=='wait'),[['click','@e2'],['select','@e5','one'],['press','Enter'],['scroll','down','300'],['scroll','left','120']]);
});

test('secret fills ride batch stdin, keep argv clean, erase bytes and taint the environment',async()=>{
 const s=fixture(),o=await s.adapter.observe(signal()),store=new InMemoryStore();let bytes:Uint8Array|undefined;
 const service=new EnvironmentActions(store,store,s.adapter,{owner:'local-owner',environment:'agent-fixture',resolveSecret:async()=>bytes=new TextEncoder().encode('synthetic-secret-value')});
 const entry=await service.propose('fill','e3',{kind:'type',secret:{owner:'local-owner',slot:'card'}});
 assert.equal(entry.status,'waiting');assert.deepEqual(entry.request.type==='action'?entry.request.action.gates:[],[{kind:'personal-data-submission'}]);
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
