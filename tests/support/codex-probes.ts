import type {CliInvocation,CliResult} from '../../src/cli-agent-providers.ts';
import {readFileSync} from 'node:fs';

// Codex rust-v0.171.0 FEATURES and stage_str, with the macOS defaults and Massion's overrides.
export const codexFeatureListing=readFileSync(new URL('./codex-0.171.0-features.txt',import.meta.url),'utf8');
export const codexMcpServerListing=JSON.stringify([{
 name:'managed',enabled:false,disabled_reason:null,
 transport:{type:'stdio',command:'stand-in',args:[],env:null,env_vars:[],cwd:null},
 startup_timeout_sec:null,tool_timeout_sec:null,auth_status:'unsupported',
}]);

export function codexProbeResult({args}:Pick<CliInvocation,'args'>):CliResult|undefined {
 const stdout=args[0]==='--version'?'codex-cli 0.171.0\n':args.slice(-2).join(' ')==='features list'?codexFeatureListing:args.slice(-3).join(' ')==='mcp list --json'?'[]\n':undefined;
 if(stdout!==undefined)return {spawned:true,exitCode:0,stdout,stderr:'',timedOut:false,aborted:false,overflow:false};
}
