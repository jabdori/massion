/**
 * The one place that decides how the two untrusted children (the app worker and
 * the calculation oracle) start. On macOS both run behind a default-deny
 * sandbox-exec profile that is proved once per process: a confined Node that
 * manages to write, connect or spawn means no confined child starts at all
 * (fail closed). Elsewhere the command comes back honestly unconfined and the
 * caller decides whether that is acceptable (the oracle: not a release target,
 * see the ADR) or grounds for refusing to start (the app worker).
 */
import {spawn} from 'node:child_process';
import {existsSync,realpathSync} from 'node:fs';
import type {AddressInfo} from 'node:net';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const SANDBOX_EXEC='/usr/bin/sandbox-exec',PROBE_TIMEOUT_MS=5000,BACKSLASH=String.fromCharCode(92);

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

export type ConfinedCommand=
 |{status:'confined';command:string;args:string[]}
 // Not OS-confined; this platform is not a release target; see the ADR.
 |{status:'unconfined';command:string;args:string[]}
 |{status:'unavailable';reason:string};

// Every attempt the startup probe and the isolation tests make from inside a child: a temp write, a loopback connect while the parent listens, exec of another binary, fork.
const attemptSource=(port:number)=>'const{spawnSync,fork}=require("node:child_process"),{writeFileSync}=require("node:fs"),{tmpdir}=require("node:os"),{join}=require("node:path"),{connect}=require("node:net");const out={};const settle=(attempt,refused)=>{out[attempt]=refused?"refused":"allowed";};(async()=>{try{writeFileSync(join(tmpdir(),"massion-confinement-"+process.pid),"probe");settle("write",false);}catch{settle("write",true);}try{settle("spawn",!!spawnSync("/usr/bin/true").error);}catch{settle("spawn",true);}await new Promise(resolve=>{try{const child=fork("/usr/bin/true");child.once("error",()=>{settle("fork",true);resolve();});child.once("exit",()=>{settle("fork",false);resolve();});}catch{settle("fork",true);resolve();}});await new Promise(resolve=>{try{const socket=connect('+port+',"127.0.0.1");socket.once("connect",()=>{settle("connect",false);socket.destroy();resolve();});socket.once("error",()=>{settle("connect",true);resolve();});}catch{settle("connect",true);resolve();}});process.stdout.write(JSON.stringify(out));})();';

type Verification={ok:true;nodePath:string;profile:string}|{ok:false;reason:string};

async function verifyOnce():Promise<Verification>{
 if(process.platform!=='darwin')return {ok:false,reason:'no OS sandbox mechanism on this platform'};
 if(!existsSync(SANDBOX_EXEC))return {ok:false,reason:SANDBOX_EXEC+' is missing'};
 let nodePath:string;
 try{nodePath=realpathSync(process.execPath);}catch{return {ok:false,reason:'the Node binary path did not resolve'};}
 const profile=confinementProfile(nodePath);
 if(!profile)return {ok:false,reason:'the Node binary path cannot be quoted in a sandbox profile'};
 const server=createServer(socket=>socket.destroy());
 server.listen(0,'127.0.0.1');
 await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
 const port=(server.address() as AddressInfo).port;
 try{
  return await new Promise<Verification>(resolve=>{
   const child=spawn(SANDBOX_EXEC,['-p',profile,nodePath,'-e',attemptSource(port)],{env:{},stdio:['ignore','pipe','pipe']});
   let out='',err='';
   const finish=(value:Verification)=>{clearTimeout(timer);resolve(value);};
   const timer=setTimeout(()=>{child.kill('SIGKILL');finish({ok:false,reason:'the confinement probe timed out'});},PROBE_TIMEOUT_MS);
   child.stdout?.setEncoding('utf8').on('data',(chunk:string)=>{out+=chunk;});
   child.stderr?.setEncoding('utf8').on('data',(chunk:string)=>{err+=chunk;});
   child.on('error',error=>finish({ok:false,reason:'the confinement probe did not start: '+error.message}));
   child.on('close',code=>{
    if(code!==0)return finish({ok:false,reason:'the confinement probe exited with '+code+(err?': '+err.slice(0,200):'')});
    let report:Record<string,string>;
    try{report=JSON.parse(out.trim().split('\n').at(-1)!);}catch{return finish({ok:false,reason:'the confinement probe returned no report'});}
    for(const [attempt,outcome] of Object.entries(report))if(outcome!=='refused')return finish({ok:false,reason:'the confinement probe was allowed to '+attempt});
    return finish({ok:true,nodePath,profile});
   });
  });
 }finally{server.close();}
}

// Once per process: prove the wall before any child relies on it.
const verified=await verifyOnce();

export function confinedCommand(nodeArgs:string[]):ConfinedCommand{
 if(process.platform!=='darwin')return {status:'unconfined',command:process.execPath,args:nodeArgs};
 if(process.env.MASSION_SANDBOX_EXEC!==undefined)return {status:'unavailable',reason:'sandbox-exec was overridden and is therefore unverified'};
 return verified.ok
  ?{status:'confined',command:SANDBOX_EXEC,args:['-p',verified.profile,verified.nodePath,...nodeArgs]}
  :{status:'unavailable',reason:verified.reason};
}

/** The confinement state for the technical status surface (GET /health). */
export function confinementStatus():{state:'confined'|'unconfined'|'unavailable';reason?:string}{
 const command=confinedCommand([]);
 return command.status==='unavailable'?{state:'unavailable',reason:command.reason}:{state:command.status};
}
