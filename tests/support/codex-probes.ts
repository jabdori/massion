import type {CliInvocation,CliResult} from '../../src/cli-agent-providers.ts';

export function codexProbeResult({args}:Pick<CliInvocation,'args'>):CliResult|undefined {
 const stdout=args[0]==='--version'?'codex-cli 0.171.0\n':args.slice(-2).join(' ')==='features list'?'shell_tool  stable  false\ncode_mode  under development  false\nunified_exec  stable  true\n':undefined;
 if(stdout!==undefined)return {spawned:true,exitCode:0,stdout,stderr:'',timedOut:false,aborted:false,overflow:false};
}
