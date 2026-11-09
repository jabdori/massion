import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createWorkbench} from '../src/server.ts';
import {InMemoryStore} from '../src/storage.ts';
import {AppsService,appDecisionId} from '../src/apps.ts';
import type {AppPackage} from '../src/apps.ts';

// Only documents from the actual approved app path are published.
test('browser view publishes installed app HTML outside the workbench origin and closes with it',async t=>{
 const store=new InMemoryStore<any>(),tools=[{name:'read',description:'Read',inputSchema:{type:'object'},readOnly:true}];
 const pkg:AppPackage={manifest:{format:'massion.app.v1',id:'frame-probe',name:'Probe',version:'1.0.0',description:'Probe',kind:'mcp',mcp:{transport:'http',url:'http://127.0.0.1:4318/mcp',tools},permissions:{read:['read'],write:[],network:['127.0.0.1'],files:[],secrets:[],events:[]},contributes:{templates:[],skills:[],procedures:[],tools:['read'],page:{title:'Probe'}},handlers:['run','page']},source:''};
 const service=new AppsService(store);await service.offer({commandId:'assistant-app-frame-offer',pkg,origin:'catalog'});
 let views=0;const mcp={list:async()=>tools,call:async()=>({}),close:async()=>{},view:async()=>{views++;return {title:'Probe',html:'<style>body{color:red}</style><script>window.ran=true</script>'};}};
 const server=createWorkbench(store,process.cwd(),{scheduleIntervalMs:0,mcp});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.drain());
 const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const view=()=>fetch(base+'/assistant/apps/view',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({app:'app-frame-probe',handler:'page'})});
 assert.equal((await view()).status,400);assert.equal(views,0);
 await service.decide({commandId:'install-frame',decisionId:appDecisionId('assistant-app-frame-offer'),answer:'act'});
 const response=await view();assert.equal(response.status,200);const data=await response.json() as any;
 assert.equal(data.frame.html,undefined);assert.equal(typeof data.frame.url,'string');
 assert.notEqual(new URL(data.frame.url).origin,base);
 assert.match(await (await fetch(data.frame.url)).text(),/window.ran=true/);
 const root=await fetch(base);assert.ok(root.headers.get('content-security-policy')!.includes('frame-src '+new URL(data.frame.url).origin));
 await server.drain();await assert.rejects(fetch(data.frame.url));
});
