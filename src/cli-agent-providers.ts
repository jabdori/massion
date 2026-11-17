import {providerRequestHash} from './provider-dispatch.ts';
/** Subscription CLIs (Claude Code, Codex) as bounded single-shot text providers. No tools, sessions or retries. */
export {spawnCliRunner} from './cli-process.ts';
import type {CliLauncher} from './cli-launcher.ts';
import {callTool,ToolCallError,TOOL_TIMEOUT_MS} from './tool-call.ts';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ProviderAdapter,ProviderDescriptor,ProviderOutcome,ProviderRequest} from './providers.ts';
import {CODEX_USAGE_LIMIT_REASON} from './providers.ts';
import type {ConnectionDiagnostic,ModelAdapterFactory,ModelConnectionProfile} from './provider-profiles.ts';

export type CliProtocol='claude-code-cli/v1'|'codex-cli/v1';
export interface CliInvocation {command:string;args:readonly string[];stdin:string;cwd:string;env:Readonly<Record<string,string>>;timeoutMs:number;maxOutputBytes:number;signal:AbortSignal;invocationId?:string;onSpawned?:()=>void}
/** `spawned:false` means the process never started, so no remote request can have been made. */
export interface CliResult {spawned:boolean;exitCode:number|null;stdout:string;stderr:string;timedOut:boolean;aborted:boolean;overflow:boolean}
export type CliRunner=(invocation:CliInvocation)=>Promise<CliResult>;
export interface CliEvidence {executionEvidence:'subscription-cli'|'local-cli-fixture';modelIdentity:'reported'|'requested';realProviderVerified:false}

const SYSTEM_PROMPT='You produce bounded plain-text answers for an independent review workflow. Follow the user instruction exactly. Do not use tools.';
const label=(v:unknown)=>typeof v==='string'&&v.length>0&&v.length<=512&&v.trim()===v&&!/[\u0000-\u001f\u007f]/.test(v);
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const unknownUsage={inputTokens:null,outputTokens:null};
/** Fixed names a launcher policy can pin; locale classes stay unset rather than widened. */
/** The extra name the claude adapter sets; the launcher allow-list and the adapter share this one constant. */
export const CLAUDE_CODE_MAX_OUTPUT_TOKEN_ENV='CLAUDE_CODE_MAX_OUTPUT_TOKENS';
export const CLI_ENVIRONMENT_LC_PATTERN=/^LC_[A-Z]+$/;
export const CLI_ENVIRONMENT_NAMES=['PATH','HOME','USER','LOGNAME','SHELL','TMPDIR','TERM','LANG','TZ','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','CODEX_HOME','CLAUDE_CONFIG_DIR','__CF_USER_TEXT_ENCODING'] as const;
/** Locale classes carry no credential; every subscription-CLI child (status, login, model call) takes them through this one allow-list. */
export const CLI_ENVIRONMENT_CLASS_NAME='LC_*';
export const cliEnvironmentAllowed=(name:string):boolean=>(CLI_ENVIRONMENT_NAMES as readonly string[]).includes(name)||CLI_ENVIRONMENT_LC_PATTERN.test(name);
/** A launcher policy pins exact names plus the one locale class the launcher expands at launch. */
export function cliLauncherEnvironmentNames(protocol:CliProtocol):string[] {return [...CLI_ENVIRONMENT_NAMES,CLI_ENVIRONMENT_CLASS_NAME,...(protocol==='claude-code-cli/v1'?[CLAUDE_CODE_MAX_OUTPUT_TOKEN_ENV]:[])];}

/** Launcher argument patterns for one protocol: fixed args exact, the one variable position an exact model id. */
export function cliArgPatterns(protocol:CliProtocol):readonly (string|RegExp)[] {
 const variable='#massion-model#',args=(protocol==='claude-code-cli/v1'?claudeArgs:codexArgs)(variable);return args.map(arg=>arg===variable?/^[a-zA-Z0-9._:/-]{1,128}$/:arg);
}
function claudeArgs(model:string){return ['-p','--output-format','json','--model',model,'--tools','','--no-session-persistence','--max-turns','1','--effort','low','--setting-sources','','--strict-mcp-config','--disable-slash-commands','--system-prompt',SYSTEM_PROMPT];}
// Codex has no tool-free mode; one fixed override list keeps a codex exec turn text-only (issue #209).
// Sources (Codex rust-v0.167.1, commit 0a94398, read 2026-11-17): Codex's own tool-less thread
// (codex-rs/tui/src/temporary_structured_request.rs:46-99), OpenMausBot's text-only Codex path
// (src/server/drivers/codex-background-text.ts:89-95, feature names only), and the collaboration
// switch agents.enabled + features.multi_agent_v2 (codex-rs/core/src/config/mod.rs:1687-1714).
// Deliberately absent: features.unified_exec (managed_features.rs:176-184 re-enables it unless a
// managed requirement pins it) and features.unified_exec_tty (with features.shell_tool=false,
// core/src/tools/spec_plan.rs:1248-1251 registers no exec tool for it to configure).
const CODEX_TEXT_ONLY_OVERRIDES=['agents.enabled=false','cloud.skills.enabled=false','features.apps=false','features.browser_use=false','features.browser_use_external=false','features.code_mode=false','features.code_mode_host=false','features.code_mode_only=false','features.computer_use=false','features.context_management=false','features.current_time_reminder=false','features.daemon_auto_start=false','features.deferred_executor=false','features.goals=false','features.hooks=false','features.image_generation=false','features.in_app_browser=false','features.memories=false','features.multi_agent=false','features.multi_agent_v2=false','features.plugins=false','features.remote_plugin=false','features.request_permissions_tool=false','features.shell_snapshot=false','features.shell_tool=false','features.skill_mcp_dependency_install=false','features.skill_search=false','features.sleep_tool=false','features.standalone_web_search=false','features.token_budget=false','features.tool_suggest=false','features.view_image=false','skills.include_instructions=false','tools.experimental_request_user_input.enabled=false','tools.update_plan.enabled=false','web_search="disabled"'] as const;
export function codexArgs(model:string){return ['exec','--json','--skip-git-repo-check','--sandbox','read-only','--ephemeral','--ignore-user-config','--ignore-rules','-m',model,'-c','model_reasoning_effort="low"','-c',`instructions=${JSON.stringify(SYSTEM_PROMPT)}`,...CODEX_TEXT_ONLY_OVERRIDES.flatMap(k=>['-c',k]),'-'];}

// Codex rust-v0.167.1 (0a94398), protocol/src/error.rs:849-889.
// An unrelated error with the same full shape, regardless of its date, also yields unknown with the usage-limit reason.
const RETRY_SUFFIX=/ (?:later|at (?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?:1st|21st|31st|2nd|22nd|3rd|23rd|[4-9]th|1[0-9]th|20th|2[4-9]th|30th), (?:[0-9]{4}|-[0-9]{4,6}|\+[1-9][0-9]{4,5}) )?(?:[1-9]|1[0-2]):[0-5][0-9] (?:AM|PM))\.$/.source;
const RETRY_AFTER_OR=' or try again'+RETRY_SUFFIX;
// Name and promotion values come from trimmed, nonempty HTTP header strings (codex-api/src/rate_limits.rs:84-88,181-185,255-257).
const HEADER_TEXT=/[!-~](?:[\t -~]*[!-~])?/.source;
const CODEX_USAGE_LIMIT_MESSAGE_PATTERNS=[
 // codex-rs/protocol/src/error.rs:755-756 (named limit).
 new RegExp(/^You’ve hit your usage limit for /.source+'(?<limitName>'+HEADER_TEXT+')'+/\. Switch to another model now,/.source+RETRY_AFTER_OR),
 // codex-rs/protocol/src/error.rs:765.
 /^Your workspace is out of credits\. Add credits to continue\.$/,
 // codex-rs/protocol/src/error.rs:771.
 /^Your workspace is out of credits\. Ask your workspace owner to refill in order to continue\.$/,
 // codex-rs/protocol/src/error.rs:777.
 /^You hit your spend cap set in your workspace\. Increase your spend cap to continue\.$/,
 // codex-rs/protocol/src/error.rs:783.
 /^You hit your spend cap set by the owner of your workspace\. Ask an owner to increase your spend cap to continue\.$/,
 // codex-rs/protocol/src/error.rs:795-796 (promotion), also the byte-identical Free/Go shape at 823-824.
 new RegExp(/^You’ve hit your usage limit\. /.source+HEADER_TEXT+','+RETRY_AFTER_OR),
 // codex-rs/protocol/src/error.rs:802-803 (Plus).
 new RegExp(/^You’ve hit your usage limit\. Upgrade to Pro \(https:\/\/chatgpt\.com\/explore\/pro\), visit https:\/\/chatgpt\.com\/settings\/usage to purchase more credits/.source+RETRY_AFTER_OR),
 // codex-rs/protocol/src/error.rs:817-818 (workspace admin request).
 new RegExp(/^You’ve hit your usage limit\. To get more access now, send a request to your admin/.source+RETRY_AFTER_OR),
 // codex-rs/protocol/src/error.rs:829-830 (Pro variants).
 new RegExp(/^You’ve hit your usage limit\. Visit https:\/\/chatgpt\.com\/settings\/usage to purchase more credits/.source+RETRY_AFTER_OR),
 // codex-rs/protocol/src/error.rs:836-841 (plain).
 new RegExp(/^You’ve hit your usage limit\. Try again/.source+RETRY_SUFFIX),
];
// codex-rs/core/src/session/turn.rs:248-254, compact_remote_v2.rs:269-273, protocol/src/error.rs:552-561.
const REMOTE_COMPACT_PREFIX='Error running remote compact task: ';

function readCodexEvents(stdout:string){
 const events:any[]=[];
 for(const line of stdout.split('\n')){
  if(!line.trim())continue;
  try{events.push(JSON.parse(line));}catch{return {status:'malformed'} as const;}
 }
 return {status:'parsed',events} as const;
}

type CodexUsageLimitDecision={status:'unmatched'}|
 (ProviderOutcome&{status:'unknown';reason:typeof CODEX_USAGE_LIMIT_REASON;errorItems:number});
function codexUsageLimitResult(events:readonly any[]):CodexUsageLimitDecision{
 const failure=events.findIndex(event=>event?.type==='turn.failed');
 if(failure===-1||failure!==events.length-1)return {status:'unmatched'};
 const raw:unknown=events[failure].error?.message;
 if(typeof raw!=='string')return {status:'unmatched'};
 const message=raw.startsWith(REMOTE_COMPACT_PREFIX)?raw.slice(REMOTE_COMPACT_PREFIX.length):raw;
 for(const pattern of CODEX_USAGE_LIMIT_MESSAGE_PATTERNS){
  const match=pattern.exec(message);
  if(!match)continue;
  const name=match.groups?.limitName?.toLowerCase();
  if(name==='codex'||name==='gpt-reserve')continue; // error.rs:750-751 sends these names to the plan branches.
  const errorItems=events.filter(event=>event?.type==='item.completed'&&event.item?.type==='error').length;
  return {status:'unknown',output:null,usage:unknownUsage,reason:CODEX_USAGE_LIMIT_REASON,errorItems};
 }
 return {status:'unmatched'};
}

/** Claude Code JSON result: one success result, exactly the pinned model, measured usage. */
// The single JSON result has no documented subscription-limit discriminator. HTTP 429 alone can be an API rate limit.
// See Claude Agent SDK SDKResultMessage and the separate SDKRateLimitEvent stream type.
export function parseClaudeResult(stdout:string,model:string,cap:number):ProviderOutcome{
 let body:any;try{body=JSON.parse(stdout);}catch{return {status:'unknown',output:null,usage:unknownUsage,reason:'cli_invalid_json_remote_outcome_unknown'};}
 const models=body&&typeof body.modelUsage==='object'&&body.modelUsage?Object.keys(body.modelUsage):[];
 const u=body?.usage;
 if(!body||body.type!=='result'||!u||![u.input_tokens,u.output_tokens,u.cache_creation_input_tokens??0,u.cache_read_input_tokens??0].every(integer))return {status:'unknown',output:null,usage:unknownUsage,reason:'cli_invalid_result_schema'};
 const usage={inputTokens:u.input_tokens+(u.cache_creation_input_tokens??0)+(u.cache_read_input_tokens??0),outputTokens:u.output_tokens};
 if(models.length!==1||models[0]!==model)return {status:'unknown',output:null,usage,reason:'cli_model_identity_mismatch'};
 if(usage.outputTokens>cap)return {status:'unknown',output:null,usage:unknownUsage,reason:'invalid_or_unbounded_usage'};
 if(body.subtype!=='success'||body.is_error!==false)return {status:'failed',output:null,usage,reason:'cli_reported_error'};
 if(body.num_turns!==1)return {status:'failed',output:null,usage,reason:'unsupported_tool_output'};
 if(typeof body.result!=='string'||!body.result.trim()||!body.result.isWellFormed())return {status:'failed',output:null,usage,reason:'empty_output'};
 return {status:'completed',output:body.result,usage,reason:'bounded_text_completion'};
}

/** Codex JSONL: exactly one agent message, no tool items, one completed turn with measured usage. */
// Item kinds of codex exec --json at rust-v0.167.1 (codex-rs/exec/src/exec_events.rs:107-133):
// agent_message, reasoning, command_execution, file_change, mcp_tool_call, collab_tool_call,
// web_search, todo_list, error. Only agent_message, reasoning and error may appear in any item
// event; any other kind — known or not — fails the run, so a new kind is refused by default.
// An error ITEM is a non-fatal warning (exec_events.rs:131-132): config warnings and deprecation
// notices arrive as completed error items while the turn keeps running
// (event_processor_with_jsonl_output.rs:411-475). Error items add to errorItems only.
export function parseCodexEvents(stdout:string,cap:number):ProviderOutcome&{errorItems:number}{
 const stream=readCodexEvents(stdout);
 if(stream.status==='malformed')return {status:'unknown',output:null,usage:unknownUsage,reason:'cli_invalid_json_remote_outcome_unknown',errorItems:0};
 const {events}=stream,limit=codexUsageLimitResult(events);
 if(limit.status!=='unmatched')return limit;
 const turns=events.filter(e=>e?.type==='turn.completed'),failed=events.some(e=>e?.type==='turn.failed');
 const itemEvents=events.filter(e=>e?.type==='item.started'||e?.type==='item.updated'||e?.type==='item.completed'),items=itemEvents.map(e=>e.item);
 const completedItems=itemEvents.filter(e=>e?.type==='item.completed').map(e=>e.item);
 const errorItems=completedItems.filter(i=>i?.type==='error').length;
 // A top-level error event (stream reconnects) means an extra or partial upstream request; error items do not.
 const messages=completedItems.filter(i=>i?.type==='agent_message'),tools=items.filter(i=>i&&!['agent_message','reasoning','error'].includes(i.type));
 if(events.some(e=>e?.type==='error'))return {status:'unknown',output:null,usage:unknownUsage,reason:'cli_error_event_remote_outcome_unknown',errorItems};
 if(failed||turns.length!==1)return {status:'unknown',output:null,usage:unknownUsage,reason:'cli_turn_not_completed_remote_outcome_unknown',errorItems};
 const u=turns[0].usage;
 if(!u||![u.input_tokens,u.output_tokens].every(integer))return {status:'unknown',output:null,usage:unknownUsage,reason:'cli_invalid_result_schema',errorItems};
 const usage={inputTokens:u.input_tokens,outputTokens:u.output_tokens};
 if(usage.outputTokens>cap)return {status:'unknown',output:null,usage:unknownUsage,reason:'invalid_or_unbounded_usage',errorItems};
 if(tools.length)return {status:'failed',output:null,usage,reason:'unsupported_tool_output',errorItems};
 if(messages.length>1)return {status:'failed',output:null,usage,reason:'unsupported_tool_output',errorItems};
 if(messages.length!==1||typeof messages[0].text!=='string'||!messages[0].text.trim()||!messages[0].text.isWellFormed())return {status:'failed',output:null,usage,reason:'empty_output',errorItems};
 return {status:'completed',output:messages[0].text,usage,reason:'bounded_text_completion',errorItems};
}

class CliTextAdapter implements ProviderAdapter {
 readonly descriptor:ProviderDescriptor;readonly evidence:Readonly<CliEvidence>;
 readonly #invocations=new Map<string,{identity:string;result:Promise<ProviderOutcome>}>();
 readonly #protocol:CliProtocol;readonly #profile:Readonly<ModelConnectionProfile>;readonly #runner:CliRunner;readonly #command:string;readonly #searchPath:(()=>string|undefined)|undefined;
 constructor(protocol:CliProtocol,profile:Readonly<ModelConnectionProfile>,runner:CliRunner,command:string,fixture:boolean,searchPath?:(()=>string|undefined)){
  this.#protocol=protocol;this.#profile=Object.freeze(structuredClone(profile));this.#runner=runner;this.#command=command;this.#searchPath=searchPath;
  this.descriptor=Object.freeze({provider:profile.providerKind,model:profile.model,configVersion:profile.revision,enabled:profile.enabled,capabilities:Object.freeze(['text-output']),evidenceClass:fixture?'fixture':'real-provider'});
  this.evidence=Object.freeze({executionEvidence:fixture?'local-cli-fixture':'subscription-cli',modelIdentity:protocol==='claude-code-cli/v1'?'reported':'requested',realProviderVerified:false});
 }
 async invoke(request:ProviderRequest):Promise<ProviderOutcome>{
  const limits=this.#profile.limits,cap=request.maxOutputTokens??limits.maxOutputTokens;
  if(!request||!(request.signal instanceof AbortSignal))return {status:'failed',output:null,usage:unknownUsage,reason:'invalid_request'};
  if(request.signal.aborted)return {status:'cancelled',output:null,usage:unknownUsage,reason:'cancelled_before_dispatch'};
  if(!this.#profile.enabled)return {status:'failed',output:null,usage:unknownUsage,reason:'provider_not_explicitly_authorized'};
  if(!label(request.invocationId)||!label(request.workId)||typeof request.instruction!=='string'||!request.instruction.trim()||!Number.isSafeInteger(cap)||cap<=0||cap>limits.maxOutputTokens)return {status:'failed',output:null,usage:unknownUsage,reason:'invalid_request_or_output_bound'};
  const prompt=request.inputReferences.length===0?request.instruction:`${request.instruction}\n\nInput references (identifiers only; their contents have not been loaded):\n${JSON.stringify(request.inputReferences)}`;
  if(Buffer.byteLength(prompt,'utf8')>limits.maxInputBytes)return {status:'failed',output:null,usage:unknownUsage,reason:'input_byte_limit'};
  const identity=providerRequestHash(request),key=JSON.stringify([request.workId,request.invocationId]),prior=this.#invocations.get(key);
  if(prior)return prior.identity===identity?prior.result:{status:'failed',output:null,usage:unknownUsage,reason:'cli_invocation_identity_conflict'};
  if(this.#invocations.size>=1024)return {status:'failed',output:null,usage:unknownUsage,reason:'cli_invocation_capacity'};
  const snapshot={...request,inputReferences:[...request.inputReferences]},result=Promise.resolve().then(()=>this.#launch(snapshot,prompt,cap));
  this.#invocations.set(key,{identity,result});return result;
 }
 async #launch(request:ProviderRequest,prompt:string,cap:number):Promise<ProviderOutcome>{
  const limits=this.#profile.limits;
  // Allowlist: subscription login only. API keys, base-URL/provider overrides and unrelated host secrets never reach the CLI.
  const env:Record<string,string>={};for(const [k,v] of Object.entries(process.env))if(v!==undefined&&cliEnvironmentAllowed(k))env[k]=v;
  // A discovered CLI runs with the PATH discovery produced; only the value changes, no name is added or widened.
  if(this.#searchPath){const discovered=this.#searchPath();if(discovered!==undefined)env.PATH=discovered;}
  if(this.#protocol==='claude-code-cli/v1')env[CLAUDE_CODE_MAX_OUTPUT_TOKEN_ENV]=String(cap);
  const cwd=await mkdtemp(join(tmpdir(),'massion-cli-'));
  try{
   if(request.signal.aborted)return {status:'cancelled',output:null,usage:unknownUsage,reason:'cancelled_before_dispatch'};
   const result=await callTool(signal=>this.#runner({invocationId:request.invocationId,command:this.#command,args:this.#protocol==='claude-code-cli/v1'?claudeArgs(this.#profile.model):codexArgs(this.#profile.model),stdin:prompt,cwd,env,timeoutMs:limits.timeoutMs,maxOutputBytes:limits.maxResponseBytes,signal}),{signal:request.signal,timeoutMs:Math.min(limits.timeoutMs,TOOL_TIMEOUT_MS)});
   if(!result.spawned)return result.aborted?{status:'cancelled',output:null,usage:unknownUsage,reason:'cancelled_before_dispatch'}:{status:'failed',output:null,usage:unknownUsage,reason:'cli_unavailable_not_started'};
   if(result.aborted)return {status:'unknown',output:null,usage:unknownUsage,reason:'cancelled_after_dispatch'};
   if(result.timedOut)return {status:'unknown',output:null,usage:unknownUsage,reason:'timeout_after_dispatch'};
   if(result.overflow)return {status:'unknown',output:null,usage:unknownUsage,reason:'cli_output_limit_remote_outcome_unknown'};
   // Observed: Claude Code continues internally after hitting its output cap (num_turns 4, 4x cap) and then exits 1.
   if(result.exitCode!==0){
    // The Codex usage-limit decision is the sole exception to the normal exit-code and terminal-token classification.
    if(typeof result.exitCode==='number'&&this.#protocol==='codex-cli/v1'){
     const stream=readCodexEvents(result.stdout);
     if(stream.status==='parsed'){
      const limit=codexUsageLimitResult(stream.events);
      if(limit.status!=='unmatched'){
       if(limit.errorItems>0)return limit;
       const {errorItems,...outcome}=limit;
       return outcome;
      }
     }
    }
    let terminal='';try{const body=JSON.parse(result.stdout);if(typeof body?.terminal_reason==='string'&&/^[a-z_]{1,64}$/.test(body.terminal_reason))terminal='_'+body.terminal_reason;}catch{}
    return {status:'unknown',output:null,usage:unknownUsage,reason:`cli_exit_${result.exitCode}${terminal}_remote_outcome_unknown`};}
   return this.#protocol==='claude-code-cli/v1'?parseClaudeResult(result.stdout,this.#profile.model,cap):parseCodexEvents(result.stdout,cap);
  }catch(error){return {status:error instanceof ToolCallError&&error.outcome==='failed'?'failed':'unknown',output:null,usage:unknownUsage,reason:error instanceof ToolCallError&&error.timedOut?'timeout_after_dispatch':'cli_outcome_unknown'};}finally{await rm(cwd,{recursive:true,force:true}).catch(()=>{});}
 }
}

export function cliProfileFactory(protocol:CliProtocol,options:{mode:'https'|'local-http-mock';runner?:CliRunner;command?:string;launcher?:CliLauncher;searchPath?:(()=>string|undefined)}):ModelAdapterFactory{
 const fixture=options.mode==='local-http-mock',command=options.command??options.launcher?.command??(protocol==='claude-code-cli/v1'?'claude':'codex');
 return {
  protocol,authMethods:['cli-login'],capabilities:['text-output'],evidenceClass:fixture?'fixture':'real-provider',
  validate(p){const errors:ConnectionDiagnostic[]=[];
   if(fixture&&!options.runner)errors.push({code:'cli_fixture_runner_missing',message:'Fixture mode never launches a real subscription CLI.'});
   if(p.auth.secretRef!==undefined)errors.push({code:'auth_invalid',message:'Subscription CLIs use their own login; no secret reference is accepted.'});
   if(!/^[a-zA-Z0-9._:/-]{1,128}$/.test(p.model))errors.push({code:'profile_invalid','message':'Exact model ID required.'});
   return errors;},
  create(p){if(fixture&&!options.runner)throw new Error('Fixture CLI runner required');return new CliTextAdapter(protocol,p,options.runner??(options.launcher?(call=>options.launcher!.launch(call.invocationId!,call)):async()=>({spawned:false,exitCode:null,stdout:'',stderr:'',timedOut:false,aborted:false,overflow:false})),command,fixture,options.searchPath);},
 };
}
