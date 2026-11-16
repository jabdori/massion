import {DomainError} from './domain.ts';
import {callTool} from './tool-call.ts';
import {spawnCliRunner} from './cli-process.ts';
import type {CliRunner,CliResult} from './cli-agent-providers.ts';
import {sameCliStamp} from './cli-launcher.ts';
import type {SignedCli} from './cli-launcher.ts';
import type {DiscoveredSubscriptionCli} from './subscription-cli-discovery.ts';

const providers=[{providerType:'claude-code-cli',command:'claude',status:['auth','status','--json'],login:['auth','login']},{providerType:'codex-cli',command:'codex',status:['login','status'],login:['login']}] as const;
export type LoginProviderType='claude-code-cli'|'codex-cli';
/** Every refusal of POST /connection-login, as a machine-readable reason next to its unchanged message and status. */
export const LOGIN_REFUSAL_REASONS={'Subscription login executable is unavailable':'cli-not-found','Login host is draining':'draining','Unknown login provider':'unknown-provider','Exact login command fields required':'invalid-fields','Login command identity conflict':'command-id-reused','Login command capacity reached':'capacity','Login already started or unresolved':'already-started'} as const;
export const loginRefusalReason=(error:DomainError):string|undefined=>(Object.entries(LOGIN_REFUSAL_REASONS) as [string,string][]).find(([message])=>message===error.message)?.[1];
const environment=/^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TERM|LANG|LC_[A-Z]+|TZ|XDG_(CONFIG|DATA|CACHE|STATE)_HOME|CODEX_HOME|CLAUDE_CONFIG_DIR|__CF_USER_TEXT_ENCODING)$/;
type LoginStatus={providerType:string;kind:'cli-login';status:'detected'|'absent'|'unknown'};
type LoginCommand=SignedCli&{searchPath?:string};
/** Only official CLI status/login commands; raw account information never leaves this adapter. */
export class LoginConnections {
 readonly #runner:CliRunner;readonly #injected:boolean;readonly #options:{discover?:(providerType:LoginProviderType,signal?:AbortSignal)=>Promise<DiscoveredSubscriptionCli|null>;rediscover?:(providerType:LoginProviderType,signal?:AbortSignal)=>Promise<DiscoveredSubscriptionCli|null>};readonly #starts=new Map<string,{providerType:string;status:'started'|'settled'|'unknown'}>();
 readonly #stop=new AbortController();readonly #running=new Set<Promise<CliResult>>();readonly #cleanup=new Set<Promise<CliResult>>();
 #reading:Promise<LoginStatus[]>|undefined;
 constructor(runner?:CliRunner,options:{discover?:(providerType:LoginProviderType,signal?:AbortSignal)=>Promise<DiscoveredSubscriptionCli|null>;rediscover?:(providerType:LoginProviderType,signal?:AbortSignal)=>Promise<DiscoveredSubscriptionCli|null>}={}){this.#runner=runner??spawnCliRunner;this.#injected=runner!==undefined;this.#options=options;}
 /** Discovery resolves the executable; a CLI that is not found yields no command and the login reads absent. Only the resolved path is executed. */
 async #command(provider:typeof providers[number],signal?:AbortSignal):Promise<LoginCommand|null>{
  if(this.#options.discover)try{return await this.#options.discover(provider.providerType,signal)??null;}catch{return null;}
  return this.#injected?{path:provider.command,stamp:''}:null;
 }
 #call(provider:typeof providers[number],signed:LoginCommand,login=false,externalSignal?:AbortSignal){const env:Record<string,string>={};for(const [key,value] of Object.entries(process.env))if(value!==undefined&&environment.test(key))env[key]=value;if(signed.searchPath)env.PATH=signed.searchPath;
  const pending=callTool(async signal=>{
   // The same TOCTOU re-check the model-call launcher does, immediately before exec; one rediscovery, then refuse.
   let command=signed;
   if(command.stamp&&!sameCliStamp(command.path,command.stamp)){
    const again=this.#options.discover?await (this.#options.rediscover??this.#options.discover)(provider.providerType,signal).catch(()=>null):null;
    if(!again||!sameCliStamp(again.path,again.stamp))throw new Error('CLI executable changed after verification');
    command={...again};if(command.searchPath)env.PATH=command.searchPath;
   }
   const cleanup=this.#runner({command:command.path,args:login?provider.login:provider.status,stdin:'',cwd:'/',env,signal,timeoutMs:login?180000:3000,maxOutputBytes:16384});
   // The tool wrapper rejects on abort before the runner finishes process cleanup.
   this.#cleanup.add(cleanup);void cleanup.then(()=>this.#cleanup.delete(cleanup),()=>this.#cleanup.delete(cleanup));return cleanup;
  },{readOnly:!login,signal:AbortSignal.any([this.#stop.signal,...(externalSignal?[externalSignal]:[])]),timeoutMs:login?180000:3000});this.#running.add(pending);void pending.then(()=>this.#running.delete(pending),()=>this.#running.delete(pending));return pending;
 }
 async #status(provider:typeof providers[number],signal?:AbortSignal):Promise<LoginStatus>{
  let status:LoginStatus['status']='unknown';
  try{const command=await this.#command(provider,signal);if(!command)return {providerType:provider.providerType,kind:'cli-login' as const,status:this.#options.discover?'absent':'unknown'};
   const result=await this.#call(provider,command,false,signal);if(!result.spawned)status='absent';else if(!result.timedOut&&!result.aborted&&!result.overflow){
   if(provider.providerType==='claude-code-cli'){try{const value=JSON.parse(result.stdout);if(value.loggedIn===false)status='absent';else if(result.exitCode===0&&value.loggedIn===true)status=value.authMethod==='claude.ai'?'detected':'absent';}catch{}}
   else if(result.exitCode===0&&/^Logged in using ChatGPT\s*$/i.test(result.stderr.trim()||result.stdout.trim()))status='detected';else if(result.exitCode!==0&&/^Not logged in\s*$/i.test(result.stderr.trim()||result.stdout.trim()))status='absent';
  }}catch{}return {providerType:provider.providerType,kind:'cli-login' as const,status};
 }
 list():Promise<LoginStatus[]>{if(this.#reading)return this.#reading;return this.#reading=Promise.all(providers.map(provider=>this.#status(provider))).finally(()=>{this.#reading=undefined;});}
 recheck(providerType:string,signal?:AbortSignal){if(this.#stop.signal.aborted)throw new DomainError('Login host is draining','denied');const provider=providers.find(p=>p.providerType===providerType);if(!provider)throw new DomainError('Unknown login provider');if(this.#options.discover)void this.#options.rediscover?.(provider.providerType,signal).catch(()=>{});return this.#status(provider,signal);}
 beginDrain(){this.#stop.abort();}
 async drain(){this.beginDrain();await Promise.allSettled([...this.#running,...this.#cleanup]);}
 async start(input:unknown){
  if(this.#stop.signal.aborted)throw new DomainError('Login host is draining','denied');
  const value=input as {providerType?:unknown;commandId?:unknown};if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==2||typeof value.commandId!=='string'||!/^[a-zA-Z0-9:_-]{1,128}$/.test(value.commandId))throw new DomainError('Exact login command fields required');
  const provider=providers.find(p=>p.providerType===value.providerType);if(!provider)throw new DomainError('Unknown login provider');
  const command=await this.#command(provider);if(!command)throw new DomainError('Subscription login executable is unavailable','denied');
  const prior=this.#starts.get(value.commandId);if(prior){if(prior.providerType!==provider.providerType)throw new DomainError('Login command identity conflict','conflict');return {...prior};}
  if(this.#starts.size>=64)throw new DomainError('Login command capacity reached');
  // Reserve before invoking: overlapping commands cannot open duplicate browser flows.
  if([...this.#starts.values()].some(p=>p.providerType===provider.providerType&&p.status!=='settled'))throw new DomainError('Login already started or unresolved','conflict');
  const record={providerType:provider.providerType,status:'started' as 'started'|'settled'|'unknown'};this.#starts.set(value.commandId,record);
  void Promise.resolve().then(()=>this.#call(provider,command,true)).then(result=>{record.status=result.spawned&&result.exitCode===0&&!result.timedOut&&!result.aborted&&!result.overflow?'settled':'unknown';},()=>{record.status='unknown';});
  return {...record};
 }
}
