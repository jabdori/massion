import {connect} from 'node:net';
import {lstat,unlink,open} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

export function daemonFiles(packaged:boolean,resources:string,directory:string){
 return {runner:join(packaged?resources:directory,'daemon-runner.mjs'),entry:packaged?join(resources,'core/src/server.ts'):resolve(directory,'../../src/server.ts')};
}

export function control(socket:string,command:'status'|'drain'):Promise<{status:string;pid?:number;origin?:string}>{
 return new Promise((resolve,reject)=>{
  const client=connect(socket);let body='';
  client.setTimeout(command==='drain'?12000:1000,()=>client.destroy(new Error('Daemon control timeout')));
  client.on('connect',()=>client.end(command+'\n'));client.on('error',reject);
  client.on('data',chunk=>{body+=chunk;if(body.length>1024)client.destroy(new Error('Invalid daemon control reply'));});
  client.on('end',()=>{try{const reply=JSON.parse(body);if(!['running','drained','unsettled'].includes(reply.status))throw new Error('Invalid daemon control reply');resolve(reply);}catch(error){reject(error);}});
 });
}
export async function drainDaemon(socket:string,origin:string){
 const status=await control(socket,'status');
 return status.origin===origin?control(socket,'drain'):{status:'external'};
}
export async function prepareControl(socket:string){
 try{await control(socket,'status');}catch(error){
  const code=(error as NodeJS.ErrnoException).code;
  if(code==='ENOENT')return;
  if(code!=='ECONNREFUSED')throw error;
  const stat=await lstat(socket);
  if(!stat.isSocket()||stat.uid!==process.getuid?.())throw new Error('Refusing unowned daemon socket');
  await unlink(socket);return;
 }
 throw new Error('Daemon already running');
}
export async function launchDaemon(options:{node:string;runner:string;entry:string;directory:string;socket:string;origin:string}){
 const log=await open(join(options.directory,'daemon.log'),'a',0o600);
 try{
  const child=spawn(options.node,[options.runner,options.socket,options.entry,options.origin],{cwd:options.directory,env:process.env,detached:true,stdio:['ignore',log.fd,log.fd]});
  await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
 }finally{await log.close();}
 for(let n=0;n<50;n++){try{return await control(options.socket,'status');}catch(error){if(!['ENOENT','ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code??''))throw error;await delay(100);}}
 throw new Error('Daemon startup failed; inspect the private daemon log');
}
