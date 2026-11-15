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
 const calls:{args:string[];stdin?:string}[]=[];let url=origin+'/start',baseUri=origin+'/start',page:FakePage=structuredClone(options.refs??refs),fail:string|undefined,dialog:{type:string;message:string}|undefined,landing:string|undefined,slow=false,failClick:string|undefined,failAttrs=false,failOpen=false,forms:string[]=[],checked=new Set<string>(),attrs:Record<string,string|null>={};
 const runner:AgentBrowserRunner=async(args,input)=>{
  calls.push({args:[...args],stdin:input?.stdin});
  const cmd=args[0]!;
  if(cmd==='snapshot'&&slow)await new Promise(resolve=>setImmediate(resolve));
  if(fail&&cmd!=='snapshot'&&cmd!=='batch'&&!(cmd==='get'&&args[1]==='url')&&cmd!=='dialog')throw new AgentBrowserError(fail.startsWith('Unknown ref')?'unknown-ref':fail.includes('covered')?'covered':'stale-ref',fail);
  if(cmd==='snapshot'){
   const text=Object.entries(page).map(([ref,node])=>'- '+node.role+' "'+node.name+'" [ref='+ref+(node.role==='link'&&typeof attrs['@'+ref+' href']==='string'?', url='+attrs['@'+ref+' href']:'')+(checked.has(ref)?', checked':'')+']').join(String.fromCharCode(10));
   return {refs:structuredClone(page),snapshot:text};
  }
  if(cmd==='get'&&args[1]==='url')return {url};
  if(cmd==='dialog'&&args[1]==='status')return dialog?{hasDialog:true,...dialog}:{hasDialog:false};
  if(cmd==='dialog')return {handled:true};
  if(cmd==='get'&&args[1]==='attr')return {value:Object.hasOwn(attrs,args[2]+' '+args[3])?attrs[args[2]+' '+args[3]]!:null};
  if(cmd==='batch'){const rows=JSON.parse(input?.stdin??'[]') as string[][];
   if(failAttrs&&rows.some(row=>row[0]==='get'))throw new AgentBrowserError('command','batch attribute read failed');
   return rows.map((row,index)=>row[0]==='get'?{success:true,index,result:{value:Object.hasOwn(attrs,row[2]+' '+row[3])?attrs[row[2]+' '+row[3]]!:null}}:row[0]==='fill'?{success:true,index,result:{filled:row[1]}}:{success:true,index,result:{}});}
  if(cmd==='click'){if(landing!==undefined)url=landing;if(failClick)throw new AgentBrowserError('command',failClick);return {clicked:'@e2'};}
  if(cmd==='eval'){const expression=Buffer.from(String(args[2]),'base64').toString();return {result:expression.includes('document.forms')?JSON.stringify(forms):baseUri};}
  if(cmd==='open'){if(failOpen){url='https://evil.example/landing';throw new AgentBrowserError('command','navigation timed out');}url=String(args[1]);return {url};}
  if(cmd==='back'){url=origin+'/start';return {};}
  if(cmd==='select')return {selected:[args[2]]};
  return {};
 };
 const adapter=new AgentBrowserEnvironment({environment:'agent-fixture',session:'member-fixture',runner,origins:[origin],requestOrigin:options.requestOrigin});
 return {adapter,runner,calls,setAttr:(ref:string,attribute:string,value:string|null)=>{attrs[ref+' '+attribute]=value;},offList:()=>{url='https://evil.example/landing';},offListHttp:()=>{url='http://evil.example/landing';},landHttp:()=>{landing='http://evil.example/landing';},growSensitive:()=>{page={...structuredClone(page),e65:{name:'Card number',role:'textbox'}};},offListAfterClick:()=>{landing='https://evil.example/landing';},failClickOffList:()=>{landing='https://evil.example/landing';failClick='navigation timed out';},failOpenOffList:()=>{failOpen=true;},failBatchAttrs:()=>{failAttrs=true;},setForms:(next:string[])=>{forms=next;},setBaseUri:(next:string)=>{baseUri=next;},check:(ref:string)=>{checked.add(ref);},slowSnapshots:()=>{slow=true;},reflect:(needle:string)=>{page=structuredClone(page);for(const key of Object.keys(page))page[key]!.name=String(page[key]!.name)+' '+needle;},drop:(ref:string)=>{page=structuredClone(page);delete page[ref];},urlWithSecret:(needle:string)=>{url=origin+'/start?token='+needle;},dialog:(next:{type:string;message:string}|undefined)=>{dialog=next;},fail:(next?:string)=>{fail=next;}};
}
const argvOf=(calls:ReturnType<typeof fixture>['calls'])=>calls.map(call=>call.args);
const context=()=>({signal:signal()});

test('observations map snapshot refs to bounded structure with host raises only',async()=>{
 const s=fixture(),o=await s.adapter.observe(signal());
 const byId=Object.fromEntries(o.structure.map(node=>[node.id,node]));
 assert.deepEqual(byId.e1,{id:'e1',role:'link',label:'Next',operations:['click','scroll'],gates:[]});
 assert.deepEqual(byId.e3,{id:'e3',role:'textbox',label:'Search',operations:['type','key','scroll'],gates:[{kind:'payment'}]});
 assert.deepEqual(byId.e5,{id:'e5',role:'combobox',label:'Choice',operations:['select','scroll'],gates:[{kind:'payment'}]});
 assert.ok(!byId.e6);
 assert.deepEqual(byId.e2!.gates,[{kind:'payment'}]);
 assert.equal(o.binding.origin,origin+':443');assert.deepEqual(o.facts,{});
});

test('act dispatches native verbs by ref and never re-implements input',async()=>{
 const s=fixture(),o=await s.adapter.observe(signal());
 const act=(element:string,input:any)=>s.adapter.act({binding:o.binding,element,input,gates:[]},context());
 await act('e2',{kind:'click'});await act('e5',{kind:'select',option:'one'});await act('e3',{kind:'key',key:'Enter'});await act('e1',{kind:'scroll',x:-120,y:300});
 assert.deepEqual(argvOf(s.calls).filter(a=>a[0]!=='snapshot'&&!(a[0]==='get')&&a[0]!=='dialog'&&a[0]!=='wait'&&a[0]!=='batch'&&a[0]!=='eval'),[['click','@e2'],['select','@e5','one'],['focus','@e3'],['press','Enter'],['scroll','down','300'],['scroll','left','120']]);
});

test('secret fills ride batch stdin, keep argv clean, erase bytes and taint the environment',async()=>{
 const s=fixture(),o=await s.adapter.observe(signal()),store=new InMemoryStore();let bytes:Uint8Array|undefined;
 const service=new EnvironmentActions(store,store,s.adapter,{owner:'local-owner',environment:'agent-fixture',resolveSecret:async()=>bytes=new TextEncoder().encode('synthetic-secret-value')});
 const entry=await service.propose('fill','e3',{kind:'type',secret:{owner:'local-owner',slot:'card'}});
 assert.equal(entry.status,'ready');assert.deepEqual(entry.request.type==='action'?entry.request.action.gates:[],[]);
 assert.equal((await service.execute('fill',entry.hash)).status,'delivered');
 assert.ok(bytes?.every(byte=>byte===0));
 assert.ok(s.calls.every(call=>!JSON.stringify(call.args).includes('synthetic-secret-value')));
 assert.equal(s.calls.find(call=>call.args[0]==='batch'&&call.stdin?.includes('"fill"'))?.stdin,JSON.stringify([['fill','@e3','synthetic-secret-value']]));
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

test('website access is separate from the level: always-allow proceeds and a remembered site approval covers only its origin',async()=>{
 let asked=0;const s=fixture({requestOrigin:async()=>{asked++;return true;}});
 await s.adapter.navigate({url:'https://other.example/x'},signal());
 assert.equal(asked,1);
 const free=new AgentBrowserEnvironment({environment:'agent-fixture',session:'member-fixture',runner:s.runner,origins:[origin],websiteAccess:'always-allow'});
 await free.navigate({url:'https://second.example/x'},signal());
 assert.ok(free.allowedOrigins.has('https://second.example:443'));
 const remembered=new AgentBrowserEnvironment({environment:'agent-fixture',session:'member-fixture',runner:s.runner,origins:[origin],requestOrigin:async()=>false,rememberedApprovals:[{covers:'first-visit',scope:'site',origin:'https://third.example:443'}]});
 await remembered.navigate({url:'https://third.example/x'},signal());
 await assert.rejects(remembered.navigate({url:'https://fourth.example/x'},signal()),(error:AgentBrowserError)=>error.code==='origin-blocked');
 assert.ok(remembered.allowedOrigins.has('https://third.example:443')&&!remembered.allowedOrigins.has('https://fourth.example:443'));
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
 assert.ok(!argvOf(second.calls).some(a=>['click','select','focus','press'].includes(a[0]!)));
 assert.ok(!second.calls.some(call=>call.args[0]==='batch'&&call.stdin?.includes('"fill"')));
});

test('secret fills re-validate binding and origin after secret resolution',async()=>{
 for(const mode of ['off-list','page-changed'] as const){
  const s=fixture(),o=await s.adapter.observe(signal());
  await assert.rejects(s.adapter.act({binding:o.binding,element:'e3',input:{kind:'type',secret:{owner:'local-owner',slot:'x'}},gates:[]},{signal:signal(),secret:async()=>{
   if(mode==='off-list')s.offList();else s.reflect('Renamed');
   return new TextEncoder().encode('synthetic-secret-value');
  }}),mode==='off-list'?(error:AgentBrowserError)=>error.code==='origin-blocked':/binding changed/);
  assert.ok(!s.calls.some(call=>call.args[0]==='batch'&&call.stdin?.includes('"fill"')),mode);
  assert.equal(s.adapter.isPrivate(),true);
 }
});

test('private taint scrubs labels, urls, dialog reports and error snapshots',async()=>{
 const s=fixture(),o=await s.adapter.observe(signal()),secret='synthetic-secret-value';
 await s.adapter.act({binding:o.binding,element:'e3',input:{kind:'type',secret:{owner:'local-owner',slot:'x'}},gates:[]},{signal:signal(),secret:async()=>new TextEncoder().encode(secret)});
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
 const crowded:FakePage={e1:{name:'Submit',role:'button'},e65:{name:'Card number',role:'textbox'}};
 for(let index=2;index<65;index++)crowded['e'+index]={name:'Filler '+index,role:'button'};
 const s=fixture({refs:crowded}),o=await s.adapter.observe(signal());
 assert.equal(o.structure.length,64);
 assert.deepEqual(o.structure.find(node=>node.id==='e1')!.gates,[{kind:'payment'}]);
});

test('the page origin rule accepts HTTPS anywhere and HTTP on loopback only',()=>{
 assert.equal(browserPageOriginRule('https://shop.example'),'https://shop.example:443');
 assert.equal(browserPageOriginRule('http://127.0.0.1:8080'),'http://127.0.0.1:8080');
 assert.equal(browserPageOriginRule('http://localhost:3000'),'http://localhost:3000');
 assert.equal(browserPageOriginRule('http://[::1]:8080'),'http://[::1]:8080');
 for(const bad of ['http://shop.example','http://10.0.0.1:8080','ftp://127.0.0.1'])assert.throws(()=>browserPageOriginRule(bad),/HTTPS/);
});

test('Enter-capable controls on a page with a card field carry the observed payment raise',async()=>{
 const sensitive=await fixture().adapter.observe(signal());
 const textbox=sensitive.structure.find(node=>node.id==='e3')!;
 assert.ok(textbox.operations.includes('key'));
 assert.deepEqual(textbox.gates,[{kind:'payment'}]);
 assert.deepEqual(sensitive.structure.find(node=>node.id==='e2')!.gates,[{kind:'payment'}]);
 const plain=fixture({refs:{e1:{name:'Search',role:'textbox'},e2:{name:'Go',role:'button'}}});
 const clean=await plain.adapter.observe(signal());
 assert.deepEqual(clean.structure.find(node=>node.id==='e1')!.gates,[]);
 assert.deepEqual(clean.structure.find(node=>node.id==='e2')!.gates,[]);
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
 assert.deepEqual(o.structure.find(node=>node.id==='e1')!.gates,[{kind:'send'}]);
 s.growSensitive();
 await assert.rejects(s.adapter.act({binding:o.binding,element:'e1',input:{kind:'click'},gates:[]},{signal:signal()}),/binding changed/);
 assert.ok(!argvOf(s.calls).some(a=>a[0]==='click'));
 const next=await s.adapter.observe(signal());
 assert.deepEqual(next.structure.find(node=>node.id==='e1')!.gates,[{kind:'payment'}]);
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

test('each adapter incarnation has a fresh surface identity',async()=>{
 const s=fixture(),first=await s.adapter.observe(signal());
 const recreated=new AgentBrowserEnvironment({environment:'agent-fixture',session:'member-fixture',runner:s.runner,origins:[origin]});
 const second=await recreated.observe(signal());
 assert.notEqual(second.binding.surface,first.binding.surface);
 await assert.rejects(recreated.act({binding:first.binding,element:'e2',input:{kind:'click'},gates:[]},{signal:signal()}),/binding changed/);
 assert.ok(!argvOf(s.calls).some(a=>a[0]==='click'));
});

test('a failing action that lands off-list still leaves and records the deviation',async()=>{
 const s=fixture(),o=await s.adapter.observe(signal());s.failClickOffList();
 await assert.rejects(s.adapter.act({binding:o.binding,element:'e2',input:{kind:'click'},gates:[]},{signal:signal()}),(error:AgentBrowserError)=>error.code==='command');
 assert.ok(s.adapter.report().deviations.some(entry=>entry==='left-origin:https://evil.example'));
 assert.ok(argvOf(s.calls).some(a=>a[0]==='back'));
 await s.adapter.observe(signal());
});

test('resolved secret bytes are erased even when validation or decoding throws',async()=>{
 for(const bytes of [new Uint8Array([255,254]),new Uint8Array(16001)]){void bytes;
  const s=fixture(),o=await s.adapter.observe(signal());
  await assert.rejects(s.adapter.act({binding:o.binding,element:'e3',input:{kind:'type',secret:{owner:'local-owner',slot:'x'}},gates:[]},{signal:signal(),secret:async()=>bytes}));
  assert.ok(bytes.every(byte=>byte===0));
 }
});

test('payment-intent actions are refused before any dispatch',async()=>{
 const s=fixture(),o=await s.adapter.observe(signal()),intent={kind:'payment-intent',payee:'Fixture recipient',amountMinor:100,currency:'USD',purpose:'Fixture request',sourceReference:'work:fixture'} as const;
 await assert.rejects(s.adapter.act({binding:o.binding,element:'e2',input:{kind:'click'},gates:[{kind:'payment',intent}]},{signal:signal()}),/Payment intents/);
 assert.ok(!argvOf(s.calls).some(a=>a[0]==='click'));
});

test('an observation interleaved with an action is superseded',async()=>{
 const s=fixture();s.slowSnapshots();
 const pending=s.adapter.observe(signal());
 void s.adapter.act({binding:{environment:'agent-fixture',surface:'agent-browser:member-fixture:x',origin,generation:1,revision:1},element:'e1',input:{kind:'click'},gates:[]},{signal:signal()}).catch(()=>{});
 await assert.rejects(pending,/superseded/);
});

test('control names raise the kind: send and delete words beat a plain button',async()=>{
 const s=fixture({refs:{e1:{name:'Buy now',role:'button'},e2:{name:'Next',role:'link'},e3:{name:'Search',role:'textbox'},e4:{name:'메시지 보내기',role:'button'},e5:{name:'영구 삭제',role:'button'}}});
 const o=await s.adapter.observe(signal());
 assert.deepEqual(o.structure.find(node=>node.id==='e1')!.gates,[{kind:'send',alwaysAsk:true}]);
 assert.deepEqual(o.structure.find(node=>node.id==='e4')!.gates,[{kind:'send'}]);
 assert.deepEqual(o.structure.find(node=>node.id==='e5')!.gates,[{kind:'delete'}]);
 assert.deepEqual(o.structure.find(node=>node.id==='e2')!.gates,[]);
 assert.deepEqual(o.structure.find(node=>node.id==='e3')!.gates,[]);
 const store=new InMemoryStore(),ledger=new EnvironmentActions(store,store,s.adapter,{owner:'local-owner',environment:'agent-fixture',permissionLevel:'auto'});
 const raised=await ledger.propose('send','e4',{kind:'click'});
 assert.deepEqual(raised.request.type==='action'?raised.request.action.gates:[],[{kind:'send'}]);assert.equal(raised.status,'waiting');
 const plain=fixture({refs:{e1:{name:'Continue',role:'button'}}}),plainStore=new InMemoryStore(),plainLedger=new EnvironmentActions(plainStore,plainStore,plain.adapter,{owner:'local-owner',environment:'agent-fixture',permissionLevel:'auto'});
 const missing=await plainLedger.propose('next','e1',{kind:'click'});
 assert.deepEqual(missing.request.type==='action'?missing.request.action.gates:[],[{kind:'send'}]);assert.equal(missing.status,'waiting');
 assert.ok(!argvOf(s.calls).some(a=>a[0]==='click'));
});

test('every clickable role raises by name while a plain link stays reading',async()=>{
 const s=fixture({refs:{e1:{name:'Delete',role:'link'},e2:{name:'공유',role:'checkbox'},e3:{name:'Next',role:'link'},e4:{name:'Sort order',role:'link'},e5:{name:'border',role:'link'}}});
 const o=await s.adapter.observe(signal());
 assert.deepEqual(o.structure.find(node=>node.id==='e1')!.gates,[{kind:'delete'}]);
 assert.deepEqual(o.structure.find(node=>node.id==='e2')!.gates,[{kind:'send'}]);
 assert.deepEqual(o.structure.find(node=>node.id==='e4')!.gates,[{kind:'send',alwaysAsk:true}],'whole payment words always ask');
 assert.deepEqual(o.structure.find(node=>node.id==='e5')!.gates,[],'order inside border does not match');
 assert.deepEqual(o.structure.find(node=>node.id==='e3')!.gates,[]);
 const store=new InMemoryStore(),ledger=new EnvironmentActions(store,store,s.adapter,{owner:'local-owner',environment:'agent-fixture',permissionLevel:'auto'});
 const raised=await ledger.propose('purge','e1',{kind:'click'});
 assert.deepEqual(raised.request.type==='action'?raised.request.action.gates:[],[{kind:'delete'}]);assert.equal(raised.status,'waiting');
 await ledger.answer('decline-purge','purge',raised.hash,'decline');
 const plain=await ledger.propose('next','e3',{kind:'click'});
 assert.deepEqual(plain.request.type==='action'?plain.request.action.gates:[],[]);assert.equal(plain.status,'ready');
});

test('payment-list words raise to send, never to the non-executable payment gate',async()=>{
 const s=fixture({refs:{e1:{name:'주문 내역',role:'button'},e2:{name:'Reorder',role:'button'},e3:{name:'checkout',role:'button'},e4:{name:'postpone',role:'button'}}});
 const o=await s.adapter.observe(signal());
 assert.deepEqual(o.structure.find(node=>node.id==='e1')!.gates,[{kind:'send',alwaysAsk:true}]);
 assert.deepEqual(o.structure.find(node=>node.id==='e3')!.gates,[{kind:'send',alwaysAsk:true}]);
 assert.deepEqual(o.structure.find(node=>node.id==='e2')!.gates,[],'reorder has no whole word order');
 assert.deepEqual(o.structure.find(node=>node.id==='e4')!.gates,[],'postpone has no whole word post');
 const store=new InMemoryStore(),ledger=new EnvironmentActions(store,store,s.adapter,{owner:'local-owner',environment:'agent-fixture',permissionLevel:'auto'});
 const history=await ledger.propose('orders','e1',{kind:'click'});
 assert.deepEqual(history.request.type==='action'?history.request.action.gates:[],[{kind:'send',alwaysAsk:true}]);assert.equal(history.status,'waiting');
 await ledger.answer('approve-orders','orders',history.hash,'approve');
 assert.equal((await ledger.execute('orders',history.hash)).status,'delivered');
});

test('off-list link and formaction targets are refused before the request leaves',async()=>{
 const s=fixture();
 s.setAttr('@e1','href','https://evil.example/x');
 const o=await s.adapter.observe(signal());
 await assert.rejects(s.adapter.act({binding:o.binding,element:'e1',input:{kind:'click'},gates:[]},{signal:signal()}),(error:AgentBrowserError)=>error.code==='origin-blocked');
 assert.ok(s.adapter.report().deviations.some(entry=>entry==='refused-target:https://evil.example'));
 assert.ok(!argvOf(s.calls).some(a=>a[0]==='click'));
 s.setAttr('@e2','formaction','http://evil.example/steal');
 const armed=await s.adapter.observe(signal());
 await assert.rejects(s.adapter.act({binding:armed.binding,element:'e2',input:{kind:'click'},gates:[{kind:'send'}]},{signal:signal()}),(error:AgentBrowserError)=>error.code==='origin-blocked');
 assert.ok(!argvOf(s.calls).some(a=>a[0]==='click'));
 s.setAttr('@e2','formaction',origin+'/own-page');
 const allowed=await s.adapter.observe(signal());
 await s.adapter.act({binding:allowed.binding,element:'e2',input:{kind:'click'},gates:[{kind:'send'}]},{signal:signal()});
 assert.ok(argvOf(s.calls).some(a=>a[0]==='click'&&a[1]==='@e2'));
});

test('changed href or formaction targets invalidate the approved binding',async()=>{
 const s=fixture();
 s.setAttr('@e2','formaction',origin+'/orders/first/delete');
 const approved=await s.adapter.observe(signal());
 s.setAttr('@e2','formaction',origin+'/orders/second/delete');
 await assert.rejects(s.adapter.act({binding:approved.binding,element:'e2',input:{kind:'click'},gates:[{kind:'send'}]},{signal:signal()}),/binding changed/);
 assert.ok(!argvOf(s.calls).some(a=>a[0]==='click'));
 const fresh=await s.adapter.observe(signal());
 await s.adapter.act({binding:fresh.binding,element:'e2',input:{kind:'click'},gates:[{kind:'send'}]},{signal:signal()});
 assert.ok(argvOf(s.calls).some(a=>a[0]==='click'&&a[1]==='@e2'));
 s.setAttr('@e1','href',origin+'/page-one');
 const linkApproved=await s.adapter.observe(signal());
 s.setAttr('@e1','href',origin+'/page-two');
 await assert.rejects(s.adapter.act({binding:linkApproved.binding,element:'e1',input:{kind:'click'},gates:[]},{signal:signal()}),/binding changed/);
});

test('known secrets are never evicted from the scrub set while the environment is open',async()=>{
 const s=fixture({refs:{e1:{name:'Search',role:'textbox'},e2:{name:'Go',role:'button'}}});
 const o=await s.adapter.observe(signal());
 const first='synthetic-secret-00',values=Array.from({length:17},(_,index)=>'synthetic-secret-'+String(index).padStart(2,'0'));
 for(const value of values)await s.adapter.act({binding:o.binding,element:'e1',input:{kind:'type',secret:{owner:'local-owner',slot:'x'}},gates:[]},{signal:signal(),secret:async()=>new TextEncoder().encode(value)});
 s.dialog({type:'confirm',message:'typed '+first});
 await s.adapter.act({binding:o.binding,element:'e2',input:{kind:'click'},gates:[]},{signal:signal()});
 const dialogs=s.adapter.report().dialogs;
 assert.ok(dialogs.some(dialog=>dialog.message.includes('\u2022\u2022\u2022\u2022')));
 assert.ok(dialogs.every(dialog=>!dialog.message.includes(first)));
});

test('past the secret bound the fill is refused instead of forgetting a value',async()=>{
 const s=fixture({refs:{e1:{name:'Search',role:'textbox'}}});
 const o=await s.adapter.observe(signal());
 for(let index=0;index<256;index++)await s.adapter.act({binding:o.binding,element:'e1',input:{kind:'type',secret:{owner:'local-owner',slot:'x'}},gates:[]},{signal:signal(),secret:async()=>new TextEncoder().encode('value-'+index)});
 await assert.rejects(s.adapter.act({binding:o.binding,element:'e1',input:{kind:'type',secret:{owner:'local-owner',slot:'x'}},gates:[]},{signal:signal(),secret:async()=>new TextEncoder().encode('value-256')}),/bound/i);
});

test('a failed target attribute read refuses the button rather than binding an unknown destination',async()=>{
 const s=fixture();s.failBatchAttrs();
 const o=await s.adapter.observe(signal());
 assert.ok(!o.structure.some(node=>node.id==='e2'),'the button is not offered');
 assert.ok(o.structure.some(node=>node.id==='e1'),'links keep their snapshot targets');
});

test('a page that changes while the secret resolves is refused before any byte is dispatched',async()=>{
 for(const mode of ['off-list','renamed'] as const){
  const s=fixture({refs:{e1:{name:'Search',role:'textbox'}}});
  const o=await s.adapter.observe(signal());
  await assert.rejects(s.adapter.act({binding:o.binding,element:'e1',input:{kind:'type',secret:{owner:'local-owner',slot:'x'}},gates:[]},{signal:signal(),secret:async()=>{if(mode==='off-list')s.offList();else s.reflect('Renamed');return new TextEncoder().encode('synthetic-secret-value');}}),mode==='off-list'?(error:AgentBrowserError)=>error.code==='origin-blocked':/binding changed/);
  assert.ok(!s.calls.some(call=>call.args[0]==='batch'&&call.stdin?.includes('"fill"')),mode);
 }
});

test('a failed navigation that lands off-list is left and reported',async()=>{
 const s=fixture();s.failOpenOffList();
 await assert.rejects(s.adapter.navigate({url:origin+'/somewhere'},signal()),(error:AgentBrowserError)=>error.code==='command');
 assert.ok(s.adapter.report().deviations.some(entry=>entry.startsWith('left-origin:https://evil.example')));
 assert.ok(argvOf(s.calls).some(a=>a[0]==='back'));
});

test('a password field keeps sign-in possible: no payment raise, the fill stays private',async()=>{
 const s=fixture({refs:{e1:{name:'Password',role:'textbox'},e2:{name:'Sign in',role:'button'}}});
 const o=await s.adapter.observe(signal());
 assert.deepEqual(o.structure.find(n=>n.id==='e1')!.gates,[]);
 assert.deepEqual(o.structure.find(n=>n.id==='e2')!.gates,[]);
 const store=new InMemoryStore();let bytes:Uint8Array|undefined;
 const ledger=new EnvironmentActions(store,store,s.adapter,{owner:'local-owner',environment:'agent-fixture',resolveSecret:async()=>bytes=new TextEncoder().encode('synthetic-login-value')});
 const fill=await ledger.propose('fill','e1',{kind:'type',secret:{owner:'local-owner',slot:'login'}});
 assert.equal(fill.status,'ready');
 assert.equal((await ledger.execute('fill',fill.hash)).status,'delivered');
 const entry=await ledger.propose('submit','e2',{kind:'click'});
 assert.equal(entry.status,'waiting');await ledger.answer('approve','submit',entry.hash,'approve');
 assert.equal((await ledger.execute('submit',entry.hash)).status,'delivered');
 assert.equal(s.adapter.isPrivate(),true);
 assert.ok(!JSON.stringify(store.inspect()).includes('synthetic-login-value'));
});

test('a comma in a link URL stays inside the binding digest',async()=>{
 const s=fixture({refs:{e1:{name:'Delete',role:'link'}}});
 s.setAttr('@e1','href',origin+'/delete?items=first,second');
 const approved=await s.adapter.observe(signal());
 s.setAttr('@e1','href',origin+'/delete?items=first,third');
 await assert.rejects(s.adapter.act({binding:approved.binding,element:'e1',input:{kind:'click'},gates:[{kind:'delete'}]},{signal:signal()}),/binding changed/);
 assert.ok(!argvOf(s.calls).some(a=>a[0]==='click'));
});

test('a changed checked state invalidates the approved binding',async()=>{
 const s=fixture({refs:{e1:{name:'Accept',role:'checkbox'}}});
 const approved=await s.adapter.observe(signal());
 s.check('e1');
 await assert.rejects(s.adapter.act({binding:approved.binding,element:'e1',input:{kind:'click'},gates:[]},{signal:signal()}),/binding changed/);
 assert.ok(!argvOf(s.calls).some(a=>a[0]==='click'));
});

test('Enter and select refuse to submit a form whose action leaves the approved list',async()=>{
 const s=fixture({refs:{e3:{name:'Search',role:'textbox'},e5:{name:'Plan',role:'combobox'}}});
 s.setForms(['https://evil.example/take']);
 const o=await s.adapter.observe(signal());
 await assert.rejects(s.adapter.act({binding:o.binding,element:'e3',input:{kind:'key',key:'Enter'},gates:[]},{signal:signal()}),(error:AgentBrowserError)=>error.code==='origin-blocked');
 await assert.rejects(s.adapter.act({binding:o.binding,element:'e5',input:{kind:'select',option:'one'},gates:[]},{signal:signal()}),(error:AgentBrowserError)=>error.code==='origin-blocked');
 assert.ok(!argvOf(s.calls).some(a=>a[0]==='focus'||a[0]==='press'||a[0]==='select'));
});

test('a card field raises payment on every control that can change the form, including selects',async()=>{
 const s=fixture({refs:{e1:{name:'Card number',role:'textbox'},e2:{name:'Plan',role:'combobox'},e3:{name:'Accept',role:'checkbox'},e4:{name:'Choice',role:'radio'},e5:{name:'Next',role:'link'}}});
 const o=await s.adapter.observe(signal());
 for(const id of ['e1','e2','e3','e4'])assert.deepEqual(o.structure.find(n=>n.id===id)!.gates,[{kind:'payment'}],id);
 assert.deepEqual(o.structure.find(n=>n.id==='e5')!.gates,[],'a link stays reading');
 const store=new InMemoryStore(),ledger=new EnvironmentActions(store,store,s.adapter,{owner:'local-owner',environment:'agent-fixture',permissionLevel:'full-access'});
 const entry=await ledger.propose('plan','e2',{kind:'select',option:'one'});
 assert.equal(entry.status,'waiting');await ledger.answer('approve','plan',entry.hash,'approve');
 await assert.rejects(ledger.execute('plan',entry.hash),/payment/i);
 assert.ok(!argvOf(s.calls).some(a=>a[0]==='select'&&a[1]==='@e2'));
});

test('a payment-word control with no card field always asks and still executes after the answer',async()=>{
 const s=fixture({refs:{e1:{name:'Buy now',role:'button'},e2:{name:'Search',role:'textbox'}}});
 const o=await s.adapter.observe(signal());
 assert.deepEqual(o.structure.find(n=>n.id==='e1')!.gates,[{kind:'send',alwaysAsk:true}]);
 const store=new InMemoryStore(),ledger=new EnvironmentActions(store,store,s.adapter,{owner:'local-owner',environment:'agent-fixture',permissionLevel:'full-access',rememberedApprovals:[{covers:'send',scope:'site',origin:origin+':443'}]});
 const entry=await ledger.propose('buy','e1',{kind:'click'});
 assert.deepEqual(entry.request.type==='action'?entry.request.action.gates:[],[{kind:'send',alwaysAsk:true}]);
 assert.equal(entry.status,'waiting');
 await ledger.answer('approve','buy',entry.hash,'approve');
 assert.equal((await ledger.execute('buy',entry.hash)).status,'delivered');
 assert.ok(argvOf(s.calls).some(a=>a[0]==='click'&&a[1]==='@e1'));
});

test('a relative target resolves against the document base, not the page URL',async()=>{
 const s=fixture({refs:{e1:{name:'Next',role:'link'},e3:{name:'Search',role:'textbox'}}});
 s.setAttr('@e1','href','/relative');
 s.setBaseUri('https://evil.example/page');
 const o=await s.adapter.observe(signal());
 await assert.rejects(s.adapter.act({binding:o.binding,element:'e1',input:{kind:'click'},gates:[]},{signal:signal()}),(error:AgentBrowserError)=>error.code==='origin-blocked');
 assert.ok(!argvOf(s.calls).some(a=>a[0]==='click'));
 s.setForms(['/relative']);
 await assert.rejects(s.adapter.act({binding:o.binding,element:'e3',input:{kind:'key',key:'Enter'},gates:[]},{signal:signal()}),(error:AgentBrowserError)=>error.code==='origin-blocked');
 assert.ok(!argvOf(s.calls).some(a=>a[0]==='press'));
});

test('stdin EPIPE from an early-exiting CLI settles as a typed failure',async()=>{
 const root=await mkdtemp(join(tmpdir(),'massion-agent-browser-'));
 try{
  const newLine=String.fromCharCode(10),script=['#!/bin/sh','for arg in "$@"; do if [ "$arg" = "--version" ]; then echo "agent-browser 0.41.2"; exit 0; fi; done','exit 1'].join(newLine);
  await writeFile(join(root,'agent-browser'),script,{mode:0o700});
  const {runner}=await createAgentBrowserRunner({session:'member-fixture',binary:join(root,'agent-browser'),namespace:join(root,'ns')});
  await assert.rejects(runner(['batch','--json','--omit-command'],{stdin:'x'.repeat(16000)}),(error:AgentBrowserError)=>error.code==='command');
 }finally{await rm(root,{recursive:true,force:true});}
});
