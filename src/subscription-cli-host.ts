import {CliLauncher} from './cli-launcher.ts';
import type {LauncherPolicy} from './cli-launcher.ts';
import {cliArgPatterns,cliLauncherEnvironmentNames} from './cli-agent-providers.ts';
import type {CliProtocol} from './cli-agent-providers.ts';
import {discoverSubscriptionCli} from './subscription-cli-discovery.ts';
import type {DiscoveredSubscriptionCli,SubscriptionCliName,SubscriptionDiscoveryAdapters} from './subscription-cli-discovery.ts';
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

/** Discovery runs once per provider when first needed and is cached; recheck and a failed stamp re-check rediscover. */
export function subscriptionCliHost(readEnvironment:(name:string)=>string|undefined,secrets:SecretSlots,adapters:SubscriptionDiscoveryAdapters={}):{run:Partial<Record<CliProtocol,CliLauncher>>;discover:(provider:SubscriptionCliProvider,signal?:AbortSignal)=>Promise<DiscoveredSubscriptionCli|null>;rediscover:(provider:SubscriptionCliProvider,signal?:AbortSignal)=>Promise<DiscoveredSubscriptionCli|null>;searchPaths:Partial<Record<CliProtocol,()=>string|undefined>>;discoverOnRestore:(provider:SubscriptionCliProvider,signal:AbortSignal)=>Promise<void>} {
 const configured=subscriptionCliConfiguredPaths(readEnvironment),run:Partial<Record<CliProtocol,CliLauncher>>={},searchPaths:Partial<Record<CliProtocol,()=>string|undefined>>={},cache=new Map<SubscriptionCliProvider,Promise<DiscoveredSubscriptionCli|null>>(),resolved=new Map<SubscriptionCliProvider,DiscoveredSubscriptionCli>();
 // Concurrent refusals can start overlapping discoveries; only the LATEST one PER PROVIDER installs or touches the cache.
 const tickets=new Map<SubscriptionCliProvider,number>();
 const protocolOf=(provider:SubscriptionCliProvider):CliProtocol=>provider==='claude-code-cli'?'claude-code-cli/v1':'codex-cli/v1';
 const install=(provider:SubscriptionCliProvider,found:DiscoveredSubscriptionCli|null)=>{
  const protocol=protocolOf(provider);
  if(!found){delete run[protocol];return found;}
  // No signature: these CLIs are handed no secret; the discovery stamp is what the launcher re-checks before exec.
  const policy:LauncherPolicy={command:found.path,stamp:found.stamp,args:cliArgPatterns(protocol),environment:cliLauncherEnvironmentNames(protocol),secrets:{},readOnly:true};
  // The refused model call stays refused; the host discovers once more so the NEXT call uses the fresh launcher.
  const launcherAdapters:LauncherAdapters={...adapters.launcher,onStampRefused:()=>{void start(provider).catch(()=>{});}};
  run[protocol]=new CliLauncher(policy,secrets,launcherAdapters);return found;
 };
 const start=(provider:SubscriptionCliProvider,signal?:AbortSignal)=>{
  const ticket=(tickets.get(provider)??0)+1;tickets.set(provider,ticket);
  const promise=discoverSubscriptionCli(NAME[provider],configured[provider],adapters,signal).then(found=>{
   if(tickets.get(provider)===ticket){if(found)resolved.set(provider,found);else resolved.delete(provider);install(provider,found);}
   return found;
  },error=>{if(tickets.get(provider)===ticket)cache.delete(provider);throw error;});
  cache.set(provider,promise);return promise;
 };
 searchPaths['claude-code-cli/v1']=()=>resolved.get('claude-code-cli')?.searchPath;
 searchPaths['codex-cli/v1']=()=>resolved.get('codex-cli')?.searchPath;
 const discoverOnRestore=async(provider:SubscriptionCliProvider,signal:AbortSignal)=>{
  try{await start(provider,signal);}catch{
   // The first list reuses even a failed startup attempt. An explicit recheck can still rediscover.
   cache.set(provider,Promise.resolve(null));
  }
 };
 return {run,discover:(provider,signal)=>cache.get(provider)??start(provider,signal),rediscover:start,searchPaths,discoverOnRestore};
}
