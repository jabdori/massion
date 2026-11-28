import {lstatSync} from 'node:fs';
import {realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute,dirname,basename} from 'node:path';
import {spawnCliRunner} from './cli-process.ts';
import {CLI_ENVIRONMENT_CLASS_NAME,CLI_ENVIRONMENT_LC_PATTERN} from './cli-agent-providers.ts';
import type {CliInvocation,CliResult,CliRunner} from './cli-agent-providers.ts';
import {checkSlot} from './secret-slots.ts';
import type {SecretSlot,SecretSlots} from './secret-slots.ts';
import {callTool,ToolCallError,TOOL_TIMEOUT_MS} from './tool-call.ts';

export interface LauncherPolicy {
 command:string;args:readonly (string|RegExp)[];probes?:readonly (readonly string[])[];environment:readonly string[];
 secrets:Readonly<Record<string,SecretSlot>>;readOnly:boolean;
 /** A discovered CLI carries its stamp; a pinned signature is verified unwrapped. */
 signature?:{teamId:string;identifier:string};stamp?:string;
}
type Prepared=()=>void|CliInvocation|Promise<void|CliInvocation>;
export interface LauncherAdapters {runner?:CliRunner;prepare?:(policy:LauncherPolicy,call:CliInvocation,onStampRefused?:(policy:LauncherPolicy)=>void)=>Promise<Prepared>;onStampRefused?:(policy:LauncherPolicy)=>void}
const unavailable=()=>new Error('CLI launcher unavailable');
const empty=(change:Partial<CliResult>={}):CliResult=>({spawned:false,exitCode:null,stdout:'',stderr:'',timedOut:false,aborted:false,overflow:false,...change});
const stampOf=(path:string)=>{const s=lstatSync(path,{bigint:true});if(!s.isFile()||s.isSymbolicLink())throw unavailable();return [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');};
/** The file-identity stamp shared by every checked CLI execution path. */
export const cliStamp=(path:string)=>stampOf(path);
export const sameCliStamp=(path:string,expected:string):boolean=>{try{return stampOf(path)===expected;}catch{return false;}};
const dangerousEnvironment=/^(?:NODE_OPTIONS|NODE_PATH|DYLD_.*|LD_.*|BASH_ENV|ENV|SHELLOPTS|PYTHONPATH|PYTHONHOME|RUBYOPT|PERL5OPT)$/;

async function prepareMac(policy:LauncherPolicy,call:CliInvocation,onStampRefused?:(policy:LauncherPolicy)=>void):Promise<Prepared>{
 // Non-darwin never had the wrapper (a missing sandbox-exec refused there by accident); the adapter refuses until an equivalent exists (ADR 0005). The refusal is now this check.
 if(process.platform!=='darwin')throw unavailable();
 const verified=policy.signature?await verifySignedCli(policy.command,policy.signature,call.signal):{path:policy.command,stamp:policy.stamp??cliStamp(policy.command)};
 const cwd=await realpath(call.cwd);
 const directory=lstatSync(cwd);
 if(dirname(cwd)!==await realpath(tmpdir())||!basename(cwd).startsWith('massion-cli-')||!directory.isDirectory()||directory.uid!==process.getuid?.()||(directory.mode&0o077)!==0)throw unavailable();
 // No OS sandbox wraps the command: the profile that stood here started no program under a real sandbox-exec (issue #190).
 return ()=>{if(!sameCliStamp(policy.command,verified.stamp)){onStampRefused?.(policy);throw unavailable();}return call;};
}

/** A verified executable: the canonical absolute path plus the pre-verification file-identity stamp. */
export interface SignedCli {path:string;stamp:string}
const validSignature=(signature:{teamId:string;identifier:string}|undefined)=>Boolean(signature&&typeof signature.teamId==='string'&&/^[A-Z0-9]{1,32}$/.test(signature.teamId)&&typeof signature.identifier==='string'&&/^[a-zA-Z0-9.-]{1,128}$/.test(signature.identifier));
/** The shared executable check: canonical absolute path plus the pinned signing requirement. Only path may ever be executed. */
export async function verifySignedCli(command:string,signature:{teamId:string;identifier:string},signal?:AbortSignal):Promise<SignedCli> {
 if(process.platform!=='darwin'||!validSignature(signature)||!isAbsolute(command)||await realpath(command)!==command)throw unavailable();
 const stamp=stampOf(command);
 const requirement=`anchor apple generic and certificate leaf[subject.OU] = "${signature.teamId}" and identifier "${signature.identifier}"`;
 const checked=await spawnCliRunner({command:'/usr/bin/codesign',args:['--verify','--strict','-R','='+requirement,command],stdin:'',cwd:'/',env:{},signal:signal??new AbortController().signal,timeoutMs:5000,maxOutputBytes:4096});
 if(!checked.spawned||checked.exitCode!==0||checked.timedOut||checked.aborted||checked.overflow)throw unavailable();
 return {path:command,stamp};
}

/** Host-only policies. Invocation identity is reserved before any asynchronous work. */
export class CliLauncher {
 readonly #policy:LauncherPolicy;readonly #secrets:SecretSlots;readonly #adapters:LauncherAdapters;
 readonly #calls=new Map<string,{identity:string;result:Promise<CliResult>}>();
 constructor(policy:LauncherPolicy,secrets:SecretSlots,adapters:LauncherAdapters={}){
  // An executable handed a secret needs a confinement that has run for real; none exists (issue #190: the deleted profile started no program). The slice that first needs one (gh, op) rebuilds it with a real sandbox-exec child test.
 // This refusal sees only the policy's secrets field: a secret passed as the value of an allowed environment variable, as an argument, or on stdin is not seen by it. Today's only caller (subscription-cli-host) passes none.
  if(Object.keys(policy.secrets).length)throw unavailable();
  // A policy without a signature is a discovered CLI (verified by --version and the stamp); one that is present must be valid.
  if(!isAbsolute(policy.command)||!policy.args.length||policy.args.length>160||typeof policy.readOnly!=='boolean'||policy.signature!==undefined&&!validSignature(policy.signature))throw unavailable();
  for(const name of [...policy.environment,...Object.keys(policy.secrets)])if((name!==CLI_ENVIRONMENT_CLASS_NAME&&!/^[A-Z_][A-Z0-9_]{0,127}$/.test(name))||dangerousEnvironment.test(name))throw unavailable();
  for(const ref of Object.values(policy.secrets))checkSlot(ref);
  for(const pattern of policy.args)if(typeof pattern!=='string'&&(!(pattern instanceof RegExp)||!pattern.source.startsWith('^')||!pattern.source.endsWith('$')||pattern.flags))throw unavailable();
  this.#policy=structuredClone(policy);this.#secrets=secrets;this.#adapters=adapters;
 }
 get command(){return this.#policy.command;}
 async launch(id:string,invocation:CliInvocation):Promise<CliResult>{
  const p=this.#policy;
  if(!/^[a-zA-Z0-9:_-]{1,256}$/.test(id))throw new Error('Invalid invocation identity');
  const shapes=[p.args,...(p.probes??[])];
  const shape=shapes.findIndex(patterns=>invocation.args.length===patterns.length&&invocation.args.every((arg,i)=>{
   if(typeof arg!=='string'||arg.length>4096||/[\u0000-\u001f\u007f]/.test(arg))return false;
   const pattern=patterns[i]!;
   return typeof pattern==='string'?arg===pattern:!arg.startsWith('-')&&pattern.exec(arg)?.[0]===arg;
  }));
  if(invocation.command!==p.command||shape<0||shape>0&&invocation.stdin!=='')throw new Error('CLI arguments refused');
  if(!Number.isSafeInteger(invocation.timeoutMs)||invocation.timeoutMs<1||invocation.timeoutMs>TOOL_TIMEOUT_MS||!Number.isSafeInteger(invocation.maxOutputBytes)||invocation.maxOutputBytes<1||invocation.maxOutputBytes>1048576||typeof invocation.stdin!=='string'||Buffer.byteLength(invocation.stdin)>1048576||!isAbsolute(invocation.cwd))throw new Error('CLI bounds refused');
  // One pinned locale class expands to the LC_* names actually present; every other entry stays an exact name.
  const environment=p.environment.flatMap(name=>name===CLI_ENVIRONMENT_CLASS_NAME?Object.keys(invocation.env).filter(key=>CLI_ENVIRONMENT_LC_PATTERN.test(key)):[name]).filter(name=>invocation.env[name]!==undefined);
  const call={...invocation,args:[...invocation.args],env:Object.fromEntries(environment.map(k=>[k,invocation.env[k]!]))};
  // Environment and secret values never enter identity hashes or durable data.
  const identity=JSON.stringify([call.command,call.args,call.stdin,call.cwd,call.timeoutMs,call.maxOutputBytes]);
  // The probes and exec share one invocation ID while remaining separate launcher calls.
  const key=`${shape}/${id}`;
  const prior=this.#calls.get(key);if(prior){if(prior.identity!==identity)throw new Error('CLI invocation identity conflict');return prior.result;}
  if(this.#calls.size>=1024*shapes.length)throw new Error('CLI invocation capacity reached');
  const result=Promise.resolve().then(()=>this.#launch(call));this.#calls.set(key,{identity,result});return result;
 }
 async #launch(call:CliInvocation):Promise<CliResult>{
  if(call.signal.aborted)return empty({aborted:true});
  const values:string[]=[],env={...call.env};let started=false;
  try{return await callTool(async signal=>{
   const prepared=await (this.#adapters.prepare??prepareMac)(this.#policy,{...call,signal},this.#adapters.onStampRefused);
   for(const [name,slot] of Object.entries(this.#policy.secrets)){const value=await this.#secrets.read(slot,signal);if(signal.aborted||!value||/[\u0000]/.test(value))throw unavailable();values.push(value);env[name]=value;}
   if(signal.aborted)throw new ToolCallError('failed',false);
   const check=prepared(),checked=check instanceof Promise?await check:check;
   if(signal.aborted)throw new ToolCallError('failed',false);
   started=true;const result=await (this.#adapters.runner??spawnCliRunner)({...call,...checked,env,signal});
   const redact=(text:string)=>{for(const value of values){for(const form of [value,JSON.stringify(value).slice(1,-1),encodeURIComponent(value),Buffer.from(value).toString('base64')])text=text.split(form).join('[REDACTED]');}return text;};
   // Truncated output can end inside a secret; retain no partial output in that case.
   return {...result,stdout:result.overflow||result.timedOut||result.aborted?'':redact(result.stdout),stderr:values.length?'':result.stderr};
  },{signal:call.signal,readOnly:this.#policy.readOnly,timeoutMs:call.timeoutMs});}
  catch(error){if(error instanceof ToolCallError)return empty({spawned:started,timedOut:error.timedOut,aborted:!error.timedOut});return empty({spawned:started});}
  finally{for(const name of Object.keys(env))delete env[name];values.length=0;}
 }
}
