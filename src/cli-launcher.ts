import {lstatSync} from 'node:fs';
import {realpath} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {isAbsolute,dirname,basename} from 'node:path';
import {spawnCliRunner} from './cli-process.ts';
import type {CliInvocation,CliResult,CliRunner} from './cli-agent-providers.ts';
import {checkSlot} from './secret-slots.ts';
import type {SecretSlot,SecretSlots} from './secret-slots.ts';
import {callTool,ToolCallError,TOOL_TIMEOUT_MS} from './tool-call.ts';

export interface LauncherPolicy {
 command:string;args:readonly (string|RegExp)[];environment:readonly string[];
 secrets:Readonly<Record<string,SecretSlot>>;readOnly:boolean;
 signature:{teamId:string;identifier:string};machServices?:readonly string[];
}
type Prepared=()=>void|CliInvocation|Promise<void|CliInvocation>;
interface LauncherAdapters {runner?:CliRunner;prepare?:(policy:LauncherPolicy,call:CliInvocation)=>Promise<Prepared>}
const unavailable=()=>new Error('CLI launcher unavailable');
const empty=(change:Partial<CliResult>={}):CliResult=>({spawned:false,exitCode:null,stdout:'',stderr:'',timedOut:false,aborted:false,overflow:false,...change});
const stamp=(path:string)=>{const s=lstatSync(path,{bigint:true});if(!s.isFile()||s.isSymbolicLink())throw unavailable();return [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');};
const dangerousEnvironment=/^(?:NODE_OPTIONS|NODE_PATH|DYLD_.*|LD_.*|BASH_ENV|ENV|SHELLOPTS|PYTHONPATH|PYTHONHOME|RUBYOPT|PERL5OPT)$/;

export function cliSandboxProfile(policy:LauncherPolicy,cwd:string,home:string):string{
 const quoted=(path:string)=>JSON.stringify(path),services=policy.machServices??[];
 if(!Array.isArray(services)||services.length>32||services.some(name=>typeof name!=='string'||!/^[a-zA-Z0-9._-]{1,128}$/.test(name)||/^com\.apple\.(securityd|SecurityServer)/i.test(name)))throw unavailable();
 const mach=services.map(name=>`(allow mach-lookup (global-name ${quoted(name)}))`).join('');
 const sensitive=['/Library/Keychains',home+'/.ssh',home+'/.aws',home+'/.azure',home+'/.config/gcloud',home+'/Library/Keychains',home+'/Library/Application Support'];
 return `(version 1)(deny default)(allow process-exec)(allow process-fork)(allow sysctl-read)${mach}(deny mach-lookup (global-name-prefix "com.apple.securityd") (global-name-prefix "com.apple.SecurityServer"))(deny process-exec (literal "/usr/bin/security"))(allow network-outbound)(allow file-read* (subpath "/System") (subpath "/usr") (subpath "/opt/homebrew") (subpath ${quoted(cwd)}) (literal ${quoted(policy.command)}))(allow file-write* (subpath ${quoted(cwd)}) (literal "/dev/null"))(deny file-read* ${sensitive.map(p=>`(subpath ${quoted(p)})`).join(' ')})`;
}

async function prepareMac(policy:LauncherPolicy,call:CliInvocation):Promise<Prepared>{
 if(process.platform!=='darwin'||!isAbsolute(policy.command)||await realpath(policy.command)!==policy.command)throw unavailable();
 const before=stamp(policy.command);
 const requirement=`anchor apple generic and certificate leaf[subject.OU] = "${policy.signature.teamId}" and identifier "${policy.signature.identifier}"`;
 const checked=await spawnCliRunner({command:'/usr/bin/codesign',args:['--verify','--strict','-R',requirement,policy.command],stdin:'',cwd:'/',env:{},signal:call.signal,timeoutMs:5000,maxOutputBytes:4096});
 if(!checked.spawned||checked.exitCode!==0||checked.timedOut||checked.aborted||checked.overflow)throw unavailable();
 const cwd=await realpath(call.cwd),home=await realpath(homedir());
 const directory=lstatSync(cwd);
 if(dirname(cwd)!==await realpath(tmpdir())||!basename(cwd).startsWith('massion-cli-')||!directory.isDirectory()||directory.uid!==process.getuid?.()||(directory.mode&0o077)!==0)throw unavailable();
 const profile=cliSandboxProfile(policy,cwd,home);
 return ()=>{if(stamp(policy.command)!==before)throw unavailable();return {...call,command:'/usr/bin/sandbox-exec',args:['-p',profile,policy.command,...call.args]};};
}

/** Host-only policies. Invocation identity is reserved before any asynchronous work. */
export class CliLauncher {
 readonly #policy:LauncherPolicy;readonly #secrets:SecretSlots;readonly #adapters:LauncherAdapters;
 readonly #calls=new Map<string,{identity:string;result:Promise<CliResult>}>();
 constructor(policy:LauncherPolicy,secrets:SecretSlots,adapters:LauncherAdapters={}){
  if(!isAbsolute(policy.command)||!policy.args.length||policy.args.length>128||typeof policy.readOnly!=='boolean'||!policy.signature||!/^[A-Z0-9]{1,32}$/.test(policy.signature.teamId)||!/^[a-zA-Z0-9.-]{1,128}$/.test(policy.signature.identifier))throw unavailable();
  for(const name of [...policy.environment,...Object.keys(policy.secrets)])if(!/^[A-Z_][A-Z0-9_]{0,127}$/.test(name)||dangerousEnvironment.test(name))throw unavailable();
  for(const ref of Object.values(policy.secrets))checkSlot(ref);
  for(const pattern of policy.args)if(typeof pattern!=='string'&&(!(pattern instanceof RegExp)||!pattern.source.startsWith('^')||!pattern.source.endsWith('$')||pattern.flags))throw unavailable();
  this.#policy=structuredClone(policy);this.#secrets=secrets;this.#adapters=adapters;
 }
 get command(){return this.#policy.command;}
 async launch(id:string,invocation:CliInvocation):Promise<CliResult>{
  const p=this.#policy;
  if(!/^[a-zA-Z0-9:_-]{1,256}$/.test(id))throw new Error('Invalid invocation identity');
  if(invocation.command!==p.command||invocation.args.length!==p.args.length||!invocation.args.every((arg,i)=>typeof arg==='string'&&arg.length<=4096&&!/[\u0000-\u001f\u007f]/.test(arg)&&(typeof p.args[i]==='string'?arg===p.args[i]:!arg.startsWith('-')&&(p.args[i] as RegExp).exec(arg)?.[0]===arg)))throw new Error('CLI arguments refused');
  if(!Number.isSafeInteger(invocation.timeoutMs)||invocation.timeoutMs<1||invocation.timeoutMs>TOOL_TIMEOUT_MS||!Number.isSafeInteger(invocation.maxOutputBytes)||invocation.maxOutputBytes<1||invocation.maxOutputBytes>1048576||typeof invocation.stdin!=='string'||Buffer.byteLength(invocation.stdin)>1048576||!isAbsolute(invocation.cwd))throw new Error('CLI bounds refused');
  const call={...invocation,args:[...invocation.args],env:Object.fromEntries(p.environment.filter(k=>invocation.env[k]!==undefined).map(k=>[k,invocation.env[k]!]))};
  // Environment and secret values never enter identity hashes or durable data.
  const identity=JSON.stringify([call.command,call.args,call.stdin,call.cwd,call.timeoutMs,call.maxOutputBytes]);
  const prior=this.#calls.get(id);if(prior){if(prior.identity!==identity)throw new Error('CLI invocation identity conflict');return prior.result;}
  if(this.#calls.size>=1024)throw new Error('CLI invocation capacity reached');
  const result=Promise.resolve().then(()=>this.#launch(call));this.#calls.set(id,{identity,result});return result;
 }
 async #launch(call:CliInvocation):Promise<CliResult>{
  if(call.signal.aborted)return empty({aborted:true});
  const values:string[]=[],env={...call.env};let started=false;
  try{return await callTool(async signal=>{
   const prepared=await (this.#adapters.prepare??prepareMac)(this.#policy,{...call,signal});
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
