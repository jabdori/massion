import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,connect} from 'node:net';
import {duplexPair} from 'node:stream';
import {createServer as createHttpServer,type ServerResponse as HttpResponse} from 'node:http';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {daemonGuard} from '../../src/daemon-auth.ts';
import {protocolConnection} from '../../src/protocol.ts';
import {contentPolicy,tauriConnectSources} from '../security.ts';
import {appDocumentHeaders} from '../../src/app-documents.ts';
import {createClientService,clientLimits} from '../client-relay.ts';
import type {ClientServiceOptions,SubscribeErrorFact} from '../client-relay.ts';
import type {Socket} from 'node:net';

const html='<html><body><script>window.alive()</script><style>body{color:red}</style></body></html>';
const limits=JSON.parse(await readFile(new URL('fixtures/line-limits.json',import.meta.url),'utf8'));

interface FakeCore{origin:string;seen:Record<string,unknown>[];streams:Set<HttpResponse>;push(cursor:number):void;endStreams():void;dropReused:number}

function fakeCore(t:any,secret:string,works?:(serial:number)=>Record<string,unknown>[]):Promise<FakeCore>{
 const authenticate=daemonGuard(secret),seen:Record<string,unknown>[]=[],streams=new Set<HttpResponse>();
 let coreOrigin='';
 let serial=0;
 const served=new WeakMap<object,number>();
 const fake:FakeCore={origin:'',seen,streams,push(cursor){for(const res of streams)res.write('id: '+JSON.stringify(['feed',cursor])+'\ndata: '+JSON.stringify({cursor})+'\n\n');},endStreams(){for(const res of streams)res.end();},dropReused:0};
 const server=createHttpServer(async(req,res)=>{
  // The relay's authenticated fetch rides the auth handshake's keep-alive
  // socket; a second request on a connection can be killed before any
  // response headers to reproduce the idle-connection re-use race.
  const previous=served.get(req.socket)??0;served.set(req.socket,previous+1);
  if(fake.dropReused>0&&previous>0){fake.dropReused--;req.socket.destroy();return;}
  if(!authenticate(req,res))return;
  seen.push({url:req.url,method:req.method,lastEventId:req.headers['last-event-id']});
  if(req.url?.startsWith('/protocol/events')){
   res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'});
   streams.add(res);res.on('close',()=>streams.delete(res));
   res.write('id: '+String(req.headers['last-event-id']??'["feed",0]')+'\ndata: {"resume":true}\n\n');
   return;
  }
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);
  let body=Buffer.concat(chunks).toString('utf8');
  let message:Record<string,unknown>={};try{message=JSON.parse(body);}catch{}
  if(req.url==='/protocol/connect'){res.end(JSON.stringify({...message,kind:'reply',status:200,payload:protocolConnection({min:1,max:1})}));return;}
  if(req.url==='/protocol/request'){
   const path=String(message.path??'');
   if(path==='/assistant/works')res.end(JSON.stringify({...message,kind:'reply',status:200,payload:{feedId:'feed',works:works? works(++serial):[{missionId:'mission',workId:'work',turnId:'turn',title:'Broken work',acceptance:'failed'}]}}));
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
 return once(server,'listening').then(()=>{fake.origin=coreOrigin;return fake;});
}

async function harness(t:any,overrides:Partial<ClientServiceOptions>&{core?:FakeCore;secret?:string;html?:string;settings?:unknown;works?:(serial:number)=>Record<string,unknown>[];pipe?:boolean}={}){
 const secret=overrides.secret??randomBytes(32).toString('hex'),root=await mkdtemp(join(tmpdir(),'client-relay-')),document=join(root,'app.html');
 await writeFile(document,overrides.html??html);
 if(overrides.settings!==undefined)await writeFile(join(root,'notifications.json'),JSON.stringify(overrides.settings)+'\n');
 t.after(()=>rm(root,{recursive:true,force:true}));
 const core=overrides.core??await fakeCore(t,secret,overrides.works);
 const calls:string[]=[];
 const service=createClientService({origin:core.origin,secret,htmlCandidates:[document],settingsFile:join(root,'notifications.json'),version:'1.0.0-fixture',stopCore:async()=>{calls.push('stopCore');},startCore:()=>{calls.push('startCore');},observeIntervalMs:30,requestTimeoutMs:750,...overrides});
 const server=createServer((socket:Socket)=>{
  socket.on('error',()=>{});
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
 t.after(()=>{service.close();server.close();});
 const pair=overrides.pipe?duplexPair():undefined;
 let client:any;
 if(overrides.pipe){
  server.close();
  client=pair![0];
  client.on('error',()=>{});
  service.handle(pair![1] as unknown as Socket);
 }else{
  server.listen(join(root,'client.sock'));await once(server,'listening');
  client=connect(join(root,'client.sock'));
  client.on('error',()=>{});
  client.write('client\n');
 }
 t.after(()=>client.destroy());
 const lines:string[]=[];let buffer=Buffer.alloc(0);
 client.on('data',(chunk:Buffer)=>{
  buffer=Buffer.concat([buffer,chunk]);let index;
  while((index=buffer.indexOf(0x0a))>=0){const line=buffer.subarray(0,index).toString('utf8');buffer=buffer.subarray(index+1);if(line)lines.push(line);}
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
 const destroyed=new Promise<void>(resolve=>client.once('close',resolve));
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

test('the relay refuses menu bar writes and preserves native-independent notification settings',async t=>{
 const {client,expect,calls}=await harness(t,{settings:{notifications:false}});
 client.write(JSON.stringify({id:'off',method:'POST',path:'/desktop/menu-bar-item',body:'false'})+'\n');
 const off=await expect(value=>value.id==='off');
 assert.equal(off.error?.code,'path');
 client.write(JSON.stringify({id:'before',method:'GET',path:'/desktop/settings'})+'\n');
 const before=JSON.parse((await expect(value=>value.id==='before')).body);
 assert.equal(before.notifications,false);
 assert.equal(before.restartRequired,false);
 client.write(JSON.stringify({id:'bad-menu-bar',method:'POST',path:'/desktop/menu-bar-item'})+'\n');
 assert.equal((await expect(value=>value.id==='bad-menu-bar')).error.code,'path');
 client.write(JSON.stringify({id:'notification',method:'POST',path:'/desktop/notifications',body:'true'})+'\n');
 assert.equal(JSON.parse((await expect(value=>value.id==='notification')).body).notifications,true);
 client.write(JSON.stringify({id:'on',method:'POST',path:'/desktop/menu-bar-item',body:'true'})+'\n');
 assert.equal((await expect(value=>value.id==='on')).error.code,'path');
 assert.deepEqual(calls,[]);
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

test('the observer stays silent when the stored notification setting is off',async t=>{
 const quiet=await harness(t,{settings:{notifications:false}});
 quiet.service.startObserver();
 quiet.client.write(JSON.stringify({event:'ready'})+'\n');
 await new Promise(resolve=>setTimeout(resolve,600));
 assert.equal(quiet.lines.some(line=>line.includes('"event":"notification"')),false,'no notification may be delivered while the setting is off');
 const loud=await harness(t,{settings:{notifications:true}});
 loud.service.startObserver();
 loud.client.write(JSON.stringify({event:'ready'})+'\n');
 const deadline=Date.now()+5000;
 while(Date.now()<deadline&&!loud.lines.some(line=>line.includes('"event":"notification"')))await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(loud.lines.some(line=>line.includes('"event":"notification"')),true,'the on setting delivers');
});

test('a request line is bounded in bytes: multibyte text over the bound drops the connection',async t=>{
 const {client}=await harness(t);
 const destroyed=new Promise<void>(resolve=>client.once('close',resolve));
 const body='가'.repeat(23470); // 23,470 UTF-16 units but 70,410 UTF-8 bytes
 client.write(JSON.stringify({id:'wide',method:'POST',path:'/protocol/connect',body})+'\n');
 await destroyed;
});

test('a request line that never ends is dropped once it passes the byte bound',async t=>{
 const {client}=await harness(t);
 const destroyed=new Promise<void>(resolve=>client.once('close',resolve));
 client.write('가'.repeat(23470)); // no newline ever
 await destroyed;
});

test('a multibyte response past the four MiB byte bound is refused, not sent',async t=>{
 const {client,expect}=await harness(t,{html:'<html>'+('가'.repeat(2100000))+'</html>'});
 client.write(JSON.stringify({id:'doc',method:'GET',path:'/'})+'\n');
 const reply=await expect(value=>value.id===''&&value.error?.code==='upstream');
 assert.equal(reply.error.code,'upstream');
});

test('a multibyte character split at every byte boundary survives decoding',async t=>{
 const {client,expect}=await harness(t,{pipe:true});
 for(let boundary=1;boundary<200;boundary++){
  const id='split-'+boundary;
  const payload=Buffer.from(JSON.stringify({id,method:'POST',path:'/protocol/request',body:JSON.stringify({kind:'query',path:'/assistant/works',tag:'가'})}));
  client.write(payload.subarray(0,boundary));
  await new Promise(resolve=>setImmediate(resolve));
  client.write(Buffer.concat([payload.subarray(boundary),Buffer.from('\n')]));
  const reply=await expect(value=>value.id===id);
  assert.match(reply.body,/"tag":"가"/,'split at byte '+boundary+' corrupted the line');
  assert.doesNotMatch(reply.body,/\uFFFD/,'no replacement characters may appear');
 }
});

test('many valid lines in one chunk whose total exceeds the bound are all processed',async t=>{
 const {client,expect}=await harness(t,{pipe:true});
 const line=(id:string)=>JSON.stringify({id,method:'GET',path:'/'});
 const ids:string[]=[];
 let batch='';
 for(let n=0;n<500;n++){const id=('m-'+n).padEnd(120,'x');ids.push(id);batch+=line(id)+'\n';}
 assert.ok(Buffer.byteLength(batch)>clientLimits.requestLineBytes,'the batch total exceeds the per-line bound');
 client.write(batch);
 await expect(value=>value.id===ids.at(-1),8000);
 for(const id of ids)await expect(value=>value.id===id,8000);
 assert.equal(client.destroyed,false,'the connection must survive many valid lines in one chunk');
});

test('a request line of exactly the limit is accepted and one byte more is refused',async t=>{
 assert.equal(limits.requestLineLimit,clientLimits.requestLineBytes,'the shared fixture pins the request line limit');
 const {client,expect}=await harness(t);
 const exact=(id:string)=>{const skeleton=JSON.stringify({id,method:'POST',path:'/protocol/connect',body:''});const padding=clientLimits.requestLineBytes-1-skeleton.length;return JSON.stringify({id,method:'POST',path:'/protocol/connect',body:'x'.repeat(padding)});};
 const okay=exact('exact');
 assert.equal(Buffer.byteLength(okay)+1,clientLimits.requestLineBytes,'the accepted line is exactly the limit including the newline');
 client.write(okay+'\n');
 await expect(value=>value.id==='exact');
 const closed=new Promise<void>(resolve=>client.once('close',resolve));
 client.write(exact('over')+'x'+'\n');
 await closed;
});

test('a response of exactly the limit is sent and one byte more is refused',async t=>{
 assert.equal(limits.responseLineLimit,clientLimits.responseLineBytes,'the shared fixture pins the response line limit');
 const policy=contentPolicy('<html></html>',[...tauriConnectSources]);
 const headers={'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':policy,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
 const skeleton=JSON.stringify({id:'doc',status:200,headers,body:''}).length;
 const pad=clientLimits.responseLineBytes-1-skeleton-'<html></html>'.length;
 const exact=await harness(t,{html:'<html>'+'a'.repeat(pad)+'</html>'});
 exact.client.write(JSON.stringify({id:'doc',method:'GET',path:'/'})+'\n');
 const accepted=await exact.expect(value=>value.id==='doc');
 assert.equal(Buffer.byteLength(JSON.stringify(accepted))+1,clientLimits.responseLineBytes,'the accepted response is exactly the limit including the newline');
 const over=await harness(t,{html:'<html>'+'a'.repeat(pad+1)+'</html>'});
 over.client.write(JSON.stringify({id:'doc',method:'GET',path:'/'})+'\n');
 const refused=await over.expect(value=>value.id===''&&value.error?.code==='upstream');
 assert.equal(refused.error.code,'upstream','one byte more than the limit must be refused');
});

test('settings can be saved and the daemon restarted again after a completed restart',async t=>{
 const {client,expect}=await harness(t);
 client.write(JSON.stringify({id:'save1',method:'POST',path:'/desktop/notifications',body:'false'})+'\n');
 await expect(value=>value.id==='save1');
 client.write(JSON.stringify({id:'restart1',method:'POST',path:'/desktop/restart'})+'\n');
 assert.equal(JSON.parse((await expect(value=>value.id==='restart1')).body).restartStatus,'idle');
 client.write(JSON.stringify({id:'save2',method:'POST',path:'/desktop/notifications',body:'true'})+'\n');
 const saved=await expect(value=>value.id==='save2');
 assert.equal(saved.error,undefined,'the next save after a completed restart must work');
 assert.equal(JSON.parse(saved.body).notifications,true);
 client.write(JSON.stringify({id:'restart2',method:'POST',path:'/desktop/restart'})+'\n');
 assert.equal(JSON.parse((await expect(value=>value.id==='restart2')).body).restartStatus,'idle','the next restart must run again');
});

test('the notification setting is re-read after a restart in both directions',async t=>{
 const {service,client,expect,lines}=await harness(t,{settings:{notifications:false},works:serial=>[{missionId:'mission',workId:'work-'+serial,turnId:'turn',title:'Broken work '+serial,acceptance:'failed'}]});
 const notifications=()=>lines.filter(line=>line.includes('"event":"notification"')).length;
 const quiet=async()=>{const before=notifications();await new Promise(resolve=>setTimeout(resolve,600));assert.equal(notifications(),before,'no notification may arrive while the setting is off');};
 service.startObserver();
 client.write(JSON.stringify({event:'ready'})+'\n');
 await quiet();
 client.write(JSON.stringify({id:'r1',method:'POST',path:'/desktop/restart'})+'\n');
 await expect(value=>value.id==='r1');
 await quiet();
 client.write(JSON.stringify({id:'on',method:'POST',path:'/desktop/notifications',body:'true'})+'\n');
 await expect(value=>value.id==='on');
 client.write(JSON.stringify({id:'r2',method:'POST',path:'/desktop/restart'})+'\n');
 await expect(value=>value.id==='r2');
 await expect(value=>value.event==='notification',8000);
 client.write(JSON.stringify({id:'off',method:'POST',path:'/desktop/notifications',body:'false'})+'\n');
 await expect(value=>value.id==='off');
 client.write(JSON.stringify({id:'r3',method:'POST',path:'/desktop/restart'})+'\n');
 await expect(value=>value.id==='r3');
 // The running setting stays on until the restart re-opens the lifecycle, so
 // deliveries racing the save-to-restart window are the design, not a leak;
 // only lines after the restart reply can violate the re-read.
 const delivered=notifications();
 const deadline=Date.now()+1500;
 while(Date.now()<deadline&&notifications()===delivered)await new Promise(resolve=>setTimeout(resolve,50));
 assert.equal(notifications(),delivered,'the off direction stays silent after a restart');
});

test('a subscription whose reused connection dies before headers reports the re-use race',async t=>{
 const secret=randomBytes(32).toString('hex');
 const core=await fakeCore(t,secret);
 const facts:SubscribeErrorFact[]=[];
 const {client,expect}=await harness(t,{core,secret,onSubscribeError:fact=>facts.push(fact)});
 core.dropReused=1;
 client.write(JSON.stringify({id:'race',method:'GET',path:'/protocol/events?version=1&requestId=r&generation=1&after=0'})+'\n');
 const reply=await expect(value=>value.event==='error'&&value.subscription==='race',8000);
 assert.ok(reply,'the error event is written when the reused connection dies');
 const fact=facts.at(-1)!;
 assert.equal(fact.way,'fetch');
 assert.equal(fact.beforeHeaders,true,'the failure came before any response headers');
 assert.equal(fact.reused,true,'the data request rode the auth handshake socket');
 assert.equal(core.dropReused,0,'exactly one reused connection was dropped');
 client.destroy();
});

