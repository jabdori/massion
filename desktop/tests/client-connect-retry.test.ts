import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,connect,type Socket} from 'node:net';
import {createServer as httpServer,type Server} from 'node:http';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import vm from 'node:vm';
import {createClientService} from '../client-relay.ts';
import {createHttpTransport,createProtocolClient,createSseTransport} from '../../src/client-protocol.ts';
import {authProof} from '../../src/daemon-auth.ts';

// The scene a person meets at a first start of the packaged app: the window's
// first protocol CONNECT fails because the core is not listening yet, and the
// client path tries again by itself (startFeed's catch calls retryFeed,
// src/workbench.ts 1694-1697, which retries after 1000 ms) and attaches once
// the core listens. No window and no Rust host: the relay is built directly,
// desktop/tauri-client.js runs in a vm against a minimal command bridge that
// speaks the same line protocol as the Rust host, and the client path is the
// real src/client-protocol.ts connect-then-subscribe path. This test and the
// install check pin the connect retry; client-resubscribe.test.ts pins a
// different scene (an error event on an established subscription).
test('the screen attaches after the core starts listening late: failed connects, then a delivered subscription',async t=>{
 const root=await mkdtemp(join(tmpdir(),'connect-retry-'));
 t.after(async()=>{service.close();server.close();core.close();await rm(root,{recursive:true,force:true});});
 const socketPath=join(root,'daemon.sock'),secret=randomBytes(32).toString('hex');
 let connectFailures=0,feedDelivered=false,relayReady=false;

 // A real HTTP core that starts listening only after TWO failed connect attempts.
 const probe=createServer();await new Promise<void>(resolve=>probe.listen(0,'127.0.0.1',resolve));
 const corePort=(probe.address() as {port:number}).port;
 await new Promise(resolve=>probe.close(resolve));
 const origin='http://127.0.0.1:'+corePort;
 const readBody=(request:import('node:http').IncomingMessage)=>new Promise<string>(resolve=>{let body='';request.on('data',chunk=>body+=chunk);request.on('end',()=>resolve(body));});
 const core=httpServer(async(request,response)=>{
  if(request.method==='GET'&&request.url==='/desktop-auth'){
   const challenge=String(request.headers['x-massion-challenge']??''),nonce=randomBytes(32).toString('hex');
   response.writeHead(204,{'X-Massion-Nonce':nonce,'X-Massion-Proof':authProof(secret,'server',origin,challenge,nonce)});response.end();return;
  }
  const url=new URL(request.url??'/',origin);
  if(request.method==='POST'&&url.pathname==='/protocol/connect'){
   const message=JSON.parse(await readBody(request));
   response.writeHead(200,{'Content-Type':'application/json'});
   response.end(JSON.stringify({version:1,requestId:message.requestId,generation:message.generation,kind:'reply',status:200,payload:{state:'ready',supported:{min:1,max:1},features:{commands:true,queries:true,feedPush:true},version:1}}));
   return;
  }
  if(request.method==='GET'&&url.pathname==='/protocol/events'){
   const message={version:Number(url.searchParams.get('version')),requestId:url.searchParams.get('requestId')??'',generation:Number(url.searchParams.get('generation'))};
   response.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'});
   response.write('id: '+JSON.stringify(['feed',1])+'\ndata: '+JSON.stringify({...message,kind:'feed',reason:'connected',feedId:'feed',cursor:1})+'\n\n');
   return;
  }
  response.writeHead(404);response.end();
 });

 // The relay, exactly as the supervisor builds it, on the user-only socket.
 await writeFile(join(root,'app.html'),'<html><body>fixture</body></html>');
 const service=createClientService({
  origin,secret,
  htmlCandidates:[join(root,'app.html')],
  settingsFile:join(root,'notifications.json'),
  version:'1.0.0-test',
  stopCore:async()=>{},startCore:()=>{},
  requestTimeoutMs:5000,observeIntervalMs:60000,
  onClientReady:()=>{relayReady=true;},
  onConnectAttempt:ok=>{if(!ok){connectFailures++;if(connectFailures===2)core.listen(corePort,'127.0.0.1');}},
  onFeedDelivered:()=>{feedDelivered=true;},
 });
 const server=createServer(client=>{
  let buffer=Buffer.alloc(0);
  const open=()=>{client.destroy();};
  const handshake=(chunk:Buffer)=>{
   buffer=Buffer.concat([buffer,chunk]);
   const newline=buffer.indexOf(10);
   if(newline===-1)return;
   if(buffer.subarray(0,newline).toString('latin1')!=='client'){client.destroy();return;}
   const rest=buffer.subarray(newline+1);buffer=Buffer.alloc(0);
   client.off('error',open);
   client.off('data',handshake);
   service.handle(client,rest);
  };
  client.on('error',open);
  client.on('data',handshake);
 });
 await new Promise<void>(resolve=>server.listen(socketPath,resolve));

 // The window side: the REAL tauri-client.js in a vm, bridged to the socket
 // the way the Rust host bridges the six commands and the event channel.
 type Reply={id:string;status:number;headers:Record<string,string>;body?:string}|{id:string;error:{code:string;message:string}};
 const pending=new Map<string,{resolve:(reply:Reply)=>void;reject:(error:Error)=>void}>();
 let activeChannel:{onmessage:((line:unknown)=>void)|null}|null=null;
 const socket:Socket=await new Promise((resolve,reject)=>{const client=connect(socketPath,()=>resolve(client));client.on('error',reject);});
 let wire=Buffer.alloc(0);
 socket.on('data',(chunk:Buffer)=>{
  wire=Buffer.concat([wire,chunk]);
  for(let index=wire.indexOf(10);index>=0;index=wire.indexOf(10)){
   const line=wire.subarray(0,index).toString('utf8');wire=wire.subarray(index+1);
   if(!line)continue;
   const value=JSON.parse(line) as Record<string,unknown>;
   if(typeof value.id==='string'&&pending.has(value.id)){pending.get(value.id)!.resolve(value as unknown as Reply);pending.delete(value.id);}
   else if(value.event==='message')activeChannel?.onmessage?.(value);
  }
 });
 socket.write('client\n');
 const send=(value:Record<string,unknown>)=>socket.write(JSON.stringify(value)+'\n');
 const request=(id:string,method:string,path:string,headers?:Record<string,string>,body?:string)=>new Promise<Reply>((resolve,reject)=>{
  pending.set(id,{resolve,reject});send({id,method,path,...(headers?{headers}:{}),...(body!==undefined?{body}:{})});
 });
 let serial=0;
 const sandboxWindow:Record<string,unknown>={};
 const sandbox:vm.Context=vm.createContext({window:sandboxWindow,console:{log(){},error(){},warn(){}}});
 const source=await readFile(new URL('../tauri-client.js',import.meta.url),'utf8');
 class Channel{onmessage:((line:unknown)=>void)|null=null}
 const bridgeInvoke=(name:string,args:Record<string,unknown>)=>{
  if(name==='desktop_ready')return Promise.resolve(send({event:'ready'}));
  if(name==='desktop_events_subscribe'){
   activeChannel=args.channel as Channel;
   return request(String(args.subscription),'GET',String(args.path),args.lastEventId!==undefined&&args.lastEventId!==null?{'Last-Event-ID':String(args.lastEventId)}:undefined).then(reply=>'error' in reply?Promise.reject(new Error('refused')):reply.status>=200&&reply.status<300?undefined:Promise.reject(new Error('refused')));
  }
  if(name==='desktop_events_close')return Promise.resolve(send({event:'close',subscription:args.subscription}));
  return Promise.reject(new Error('Unknown command '+name));
 };
 sandboxWindow.__TAURI__={core:{Channel,invoke:bridgeInvoke},event:{listen:async()=>()=>({})}};
 vm.runInContext(source,sandbox);

 // The app document registers its focus callback first, which is what makes
 // the screen tell the supervisor "ready".
 (sandboxWindow.massionDesktop as {onFocus:(callback:()=>void)=>()=>void}).onFocus(()=>{});
 const readyDeadline=Date.now()+5000;
 while(!relayReady){
  if(Date.now()>readyDeadline)assert.fail('the ready event reached the supervisor');
  await delay(20);
 }

 const fetchThroughRelay=async(input:RequestInfo|URL,init?:RequestInit)=>{
  const path=String(new URL(String(input),origin)).slice(origin.length)||String(input);
  const reply=await request('http-'+(++serial),init?.method??'GET',path,undefined,typeof init?.body==='string'?init.body:undefined);
  if('error' in reply)throw new Error('upstream refused');
  return new Response(reply.body??'',{status:reply.status});
 };
 const sourceFactory=(url:string)=>(sandboxWindow.__massionSseSource as unknown as (url:string)=>EventSource)(url);
 const client=createProtocolClient(createSseTransport(createHttpTransport(fetchThroughRelay),sourceFactory));

 const events:unknown[]=[];
 let attempts=0,stop=():void=>{};
 for(;;){
  attempts++;
  try{
   stop=await client.subscribe({after:0},event=>events.push(event),()=>{});
   break;
  }catch(error){
   if(attempts>=6)throw error;
   await delay(1000);
  }
 }
 assert.equal(connectFailures,2,'the screen failed exactly twice before the core listened');
 assert.equal(attempts,3,'the third attempt attached');
 await new Promise<void>(resolve=>{const check=()=>{if(feedDelivered)resolve();else setTimeout(check,20);};check();});
 assert.equal(feedDelivered,true,'the relay observed the delivered subscription');
 const first=events[0] as {reason:string;feedId:string;cursor:number};
 assert.equal(first.reason,'connected');
 assert.equal(first.feedId,'feed');
 assert.equal(first.cursor,1);
 stop();
 socket.destroy();
});
