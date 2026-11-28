import {connect} from 'node:net';
import {createReadStream} from 'node:fs';
import {lstat,unlink,open,readFile,access} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {validAuthValue} from '../src/daemon-auth.ts';

export type RuntimeStartCause='runtime-damaged'|'database-start'|'data-credential'|'data-version'|'core-start';
export interface RuntimeStartFailure{cause:RuntimeStartCause;detail:string}
export class RuntimeStartFailureError extends Error{
 readonly failure:RuntimeStartFailure;
 constructor(failure:RuntimeStartFailure){super('Daemon start failed: '+failure.cause);this.name='RuntimeStartFailureError';this.failure=failure;}
}
export const shortenHome=(value:string)=>value.split(homedir()).join('~');
export function resolveNodeExecutable(runtimeDirectory:string|undefined,environment:NodeJS.ProcessEnv=process.env,packaged=false):string{
 // The one decision for which Node runs the daemon; the core inherits the daemon's own executable.
 // A packaged app always runs the bundled Node; the override is a development setting only.
 if(packaged&&runtimeDirectory)return join(runtimeDirectory,'node');
 if(environment.MASSION_NODE_BINARY)return environment.MASSION_NODE_BINARY;
 return runtimeDirectory?join(runtimeDirectory,'node'):'node';
}
export async function bundledRuntimeDirectory(packaged:boolean,resources:string,directory:string):Promise<string|undefined>{
 const candidate=packaged?join(resources,'runtime'):join(directory,'..','.runtime','current');
 try{await access(candidate);return candidate;}catch{return undefined;}
}
async function fileSha256(file:string){
 const hash=createHash('sha256');
 for await(const chunk of createReadStream(file,{highWaterMark:1<<20}))hash.update(chunk);
 return hash.digest('hex');
}
export async function verifyBundledRuntime(runtimeDirectory:string,options:{node?:boolean;surreal?:boolean}={}){
 const damaged=(detail:string)=>new RuntimeStartFailureError({cause:'runtime-damaged',detail:shortenHome(detail)});
 let raw:string;try{raw=await readFile(join(runtimeDirectory,'manifest.json'),'utf8');}catch{throw damaged('runtime manifest is missing in '+runtimeDirectory);}
 let manifest:{node?:{sha256?:unknown},surreal?:{sha256?:unknown}};try{manifest=JSON.parse(raw);}catch{throw damaged('runtime manifest is not valid JSON');}
 const verify=async(tool:'node'|'surreal')=>{
  if(!options[tool])return;
  const expected=manifest[tool]?.sha256;
  if(typeof expected!=='string'||!/^[a-f0-9]{64}$/.test(expected))throw damaged('runtime manifest has no valid '+tool+' SHA-256');
  const file=join(runtimeDirectory,tool);
  let actual:string;try{actual=await fileSha256(file);}catch{throw damaged('bundled '+tool+' is missing or unreadable: '+file);}
  if(actual!==expected)throw damaged('bundled '+tool+' SHA-256 mismatch for '+file+': expected '+expected.slice(0,16)+', found '+actual.slice(0,16));
 };
 await verify('node');
 await verify('surreal');
}
export interface RuntimeStartPlan{node:string;runtimeDirectory?:string;verifyNode:boolean;verifySurreal:boolean;managedDatabase:boolean;environment:NodeJS.ProcessEnv}
/** One decision for the whole start: which Node runs, whether the bundle is used and verified,
 * and which environment the daemon may see. Overrides are honored only in unpackaged runs. */
export function planRuntimeStart(options:{packaged:boolean;runtimeDirectory?:string;environment?:NodeJS.ProcessEnv}):RuntimeStartPlan{
 const environment=options.environment??process.env;
 if(options.packaged){
  if(!options.runtimeDirectory)throw new RuntimeStartFailureError({cause:'runtime-damaged',detail:'the packaged runtime is missing'});
  const clean=Object.fromEntries(Object.entries(environment).filter(([key])=>key!=='MASSION_NODE_BINARY'&&key!=='MASSION_SURREAL_RPC'));
  return {node:join(options.runtimeDirectory,'node'),runtimeDirectory:options.runtimeDirectory,verifyNode:true,verifySurreal:true,managedDatabase:true,environment:clean};
 }
 const node=resolveNodeExecutable(options.runtimeDirectory,environment);
 if(!environment.MASSION_SURREAL_RPC&&!options.runtimeDirectory)throw new Error('Set MASSION_SURREAL_RPC before starting the desktop daemon');
 const managedDatabase=Boolean(options.runtimeDirectory)&&!environment.MASSION_SURREAL_RPC;
 return {node,runtimeDirectory:options.runtimeDirectory,verifyNode:Boolean(options.runtimeDirectory)&&options.runtimeDirectory!==undefined&&node===join(options.runtimeDirectory,'node'),verifySurreal:managedDatabase,managedDatabase,environment};
}
export function daemonFiles(packaged:boolean,resources:string,directory:string){
 return {runner:join(packaged?resources:directory,'daemon-runner.mjs'),entry:packaged?join(resources,'core/src/server.ts'):resolve(directory,'../../src/server.ts')};
}

export interface ControlReply{status:string;pid?:number;origin?:string;secret?:string;cause?:string;detail?:string}
export function control(socket:string,command:'status'|'drain'|'credentials'):Promise<ControlReply>{
 return new Promise((resolve,reject)=>{
  const client=connect(socket);let body='';
  // Drain covers the whole shutdown bound: core SIGTERM 11 s + core SIGKILL 5 s + keeper 16 s
  // + keeper SIGKILL 5 s + direct database stop 15 s + unclosed-keeper probe <= 2 s + process scan <= 2 s
  // + PID file removal and check <= 2 s = 58 s. Startup and other file operations also use the 60 s budget.
  client.setTimeout(command==='drain'?60_000:1000,()=>client.destroy(new Error('Daemon control timeout')));
  client.on('connect',()=>client.end(command+'\n'));client.on('error',reject);
  client.on('data',chunk=>{body+=chunk;if(body.length>1024)client.destroy(new Error('Invalid daemon control reply'));});
  client.on('end',()=>{try{const reply=JSON.parse(body);if(!['running','drained','unsettled','starting','failed'].includes(reply.status))throw new Error();resolve(reply);}catch{reject(new Error('Invalid daemon control reply'));}});
 });
}
export async function daemonCredential(socket:string,origin:string){
 const file=await lstat(socket);
 if(!file.isSocket()||file.uid!==process.getuid?.()||(file.mode&0o077)!==0)throw new Error('Private daemon authentication socket required');
 const reply=await control(socket,'credentials');
 if(reply.origin!==origin||!validAuthValue(reply.secret))throw new Error('Daemon authentication unavailable');return reply.secret;
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
const runtimeStartCauses:readonly RuntimeStartCause[]=['runtime-damaged','database-start','data-credential','data-version','core-start'];
export async function launchDaemon(options:{node:string;runner:string;entry:string;directory:string;socket:string;origin:string;runtimeDirectory?:string;environment?:NodeJS.ProcessEnv}){
 const log=await open(join(options.directory,'daemon.log'),'a',0o600);
 try{
  const child=spawn(options.node,[options.runner,options.socket,options.entry,options.origin,...options.runtimeDirectory?[options.runtimeDirectory]:[]],{cwd:options.directory,env:options.environment??process.env,detached:true,stdio:['ignore',log.fd,log.fd]});
  await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
 }finally{await log.close();}
 const deadline=Date.now()+75_000;
 for(;;){
  let reply:ControlReply;
  try{reply=await control(options.socket,'status');}
  catch(error){
   if(!['ENOENT','ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code??''))throw error;
   if(Date.now()>deadline)throw new Error('Daemon startup failed; inspect the private daemon log');
   await delay(100);continue;
  }
  if(reply.status==='failed'){
   if(runtimeStartCauses.includes(reply.cause as RuntimeStartCause)&&typeof reply.detail==='string')throw new RuntimeStartFailureError({cause:reply.cause as RuntimeStartCause,detail:reply.detail});
   throw new Error('Daemon startup failed; inspect the private daemon log');
  }
  if(reply.status==='running')return reply;
  if(Date.now()>deadline)throw new Error('Daemon startup failed; inspect the private daemon log');
  await delay(100);
 }
}
