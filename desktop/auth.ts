import {Agent,request} from 'node:http';
import {randomBytes} from 'node:crypto';
import {Readable} from 'node:stream';
import type {Socket} from 'node:net';
import {authProof,equalAuth,validAuthValue} from '../src/daemon-auth.ts';

export async function authenticatedFetch(url:URL,init:RequestInit,secret:string):Promise<Response>{
 if(!validAuthValue(secret))throw new Error('Daemon authentication unavailable');
 const agent=new Agent({keepAlive:true,maxSockets:1,maxFreeSockets:1}),challenge=randomBytes(32).toString('hex');
 let socket:Socket|undefined;
 // Connection evidence for the caller's diagnostics: whether the failure came
 // before any response headers, and whether the data request rode the socket
 // the auth handshake opened (the only connection the protocol allows).
 const connectionFact={beforeHeaders:true,reused:false};
 try{
  const nonce=await new Promise<string>((resolve,reject)=>{
   const req=request(new URL('/desktop-auth',url),{agent,headers:{'X-Massion-Challenge':challenge},signal:init.signal??undefined},res=>{
    const nonce=res.headers['x-massion-nonce'],proof=res.headers['x-massion-proof'];
    if(res.statusCode!==204||!validAuthValue(nonce)||!equalAuth(proof,authProof(secret,'server',url.origin,challenge,nonce))){res.destroy();reject(new Error('Daemon authentication failed'));return;}
    res.on('error',reject);res.on('end',()=>resolve(nonce));res.resume();
   });
   const timer=setTimeout(()=>req.destroy(new Error('Daemon authentication timeout')),3000);
   req.on('close',()=>clearTimeout(timer));req.on('socket',value=>{socket=value;});req.on('error',reject);req.end();
  });
  const headers=Object.fromEntries(new Headers(init.headers));headers.authorization='Bearer '+authProof(secret,'client',url.origin,challenge,nonce);
  if(init.body!==undefined&&typeof init.body!=='string')throw new TypeError('Daemon request body must be a string');
  return await new Promise<Response>((resolve,reject)=>{
   const req=request(url,{agent,method:init.method,headers,signal:init.signal??undefined},res=>{
    connectionFact.beforeHeaders=false;
    res.once('close',()=>agent.destroy());
    const status=res.statusCode!;
    if(status>=300&&status<400){res.destroy();reject(new Error('Daemon redirect refused'));return;}
    const responseHeaders=new Headers();for(const [name,value] of Object.entries(res.headers))if(value!==undefined)responseHeaders.set(name,Array.isArray(value)?value.join(', '):value);
    const body=status===204||status===205?null:Readable.toWeb(res) as ReadableStream<Uint8Array>;
    if(body===null)res.resume();resolve(new Response(body,{status,headers:responseHeaders}));
   });
   req.on('error',reject);
   // Refuse a replaced TCP connection before sending application headers or body.
   req.once('socket',value=>{connectionFact.reused=value===socket;if(value!==socket||value.destroyed){req.destroy(new Error('Daemon authenticated connection changed'));return;}value.setTimeout(0);req.end(init.body as string|undefined);});
  });
 }catch(error){agent.destroy();if(error instanceof Error)Object.assign(error,{connectionFact:{...connectionFact}});throw error;}
}
