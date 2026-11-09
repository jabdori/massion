import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createWorkbench} from '../../src/server.ts';
import {InMemoryStore} from '../../src/storage.ts';
import {createProtocolClient} from '../../src/client-protocol.ts';
import {protocolConnection} from '../../src/protocol.ts';
import {daemonTransport,proxyProtocol} from '../transport.ts';
import {daemonGuard} from '../../src/daemon-auth.ts';

test('a v1-speaking impostor cannot receive owner commands or the launch secret',async t=>{
 const secret=randomBytes(32).toString('hex'),seen:string[]=[];
 const server=createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;seen.push(req.url+' '+JSON.stringify(req.headers)+' '+body);
  let message;try{message=JSON.parse(body);}catch{message={};}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...message,kind:'reply',status:200,payload:protocolConnection({min:1,max:1})}));
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 t.after(()=>{server.closeAllConnections();server.close();});
 const client=createProtocolClient(daemonTransport(origin,async()=>secret));
 await assert.rejects(client.connection(),/authenticat/i);
 await assert.rejects(proxyProtocol(new Request('massion://app/protocol/request',{method:'POST',body:JSON.stringify({ownerText:'private owner command'})}),origin,async()=>secret),/authenticat/i);
 assert.ok(seen.length>0);assert.ok(seen.every(value=>!value.includes(secret)&&!value.includes('private owner command')));
});

test('owner payload is not sent if the authenticated socket closes before dispatch',async t=>{
 const secret=randomBytes(32).toString('hex'),authenticate=daemonGuard(secret);let commands=0;
 const server=createServer((req,res)=>{
  if(req.url==='/desktop-auth')res.setHeader('Connection','close');else commands++;
  if(authenticate(req,res))res.end('{}');
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 t.after(()=>{server.closeAllConnections();server.close();});
 await assert.rejects(proxyProtocol(new Request('massion://app/protocol/request',{method:'POST',body:'private owner command'}),origin,async()=>secret),/connection changed/);
 assert.equal(commands,0);
});

test('a fresh proof relayed from another port does not authenticate the impostor',async t=>{
 const secret=randomBytes(32).toString('hex'),authenticate=daemonGuard(secret);
 const real=createServer((req,res)=>{if(authenticate(req,res))res.end('{}');});
 real.listen(0,'127.0.0.1');await once(real,'listening');
 const impostor=createServer(async(req,res)=>{
  const reply=await fetch('http://127.0.0.1:'+(real.address() as {port:number}).port+'/desktop-auth',{headers:{'X-Massion-Challenge':String(req.headers['x-massion-challenge'])}});
  res.writeHead(reply.status,Object.fromEntries(reply.headers));res.end();
 });
 impostor.listen(0,'127.0.0.1');await once(impostor,'listening');
 t.after(()=>{for(const server of [real,impostor]){server.closeAllConnections();server.close();}});
 const client=createProtocolClient(daemonTransport('http://127.0.0.1:'+(impostor.address() as {port:number}).port,async()=>secret));
 await assert.rejects(client.connection(),/authentication failed/);
});

test('authenticated daemon gates commands and SSE while preserving owner negotiation and writes',async t=>{
 const root=await mkdtemp(join(tmpdir(),'e4-auth-')),secret=randomBytes(32).toString('hex');
 const server=createWorkbench(new InMemoryStore<any>(),root,{scheduleIntervalMs:0,daemonSecret:secret});
 server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 t.after(async()=>{await server.drain();await rm(root,{recursive:true,force:true});});
 assert.equal((await fetch(origin+'/health')).status,401);
 const stranger=createProtocolClient(daemonTransport(origin,async()=>randomBytes(32).toString('hex')));
 await assert.rejects(stranger.connection(),/authenticat/i);
 const owner=createProtocolClient(daemonTransport(origin,async()=>secret));
 assert.equal((await owner.connection()).state,'ready');assert.equal((await owner.query('/health',{scope:'health'})).body.status,'ready');
 const payload={id:'authenticated',commandId:'create-authenticated',purpose:'Owner command',scope:'fixture',constraints:[],criteria:{version:1,description:'Original receipt',oracle:'manual-review/v1'}};
 assert.equal((await fetch(origin+'/missions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})).status,401);
 const state=(await owner.query('/read-state',{scope:'state'})).body;
 assert.equal((await owner.dispatch('/missions',{headers:{'X-Massion-Feed':state.feedId},body:JSON.stringify(payload)})).response.status,201);
 const path='/protocol/events?version=1&requestId=auth-feed&generation=1&after=0';
 assert.equal((await fetch(origin+path)).status,401);
 const stream=await proxyProtocol(new Request('massion://app'+path,{signal:AbortSignal.timeout(3000)}),origin,async()=>secret),reader=stream.body!.getReader();
 const chunk=await reader.read();assert.match(new TextDecoder().decode(chunk.value),/"kind":"feed"/);await reader.cancel();
});
