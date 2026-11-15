import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,connect} from 'node:net';
import {createServer as createHttpServer,type ServerResponse as HttpResponse} from 'node:http';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {daemonGuard} from '../../src/daemon-auth.ts';
import {protocolConnection} from '../../src/protocol.ts';
import {contentPolicy,tauriConnectSources} from '../security.ts';
import {appDocumentHeaders} from '../../src/app-documents.ts';
import {createClientService,clientLimits} from '../client-relay.ts';
import type {ClientServiceOptions} from '../client-relay.ts';
import type {Socket} from 'node:net';

const html='<html><body><script>window.alive()</script><style>body{color:red}</style></body></html>';

interface FakeCore{origin:string;seen:Record<string,unknown>[];streams:Set<HttpResponse>;push(cursor:number):void;endStreams():void}

function fakeCore(t:any,secret:string):Promise<FakeCore>{
 const authenticate=daemonGuard(secret),seen:Record<string,unknown>[]=[],streams=new Set<HttpResponse>();
 let coreOrigin='';
 const server=createHttpServer(async(req,res)=>{
  if(!authenticate(req,res))return;
  seen.push({url:req.url,method:req.method,lastEventId:req.headers['last-event-id']});
  if(req.url?.startsWith('/protocol/events')){
   res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'});
   streams.add(res);res.on('close',()=>streams.delete(res));
   res.write('id: '+String(req.headers['last-event-id']??'["feed",0]')+'\ndata: {"resume":true}\n\n');
   return;
  }
  let body='';for await(const chunk of req)body+=chunk;
  let message:Record<string,unknown>={};try{message=JSON.parse(body);}catch{}
  if(req.url==='/protocol/connect'){res.end(JSON.stringify({...message,kind:'reply',status:200,payload:protocolConnection({min:1,max:1})}));return;}
  if(req.url==='/protocol/request'){
   const path=String(message.path??'');
   if(path==='/assistant/works')res.end(JSON.stringify({...message,kind:'reply',status:200,payload:{feedId:'feed',works:[{missionId:'mission',workId:'work',turnId:'turn',title:'Broken work',acceptance:'failed'}]}}));
   else if(path==='/assistant/conversation')res.end(JSON.stringify({...message,kind:'reply',status:200,payload:{feedId:'feed',decisions:[],members:[]}}));
   else if(path==='/leak')res.end(JSON.stringify({...message,kind:'reply',status:200,payload:{echo:secret+' '+coreOrigin}}));
   else if(path==='/hold')await new Promise(()=>{});
   else if(path==='/assistant/apps/view')res.end(JSON.stringify({...message,kind:'reply',status:200,payload:{status:200,frame:{html:'<p>isolated app</p>'}}}));
   else res.end(JSON.stringify({...message,kind:'reply',status:200,payload:{}}));
   return;
  }
  res.end('{}');
 });
 server.listen(0,'127.0.0.1',()=>{coreOrigin='http://127.0.0.1:'+(server.address() as {port:number}).port;});
 t.after(()=>{server.closeAllConnections();server.close();});
 return once(server,'listening').then(()=>({origin:coreOrigin,seen,streams,
  push(cursor:number){for(const res of streams)res.write('id: '+JSON.stringify(['feed',cursor])+'\ndata: '+JSON.stringify({cursor})+'\n\n');},
  endStreams(){for(const res of streams)res.end();}}));
}

async function harness(t:any,overrides:Partial<ClientServiceOptions>&{core?:FakeCore;secret?:string}={}){
 const secret=overrides.secret??randomBytes(32).toString('hex'),root=await mkdtemp(join(tmpdir(),'client-relay-')),document=join(root,'app.html');
 await writeFile(document,html);
 t.after(()=>rm(root,{recursive:true,force:true}));
 const core=overrides.core??await fakeCore(t,secret);
 const calls:string[]=[];
 const service=createClientService({origin:core.origin,secret,htmlCandidates:[document],settingsFile:join(root,'notifications.json'),version:'1.0.0-fixture',stopCore:async()=>{calls.push('stopCore');},startCore:()=>{calls.push('startCore');},observeIntervalMs:30,requestTimeoutMs:750,...overrides});
 const server=createServer((socket:Socket)=>{
  let buffer='';
  const handshake=(chunk:Buffer)=>{
   buffer+=String(chunk);
   const newline=buffer.indexOf('\n');
   if(newline===-1){if(buffer.length>32)socket.destroy();return;}
   if(buffer.slice(0,newline)!=='client'){socket.destroy();return;}
   socket.off('data',handshake);
   service.handle(socket,buffer.slice(newline+1));
  };
  socket.on('data',handshake);
 });
 server.listen(join(root,'client.sock'));await once(server,'listening');
 t.after(()=>{service.close();server.close();});
 const client=connect(join(root,'client.sock'));client.write('client\n');
 t.after(()=>client.destroy());
 const lines:string[]=[];let buffer='';
 client.on('data',chunk=>{
  buffer+=String(chunk);let index;
  while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(line)lines.push(line);}
 });
 return {service,client,lines,core,calls,async expect(match:(value:any)=>boolean,timeoutMs=4000){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
   for(const line of lines){const value=JSON.parse(line);if(match(value))return value;}
   await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw new Error('expected line not found; received:\n'+lines.join('\n'));
 }};
}

test("the app document reply carries today's headers, the CSP and the exact HTML",async t=>{
 const {client,expect}=await harness(t);
 client.write(JSON.stringify({id:'doc',method:'GET',path:'/'})+'\n');
 const reply=await expect(value=>value.id==='doc');
 const policy=contentPolicy(html,[...tauriConnectSources]);
 assert.equal(reply.status,200);assert.equal(reply.body,html);
 assert.deepEqual(reply.headers,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':policy,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
 assert.match(policy,/connect-src 'self' ipc: http:\/\/ipc\.localhost/);
 assert.match(policy,/frame-src massion-app:\/\/document/);
});

test('framing, path, method, header and size rules refuse everything the proxy refuses today',async t=>{
 const {client,expect}=await harness(t);
 client.write(JSON.stringify({id:'a',method:'GET',path:'/health'})+'\n');
 assert.equal((await expect(value=>value.id==='a')).error.code,'path');
 client.write(JSON.stringify({id:'b',method:'PUT',path:'/protocol/connect',body:'{}'})+'\n');
 assert.equal((await expect(value=>value.id==='b')).error.code,'method');
 client.write(JSON.stringify({id:'c',method:'GET',path:'/protocol/connect',body:'{}'})+'\n');
 assert.equal((await expect(value=>value.id==='c')).error.code,'method');
 client.write(JSON.stringify({id:'d',method:'POST',path:'/protocol/connect',headers:{'X-Other':'1'},body:'{}'})+'\n');
 assert.equal((await expect(value=>value.id==='d')).error.code,'header');
 client.write(JSON.stringify({id:'e',method:'POST',path:'/protocol/connect',body:'x'.repeat(49153)})+'\n');
 assert.equal((await expect(value=>value.id==='e')).error.code,'size');
 client.write('not-json\n');
 assert.equal((await expect(value=>value.id==='')).error.code,'invalid');
 client.write(JSON.stringify({id:'f',method:'GET',path:'/protocol/events?version=1',headers:{'Last-Event-ID':42}})+'\n');
 assert.equal((await expect(value=>value.id==='f')).error.code,'header');
});

test('a request line above the bound and too many pending requests are refused',async t=>{
 const {client,expect}=await harness(t);
 client.write(JSON.stringify({id:'held-0',method:'POST',path:'/protocol/request',body:JSON.stringify({path:'/hold'})})+'\n');
 for(let n=1;n<=clientLimits.pending;n++)client.write(JSON.stringify({id:'held-'+n,method:'POST',path:'/protocol/request',body:JSON.stringify({path:'/hold'})})+'\n');
 assert.equal((await expect(value=>value.error?.code==='busy')).error.code,'busy');
 const destroyed=once(client,'close');
 client.write('x'.repeat(clientLimits.requestLineBytes+1)+'\n');
 await destroyed;
});

test('no reply on the client connection kind contains the secret or the core origin',async t=>{
 const secret=randomBytes(32).toString('hex');
 const core=await fakeCore(t,secret);
 const {client,expect}=await harness(t,{core,secret});
 client.write(JSON.stringify({id:'leak',method:'POST',path:'/protocol/request',body:JSON.stringify({path:'/leak'})})+'\n');
 const reply=await expect(value=>value.error?.code==='upstream');
 assert.equal(reply.error.code,'upstream');
 assert.equal(JSON.stringify(reply).includes(secret),false);
 assert.equal(JSON.stringify(reply).includes(core.origin),false);
});

test('feed events stream over the connection and resume from the last event id',async t=>{
 const {client,expect,core}=await harness(t);
 client.write(JSON.stringify({id:'s1',method:'GET',path:'/protocol/events?version=1&requestId=r&generation=1&after=0'})+'\n');
 assert.equal((await expect(value=>value.id==='s1')).status,200);
 core.push(1);core.push(2);
 const message=await expect(value=>value.event==='message'&&value.subscription==='s1'&&value.lastEventId==='["feed",2]');
 assert.equal(JSON.parse(message.data).cursor,2);
 client.write(JSON.stringify({event:'close',subscription:'s1'})+'\n');
 client.write(JSON.stringify({id:'s2',method:'GET',path:'/protocol/events?version=1&requestId=r&generation=1&after=0',headers:{'Last-Event-ID':message.lastEventId}})+'\n');
 assert.equal((await expect(value=>value.id==='s2')).status,200);
 assert.equal((await expect(value=>value.event==='message'&&value.subscription==='s2')).lastEventId,'["feed",2]');
 const resume=core.seen.filter(value=>String(value.url).startsWith('/protocol/events')).at(-1);
 assert.equal(resume!.lastEventId,'["feed",2]');
 core.endStreams();
 await expect(value=>value.event==='error'&&value.subscription==='s2');
});

test("app documents publish under massion-app and serve with today's sandbox headers or 404",async t=>{
 const {client,expect}=await harness(t);
 client.write(JSON.stringify({id:'view',method:'POST',path:'/protocol/request',body:JSON.stringify({kind:'query',path:'/assistant/apps/view'})})+'\n');
 const reply=await expect(value=>value.id==='view');
 assert.equal(reply.status,200);
 const url=JSON.parse(reply.body).payload.frame.url;
 assert.match(url,/^massion-app:\/\/document\/[a-f0-9]{64}$/);
 client.write(JSON.stringify({id:'doc',method:'GET',path:new URL(url).pathname})+'\n');
 const served=await expect(value=>value.id==='doc');
 assert.equal(served.status,200);assert.equal(served.body,'<p>isolated app</p>');assert.deepEqual(served.headers,appDocumentHeaders);
 client.write(JSON.stringify({id:'missing',method:'GET',path:'/document/'+'0'.repeat(64)})+'\n');
 assert.equal((await expect(value=>value.id==='missing')).status,404);
});

test('settings, notification preference and restart are daemon-side requests',async t=>{
 const {client,expect,calls}=await harness(t);
 client.write(JSON.stringify({id:'read',method:'GET',path:'/desktop/settings'})+'\n');
 assert.deepEqual(JSON.parse((await expect(value=>value.id==='read')).body),{installedVersion:'1.0.0-fixture',notifications:true,restartRequired:false,restartStatus:'idle',update:'unknown'});
 client.write(JSON.stringify({id:'save',method:'POST',path:'/desktop/notifications',body:'false'})+'\n');
 assert.equal(JSON.parse((await expect(value=>value.id==='save')).body).restartRequired,true);
 client.write(JSON.stringify({id:'bad',method:'POST',path:'/desktop/notifications',body:'"false"'})+'\n');
 assert.equal((await expect(value=>value.id==='bad')).error.code,'method');
 client.write(JSON.stringify({id:'restart',method:'POST',path:'/desktop/restart'})+'\n');
 const restarted=await expect(value=>value.id==='restart');
 assert.deepEqual(calls,['stopCore','startCore']);
 assert.equal(JSON.parse(restarted.body).restartStatus,'idle');
});

test('a stalled core request times out to a sanitized error',async t=>{
 const {client,expect}=await harness(t,{requestTimeoutMs:150});
 client.write(JSON.stringify({id:'stall',method:'POST',path:'/protocol/request',body:JSON.stringify({path:'/hold'})})+'\n');
 assert.equal((await expect(value=>value.id==='stall')).error.code,'upstream');
});

test('the observer notifies only ready clients and a click focuses the still-current target',async t=>{
 const {service,client,expect}=await harness(t);
 service.startObserver();
 client.write(JSON.stringify({event:'ready'})+'\n');
 const notification=await expect(value=>value.event==='notification');
 assert.equal(notification.title,'Broken work');
 client.write(JSON.stringify({event:'notification-clicked',key:notification.key})+'\n');
 const focus=await expect(value=>value.event==='focus');
 assert.equal(focus.target.missionId,'mission');assert.equal(focus.target.workId,'work');assert.equal(focus.target.turnId,'turn');
 assert.equal(service.connections(),1);
});
