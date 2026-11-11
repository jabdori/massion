import {createServer} from 'node:http';
import type {IncomingMessage} from 'node:http';
import type {Duplex} from 'node:stream';
import {once} from 'node:events';
import {isIP} from 'node:net';

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
export async function createBrowserDenyProxy(){
 const server=createServer((_req,res)=>{res.writeHead(403,{'Content-Type':'text/plain','Connection':'close','Cache-Control':'no-store'});res.end('Browser request denied');});
 const refuse=(_req:IncomingMessage,socket:Duplex)=>{socket.on('error',()=>{});socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');};server.on('connect',refuse);server.on('upgrade',refuse);
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw Error('Browser proxy unavailable');
 return {url:'http://127.0.0.1:'+address.port,
  async close(){server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}};
}
