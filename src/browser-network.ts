import {createServer} from 'node:http';
import type {IncomingMessage} from 'node:http';
import type {Duplex} from 'node:stream';
import {once} from 'node:events';
import {connect,isIP} from 'node:net';

export function browserOriginRule(origin:string){
 let url:URL;try{url=new URL(origin);}catch{throw Error('Exact HTTPS browser origin required');}
 const host=url.hostname,plainHost=host.startsWith('[')?host.slice(1,-1):host;
 if(url.protocol!=='https:'||url.origin!==origin||url.username||url.password||!(isIP(plainHost)||host.length<=253&&host.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))))throw Error('Exact HTTPS browser origin required');
 return 'https://'+host+':'+(url.port||'443');
}
export function browserPageOriginRule(origin:string){
 let url:URL;try{url=new URL(origin);}catch{throw Error('Exact HTTP(S) browser origin required');}
 const host=url.hostname,plainHost=host.startsWith('[')?host.slice(1,-1):host;
 if(!['https:','http:'].includes(url.protocol)||url.origin!==origin||url.username||url.password||!(isIP(plainHost)||host.length<=253&&host.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))))throw Error('Exact HTTP(S) browser origin required');
 return url.protocol+'//'+host+':'+(url.port||(url.protocol==='https:'?'443':'80'));
}
/** Dynamic origin gate: only CONNECT tunnels and absolute-form requests to approved origins pass; everything else is refused without forwarding. */
export async function createBrowserGateProxy(allowed:()=>Set<string>){
 const server=createServer((req,res)=>{
  let url:URL;try{url=new URL(req.url??'');}catch{res.writeHead(403,{'Content-Type':'text/plain','Connection':'close','Cache-Control':'no-store'});res.end('Browser request denied');return;}
  const port=url.port||(url.protocol==='https:'?'443':'80');
  if(url.protocol!=='http:'||!allowed().has(url.protocol+'//'+url.hostname+':'+port)){res.writeHead(403,{'Content-Type':'text/plain','Connection':'close','Cache-Control':'no-store'});res.end('Browser request denied');return;}
  const upstream=connect({host:url.hostname.startsWith('[')?url.hostname.slice(1,-1):url.hostname,port:Number(port)},()=>{
   upstream.write(req.method+' '+url.pathname+url.search+' HTTP/1.1\r\n');
   for(const [name,value] of Object.entries(req.headers))if(!['connection','proxy-connection','proxy-authorization'].includes(name))upstream.write(name+': '+value+'\r\n');
   upstream.write('Connection: close\r\n\r\n');req.pipe(upstream);
  });
  const fail=()=>{upstream.destroy();res.destroy();};
  upstream.on('error',fail);req.on('error',fail);upstream.pipe(res);
 });
 const refuse=(socket:Duplex)=>{socket.on('error',()=>{});socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');};
 server.on('connect',(req,socket,head)=>{
  const match=/^\[([^\]]+)\]:(\d+)$|^(.+):(\d+)$/.exec(req.url??'');let host='',port=443;
  if(match){if(match[1]!==undefined){host='['+match[1]+']';port=Number(match[2]);}else{host=match[3]!;port=Number(match[4]);}}
  if(!match||!allowed().has('https://'+host+':'+port)){refuse(socket);return;}
  const upstream=connect({host:host.startsWith('[')?host.slice(1,-1):host,port},()=>{
   socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);
  });
  const fail=()=>{upstream.destroy();socket.destroy();};
  upstream.on('error',fail);socket.on('error',fail);
 });
 server.on('upgrade',refuse);
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();
 if(!address||typeof address==='string')throw Error('Browser proxy unavailable');
 return {url:'http://127.0.0.1:'+address.port,
  async close(){server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}};
}
export async function createBrowserDenyProxy(){
 const server=createServer((_req,res)=>{res.writeHead(403,{'Content-Type':'text/plain','Connection':'close','Cache-Control':'no-store'});res.end('Browser request denied');});
 const refuse=(_req:IncomingMessage,socket:Duplex)=>{socket.on('error',()=>{});socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');};server.on('connect',refuse);server.on('upgrade',refuse);
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw Error('Browser proxy unavailable');
 return {url:'http://127.0.0.1:'+address.port,
  async close(){server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}};
}
