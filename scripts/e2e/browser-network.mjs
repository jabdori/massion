import {createServer} from 'node:http';
import {once} from 'node:events';

export async function createBrowserNetwork(){
 const server=createServer((_req,res)=>{res.writeHead(403,{'Content-Type':'text/plain','Connection':'close'});res.end('E2E loopback only');});
 const refuse=(_req,socket)=>{socket.on('error',()=>{});socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');};server.on('connect',refuse);server.on('upgrade',refuse);
 server.listen(0,'127.0.0.1');await once(server,'listening');
 return {config:{proxy:'http://127.0.0.1:'+server.address().port,proxyBypass:'<-loopback>;127.0.0.1',args:'--force-webrtc-ip-handling-policy=disable_non_proxied_udp'},
  async close(){server.closeAllConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}};
}
