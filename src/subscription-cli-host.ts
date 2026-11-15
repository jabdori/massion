import {CliLauncher} from './cli-launcher.ts';
import type {LauncherPolicy} from './cli-launcher.ts';
import {cliArgPatterns,CLI_ENVIRONMENT_NAMES} from './cli-agent-providers.ts';
import type {CliProtocol} from './cli-agent-providers.ts';
import type {SubscriptionLoginSelection} from './connection-logins.ts';
import {DomainError} from './domain.ts';
import type {SecretSlots} from './secret-slots.ts';

/** Host-selected executables for the two subscription CLIs; the packager sets these, nothing is resolved from PATH. */
export type SubscriptionCliProvider='claude-code-cli'|'codex-cli';
export type SubscriptionCliSelection=SubscriptionLoginSelection;
const CONFIG={'claude-code-cli':['MASSION_CLAUDE_CLI_COMMAND','MASSION_CLAUDE_CLI_TEAM_ID','MASSION_CLAUDE_CLI_IDENTIFIER'],'codex-cli':['MASSION_CODEX_CLI_COMMAND','MASSION_CODEX_CLI_TEAM_ID','MASSION_CODEX_CLI_IDENTIFIER']} as const;
function requireSelection(condition:unknown,message:string):asserts condition {if(!condition)throw new DomainError('Host configuration: '+message);}

/** Incomplete selections fail loudly; a partially configured host must not silently fall back to PATH names. */
export function subscriptionCliSelections(readEnvironment:(name:string)=>string|undefined):Partial<Record<SubscriptionCliProvider,SubscriptionCliSelection>> {
 const selections:Partial<Record<SubscriptionCliProvider,SubscriptionCliSelection>>={};
 for(const [provider,names] of Object.entries(CONFIG) as [SubscriptionCliProvider,typeof CONFIG['claude-code-cli']][]){
  const values=names.map(readEnvironment),present=values.filter(v=>v!==undefined).length;
  requireSelection(present===0||present===names.length,'incomplete subscription CLI selection for '+provider);
  if(present)selections[provider]={command:values[0]!,teamId:values[1]!,identifier:values[2]!};
 }
 return selections;
}

/** The production assembly: run launchers with the existing path/signature/isolation checks, and the same selection for login detection. */
export function subscriptionCliHost(readEnvironment:(name:string)=>string|undefined,secrets:SecretSlots):{run:Partial<Record<CliProtocol,CliLauncher>>;logins:Partial<Record<SubscriptionCliProvider,SubscriptionCliSelection>>} {
 const logins=subscriptionCliSelections(readEnvironment),run:Partial<Record<CliProtocol,CliLauncher>>={};
 for(const [provider,selection] of Object.entries(logins) as [SubscriptionCliProvider,SubscriptionCliSelection][]){
  const protocol=(provider==='claude-code-cli'?'claude-code-cli/v1':'codex-cli/v1') as CliProtocol;
  const policy:LauncherPolicy={command:selection.command,args:cliArgPatterns(protocol),environment:[...CLI_ENVIRONMENT_NAMES,...(provider==='claude-code-cli'?['CLAUDE_CODE_MAX_OUTPUT_TOKEN']:[])],secrets:{},readOnly:true,signature:{teamId:selection.teamId,identifier:selection.identifier}};
  run[protocol]=new CliLauncher(policy,secrets);
 }
 return {run,logins};
}

