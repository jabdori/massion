import {CliLauncher} from './cli-launcher.ts';
import type {LauncherPolicy} from './cli-launcher.ts';
import {cliArgPatterns,cliLauncherEnvironmentNames,CODEX_PROBE_ARGS} from './cli-agent-providers.ts';
import type {CliProtocol} from './cli-agent-providers.ts';
import {discoverSubscriptionCli,parseLoginShellPath,spawnLoginShellPath} from './subscription-cli-discovery.ts';
import type {DiscoveredSubscriptionCli,LoginShellPathResult,SubscriptionCliName,SubscriptionCliSearchResult,SubscriptionDiscoveryAdapters} from './subscription-cli-discovery.ts';
import type {SecretSlots} from './secret-slots.ts';
import type {LauncherAdapters} from './cli-launcher.ts';

/** The two subscription CLIs, found by discovery or by an explicit absolute path; the signing names are gone. */
export type SubscriptionCliProvider='claude-code-cli'|'codex-cli';
const CONFIG={'claude-code-cli':'MASSION_CLAUDE_CLI_COMMAND','codex-cli':'MASSION_CODEX_CLI_COMMAND'} as const;
const NAME={'claude-code-cli':'claude','codex-cli':'codex'} as const satisfies Record<SubscriptionCliProvider,SubscriptionCliName>;

/** Optional explicit absolute paths; the removed team/identifier names are ignored. */
export function subscriptionCliConfiguredPaths(readEnvironment:(name:string)=>string|undefined):Partial<Record<SubscriptionCliProvider,string>> {
 const paths:Partial<Record<SubscriptionCliProvider,string>>={};
 for(const [provider,name] of Object.entries(CONFIG) as [SubscriptionCliProvider,string][]) {const value=readEnvironment(name);if(value!==undefined)paths[provider]=value;}
 return paths;
}

/** Discovery runs once per provider when first needed and a definitive absence is cached; a search that ended by waiting is not, so the next list searches again; recheck and a failed stamp re-check rediscover, obtaining the login-shell PATH afresh while automatic searches reuse a PATH already obtained. */
export function subscriptionCliHost(readEnvironment:(name:string)=>string|undefined,secrets:SecretSlots,adapters:SubscriptionDiscoveryAdapters={}):{run:Partial<Record<CliProtocol,CliLauncher>>;discover:(provider:SubscriptionCliProvider,signal?:AbortSignal)=>Promise<SubscriptionCliSearchResult>;rediscover:(provider:SubscriptionCliProvider,signal?:AbortSignal)=>Promise<SubscriptionCliSearchResult>;searchPaths:Partial<Record<CliProtocol,()=>string|undefined>>} {
 const configured=subscriptionCliConfiguredPaths(readEnvironment),run:Partial<Record<CliProtocol,CliLauncher>>={},searchPaths:Partial<Record<CliProtocol,()=>string|undefined>>={},cache=new Map<SubscriptionCliProvider,Promise<SubscriptionCliSearchResult>>(),resolved=new Map<SubscriptionCliProvider,DiscoveredSubscriptionCli>();
 // Concurrent refusals can start overlapping discoveries; only the LATEST one PER PROVIDER installs or touches the cache.
 const tickets=new Map<SubscriptionCliProvider,number>();
 const protocolOf=(provider:SubscriptionCliProvider):CliProtocol=>provider==='claude-code-cli'?'claude-code-cli/v1':'codex-cli/v1';
 const install=(provider:SubscriptionCliProvider,found:DiscoveredSubscriptionCli|null)=>{
  const protocol=protocolOf(provider);
  if(!found){delete run[protocol];return found;}
  // No signature: these CLIs are handed no secret; the discovery stamp is what the launcher re-checks before exec.
  const policy:LauncherPolicy={command:found.path,stamp:found.stamp,args:cliArgPatterns(protocol),...(protocol==='codex-cli/v1'?{probes:CODEX_PROBE_ARGS}:{}),environment:cliLauncherEnvironmentNames(protocol),secrets:{},readOnly:true};
  // The refused model call stays refused; the host discovers once more so the NEXT call uses the fresh launcher.
  const launcherAdapters:LauncherAdapters={...adapters.launcher,onStampRefused:()=>{void start(provider,undefined,true).catch(()=>{});}};
  run[protocol]=new CliLauncher(policy,secrets,launcherAdapters);return found;
 };
 // A repeated AUTOMATIC search must not pay the login-shell PATH step again: once a shell printed a usable PATH, every later automatic search reuses it, and the two providers of one list share the one in-flight obtain. An explicit search again (recheck, the turn-on gate, a refused stamp) obtains the PATH afresh, as on main.
 const runLoginShell=adapters.runLoginShell??spawnLoginShellPath,shellPaths=new Map<string,Promise<LoginShellPathResult>>();
 const searchAdapters=(obtainPathAfresh:boolean):SubscriptionDiscoveryAdapters=>({...adapters,runLoginShell:(shell:string,timeoutMs:number,signal?:AbortSignal)=>{
  if(obtainPathAfresh)shellPaths.delete(shell);
  const cached=shellPaths.get(shell);if(cached!==undefined)return cached;
  // The first list starts both providers' searches together: the in-flight obtain is shared so the shell runs once, and only a shell that printed a usable PATH is kept.
  const obtaining=runLoginShell(shell,timeoutMs,signal).then(step=>{if(step.stdout===null||!parseLoginShellPath(step.stdout)?.length)shellPaths.delete(shell);return step;},error=>{shellPaths.delete(shell);throw error;});
  shellPaths.set(shell,obtaining);return obtaining;
 }});
 const start=(provider:SubscriptionCliProvider,signal?:AbortSignal,obtainPathAfresh=false)=>{
  const ticket=(tickets.get(provider)??0)+1;tickets.set(provider,ticket);
  const promise=discoverSubscriptionCli(NAME[provider],configured[provider],searchAdapters(obtainPathAfresh),signal).then(found=>{
   if(tickets.get(provider)===ticket){
    if(found&&found!=='timed-out'){resolved.set(provider,found);install(provider,found);}
    else{resolved.delete(provider);install(provider,null);}
    // A search that ended by waiting is not absence: the cache entry leaves with it so the next list searches again.
    if(found==='timed-out')cache.delete(provider);
   }
   return found;
  },error=>{if(tickets.get(provider)===ticket)cache.delete(provider);throw error;});
  cache.set(provider,promise);return promise;
 };
 searchPaths['claude-code-cli/v1']=()=>resolved.get('claude-code-cli')?.searchPath;
 searchPaths['codex-cli/v1']=()=>resolved.get('codex-cli')?.searchPath;
 return {run,discover:(provider,signal)=>cache.get(provider)??start(provider,signal),rediscover:(provider,signal)=>start(provider,signal,true),searchPaths};
}
