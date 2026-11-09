import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {once} from 'node:events';
import {join} from 'node:path';
import {AppsService,appDecisionId} from '../../src/apps.ts';
import type {AppPackage} from '../../src/apps.ts';
import {InMemoryStore} from '../../src/storage.ts';
import {createWorkbench} from '../../src/server.ts';

// Use the development server and owner approval path without external services.
const directory=await mkdtemp('/private/tmp/massion-frame-browser-'),store=new InMemoryStore<any>();
const tools=[{name:'read',description:'Read',inputSchema:{type:'object'},readOnly:true}];
const pkg:AppPackage={manifest:{format:'massion.app.v1',id:'frame-probe',name:'검증 앱',version:'1.0.0',description:'격리 문서',kind:'mcp',mcp:{transport:'http',url:'http://127.0.0.1:4318/mcp',tools},permissions:{read:['read'],write:[],network:['127.0.0.1'],files:[],secrets:[],events:[]},contributes:{templates:[],skills:[],procedures:[],tools:['read'],page:{title:'문서 검증'}},handlers:['run','page']},source:''};
const service=new AppsService(store);
await service.offer({commandId:'assistant-app-browser-offer',pkg,origin:'catalog'});
assert.equal((await service.decide({commandId:'install-browser-frame',decisionId:appDecisionId('assistant-app-browser-offer'),answer:'act'})).status,'committed');
const mcp={list:async()=>tools,call:async()=>({}),close:async()=>{},view:async()=>({title:'문서 검증',html:`<!doctype html><html lang="ko"><meta charset="utf-8"><style>
body{margin:0;padding:24px;background:rgb(234,235,236);color:rgb(23,24,25);font:18px sans-serif}h1{font-size:24px}button{padding:12px;font:inherit}
@media(prefers-color-scheme:dark){body{background:rgb(12,34,56);color:rgb(210,220,230)}}
</style><h1>격리 문서</h1><button id="resize" type="button">크기 변경</button><script>
window.probe={ran:true,parentBlocked:false,networkBlocked:false,opaque:self.origin==='null'};
try{parent.document.body.dataset.appEscaped='true';}catch{window.probe.parentBlocked=true;}
const report=()=>document.querySelector('h1').dataset.probe=JSON.stringify({...window.probe,background:getComputedStyle(document.body).backgroundColor,origin:self.origin,node:typeof require,desktopBridge:typeof window.massionDesktop});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change',report);
Promise.all(['https://example.org/','http://127.0.0.1:1/',location.href].map(url=>fetch(url).then(()=>false,()=>true))).then(blocked=>{
 window.probe.networkBlocked=blocked.every(Boolean);report();parent.postMessage({type:'ready'},'*');parent.postMessage({type:'resize',height:617},'*');
});
document.getElementById('resize').onclick=()=>parent.postMessage({type:'resize',height:701},'*');
</script></html>`})};
const server=createWorkbench(store,join(directory,'workspace'),{scheduleIntervalMs:0,mcp});
server.listen(0,'127.0.0.1');await once(server,'listening');
console.log(JSON.stringify({url:'http://127.0.0.1:'+(server.address() as {port:number}).port,appId:'app-frame-probe',externalCalls:0}));
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{void server.drain().then(()=>rm(directory,{recursive:true,force:true})).then(()=>process.exit(0));});
