import {DomainError} from './domain.ts';
import {callTool} from './tool-call.ts';
import {spawnCliRunner} from './cli-process.ts';
import type {CliRunner,CliResult} from './cli-agent-providers.ts';
import {verifySignedCli} from './cli-launcher.ts';

const providers=[{providerType:'claude-code-cli',command:'claude',status:['auth','status','--json'],login:['auth','login']},{providerType:'codex-cli',command:'codex',status:['login','status'],login:['login']}] as const;
export type LoginProviderType='claude-code-cli'|'codex-cli';
/** A host-selected subscription executable: absolute path plus the signing identity the launcher also checks. */
export interface SubscriptionLoginSelection {command:string;teamId:string;identifier:string}
const environment=/^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TERM|LANG|LC_[A-Z]+|TZ|XDG_(CONFIG|DATA|CACHE|STATE)_HOME|CODEX_HOME|CLAUDE_CONFIG_DIR|__CF_USER_TEXT_ENCODING)$/;
type LoginStatus={providerType:string;kind:'cli-login';status:'detected'|'absent'|'unknown'};
/** Only official CLI status/login commands; raw account information never leaves this adapter. */
export class LoginConnections {
 readonly #runner:CliRunner;readonly #injected:boolean;readonly #options:{subscriptions?:Partial<Record<LoginProviderType,SubscriptionLoginSelection>>;verify?:(command:string,signature:{teamId:string;identifier:string},signal?:AbortSignal)=>Promise<string>};readonly #starts=new Map<string,{providerType:string;status:'started'|'settled'|'unknown'}>();
 readonly #stop=new AbortController();readonly #running=new Set<Promise<CliResult>>();readonly #cleanup=new Set<Promise<CliResult>>();
 #reading:Promise<LoginStatus[]>|undefined;
 constructor(runner?:CliRunner,options:{subscriptions?:Partial<Record<LoginProviderType,SubscriptionLoginSelection>>;verify?:(command:string,signature:{teamId:string;identifier:string},signal?:AbortSignal)=>Promise<string>}={}){this.#runner=runner??spawnCliRunner;this.#injected=runner!==undefined;this.#options=options;}
 /** A configured selection resolves only through the same signature check the launcher uses; the host default never falls back to a PATH name. */
 async #command(provider:typeof providers[number],signal?:AbortSignal):Promise<string|null>{
  const selection=this.#options.subscriptions?.[provider.providerType];
  if(selection)try{return await (this.#options.verify??verifySignedCli)(selection.command,{teamId:selection.teamId,identifier:selection.identifier},signal);}catch{return null;}
  return this.#injected?provider.command:null;
 }
 #call(provider:typeof providers[number],command:string,login=false,externalSignal?:AbortSignal){const env:Record<string,string>={};for(const [key,value] of Object.entries(process.env))if(value!==undefined&&environment.test(key))env[key]=value;
  const pending=callTool(signal=>{
   const cleanup=this.#runner({command,args:login?provider.login:provider.status,stdin:'',cwd:'/',env,signal,timeoutMs:login?180000:3000,maxOutputBytes:16384});
   // The tool wrapper rejects on abort before the runner finishes process cleanup.
   this.#cleanup.add(cleanup);void cleanup.then(()=>this.#cleanup.delete(cleanup),()=>this.#cleanup.delete(cleanup));return cleanup;
  },{readOnly:!login,signal:AbortSignal.any([this.#stop.signal,...(externalSignal?[externalSignal]:[])]),timeoutMs:login?180000:3000});this.#running.add(pending);void pending.then(()=>this.#running.delete(pending),()=>this.#running.delete(pending));return pending;
 }
 async #status(provider:typeof providers[number],signal?:AbortSignal):Promise<LoginStatus>{
  let status:LoginStatus['status']='unknown';
  try{const command=await this.#command(provider,signal);if(!command)return {providerType:provider.providerType,kind:'cli-login' as const,status:'unknown'};
   const result=await this.#call(provider,command,false,signal);if(!result.spawned)status='absent';else if(!result.timedOut&&!result.aborted&&!result.overflow){
   if(provider.providerType==='claude-code-cli'){try{const value=JSON.parse(result.stdout);if(value.loggedIn===false)status='absent';else if(result.exitCode===0&&value.loggedIn===true)status=value.authMethod==='claude.ai'?'detected':'absent';}catch{}}
   else if(result.exitCode===0&&/^Logged in using ChatGPT\s*$/i.test(result.stderr.trim()||result.stdout.trim()))status='detected';else if(result.exitCode!==0&&/^Not logged in\s*$/i.test(result.stderr.trim()||result.stdout.trim()))status='absent';
  }}catch{}return {providerType:provider.providerType,kind:'cli-login' as const,status};
 }
 list():Promise<LoginStatus[]>{if(this.#reading)return this.#reading;return this.#reading=Promise.all(providers.map(provider=>this.#status(provider))).finally(()=>{this.#reading=undefined;});}
 recheck(providerType:string,signal?:AbortSignal){if(this.#stop.signal.aborted)throw new DomainError('Login host is draining','denied');const provider=providers.find(p=>p.providerType===providerType);if(!provider)throw new DomainError('Unknown login provider');return this.#status(provider,signal);}
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
