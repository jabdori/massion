import test from 'node:test';
import assert from 'node:assert/strict';
import {AppsService,APPS_ID,validatePackage,applyApps,appDecisionId} from '../src/apps.ts';
import type {AppPackage} from '../src/apps.ts';
import {InMemoryStore} from '../src/storage.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';
import {createWorkbench} from '../src/server.ts';
import {InMemorySecretSlots} from '../src/secret-slots.ts';

const host={id:'assistant-representative',roles:['assistant' as const]};
const tools=[{name:'list_prs',description:'List pull requests',inputSchema:{type:'object'},readOnly:true},{name:'comment',description:'Comment on a pull request',inputSchema:{type:'object'},readOnly:false}];
function pkg():AppPackage {return {manifest:{format:'massion.app.v1',id:'mcp-github',name:'GitHub',version:'1.0.0',description:'Pull requests',kind:'mcp',mcp:{transport:'http',url:'http://127.0.0.1:4318/mcp',tools:structuredClone(tools)},permissions:{read:['list_prs'],write:['comment'],network:['127.0.0.1'],files:[],secrets:[],events:[]},contributes:{templates:[],skills:[],procedures:[],tools:['list_prs','comment']},handlers:['run']},source:''} as AppPackage;}
async function setup(options:any={}) {const store=new InMemoryStore<any>(),service=new AppsService(store,options);await service.offer({commandId:'assistant-app-offer',pkg:pkg(),origin:'catalog'});return {store,service,decisionId:appDecisionId('assistant-app-offer')};}
const install=(s:AppsService,decisionId:string)=>s.decide({commandId:'install',decisionId,answer:'act'});
const call=(s:AppsService,name='list_prs',commandId='assistant-app-call')=>(s as any).callTool({commandId,appId:'app-mcp-github',name,arguments:{}});

test('MCP manifests validate one local server, pinned tools and exact scope',()=>{
 assert.equal(validatePackage(pkg()),null);
 for(const url of ['http://evil.example/mcp','http://user@127.0.0.1:4318/mcp','file:///tmp/mcp','http://127.0.0.1:4318/mcp#secret']){const p:any=pkg();p.manifest.mcp.url=url;assert.match(validatePackage(p)!,/MCP/);}
 const p:any=pkg();p.manifest.mcp.tools.push({...tools[0]});assert.match(validatePackage(p)!,/MCP/);
 const stdio:any=pkg();stdio.manifest.mcp={transport:'stdio',target:'approved-server',tools:structuredClone(tools)};stdio.manifest.permissions.network=['localhost'];assert.equal(validatePackage(stdio),null);
 stdio.manifest.mcp.args=['--unsafe'];assert.match(validatePackage(stdio)!,/MCP/);
});

test('MCP install waits for owner; simultaneous identical answers commit once',async()=>{
 const {store,service,decisionId}=await setup();assert.equal((await service.read()).apps.length,0);
 await assert.rejects(call(service),/installed/);
 const initial=(await store.load(APPS_ID))!.value;
 assert.throws(()=>applyApps(initial,{type:'decide-app',decisionId,answer:'act'},host,{observedAt:1}),/role/);
 const results=await Promise.all([install(service,decisionId),install(service,decisionId)]);
 assert.deepEqual(results.map(r=>r.status).sort(),['committed','replayed']);assert.equal((await service.read()).apps.length,1);
 validateMissionJournalLineage(store.inspect() as any);
});

test('changed tools or endpoint require owner approval; removing tools narrows',async()=>{
 const {service,decisionId}=await setup();await install(service,decisionId);
 const changed:any=pkg();changed.manifest.version='1.0.1';changed.manifest.mcp.tools[0].description='Also delete';
 await service.offer({commandId:'assistant-app-change',pkg:changed,origin:'catalog'});
 assert.equal((await service.read()).apps[0]!.version,'1.0.0');assert.equal((await service.decisions(null)).filter(d=>d.state==='open').length,1);
 const narrower:any=pkg();narrower.manifest.version='1.0.2';narrower.manifest.mcp.tools.pop();narrower.manifest.permissions.write=[];narrower.manifest.contributes.tools.pop();
 await service.offer({commandId:'assistant-app-narrow',pkg:narrower,origin:'catalog'});assert.equal((await service.read()).apps[0]!.version,'1.0.2');
 const moved:any=structuredClone(narrower);moved.manifest.version='1.0.3';moved.manifest.mcp.url='http://127.0.0.1:4319/mcp';
 await service.offer({commandId:'assistant-app-move',pkg:moved,origin:'catalog'});assert.equal((await service.read()).apps[0]!.version,'1.0.2');
});

test('only pinned tools reach transport; changed live list refuses before sending',async()=>{
 let sent=0,live=structuredClone(tools);const mcp={list:async()=>live,call:async()=>{sent++;return {content:[{type:'text',text:'data only'}]};},close:async()=>{}};
 const {service,decisionId,store}=await setup({mcp});await install(service,decisionId);
 assert.equal((await call(service)).status,'succeeded');assert.equal(sent,1);
 await assert.rejects(call(service,'delete','assistant-app-delete'),/declared|scope/);assert.equal(sent,1);
 live=[...tools,{name:'delete',description:'Delete',inputSchema:{type:'object'},readOnly:false}];
 await assert.rejects(call(service,'list_prs','assistant-app-changed'),/changed|approval/);assert.equal(sent,1);
 live=structuredClone(tools);await service.act({commandId:'off',action:'disable',appId:'app-mcp-github'});
 await assert.rejects(call(service,'list_prs','assistant-app-off'),/off/);assert.equal(sent,1);
 validateMissionJournalLineage(store.inspect() as any);
});

test('write timeout is durable unknown and never resent across service restart',async()=>{
 let sent=0,closed=0,aborted=false;
 const mcp={list:async()=>tools,call:async(r:any)=>{sent++;r.signal.addEventListener('abort',()=>{aborted=true;});return new Promise(()=>{});},close:async()=>{closed++;}};
 const {service,store,decisionId}=await setup({mcp,toolTimeoutMs:10});await install(service,decisionId);
 const input={commandId:'assistant-app-write',appId:'app-mcp-github',name:'comment',arguments:{text:'hello'}};
 const [a,b]=await Promise.all([(service as any).callTool(input),(service as any).callTool(input)]);
 assert.equal(a.status,'unknown');assert.equal(b.status,'unknown');assert.equal(sent,1);assert.equal(aborted,true);assert.ok(closed>=1);
 const next=new AppsService(store,{mcp} as any);assert.equal((await (next as any).callTool(input)).status,'unknown');assert.equal(sent,1);
 assert.equal((await call(new AppsService(store,{mcp,toolTimeoutMs:10} as any),'list_prs','assistant-app-read')).status,'failed');
 validateMissionJournalLineage(store.inspect() as any);
});

async function connectedSetup(slots:any){const store=new InMemoryStore<any>(),service=new AppsService(store,{secrets:slots,mcp:{list:async()=>tools,call:async()=>({}),close:async()=>{}}}),p:any=pkg();p.manifest.permissions.secrets=[{slot:'github-token',label:'GitHub token'}];p.manifest.connection={slot:'github-token'};await service.offer({commandId:'assistant-app-offer',pkg:p,origin:'catalog'});return {store,service,decisionId:appDecisionId('assistant-app-offer')};}
test('connect writes token once to its own slot; no token or token hash enters journal or readback',async()=>{
 const sentinel='sentinel-private-token-E5b',stored=new InMemorySecretSlots();let writes=0;const slots={set:async(ref:{owner:string;slot:string},value:string)=>{assert.deepEqual(ref,{owner:'app-mcp-github',slot:'github-token'});assert.equal(value,sentinel);await stored.set(ref,value);writes++;}};
 const {store,service,decisionId}=await connectedSetup(slots);
 await assert.rejects(install(service,decisionId),/connect|token/i);
 const input={commandId:'connect',decisionId,token:sentinel};const results=await Promise.all([(service as any).connect(input),(service as any).connect(input)]);
 assert.ok(results.every(r=>r.status==='committed'||r.status==='replayed'));assert.equal(writes,1);assert.equal(await stored.read({owner:'app-mcp-github',slot:'github-token'}),sentinel);assert.equal((await service.read()).apps.length,1);
 assert.equal((await service.decisions(null))[0]!.connection!.connected,true);
 assert.ok(!JSON.stringify([results,store.inspect(),await service.read(),await service.decisions(null)]).includes(sentinel));
 validateMissionJournalLineage(store.inspect() as any);
});

test('secret adapter failure is redacted, leaves uninstalled unknown, and never retries',async()=>{
 let writes=0;const sentinel='private-failed-secret';const {store,service,decisionId}=await connectedSetup({set:async()=>{writes++;throw new Error(sentinel);}});
 const input={commandId:'connect',decisionId,token:sentinel};assert.equal((await (service as any).connect(input)).status,'unknown');
 assert.equal((await (new AppsService(store,{secrets:{set:async()=>{writes++;}}} as any) as any).connect(input)).status,'unknown');assert.equal(writes,1);assert.equal((await service.read()).apps.length,0);assert.ok(!JSON.stringify(store.inspect()).includes(sentinel));
});

test('HTTP connect uses owner drain/feed guards and returns metadata only',async t=>{
 const sentinel='http-secret-sentinel';let writes=0;const slots={set:async()=>{writes++;}};const {store,decisionId}=await connectedSetup(slots);
 const server=createWorkbench(store,process.cwd(),{scheduleIntervalMs:0,appSecrets:slots,mcp:{list:async()=>tools,call:async()=>({}),close:async()=>{}}});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());const base='http://127.0.0.1:'+(server.address() as any).port;
 const post=(feed?:string)=>fetch(base+'/assistant/apps/connect',{method:'POST',headers:{'content-type':'application/json',...(feed?{'X-Massion-Feed':feed}:{})},body:JSON.stringify({commandId:'http-connect',decisionId,token:sentinel})});
 assert.equal((await post('old-feed')).status,409);assert.equal(writes,0);
 const response=await post();assert.equal(response.status,200);assert.ok(!(await response.text()).includes(sentinel));assert.equal(writes,1);
 const read=await fetch(base+'/assistant/conversation');assert.ok(!(await read.text()).includes(sentinel));
});

test('MCP app UI is admitted with the app and returned only as isolated frame data',async()=>{
 const store=new InMemoryStore<any>();let views=0;const p:any=pkg();p.manifest.handlers.push('page');p.manifest.contributes.page={title:'GitHub'};
 const service=new AppsService(store,{mcp:{list:async()=>tools,call:async()=>({}),close:async()=>{},view:async()=>{views++;return {title:'GitHub',html:'<script>parent.document.body.textContent="bad"</script><p>App view</p>'};}}} as any);
 await service.offer({commandId:'assistant-app-ui',pkg:p,origin:'catalog'});
 await assert.rejects(service.view({app:'app-mcp-github',handler:'page'}),/installed/);assert.equal(views,0);
 await install(service,appDecisionId('assistant-app-ui'));
 const view:any=await service.view({app:'app-mcp-github',handler:'page'});assert.equal(view.frame.html.includes('parent.document'),true);assert.deepEqual(view.groups,[]);assert.equal(views,1);
});

test('a connection held across drain cannot write its secret or install',async t=>{
 const {store,decisionId}=await connectedSetup({set:async()=>{}});let hold=true,reached!:()=>void,release!:()=>void,writes=0;
 const paused=new Promise<void>(r=>{reached=r;}),gate=new Promise<void>(r=>{release=r;});
 const guarded=new Proxy(store,{get(target,key){if(key==='load')return async(id:string)=>{if(hold&&id===APPS_ID){hold=false;reached();await gate;}return target.load(id);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const server=createWorkbench(guarded,process.cwd(),{scheduleIntervalMs:0,appSecrets:{set:async()=>{writes++;}},mcp:{list:async()=>tools,call:async()=>({}),close:async()=>{}}});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const response=fetch('http://127.0.0.1:'+(server.address() as any).port+'/assistant/apps/connect',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({commandId:'drain-connect',decisionId,token:'fixture-only'})});
 await paused;const drain=server.drain();release();assert.equal((await response).status,503);await drain;assert.equal(writes,0);assert.equal((await store.load(APPS_ID))!.value.apps[0].current,null);
});

test('database replacement after a connection claim fences the secret write',async()=>{
 const {store,decisionId}=await connectedSetup({set:async()=>{}});let replaced=false,writes=0;
 const guarded=new Proxy(store,{get(target,key){if(key==='readState')return async()=>({...await target.readState(),...(replaced?{feedId:'replacement'}:{})});if(key==='commit')return async(input:any)=>{const result=await target.commit(input);if(input.commandId==='replace-connect')replaced=true;return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const service=new AppsService(guarded,{secrets:{set:async()=>{writes++;}},mcp:{list:async()=>tools,call:async()=>({}),close:async()=>{}}});
 assert.equal((await service.connect({commandId:'replace-connect',decisionId,token:'fixture-only'})).status,'unknown');assert.equal(writes,0);assert.equal((await service.read()).apps.length,0);
});

test('an ambiguous committed tool claim never invokes, including after restart',async()=>{
 let sent=0;const adapter={list:async()=>tools,call:async()=>{sent++;return {};},close:async()=>{}};
 const {store,service,decisionId}=await setup({mcp:adapter});await install(service,decisionId);
 const guarded=new Proxy(store,{get(target,key){if(key==='commit')return async(input:any)=>{await target.commit(input);if(input.commandId==='assistant-app-lost'){const e=new Error('Lost receipt');e.name='CommitOutcomeUnknownError';throw e;}return target.lookupOperation({id:input.id,commandId:input.commandId,fingerprint:input.fingerprint});};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 await assert.rejects(call(new AppsService(guarded,{mcp:adapter}),'comment','assistant-app-lost'),/Lost receipt/);
 assert.equal((await call(new AppsService(store,{mcp:adapter}),'comment','assistant-app-lost')).status,'unknown');assert.equal(sent,0);
});

test('MCP schemas, arguments and results preserve finite JSON fractions',async()=>{
 const p:any=pkg();p.manifest.mcp.tools[0].inputSchema={type:'object',properties:{amount:{type:'number',minimum:0.01}}};assert.equal(validatePackage(p),null);
 const store=new InMemoryStore<any>(),service=new AppsService(store,{mcp:{list:async()=>p.manifest.mcp.tools,call:async r=>({content:[{type:'text',text:String(r.arguments.amount)}],structuredContent:{amount:0.125}}),close:async()=>{}}});
 await service.offer({commandId:'assistant-app-fraction',pkg:p,origin:'catalog'});await install(service,appDecisionId('assistant-app-fraction'));
 const result:any=await service.callTool({commandId:'assistant-app-fraction-call',appId:'app-mcp-github',name:'list_prs',arguments:{amount:0.125}});assert.equal(result.status,'succeeded');assert.equal(result.result.structuredContent.amount,0.125);
});

test('connection cards localize permission labels and approved updates reuse the saved slot',async()=>{
 const {service,store,decisionId}=await connectedSetup({set:async()=>{}});
 const card=(await service.decisions(null))[0]!;assert.equal(card.question,'GitHub 앱을 연결할까요?');assert.deepEqual(card.rows.map(r=>r[0]),['도구','읽기','쓰기','네트워크','토큰','이벤트','추가되는 것']);
 await service.connect({commandId:'connect',decisionId,token:'fixture-only'});
 const next:any=structuredClone((await store.load(APPS_ID))!.value.apps[0].versions[0].package);next.manifest.version='1.1.0';next.manifest.permissions.write.push('new-write');
 await service.offer({commandId:'assistant-app-updated-slot',pkg:next,origin:'catalog'});
 const update=(await service.decisions(null)).find(d=>d.state==='open')!;assert.equal(update.connection,undefined);
 assert.equal((await service.decide({commandId:'update',decisionId:update.id,answer:'act'})).status,'committed');assert.equal((await service.read()).apps[0]!.version,'1.1.0');
});

test('only an evidenced owner reconciliation releases the exact unknown call without resending it',async()=>{
 for(const outcome of ['done','not-done'] as const){
  let sent=0,listed=0,now=100;const adapter={list:async()=>{listed++;return tools;},call:async()=>{sent++;return sent===1?new Promise(()=>{}):{content:[]};},close:async()=>{}};
  const {store,service,decisionId}=await setup({mcp:adapter,toolTimeoutMs:10,clock:()=>now});await install(service,decisionId);
  assert.equal((await call(service,'comment','assistant-app-uncertain')).status,'unknown');
  await assert.rejects(call(service,'comment','assistant-app-next'),/Unresolved/);assert.equal(sent,1);
  const request={commandId:'reconcile',action:'reconcile',appId:'app-mcp-github',callId:'assistant-app-uncertain',outcome,evidence:'Service receipt #42 observed by owner'};
  await assert.rejects(service.act({...request,evidence:' '}),/evidence/i);
  await assert.rejects(service.act({...request,appId:'app-other'}),/call/i);
  const state=(await store.load(APPS_ID))!.value;
  assert.throws(()=>applyApps(state,{type:'reconcile-app-tool',appId:request.appId,callId:request.callId,outcome,evidence:request.evidence} as any,host,{observedAt:200}),/role/);
  const pending=structuredClone(state);pending.toolCalls[0].status='pending';assert.throws(()=>applyApps(pending,{type:'reconcile-app-tool',appId:request.appId,callId:request.callId,outcome,evidence:request.evidence},{id:'local-owner',roles:['owner']},{observedAt:200}),/unknown call/);
  const before={sent,listed};now=200;
  const result=await Promise.all([service.act(request),service.act(request)]);assert.deepEqual(result.map(r=>r.status).sort(),['committed','replayed']);assert.deepEqual({sent,listed},before);
  const resolved=(await store.load(APPS_ID))!.value.toolCalls.find((c:any)=>c.id===request.callId);
  assert.equal(resolved.status,outcome==='done'?'succeeded':'failed');assert.deepEqual(resolved.reconciliation,{actorId:'local-owner',at:200,outcome,evidence:request.evidence});
  assert.equal((await call(new AppsService(store,{mcp:adapter}),'comment',request.callId)).status,resolved.status);assert.deepEqual({sent,listed},before,'replay never invokes again');
  assert.equal((await call(service,'comment','assistant-app-next')).status,'succeeded');assert.equal(sent,2);
  validateMissionJournalLineage(store.inspect() as any);
 }
});

test('unknown app calls are projected without arguments and reconcile over the existing owner route',async t=>{
 const {store,service,decisionId}=await setup({mcp:{list:async()=>tools,call:async()=>new Promise(()=>{}),close:async()=>{}},toolTimeoutMs:10});await install(service,decisionId);
 await call(service,'comment','assistant-app-unknown-ui');
 const rail:any=await service.rail();assert.deepEqual(rail[0].unresolved,[{id:'assistant-app-unknown-ui',name:'comment',status:'unknown'}]);
 const server=createWorkbench(store,process.cwd(),{scheduleIntervalMs:0});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const base='http://127.0.0.1:'+(server.address() as any).port,body={commandId:'reconcile-http',action:'reconcile',appId:'app-mcp-github',callId:'assistant-app-unknown-ui',outcome:'not-done',evidence:'Server receipt confirms no effect'};
 const post=(feed?:string)=>fetch(base+'/assistant/apps',{method:'POST',headers:{'content-type':'application/json',...(feed?{'X-Massion-Feed':feed}:{})},body:JSON.stringify(body)});
 assert.equal((await post('old-feed')).status,409);assert.equal((await service.rail() as any)[0].unresolved.length,1);
 assert.equal((await post()).status,200);assert.deepEqual((await service.rail() as any)[0].unresolved,[]);
});
