import {DomainError} from './domain.ts';
import {spawnCliRunner} from './cli-process.ts';
import type {CliRunner,CliResult} from './cli-agent-providers.ts';

const providers=[{providerType:'claude-code-cli',command:'claude',status:['auth','status','--json'],login:['auth','login']},{providerType:'codex-cli',command:'codex',status:['login','status'],login:['login']}] as const;
const environment=/^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TERM|LANG|LC_[A-Z]+|TZ|XDG_(CONFIG|DATA|CACHE|STATE)_HOME|CODEX_HOME|CLAUDE_CONFIG_DIR|__CF_USER_TEXT_ENCODING)$/;
type LoginStatus={providerType:string;kind:'cli-login';status:'detected'|'absent'|'unknown'};
/** Only official CLI status/login commands; raw account information never leaves this adapter. */
export class LoginConnections {
 readonly #runner:CliRunner;readonly #starts=new Map<string,{providerType:string;status:'started'|'settled'|'unknown'}>();
 readonly #stop=new AbortController();readonly #running=new Set<Promise<CliResult>>();
 #reading:Promise<LoginStatus[]>|undefined;
 constructor(runner:CliRunner=spawnCliRunner){this.#runner=runner;}
 #call(provider:typeof providers[number],login=false){const env:Record<string,string>={};for(const [key,value] of Object.entries(process.env))if(value!==undefined&&environment.test(key))env[key]=value;
  const pending=this.#runner({command:provider.command,args:login?provider.login:provider.status,stdin:'',cwd:'/',env,signal:AbortSignal.any([this.#stop.signal,AbortSignal.timeout(login?180000:3000)]),timeoutMs:login?180000:3000,maxOutputBytes:16384});this.#running.add(pending);void pending.then(()=>this.#running.delete(pending),()=>this.#running.delete(pending));return pending;
 }
 list():Promise<LoginStatus[]>{if(this.#reading)return this.#reading;return this.#reading=Promise.all(providers.map(async provider=>{
  let status:LoginStatus['status']='unknown';
  try{const result=await this.#call(provider);if(!result.spawned)status='absent';else if(!result.timedOut&&!result.aborted&&!result.overflow){
   if(provider.providerType==='claude-code-cli'){try{const value=JSON.parse(result.stdout);if(value.loggedIn===false)status='absent';else if(result.exitCode===0&&value.loggedIn===true)status=value.authMethod==='claude.ai'?'detected':'absent';}catch{}}
   else if(result.exitCode===0&&/^Logged in using ChatGPT\s*$/i.test(result.stderr.trim()||result.stdout.trim()))status='detected';else if(result.exitCode!==0&&/^Not logged in\s*$/i.test(result.stderr.trim()||result.stdout.trim()))status='absent';
  }}catch{}return {providerType:provider.providerType,kind:'cli-login' as const,status};
 })).finally(()=>{this.#reading=undefined;});}
 beginDrain(){this.#stop.abort();}
 async drain(){this.beginDrain();await Promise.allSettled([...this.#running]);}
 async start(input:unknown){
  if(this.#stop.signal.aborted)throw new DomainError('Login host is draining','denied');
  const value=input as {providerType?:unknown;commandId?:unknown};if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==2||typeof value.commandId!=='string'||!/^[a-zA-Z0-9:_-]{1,128}$/.test(value.commandId))throw new DomainError('Exact login command fields required');
  const provider=providers.find(p=>p.providerType===value.providerType);if(!provider)throw new DomainError('Unknown login provider');
  const prior=this.#starts.get(value.commandId);if(prior){if(prior.providerType!==provider.providerType)throw new DomainError('Login command identity conflict','conflict');return {...prior};}
  if(this.#starts.size>=64)throw new DomainError('Login command capacity reached');
  // Reserve before invoking: overlapping commands cannot open duplicate browser flows.
  if([...this.#starts.values()].some(p=>p.providerType===provider.providerType&&p.status!=='settled'))throw new DomainError('Login already started or unresolved','conflict');
  const record={providerType:provider.providerType,status:'started' as 'started'|'settled'|'unknown'};this.#starts.set(value.commandId,record);
  void Promise.resolve().then(()=>this.#call(provider,true)).then(result=>{record.status=result.spawned&&result.exitCode===0&&!result.timedOut&&!result.aborted&&!result.overflow?'settled':'unknown';},()=>{record.status='unknown';});
  return {...record};
 }
}
