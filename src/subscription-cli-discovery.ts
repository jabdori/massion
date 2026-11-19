import {spawn} from 'node:child_process';
import {existsSync,statSync} from 'node:fs';
import {realpath} from 'node:fs/promises';
import {userInfo} from 'node:os';
import {isAbsolute,join} from 'node:path';
import {spawnCliRunner} from './cli-process.ts';
import type {CliRunner} from './cli-agent-providers.ts';
import {applyCliAccountEnvironment,cliAccountUsername,cliLauncherEnvironmentNames} from './cli-agent-providers.ts';
import {cliStamp,sameCliStamp} from './cli-launcher.ts';
import type {LauncherAdapters} from './cli-launcher.ts';

export type SubscriptionCliName='claude'|'codex';
/** A found CLI: the resolved absolute path, its file-identity stamp, the search path it runs with, and the exact --version line that passed validation. */
export interface DiscoveredSubscriptionCli {path:string;stamp:string;searchPath:string;version:string}
/** What one search ended with: the found CLI, null when absence is definitive, or 'timed-out' when a check ended by waiting and nothing was found. */
export type SubscriptionCliSearchResult=DiscoveredSubscriptionCli|'timed-out'|null;
export interface SubscriptionDiscoveryAdapters {
 home?:()=>string;
 fixedFolders?:(home:string)=>readonly string[];
 loginShell?:()=>string|undefined;
 runLoginShell?:(shell:string,timeoutMs:number,signal?:AbortSignal)=>Promise<string|null>;
 loginShellTimeoutMs?:number;
 versionRunner?:CliRunner;
 account?:()=>string;
 /** Passed to the launcher the host installs, so tests can inject a runner; production leaves it unset. */
 launcher?:LauncherAdapters;
 readEnvironment?:(name:string)=>string|undefined;
 fileExists?:(path:string)=>boolean;
}

// Claude Code prints "<semver> (Claude Code)": the provider-published cli.js registers exactly this version string
// (https://unpkg.com/@anthropic-ai/claude-code@1.0.88/cli.js, `-v, --version`); the optional pre-release part follows
// the version syntax the provider's own installer accepts (https://claude.ai/install.sh).
const CLAUDE_VERSION=/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)? \(Claude Code\)$/;
// Codex is a clap CLI whose package name is codex-cli, so --version renders "codex-cli <cargo version>"
// (https://github.com/openai/codex codex-rs/cli/src/main.rs #[clap(author, version)] with codex-rs/cli/Cargo.toml
// name = "codex-cli"; observed output "codex-cli 0.114.0" in https://github.com/openai/codex/issues/19110).
const CODEX_VERSION=/^codex-cli \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const SUBSCRIPTION_CLI_VERSION_PATTERNS:{[name in SubscriptionCliName]:RegExp}={'claude':CLAUDE_VERSION,'codex':CODEX_VERSION};
export const SUBSCRIPTION_CLI_FIXED_FOLDERS=(home:string):readonly string[]=>[join(home,'.local','bin'),'/opt/homebrew/bin','/usr/local/bin'];
export const SUBSCRIPTION_CLI_FALLBACK_DIRECTORIES=['/usr/bin','/bin'] as const;
const PATH_BEGIN='__MASSION_PATH_BEGIN__',PATH_END='__MASSION_PATH_END__',SHELL_PATH_COMMAND='printf \''+PATH_BEGIN+'%s'+PATH_END+'\' "$PATH"';

/** The login shell is used only to obtain PATH: login+interactive, prints it between fixed markers, does nothing else. */
export function spawnLoginShellPath(shell:string,timeoutMs:number,signal?:AbortSignal):Promise<string|null> {
 return new Promise(resolve=>{
  let child:ReturnType<typeof spawn>;try{child=spawn(shell,['-l','-i','-c',SHELL_PATH_COMMAND],{stdio:['ignore','pipe','pipe'],detached:true});}catch{resolve(null);return;}
  const out:Buffer[]=[];let bytes=0,settled=false;const signalGroup=(s:NodeJS.Signals)=>{if(child.pid!==undefined){try{process.kill(-child.pid,s);}catch{try{child.kill(s);}catch{}}}};
  const finish=()=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);resolve(Buffer.concat(out).toString('utf8'));};
  const onAbort=()=>{signalGroup('SIGKILL');finish();};
  const timer=setTimeout(()=>{signalGroup('SIGKILL');finish();},timeoutMs);
  signal?.addEventListener('abort',onAbort,{once:true});
  child.stdout?.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>65536){signalGroup('SIGKILL');finish();return;}out.push(chunk);});
  child.on('error',finish);child.on('close',finish);
 });
}

/** Markers survive login-shell noise before and after; entries are deduplicated in order. */
export function parseLoginShellPath(stdout:string):string[]|null {
 const begin=stdout.indexOf(PATH_BEGIN);if(begin<0)return null;
 const end=stdout.indexOf(PATH_END,begin+PATH_BEGIN.length);if(end<0)return null;
 const directories:string[]=[];for(const entry of stdout.slice(begin+PATH_BEGIN.length,end).split(':'))if(entry&&!directories.includes(entry))directories.push(entry);
 return directories;
}

/** The PATH handed to a subscription CLI: fixed folders, then the login shell's absolute directories, or the fallback. */
export function subscriptionCliSearchPath(fixed:readonly string[],shellDirectories:readonly string[]|null):string {
 const value=[...fixed];if(shellDirectories===null)value.push(...SUBSCRIPTION_CLI_FALLBACK_DIRECTORIES);
 else for(const directory of shellDirectories)if(isAbsolute(directory)&&!value.includes(directory))value.push(directory);
 return value.join(':');
}

const protocolOf=(name:SubscriptionCliName)=>name==='claude'?'claude-code-cli/v1':'codex-cli/v1' as const;
/** Only the names the launcher pins, with PATH replaced by the discovered search path; USER and LOGNAME come from the OS account lookup, and no other name is added. */
export function subscriptionCliVersionEnvironment(name:SubscriptionCliName,searchPath:string,readEnvironment:(n:string)=>string|undefined,account:()=>string=cliAccountUsername):Record<string,string> {
 const env:Record<string,string>={};for(const key of cliLauncherEnvironmentNames(protocolOf(name))){const value=readEnvironment(key);if(value!==undefined)env[key]=value;}
 applyCliAccountEnvironment(env,account);env.PATH=searchPath;return env;
}

async function probe(name:SubscriptionCliName,resolved:string,searchPath:string,adapters:Required<Pick<SubscriptionDiscoveryAdapters,'versionRunner'|'readEnvironment'|'account'>>,signal?:AbortSignal):Promise<SubscriptionCliSearchResult> {
 let file;try{file=statSync(resolved);}catch{return null;}
 // The candidate must itself be an executable regular file; shims qualify when they answer --version below.
 if(!file.isFile()||(file.mode&0o111)===0)return null;
 // Like verifySignedCli, the stamp is taken BEFORE the check; a file replaced during the run is another program.
 let stamp;try{stamp=cliStamp(resolved);}catch{return null;}
 const result=await adapters.versionRunner({command:resolved,args:['--version'],stdin:'',cwd:'/',env:subscriptionCliVersionEnvironment(name,searchPath,adapters.readEnvironment,adapters.account),timeoutMs:3000,maxOutputBytes:16384,signal:signal??new AbortController().signal});
 // A check that ended by waiting is not evidence of absence: 'timed-out' keeps it out of the absence cache and names the log line.
 if(result.timedOut||result.aborted)return 'timed-out';
 if(!result.spawned||result.exitCode!==0||result.overflow)return null;
  if(!SUBSCRIPTION_CLI_VERSION_PATTERNS[name].test(result.stdout.trim()))return null;
 if(!sameCliStamp(resolved,stamp))return null;
 return {path:resolved,stamp,searchPath,version:result.stdout.trim()};
}

/** Find one subscription CLI: configured absolute path only, or fixed folders then the login shell's PATH. */
export async function discoverSubscriptionCli(name:SubscriptionCliName,configuredPath:string|undefined,adapters:SubscriptionDiscoveryAdapters={},signal?:AbortSignal):Promise<SubscriptionCliSearchResult> {
 const home=adapters.home!==undefined?adapters.home():userInfo().homedir,fixed=adapters.fixedFolders?.(home)??SUBSCRIPTION_CLI_FIXED_FOLDERS(home);
 const exists=adapters.fileExists??existsSync,readEnvironment=adapters.readEnvironment??((n:string)=>process.env[n]),versionRunner=adapters.versionRunner??spawnCliRunner,account=adapters.account??cliAccountUsername;
 // An injected loginShell is final: undefined skips the shell step instead of falling back to the real one.
 const shell=adapters.loginShell!==undefined?adapters.loginShell():userInfo().shell;
 // The shell PATH is obtained once per discovery even when a fixed folder already has the CLI: its interpreter may live elsewhere.
 let shellDirectories:string[]|null=null;
 if(typeof shell==='string'&&isAbsolute(shell)){const stdout=await (adapters.runLoginShell??spawnLoginShellPath)(shell,adapters.loginShellTimeoutMs??5000,signal);shellDirectories=parseLoginShellPath(stdout??'')?.filter(isAbsolute)??null;if(!shellDirectories?.length)shellDirectories=null;}
 const searchPath=subscriptionCliSearchPath(fixed,shellDirectories);
  const seen=new Set<string>();let waited=false;
  const attempt=async(candidate:string):Promise<DiscoveredSubscriptionCli|null>=>{
   if(!exists(candidate)||!isAbsolute(candidate))return null;
   let resolved:string;try{resolved=await realpath(candidate);}catch{return null;}
   if(seen.has(resolved))return null; // a duplicate resolved path already failed or answered; drop duplicates by resolved path
   seen.add(resolved);
   const probed=await probe(name,resolved,searchPath,{versionRunner,readEnvironment,account},signal);
   if(probed==='timed-out'){waited=true;return null;} // the search still tries the next candidate, exactly as before
   return probed;
  };
 if(configuredPath!==undefined){const found=await attempt(configuredPath);return found??(waited?'timed-out':null);} // A configured path never falls back to discovery.
 for(const folder of fixed){const found=await attempt(join(folder,name));if(found)return found;}
 if(shellDirectories)for(const directory of shellDirectories){if(fixed.includes(directory))continue;const found=await attempt(join(directory,name));if(found)return found;}
 return waited?'timed-out':null;
}
