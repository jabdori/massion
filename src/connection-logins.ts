import {DomainError} from './domain.ts';
import {callTool,ToolCallError} from './tool-call.ts';
import {spawnCliRunner} from './cli-process.ts';
import {applyCliAccountEnvironment,cliAccountUsername,cliEnvironmentAllowed} from './cli-agent-providers.ts';
import type {CliRunner,CliResult} from './cli-agent-providers.ts';
import {sameCliStamp} from './cli-launcher.ts';
import type {SignedCli} from './cli-launcher.ts';
import type {DiscoveredSubscriptionCli} from './subscription-cli-discovery.ts';

const providers=[{providerType:'claude-code-cli',command:'claude',status:['auth','status','--json'],login:['auth','login']},{providerType:'codex-cli',command:'codex',status:['login','status'],login:['login']}] as const;
export type LoginProviderType='claude-code-cli'|'codex-cli';
/** Every refusal of POST /connection-login, as a machine-readable reason next to its unchanged message and status. */
export const LOGIN_REFUSAL_REASONS={'Subscription login executable is unavailable':'cli-not-found','Login host is draining':'draining','Unknown login provider':'unknown-provider','Exact login command fields required':'invalid-fields','Login command identity conflict':'command-id-reused','Login command capacity reached':'capacity','Login already started or unresolved':'already-started','Login command could not be started':'login-not-started'} as const;
export const loginRefusalReason=(error:DomainError):string|undefined=>(Object.entries(LOGIN_REFUSAL_REASONS) as [string,string][]).find(([message])=>message===error.message)?.[1];
/** `status` keeps today's exact values (the connection-lifecycle observation and the activation gate read it); `state` splits absent/unknown into what a person can act on. */
type LoginState='cli-not-found'|'logged-out'|'logged-in'|'unreadable'|'unknown';
type LoginStatus={providerType:string;kind:'cli-login';status:'detected'|'absent'|'unknown';state:LoginState;unreadableReason?:'failed'|'timed-out'|'unrecognised-output';version?:string};
/** The outcome line's reason codes are the names the login status already uses; unreadable is split by its existing unreadableReason. */
type DetectionOutcomeCode='detected'|'cli-not-found'|'logged-out'|'unknown'|'failed'|'timed-out'|'unrecognised-output';
const detectionOutcomeOf=(status:LoginStatus):DetectionOutcomeCode=>status.state==='logged-in'?'detected':status.state==='unreadable'?(status.unreadableReason??'failed'):status.state;
type LoginCommand=SignedCli&{searchPath?:string;version?:string};
type LoginStartRecord={providerType:string;status:'started'|'settled'|'unknown';outcome:'login-started'|'already-logged-in'};
/** Only official CLI status/login commands; raw account information never leaves this adapter. */
export class LoginConnections {
 readonly #runner:CliRunner;readonly #injected:boolean;readonly #options:{discover?:(providerType:LoginProviderType,signal?:AbortSignal)=>Promise<DiscoveredSubscriptionCli|null>;rediscover?:(providerType:LoginProviderType,signal?:AbortSignal)=>Promise<DiscoveredSubscriptionCli|null>;account?:()=>string;writeDetectionOutcome?:(line:string)=>void};readonly #starts=new Map<string,LoginStartRecord>();#laneTail:Promise<void>=Promise.resolve();
 readonly #stop=new AbortController();readonly #running=new Set<Promise<CliResult>>();readonly #cleanup=new Set<Promise<CliResult>>();
 #reading:Promise<LoginStatus[]>|undefined;
 readonly #write:(line:string)=>void;readonly #lastOutcome=new Map<string,DetectionOutcomeCode>();
 constructor(runner?:CliRunner,options:{discover?:(providerType:LoginProviderType,signal?:AbortSignal)=>Promise<DiscoveredSubscriptionCli|null>;rediscover?:(providerType:LoginProviderType,signal?:AbortSignal)=>Promise<DiscoveredSubscriptionCli|null>;account?:()=>string;writeDetectionOutcome?:(line:string)=>void}={}){this.#runner=runner??spawnCliRunner;this.#injected=runner!==undefined;this.#options=options;this.#write=options.writeDetectionOutcome??((line)=>{console.error(line);});}
 /** Discovery resolves the executable; a CLI that is not found yields no command and the login reads absent. Only the resolved path is executed. */
 async #command(provider:typeof providers[number],signal?:AbortSignal):Promise<LoginCommand|null>{
  if(this.#options.discover)try{return await this.#options.discover(provider.providerType,signal)??null;}catch{return null;}
  return this.#injected?{path:provider.command,stamp:''}:null;
 }
 #call(provider:typeof providers[number],signed:LoginCommand,login=false,externalSignal?:AbortSignal,onSpawned?:()=>void){const env:Record<string,string>={};for(const [key,value] of Object.entries(process.env))if(value!==undefined&&cliEnvironmentAllowed(key))env[key]=value;applyCliAccountEnvironment(env,this.#options.account??cliAccountUsername);if(signed.searchPath)env.PATH=signed.searchPath;
  const pending=callTool(async signal=>{
   // The same TOCTOU re-check the model-call launcher does, immediately before exec; one rediscovery, then refuse.
   let command=signed;
   if(command.stamp&&!sameCliStamp(command.path,command.stamp)){
    const again=this.#options.discover?await (this.#options.rediscover??this.#options.discover)(provider.providerType,signal).catch(()=>null):null;
    if(!again||!sameCliStamp(again.path,again.stamp))throw new Error('CLI executable changed after verification');
    command={...again};if(command.searchPath)env.PATH=command.searchPath;
   }
   const cleanup=this.#runner({command:command.path,args:login?provider.login:provider.status,stdin:'',cwd:'/',env,signal,timeoutMs:login?180000:3000,maxOutputBytes:16384,onSpawned});
   // The tool wrapper rejects on abort before the runner finishes process cleanup.
   this.#cleanup.add(cleanup);void cleanup.then(()=>this.#cleanup.delete(cleanup),()=>this.#cleanup.delete(cleanup));return cleanup;
  },{readOnly:!login,signal:AbortSignal.any([this.#stop.signal,...(externalSignal?[externalSignal]:[])]),timeoutMs:login?180000:3000});this.#running.add(pending);void pending.then(()=>this.#running.delete(pending),()=>this.#running.delete(pending));return pending;
 }
 /** A line means a login read for this provider just finished in this core process with an outcome different from the last one written here (the first read after start always writes). No line does not mean no attempt was made: an unchanged outcome writes nothing, a login start refused on the executable lookup returns before this read, and server-start discovery warm-up reads no login status. */
 async #status(provider:typeof providers[number],signal?:AbortSignal):Promise<LoginStatus>{const status=await this.#readStatus(provider,signal);this.#noteOutcome(provider,status);return status;}
 /** One line per provider per outcome: a repeat is suppressed, the map is bounded by the fixed providers list, and a failing write is ignored. */
 #noteOutcome(provider:typeof providers[number],status:LoginStatus){
  const outcome=detectionOutcomeOf(status);
  if(this.#lastOutcome.get(provider.providerType)===outcome)return;
  this.#lastOutcome.set(provider.providerType,outcome);
  try{this.#write(JSON.stringify({cliDetection:{time:new Date().toISOString(),provider:provider.providerType,outcome}}));}catch{}
 }
 async #readStatus(provider:typeof providers[number],signal?:AbortSignal):Promise<LoginStatus>{
 try{
  const command=await this.#command(provider,signal);
  if(!command)return {providerType:provider.providerType,kind:'cli-login' as const,status:this.#options.discover?'absent' as const:'unknown' as const,state:this.#options.discover?'cli-not-found' as const:'unknown' as const};
  // Only discovery resolves a real executable; the injected-runner mode has no version to report. No path travels: it is the person's own file-system layout.
  const found=this.#options.discover?{version:command.version}:{};
  const result=await this.#call(provider,command,false,signal);
  // The activation gate and the stored lifecycle observation read status, so it keeps main's value (absent) when the status child never spawned; state carries the truth.
  if(!result.spawned)return {...this.#entry(provider,found),status:'absent' as const,state:'unreadable' as const,unreadableReason:'failed' as const};
  if(result.timedOut)return {...this.#entry(provider,found),status:'unknown' as const,state:'unreadable' as const,unreadableReason:'timed-out' as const};
  if(result.aborted||result.overflow)return {...this.#entry(provider,found),status:'unknown' as const,state:'unreadable' as const,unreadableReason:'failed' as const};
  if(provider.providerType==='claude-code-cli'){
   try{const value=JSON.parse(result.stdout) as {loggedIn?:unknown;authMethod?:unknown};
    if(value.loggedIn===false)return {...this.#entry(provider,found),status:'absent' as const,state:'logged-out' as const};
    if(result.exitCode===0&&value.loggedIn===true)return value.authMethod==='claude.ai'?{...this.#entry(provider,found),status:'detected' as const,state:'logged-in' as const}:{...this.#entry(provider,found),status:'absent' as const,state:'logged-out' as const};
   }catch{}
   return {...this.#entry(provider,found),status:'unknown' as const,state:'unreadable' as const,unreadableReason:'unrecognised-output' as const};
  }
  const text=result.stderr.trim()||result.stdout.trim();
  if(result.exitCode===0&&/^Logged in using ChatGPT\s*$/i.test(text))return {...this.#entry(provider,found),status:'detected' as const,state:'logged-in' as const};
  if(result.exitCode!==0&&/^Not logged in\s*$/i.test(text))return {...this.#entry(provider,found),status:'absent' as const,state:'logged-out' as const};
  return {...this.#entry(provider,found),status:'unknown' as const,state:'unreadable' as const,unreadableReason:'unrecognised-output' as const};
 }catch(error){
  // The wrapper's 3 s deadline rejects here before the runner's own timer can settle, so a real status timeout arrives as ToolCallError with timedOut set, not as a timed-out result above.
  const timedOut=error instanceof ToolCallError&&error.timedOut;
  return {providerType:provider.providerType,kind:'cli-login' as const,status:'unknown' as const,state:'unreadable' as const,unreadableReason:timedOut?'timed-out' as const:'failed' as const};
 }
 }
 #entry(provider:typeof providers[number],found:{version?:string}){return {providerType:provider.providerType,kind:'cli-login' as const,...found};}
 list():Promise<LoginStatus[]>{if(this.#reading)return this.#reading;return this.#reading=Promise.all(providers.map(provider=>this.#status(provider))).finally(()=>{this.#reading=undefined;});}
 recheck(providerType:string,signal?:AbortSignal){if(this.#stop.signal.aborted)throw new DomainError('Login host is draining','denied');const provider=providers.find(p=>p.providerType===providerType);if(!provider)throw new DomainError('Unknown login provider');if(this.#options.discover)void this.#options.rediscover?.(provider.providerType,signal).catch(()=>{});return this.#status(provider,signal);}
 beginDrain(){this.#stop.abort();}
 async drain(){this.beginDrain();await Promise.allSettled([...this.#running,...this.#cleanup]);}
 async start(input:unknown){
  const value=input as {providerType?:unknown;commandId?:unknown};if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==2||typeof value.commandId!=='string'||!/^[a-zA-Z0-9:_-]{1,128}$/.test(value.commandId))throw new DomainError('Exact login command fields required');
  const provider=providers.find(p=>p.providerType===value.providerType);if(!provider)throw new DomainError('Unknown login provider');
  const commandId=value.commandId;
  return await this.#lane(()=>this.#decide(provider,commandId));
 }
 /** ONE lane for the whole host: every deciding section runs one request at a time, so no await inside it can interleave a second start's checks with this one's reservation - not even for two different providers using the same command id. Another provider's status read holds the lane for up to 3 seconds; starting a login is a rare act of a person, so that is accepted. */
 #lane<T>(section:()=>Promise<T>):Promise<T>{
  const run=this.#laneTail.then(section,section); // a rejected lane never blocks the next request
  this.#laneTail=run.then(()=>undefined,()=>undefined);
  return run;
 }
 async #decide(provider:typeof providers[number],commandId:string):Promise<LoginStartRecord>{
  // The order below is load-bearing: a finished record first (it answers even while draining), then the drain check, the overlap and capacity checks, discovery, the state read, the reservation.
  const prior=this.#starts.get(commandId);if(prior){if(prior.providerType!==provider.providerType)throw new DomainError('Login command identity conflict','conflict');return {...prior};}
  if(this.#stop.signal.aborted)throw new DomainError('Login host is draining','denied');
  if(this.#starts.size>=64)throw new DomainError('Login command capacity reached');
  if([...this.#starts.values()].some(p=>p.providerType===provider.providerType&&p.status!=='settled'))throw new DomainError('Login already started or unresolved','conflict');
  const command=await this.#command(provider);
  // Once draining, every refusal in this section is draining, so same-id requests cannot be split across reasons.
  if(this.#stop.signal.aborted)throw new DomainError('Login host is draining','denied');
  if(!command)throw new DomainError('Subscription login executable is unavailable','denied');
  // A CLI that is already logged in gets no second login: the owner's act still turns the connection on.
  if((await this.#status(provider)).status==='detected'){const settled:LoginStartRecord={providerType:provider.providerType,status:'settled',outcome:'already-logged-in'};this.#starts.set(commandId,settled);return {...settled};}
  if(this.#stop.signal.aborted)throw new DomainError('Login host is draining','denied');
  const record:LoginStartRecord={providerType:provider.providerType,status:'started',outcome:'login-started'};this.#starts.set(commandId,record);
  // The login must really start: only the spawn acknowledgement is awaited inside the lane; the command's finish (up to 180s) stays outside.
  let failure:unknown;
  const started=await new Promise<boolean>(resolve=>{
   let decided=false;const done=(value:boolean)=>{if(!decided){decided=true;resolve(value);}};
   const outcome=this.#call(provider,command,true,undefined,()=>done(true));
   void outcome.then(result=>{done(result.spawned);record.status=result.spawned&&result.exitCode===0&&!result.timedOut&&!result.aborted&&!result.overflow?'settled':'unknown';},error=>{failure=error;done(false);record.status='unknown';});
  });
  if(started)return {...record};
  this.#starts.delete(commandId);
  if(this.#stop.signal.aborted)throw new DomainError('Login host is draining','denied');
  if(failure instanceof Error&&failure.message==='CLI executable changed after verification')throw new DomainError('Subscription login executable is unavailable','denied');
  throw new DomainError('Login command could not be started','denied');
 }
}
