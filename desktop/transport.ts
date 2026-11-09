import {createHttpTransport} from '../src/client-protocol.ts';
import {appOrigin} from './security.ts';

export function daemonOrigin(value:string){
 const url=new URL(value);
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Explicit loopback daemon origin required');
 return url.origin;
}
export function daemonTransport(origin:string){
 const base=daemonOrigin(origin);
 return createHttpTransport((input,init)=>fetch(new URL(String(input),base),{...init,headers:{...init?.headers,Origin:base}}));
}
export async function proxyProtocol(request:Request,origin:string):Promise<Response>{
 const url=new URL(request.url),base=daemonOrigin(origin);
 if(url.protocol!=='massion:'||url.host!=='app'||url.username||url.password||!['/protocol/connect','/protocol/request','/protocol/events'].includes(url.pathname)||request.method!==(url.pathname==='/protocol/events'?'GET':'POST'))return new Response(null,{status:403});
 const headers:Record<string,string>={Origin:base,'Content-Type':'application/json'};
 const last=request.headers.get('Last-Event-ID');if(last)headers['Last-Event-ID']=last;
 let body:string|undefined;
 if(request.method==='POST'){
  const reader=request.body?.getReader();let size=0;const chunks:Uint8Array[]=[];
  if(reader)for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>49152){await reader.cancel();return new Response(null,{status:413});}chunks.push(part.value);}
  body=Buffer.concat(chunks).toString('utf8');
 }
 const response=await fetch(base+url.pathname+url.search,{method:request.method,headers,body,redirect:'error',signal:request.signal});
 return new Response(response.body,{status:response.status,headers:{'Content-Type':response.headers.get('Content-Type')??'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Access-Control-Allow-Origin':appOrigin}});
}
