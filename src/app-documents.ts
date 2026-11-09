import {randomBytes} from 'node:crypto';
import {createServer} from 'node:http';

export const appDocumentPolicy="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";
export const appDocumentHeaders={'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':appDocumentPolicy,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};

export class AppDocuments {
 private documents=new Map<string,{html:string;expires:number}>();
 private now:()=>number;
 constructor(now:()=>number=Date.now){this.now=now;}
 private prune(){for(const [key,value] of this.documents)if(value.expires<=this.now())this.documents.delete(key);}
 publish(html:string){
  if(typeof html!=='string'||Buffer.byteLength(html)>65536)throw new Error('App document exceeds byte bound');
  this.prune();while(this.documents.size>=32)this.documents.delete(this.documents.keys().next().value!);
  const path='/'+randomBytes(32).toString('hex');this.documents.set(path,{html,expires:this.now()+300000});return path;
 }
 read(path:string){this.prune();return this.documents.get(path)?.html;}
 clear(){this.documents.clear();}
}

export function createAppDocumentHost(){
 const documents=new AppDocuments();let closed=false,start:Promise<string>|undefined,closing:Promise<void>|undefined;
 const server=createServer((req,res)=>{
  const address=server.address(),expected=typeof address==='object'&&address?'127.0.0.1:'+address.port:'';
  if(req.method!=='GET'||req.headers.host!==expected||req.headers.origin||req.headers.cookie||req.headers.authorization){res.writeHead(403);res.end();return;}
  const html=documents.read(req.url??'');res.writeHead(html===undefined?404:200,appDocumentHeaders);res.end(html);
 });
 const origin=()=>{
  if(closed)return Promise.reject(new Error('App document host closed'));
  return start??=new Promise<string>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',reject);server.unref();resolve('http://127.0.0.1:'+(server.address() as {port:number}).port);});});
 };
 return {origin,async publish(html:string){const base=await origin();if(closed)throw new Error('App document host closed');return base+documents.publish(html);},close(){if(closing)return closing;closed=true;documents.clear();return closing=(async()=>{if(start){await start.catch(()=>{});if(!server.listening)return;server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}})();}};
}
