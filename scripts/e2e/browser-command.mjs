import {createServer} from 'node:http';
import assert from 'node:assert/strict';

export async function browserCommand(run){
 let response;
 try{response=await run();}catch(error){
  let result;try{result=JSON.parse(error.stdout);}catch{throw error;}
  if(result.success!==false||result.error!=='Failed to install browser network controls: CDP error (Runtime.evaluate): Cannot find default execution context')throw error;
  await new Promise(resolve=>setTimeout(resolve,200));response=await run();
 }
 const result=JSON.parse(response.stdout);assert.ok(result.success,result.error);return result.data;
}

/** Chrome bypasses this deny-only proxy solely for the owned 127.0.0.1 fixtures. */
export async function browserEgressProxy(){
 const server=createServer((_request,response)=>{response.writeHead(403,{'Connection':'close'});response.end('Blocked browser egress');});
 const refuse=(_request,socket)=>socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');server.on('connect',refuse);server.on('upgrade',refuse);
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 return {url:'http://127.0.0.1:'+server.address().port,close:()=>new Promise((resolve,reject)=>{server.closeAllConnections();server.close(error=>error?reject(error):resolve());})};
}
