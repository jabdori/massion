// The product contract for a window opened before the core: every subscription
// attempt against a closed core port surfaces the relay's error event to the
// client source, and the next attempt - what workbench's retryFeed keeps
// issuing every second - delivers once the core listens, with the client's
// last event id (its cursor) preserved.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer as createHttpServer,type ServerResponse as HttpResponse} from 'node:http';
import {createServer as netServer,type Socket} from 'node:net';
import {duplexPair} from 'node:stream';
import {once} from 'node:events';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runInNewContext} from 'node:vm';
import {randomBytes} from 'node:crypto';
import {daemonGuard} from '../../src/daemon-auth.ts';
import {createSseTransport} from '../../src/client-protocol.ts';
import {createClientService} from '../client-relay.ts';
import type {ProtocolTransport} from '../../src/protocol.ts';

// A core the test starts listening late: the server exists from the start but
// listen() happens only when the test calls it, so the first subscription
// attempts really meet a closed port (the ECONNREFUSED of run 1).
function lateCore(t:any,secret:string){
 const authenticate=daemonGuard(secret),streams=new Set<HttpResponse>(),seen:Record<string,unknown>[]=[];
 const server=createHttpServer(async(req,res)=>{
  if(!authenticate(req,res))return;
  seen.push({url:req.url,lastEventId:req.headers['last-event-id']});
  if(req.url?.startsWith('/protocol/events')){
   res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'});
   streams.add(res);res.on('close',()=>streams.delete(res));
   res.write('id: '+String(req.headers['last-event-id']??'["feed",0]')+'\ndata: {"resume":true}\n\n');
   return;
  }
  res.end('{}');
 });
 t.after(()=>{server.closeAllConnections();server.close();});
 return {server,seen,push(cursor:number){for(const res of streams)res.write('id: '+JSON.stringify(['feed',cursor])+'\ndata: '+JSON.stringify({cursor})+'\n\n');}};
}

// The real relay plus the real Tauri bootstrap over the line protocol the Rust
// host carries (desktop/tauri/carrier/src/socket.rs): subscribe and close
// become request lines, every event line goes to the channel. Not covered
// here because they need a browser or the real host: the workbench retryFeed
// loop, the Rust scheme and IPC layers, and createProtocolClient's
// connect-before-subscribe ordering.
async function clientStack(t:any,origin:string,secret:string){
 const root=await mkdtemp(join(tmpdir(),'client-resubscribe-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(join(root,'app.html'),'<html><body>fixture</body></html>');
 const service=createClientService({origin,secret,htmlCandidates:[join(root,'app.html')],settingsFile:join(root,'notifications.json'),version:'1.0.0-fixture',stopCore:async()=>{},startCore(){}});
 t.after(()=>service.close());
 const [carrier,relayEnd]=duplexPair();
 carrier.on('error',()=>{});
 t.after(()=>carrier.destroy());
 service.handle(relayEnd as unknown as Socket);
 const script=await readFile(new URL('../tauri-client.js',import.meta.url),'utf8');
 let channel:{onmessage:((line:unknown)=>void)|null}|undefined;
 const pending=new Map<string,{resolve:(value:unknown)=>void;reject:(error:Error)=>void}>();
 let buffer='';
 carrier.on('data',(chunk:Buffer)=>{
  buffer+=String(chunk);let index;
  while((index=buffer.indexOf('\n'))>=0){
   const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!line)continue;
   const value=JSON.parse(line);
   if(value.event!==undefined)channel?.onmessage?.(value);
   else{
    const waiter=pending.get(value.id);
    if(waiter){
     pending.delete(value.id);
     if(typeof value.status==='number'&&value.status>=200&&value.status<300)waiter.resolve(value);
     else waiter.reject(new Error('The feed refused the subscription'));
    }
   }
  }
 });
 class Channel{onmessage:((line:unknown)=>void)|null=null}
 const context:any={window:{}};
 context.__TAURI__={core:{invoke:(command:string,args:any)=>{
  if(command==='desktop_events_subscribe'){
   channel=args.channel;
   return new Promise((resolve,reject)=>{
    pending.set(args.subscription,{resolve,reject});
    carrier.write(JSON.stringify({id:args.subscription,method:'GET',path:args.path,headers:args.lastEventId?{'Last-Event-ID':args.lastEventId}:{},body:null})+'\n');
   });
  }
  carrier.write(JSON.stringify({event:'close',subscription:args.subscription})+'\n');
  return Promise.resolve(undefined);
 },Channel},event:{listen:()=>Promise.resolve(()=>{})}};
 context.window.__TAURI__=context.__TAURI__;
 runInNewContext(script,context);
 const unused:ProtocolTransport={connect:async()=>{throw new Error('unused')},request:async()=>{throw new Error('unused')},subscribe(){throw new Error('unused')}};
 return {transport:createSseTransport(unused,context.window.__massionSseSource)};
}

test('a subscription before the core listens errors per attempt and the next one delivers with the cursor preserved',async t=>{
 const secret=randomBytes(32).toString('hex');
 const core=lateCore(t,secret);
 const reserve=netServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');
 const port=(reserve.address() as {port:number}).port;reserve.close();
 const {transport}=await clientStack(t,'http://127.0.0.1:'+port,secret);
 const failures:number[]=[],events:unknown[]=[];
 const waitFor=async(ready:()=>boolean,what:string)=>{
  const deadline=Date.now()+8000;
  while(Date.now()<deadline){
   if(ready())return;
   await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.fail(what);
 };
 // Each failure is driven only by the relay's error event line on the channel,
 // so counting failures counts the error events the contract demands.
 const attempt=()=>transport.subscribe({version:1,requestId:'r',generation:1,after:0},event=>events.push(event),()=>failures.push(failures.length));

 // Two failed attempts while the port is closed, as when the window is up
 // before the core and retryFeed re-subscribes every second.
 let stop=attempt();
 await waitFor(()=>failures.length>=1,'the first attempt before the core listens must reach the error event');
 stop();
 stop=attempt();
 await waitFor(()=>failures.length>=2,'the second attempt must also reach the error event');
 stop();

 // The core starts listening only now; the next subscription delivers.
 core.server.listen(port,'127.0.0.1');
 await once(core.server,'listening');
 stop=attempt();
 await waitFor(()=>events.length>=1,'the message must arrive after the core starts listening');
 assert.deepEqual(events[0],{resume:true});
 core.push(5);
 await waitFor(()=>events.length>=2,'the pushed cursor must arrive');
 assert.deepEqual(events[1],{cursor:5});

 // The core goes away again; the re-subscription carries the client's cursor.
 const failuresBefore=failures.length;
 core.server.closeAllConnections();
 core.server.close();await once(core.server,'close');
 await waitFor(()=>failures.length>failuresBefore,'the dropped stream must reach the error event');
 stop();
 core.server.listen(port,'127.0.0.1');
 await once(core.server,'listening');
 stop=attempt();
 await waitFor(()=>events.length>=3,'the resumed subscription must deliver again');
 const resumed=core.seen.filter(value=>String(value.url).startsWith('/protocol/events')).at(-1)!;
 assert.equal(resumed.lastEventId,'["feed",5]','the client re-subscribes with its preserved cursor');
 stop();
});
