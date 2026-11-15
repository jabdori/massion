/**
 * The one place that decides how the two untrusted children (the app worker and
 * the calculation oracle) start. On macOS both run behind a default-deny
 * sandbox-exec profile that is proved once per process: the same probe program
 * must succeed unwrapped (write a temp file it then removes, connect to the
 * listening parent) and, wrapped, be refused on every axis with exactly the
 * sandbox error; otherwise no confined child starts at all (fail closed). The
 * proof is bound to the Node binary and re-run if that binary changes.
 * Elsewhere the command comes back honestly unconfined and the caller decides
 * whether that is acceptable (the oracle: not a release target, see ADR 0009)
 * or grounds for refusing to start (the app worker). Production reads no
 * environment override; setConfinementForTests is the only switch and it can
 * only disable or restore confinement.
 */
import {spawn} from 'node:child_process';
import {existsSync,realpathSync,statSync} from 'node:fs';
import type {AddressInfo} from 'node:net';
import {createServer} from 'node:net';

const SANDBOX_EXEC='/usr/bin/sandbox-exec',PROBE_TIMEOUT_MS=5000,BACKSLASH=String.fromCharCode(92);
/** Every probe under this profile fails with exactly EPERM (write, spawn, fork, connect; measured on this machine and on the design experiments). */
const REFUSAL_CODE='EPERM';
const PROBES=['write','spawn','fork','connect'] as const;

// Quoted for the profile language only when nothing needs escaping: a path with a quote, a backslash or a control character is refused outright.
const quotable=(path:string)=>!!path&&![...path].some(character=>character==='"'||character===BACKSLASH||character.charCodeAt(0)<32||character.charCodeAt(0)===127);

/**
 * The exact default-deny profile the Mac experiments found minimal: execute
 * this Node binary, read files, read sysctls. Writes, the network, every other
 * binary and fork stay denied by default.
 */
export function confinementProfile(nodePath:string):string|null{
 if(!quotable(nodePath))return null;
 return '(version 1)(deny default)(allow process-exec (literal "'+nodePath+'"))(allow file-read*)(allow sysctl-read)';
}

/** Fixed reason codes only: no child output, path or other free text leaves this module. */
export type ConfinementReason='mechanism-missing'|'node-path'|'control-failed'|'probe-failed'|'probe-report-invalid'|'probe-allowed'|'binary-changed';

export type ConfinedCommand=
 |{status:'confined';command:string;args:string[]}
 // Not OS-confined; this platform is not a release target; see ADR 0009.
 |{status:'unconfined';command:string;args:string[]}
 |{status:'unavailable';reason:ConfinementReason};

// The probe program, run unwrapped (control) and wrapped (proof). Each attempt reports the exact error code it failed with, or succeeded.
const attemptSource=(port:number)=>'const{spawnSync,fork}=require("node:child_process"),{writeFileSync,unlinkSync}=require("node:fs"),{tmpdir}=require("node:os"),{join}=require("node:path"),{connect}=require("node:net");const temp=join(tmpdir(),"massion-confinement-"+process.pid),out={},left=new Set(["write","spawn","fork","connect"]);const finish=()=>{if(left.size)return;try{unlinkSync(temp);}catch{}process.stdout.write(JSON.stringify(out));process.exit(0);};try{writeFileSync(temp,"probe");out.write="succeeded";}catch(e){out.write=String(e.code||e.message);}left.delete("write");finish();try{const done=spawnSync("/usr/bin/true");out.spawn=done.error?String(done.error.code||done.message):"succeeded";}catch(e){out.spawn=String(e.code||e.message);}left.delete("spawn");finish();try{const child=fork("/usr/bin/true");child.once("error",e=>{out.fork=String(e.code||e.message);left.delete("fork");finish();});child.once("exit",()=>{if(!Object.hasOwn(out,"fork")){out.fork="succeeded";left.delete("fork");finish();}});}catch(e){out.fork=String(e.code||e.message);left.delete("fork");finish();}const socket=connect('+port+',"127.0.0.1");socket.once("connect",()=>{out.connect="succeeded";left.delete("connect");finish();});socket.once("error",e=>{out.connect=String(e.code||e.message);left.delete("connect");finish();});setTimeout(()=>{for(const probe of left)out[probe]="timeout";try{unlinkSync(temp);}catch{}process.stdout.write(JSON.stringify(out));process.exit(0);},3000);';

export type ConfinementIdentity={dev:string;ino:string;size:string;mtime:string};
export type ConfinementVerification=
 |{ok:true;nodePath:string;profile:string;identity:ConfinementIdentity}
 |{ok:false;reason:ConfinementReason};

const identityOf=(path:string):ConfinementIdentity=>{const stats=statSync(path,{bigint:true});return {dev:String(stats.dev),ino:String(stats.ino),size:String(stats.size),mtime:String(stats.mtimeNs)};};

export interface ChildRun{code:number|null;signal:string|null;timedOut:boolean;stdout:string}
export type ChildRunner=(command:string,args:string[])=>Promise<ChildRun>;

async function spawnChild(command:string,args:string[]):Promise<ChildRun>{
 return new Promise(resolve=>{
  const child=spawn(command,args,{env:{},stdio:['ignore','pipe','pipe']});
  let stdout='';
  const finish=(result:ChildRun)=>{clearTimeout(timer);resolve(result);};
  const timer=setTimeout(()=>{child.kill('SIGKILL');finish({code:null,signal:null,timedOut:true,stdout});},PROBE_TIMEOUT_MS);
  child.stdout?.setEncoding('utf8').on('data',(chunk:string)=>{stdout+=chunk;});
  child.on('error',()=>finish({code:null,signal:null,timedOut:false,stdout}));
  child.on('close',(code,signal)=>finish({code,signal,timedOut:false,stdout}));
 });
}

const parseReport=(stdout:string):Record<string,string>|null=>{
 try{const parsed=JSON.parse(stdout.trim().split('\n').at(-1)!);return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed as Record<string,string>:null;}catch{return null;}
};

// The control must be able to write and connect on this machine, or confinement cannot be proved here.
const controlProves=(report:Record<string,string>|null):boolean=>!!report&&report['write']==='succeeded'&&report['connect']==='succeeded';

// Every probe must be present and refused with exactly the sandbox EPERM; succeeded, a missing probe, another code (ENOENT, EACCES, EMFILE, ETIMEDOUT) or a timeout is not proof.
const probeProves=(report:Record<string,string>|null):ConfinementReason|null=>{
 if(!report)return 'probe-report-invalid';
 for(const probe of PROBES){
  if(!Object.hasOwn(report,probe))return 'probe-report-invalid';
  if(report[probe]==='succeeded')return 'probe-allowed';
  if(report[probe]!==REFUSAL_CODE)return 'probe-report-invalid';
 }
 return null;
};

/** Runs the control and the wrapped probe. runChild replaces both real child runs in tests. */
export async function verifyConfinement(injection:{nodePath?:string;runChild?:ChildRunner}={}):Promise<ConfinementVerification>{
 const execute=injection.runChild??spawnChild;
 if(!injection.runChild&&(process.platform!=='darwin'||!existsSync(SANDBOX_EXEC)))return {ok:false,reason:'mechanism-missing'};
 let nodePath:string;
 try{nodePath=realpathSync(injection.nodePath??process.execPath);}catch{return {ok:false,reason:'node-path'};}
 const profile=confinementProfile(nodePath);
 if(!profile)return {ok:false,reason:'node-path'};
 const server=createServer(socket=>socket.destroy());
 server.listen(0,'127.0.0.1');
 await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
 const port=(server.address() as AddressInfo).port;
 try{
  const control=await execute(nodePath,['-e',attemptSource(port)]);
  if(control.timedOut||control.code!==0||!controlProves(parseReport(control.stdout)))return {ok:false,reason:'control-failed'};
  const probe=await execute(SANDBOX_EXEC,['-p',profile,nodePath,'-e',attemptSource(port)]);
  if(probe.timedOut||probe.code!==0)return {ok:false,reason:'probe-failed'};
  const refusal=probeProves(parseReport(probe.stdout));
  if(refusal)return {ok:false,reason:refusal};
  return {ok:true,nodePath,profile,identity:identityOf(nodePath)};
 }finally{server.close();}
}

// Once per process, before any child relies on it; a failed proof stays cached unless the binary changes.
let real:ConfinementVerification;
try{real=await verifyConfinement();}catch{real={ok:false,reason:'control-failed'};}
let verified:ConfinementVerification=real;
let reverifying:Promise<void>|undefined;

const binaryChanged=(record:Extract<ConfinementVerification,{ok:true}>):boolean=>{
 try{return JSON.stringify(identityOf(record.nodePath))!==JSON.stringify(record.identity);}catch{return true;}
};

// The checked binary changed: prove the wall again before anything starts; until then nothing starts.
const reverify=()=>{if(reverifying)return;reverifying=(async()=>{try{const fresh=await verifyConfinement();real=fresh;verified=fresh;}catch{/* keep the failed result; fail closed */}finally{reverifying=undefined;}})();};

export function confinedCommand(nodeArgs:string[]):ConfinedCommand{
 if(process.platform!=='darwin')return {status:'unconfined',command:process.execPath,args:nodeArgs};
 if(!verified.ok)return {status:'unavailable',reason:verified.reason};
 if(binaryChanged(verified)){reverify();return {status:'unavailable',reason:'binary-changed'};}
 return {status:'confined',command:SANDBOX_EXEC,args:['-p',verified.profile,verified.nodePath,...nodeArgs]};
}

/** The confinement state for the technical status surface (GET /health); the reason is always one fixed code, never child output. */
export function confinementStatus():{state:'confined'|'unconfined'|'unavailable';reason?:ConfinementReason}{
 const command=confinedCommand([]);
 return command.status==='unavailable'?{state:'unavailable',reason:command.reason}:{state:command.status};
}

/** Test-only: replace the process-wide verification result (undefined restores the real one). Production reads no override; this can only disable or restore confinement. */
export function setConfinementForTests(value:ConfinementVerification|undefined){verified=value??real;}
