import {providerRequestHash} from './provider-dispatch.ts';
/** Subscription CLIs (Claude Code, Codex) as bounded single-shot text providers. No tools, sessions or retries. */
export {spawnCliRunner} from './cli-process.ts';
import type {CliLauncher} from './cli-launcher.ts';
import {callTool,ToolCallError,TOOL_TIMEOUT_MS} from './tool-call.ts';
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir,userInfo} from 'node:os';
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
/** The OS account name behind USER and LOGNAME: the same account lookup discovery uses for the home directory and the shell, never this process's environment. */
export const cliAccountUsername=():string=>userInfo().username;
/** The account lookup is the source of truth for the two names a subscription CLI reads for its login identity (the packaged supervisor clears them from the core's environment, and an inherited value never overrides the account). A failed lookup leaves the two names as inherited (present if the core's environment had them, absent if not); the child still starts. */
export function applyCliAccountEnvironment(env:Record<string,string>,account:()=>string=cliAccountUsername):void{
 try{const username=account();env.USER=username;env.LOGNAME=username;}catch{}
}
export const CLI_MODEL_ID_MAX_LENGTH=128;
const CLI_MODEL_ID_PATTERN=new RegExp(`^[a-zA-Z0-9._:/-]{1,${CLI_MODEL_ID_MAX_LENGTH}}$`);
/** A launcher policy pins exact names plus the one locale class the launcher expands at launch. */
export function cliLauncherEnvironmentNames(protocol:CliProtocol):string[] {return [...CLI_ENVIRONMENT_NAMES,CLI_ENVIRONMENT_CLASS_NAME,...(protocol==='claude-code-cli/v1'?[CLAUDE_CODE_MAX_OUTPUT_TOKEN_ENV]:[])];}

/** Launcher argument patterns for one protocol: fixed args exact, the one variable position an exact model id. */
export function cliArgPatterns(protocol:CliProtocol):readonly (string|RegExp)[] {
 const model='#massion-model#',catalog='/#massion-catalog#',args=protocol==='claude-code-cli/v1'?claudeArgs(model):codexArgs(model,catalog);
 return args.map(arg=>arg===model?CLI_MODEL_ID_PATTERN:arg===catalogOverride(catalog)?/^model_catalog_json="\/(?:[^"\\]|\\["\\])*\/model-catalog\.json"$/:arg);
}
function claudeArgs(model:string){return ['-p','--output-format','json','--model',model,'--tools','','--no-session-persistence','--max-turns','1','--effort','low','--setting-sources','','--strict-mcp-config','--disable-slash-commands','--system-prompt',SYSTEM_PROMPT];}
// Codex has no tool-free mode. Keep the tool-off switches together (issue #209).
// Sources (Codex rust-v0.167.1, commit 0a94398, read 2026-11-17): Codex's own tool-less thread
// (codex-rs/tui/src/temporary_structured_request.rs:46-99), OpenMausBot's text-only Codex path
// (src/server/drivers/codex-background-text.ts:89-95, feature names only), and the collaboration
// switch agents.enabled + features.multi_agent_v2 (codex-rs/core/src/config/mod.rs:1687-1714).
// Deliberately absent: features.unified_exec (managed_features.rs:176-184 re-enables it unless a
// managed requirement pins it) and features.unified_exec_tty (with features.shell_tool=false,
// core/src/tools/spec_plan.rs:1248-1251 registers no exec tool for it to configure).
// Additional keys come from codex-rs/features/src/lib.rs (FEATURES at rust-v0.167.1).
const CODEX_DISABLED_FEATURES=[
 'api_key_cyber_access_programs','api_key_model_discovery','apps','auth_elicitation',
 'browser_annotation_api','browser_use','browser_use_external','browser_use_full_cdp_access','cli_daybreak',
 'code_mode','code_mode_host','code_mode_only','computer_use','context_management','current_time_reminder',
 'daemon_auto_start','deferred_executor','goals','guardian_approval','hooks','image_generation',
 'in_app_browser','in_app_chat','in_app_dictation','in_app_local_automation','in_app_updates','in_app_voice',
 'mcp_oauth_refresh_coordination','memories','mentions_v2','multi_agent','multi_agent_v2','network_proxy','plugin_discovery_prefetch',
 'plugin_sharing','plugins','remote_plugin','request_permissions_tool','send_message_to_user_async','shell_snapshot','shell_tool',
 'skill_mcp_dependency_install','skill_search','sleep_tool','standalone_web_search','system_proxy_fallback','token_budget',
 'tool_call_mcp_elicitation','tool_suggest','unbounded_connection_retries','view_image','workspace_dependencies',
];
// Legacy notify commands are registered independently of features.hooks (hooks/src/registry.rs:179-195).
const CODEX_TEXT_ONLY_OVERRIDES=['agents.enabled=false','analytics.enabled=false','approval_policy="never"','cloud.skills.enabled=false',...CODEX_DISABLED_FEATURES.map(key=>`features.${key}=false`),'notify=[]','otel.metrics_exporter="none"','skills.include_instructions=false','tools.experimental_request_user_input.enabled=false','tools.update_plan.enabled=false','web_search="disabled"'];
const CODEX_TEXT_ONLY_CONFIG_ARGS=CODEX_TEXT_ONLY_OVERRIDES.flatMap(override=>['-c',override]);
const catalogOverride=(path:string)=>`model_catalog_json=${JSON.stringify(path)}`;
export function codexArgs(model:string,catalogPath:string){return ['exec','--json','--skip-git-repo-check','--sandbox','read-only','--ephemeral','--ignore-user-config','--ignore-rules','-m',model,'-c',catalogOverride(catalogPath),'-c','model_reasoning_effort="low"','-c',`instructions=${JSON.stringify(SYSTEM_PROMPT)}`,...CODEX_TEXT_ONLY_CONFIG_ARGS,'-'];}
const CODEX_VERSION='codex-cli 0.171.0';
// The features subcommand accepts root config overrides but has no exec-only --ignore-user-config flag.
export const CODEX_PROBE_ARGS=[['--version'],[...CODEX_TEXT_ONLY_CONFIG_ARGS,'features','list']] as const;
// rust-v0.171.0: defaults for UI, storage, request/response formatting, and options of disabled tools.
// In particular, unified_exec is normalized on, but shell_tool and the model's shell_type control registration.
// Removed features can still appear enabled in the listing, including realtime_conversation and worktrees.
const CODEX_ALLOWED_FEATURES=new Set([
 'bedrock_setup_wizard','code_mode_host_grpc','code_mode_host_output_truncation','code_mode_interrupt',
 'collaboration_modes','compaction_image_budget','content_item_kinds','deferred_tool_world_state','enable_request_compression',
 'fast_mode','guardian_include_additional_context','guardian_reuse_parent_compaction','incremental_tools','incremental_tools_legacy',
 'incremental_tools_legacy_gcp','instant_interrupt','item_ids','prediction_preserve_parent_tools','realtime_conversation','reasoning_effort_override',
 'resize_all_images','retain_client_tool_outputs','sqlite','steer','terminal_resize_reflow','tool_search_always_defer_mcp_tools',
 'tui_app_server','tui_workspace','ultrafast_mode','unified_exec','unified_exec_tty','unified_image_budget',
 'untrusted_as_tool_output','worktrees','write_stdin_approval',
]);

function codexListingStatus(stdout:string){
 const seen=new Set<string>();let unexpected=false;
 for(const line of stdout.trim().split(/\r?\n/)){
  const row=/^([a-z][a-z0-9_]*)[ \t]+(?:under development|experimental|stable|deprecated|removed)[ \t]+(true|false)[ \t]*$/.exec(line);
  if(!row||seen.has(row[1]!))return 'listing_invalid';
  const [,feature,enabled]=row;
  seen.add(feature!);
  if(enabled==='true'&&!CODEX_ALLOWED_FEATURES.has(feature!))unexpected=true;
 }
 return unexpected?'enabled_feature':'ready';
}

/** One bounded preflight and one model process, through the same effective runner. */
export async function runCodexText(model:string,call:Omit<CliInvocation,'args'>,runner:CliRunner):Promise<
 {status:'unsupported_version'|'listing_failed'|'listing_invalid'|'enabled_feature'|'catalog_failed'|'cancelled'}|
 {status:'ran';version:string;result:CliResult}
>{
 const probe=async(args:readonly string[])=>{
  try{
   const timeoutMs=Math.min(call.timeoutMs,5000);
   const result=await callTool(signal=>runner({...call,args,stdin:'',signal,timeoutMs,maxOutputBytes:65536}),{signal:call.signal,timeoutMs,readOnly:true});
   if(result.spawned&&result.exitCode===0&&!result.aborted&&!result.timedOut&&!result.overflow)return result.stdout;
  }catch{}
  return null;
 };
 if(!CLI_MODEL_ID_PATTERN.test(model)||model.startsWith('-'))return {status:'catalog_failed'};
 const version=await probe(CODEX_PROBE_ARGS[0]);
 if(call.signal.aborted)return {status:'cancelled'};
 if(version?.trim()!==CODEX_VERSION)return {status:'unsupported_version'};
 const listing=await probe(CODEX_PROBE_ARGS[1]);
 if(call.signal.aborted)return {status:'cancelled'};
 if(listing===null)return {status:'listing_failed'};
 const status=codexListingStatus(listing);
 if(status!=='ready')return {status};

 // ModelInfo and its instruction template, codex-rs/protocol/src/openai_models.rs:427-533,1044-1082 at rust-v0.171.0.
 // No model-owned tools. Optional apply_patch_tool_type is deliberately absent.
 const catalog={models:[{slug:model,display_name:model,supported_reasoning_levels:[{effort:'low',description:'Low'}],
  shell_type:'disabled',visibility:'list',supported_in_api:true,priority:0,include_apps_usage_instructions:false,
  supports_reasoning_summary_parameter:false,support_verbosity:false,truncation_policy:{mode:'tokens',limit:10000},
  experimental_supported_tools:[],model_messages:{instructions_template:SYSTEM_PROMPT}}]};
 let path:string;
 try{
  path=join(await realpath(call.cwd),'model-catalog.json');
  await writeFile(path,JSON.stringify(catalog)+'\n',{flag:'wx',mode:0o600});
 }catch{return {status:'catalog_failed'};}
 try{
  if(call.signal.aborted)return {status:'cancelled'};
  const result=await callTool(signal=>runner({...call,args:codexArgs(model,path),signal}),{signal:call.signal,timeoutMs:call.timeoutMs});
  return {status:'ran',version:CODEX_VERSION,result};
 }finally{await rm(path,{force:true}).catch(()=>{});}
}

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
 const events:any[]=[];let malformed=false;
 for(const line of stdout.split('\n')){
  if(!line.trim())continue;
  try{const event=JSON.parse(line);if(typeof event?.type==='string')events.push(event);else malformed=true;}catch{malformed=true;}
 }
 return {malformed,events};
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
// Item kinds of codex exec --json at rust-v0.171.0 (codex-rs/exec/src/exec_events.rs:107-133):
// agent_message, reasoning, command_execution, file_change, mcp_tool_call, collab_tool_call,
// web_search, todo_list, error. Only agent_message, reasoning and error may appear in any item
// event; any other kind — known or not — fails the run, so a new kind is refused by default.
// An error ITEM is a non-fatal warning (exec_events.rs:131-132): config warnings and deprecation
// notices arrive as completed error items while the turn keeps running
// (event_processor_with_jsonl_output.rs:411-475). Error items add to errorItems only.
export function parseCodexEvents(stdout:string,cap:number):ProviderOutcome&{errorItems:number}{
 const {events,malformed}=readCodexEvents(stdout);
 const turns=events.filter(e=>e?.type==='turn.completed'),failed=events.some(e=>e?.type==='turn.failed');
 const itemEvents=events.filter(e=>e?.type==='item.started'||e?.type==='item.updated'||e?.type==='item.completed'),items=itemEvents.map(e=>e.item);
 const completedItems=itemEvents.filter(e=>e?.type==='item.completed').map(e=>e.item);
 const errorItems=completedItems.filter(i=>i?.type==='error').length;
 // A top-level error event (stream reconnects) means an extra or partial upstream request; error items do not.
 const messages=completedItems.filter(i=>i?.type==='agent_message');
 const unexpectedItem=items.some(i=>!['agent_message','reasoning','error'].includes(i?.type));
 // The top-level event kinds are closed too (codex-rs/exec/src/exec_events.rs:8-37).
 const unexpectedEvent=events.some(e=>!['thread.started','turn.started','turn.completed','turn.failed','error','item.started','item.updated','item.completed'].includes(e?.type));
 const u=turns[0]?.usage,validUsage=turns.length===1&&u&&[u.input_tokens,u.output_tokens].every(integer);
 if(unexpectedItem||unexpectedEvent)return {status:'failed',output:null,usage:validUsage?{inputTokens:u.input_tokens,outputTokens:u.output_tokens}:unknownUsage,reason:'unsupported_tool_output',errorItems};
 if(malformed)return {status:'unknown',output:null,usage:unknownUsage,reason:'cli_invalid_json_remote_outcome_unknown',errorItems:0};
 const limit=codexUsageLimitResult(events);
 if(limit.status!=='unmatched')return limit;
 if(events.some(e=>e?.type==='error'))return {status:'unknown',output:null,usage:unknownUsage,reason:'cli_error_event_remote_outcome_unknown',errorItems};
 if(failed||turns.length!==1)return {status:'unknown',output:null,usage:unknownUsage,reason:'cli_turn_not_completed_remote_outcome_unknown',errorItems};
 if(!validUsage)return {status:'unknown',output:null,usage:unknownUsage,reason:'cli_invalid_result_schema',errorItems};
 const usage={inputTokens:u.input_tokens,outputTokens:u.output_tokens};
 if(usage.outputTokens>cap)return {status:'unknown',output:null,usage:unknownUsage,reason:'invalid_or_unbounded_usage',errorItems};
 if(messages.length>1)return {status:'failed',output:null,usage,reason:'unsupported_tool_output',errorItems};
 if(messages.length!==1||typeof messages[0].text!=='string'||!messages[0].text.trim()||!messages[0].text.isWellFormed())return {status:'failed',output:null,usage,reason:'empty_output',errorItems};
 return {status:'completed',output:messages[0].text,usage,reason:'bounded_text_completion',errorItems};
}

class CliTextAdapter implements ProviderAdapter {
 readonly descriptor:ProviderDescriptor;readonly evidence:Readonly<CliEvidence>;
 readonly #invocations=new Map<string,{identity:string;result:Promise<ProviderOutcome>}>();
 readonly #protocol:CliProtocol;readonly #profile:Readonly<ModelConnectionProfile>;readonly #runner:CliRunner;readonly #command:string;readonly #searchPath:(()=>string|undefined)|undefined;readonly #account:()=>string;
 constructor(protocol:CliProtocol,profile:Readonly<ModelConnectionProfile>,runner:CliRunner,command:string,fixture:boolean,searchPath?:(()=>string|undefined),account:()=>string=cliAccountUsername){
  this.#protocol=protocol;this.#profile=Object.freeze(structuredClone(profile));this.#runner=runner;this.#command=command;this.#searchPath=searchPath;this.#account=account;
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
  applyCliAccountEnvironment(env,this.#account);
  // A discovered CLI runs with the PATH discovery produced; only the value changes, no name is added or widened.
  if(this.#searchPath){const discovered=this.#searchPath();if(discovered!==undefined)env.PATH=discovered;}
  if(this.#protocol==='claude-code-cli/v1')env[CLAUDE_CODE_MAX_OUTPUT_TOKEN_ENV]=String(cap);
  const cwd=await mkdtemp(join(tmpdir(),'massion-cli-'));
  try{
   if(request.signal.aborted)return {status:'cancelled',output:null,usage:unknownUsage,reason:'cancelled_before_dispatch'};
   const call={invocationId:request.invocationId,command:this.#command,stdin:prompt,cwd,env,timeoutMs:Math.min(limits.timeoutMs,TOOL_TIMEOUT_MS),maxOutputBytes:limits.maxResponseBytes,signal:request.signal};
   let result:CliResult;
   if(this.#protocol==='codex-cli/v1'){
    const execution=await runCodexText(this.#profile.model,call,this.#runner);
    if(execution.status==='cancelled')return {status:'cancelled',output:null,usage:unknownUsage,reason:'cancelled_before_dispatch'};
    if(execution.status!=='ran')return {status:'failed',output:null,usage:unknownUsage,reason:'cli_unavailable_not_started'};
    result=execution.result;
   }else result=await callTool(signal=>this.#runner({...call,args:claudeArgs(this.#profile.model),signal}),{signal:request.signal,timeoutMs:call.timeoutMs});
   if(!result.spawned)return result.aborted?{status:'cancelled',output:null,usage:unknownUsage,reason:'cancelled_before_dispatch'}:{status:'failed',output:null,usage:unknownUsage,reason:'cli_unavailable_not_started'};
   const codex=this.#protocol==='codex-cli/v1'?parseCodexEvents(result.stdout,cap):null;
   if(codex?.reason==='unsupported_tool_output')return codex;
   if(result.aborted)return {status:'unknown',output:null,usage:unknownUsage,reason:'cancelled_after_dispatch'};
   if(result.timedOut)return {status:'unknown',output:null,usage:unknownUsage,reason:'timeout_after_dispatch'};
   if(result.overflow)return {status:'unknown',output:null,usage:unknownUsage,reason:'cli_output_limit_remote_outcome_unknown'};
   // Observed: Claude Code continues internally after hitting its output cap (num_turns 4, 4x cap) and then exits 1.
   if(result.exitCode!==0){
    // The Codex usage-limit decision is the sole exception to the normal exit-code and terminal-token classification.
    if(typeof result.exitCode==='number'&&codex?.reason===CODEX_USAGE_LIMIT_REASON){
     if(codex.errorItems>0)return codex;
     const {errorItems,...outcome}=codex;
     return outcome;
    }
    let terminal='';try{const body=JSON.parse(result.stdout);if(typeof body?.terminal_reason==='string'&&/^[a-z_]{1,64}$/.test(body.terminal_reason))terminal='_'+body.terminal_reason;}catch{}
    return {status:'unknown',output:null,usage:unknownUsage,reason:`cli_exit_${result.exitCode}${terminal}_remote_outcome_unknown`};}
   return codex??parseClaudeResult(result.stdout,this.#profile.model,cap);
  }catch(error){return {status:error instanceof ToolCallError&&error.outcome==='failed'?'failed':'unknown',output:null,usage:unknownUsage,reason:error instanceof ToolCallError&&error.timedOut?'timeout_after_dispatch':'cli_outcome_unknown'};}finally{await rm(cwd,{recursive:true,force:true}).catch(()=>{});}
 }
}

export function cliProfileFactory(protocol:CliProtocol,options:{mode:'https'|'local-http-mock';runner?:CliRunner;command?:string;launcher?:CliLauncher;searchPath?:(()=>string|undefined);account?:()=>string}):ModelAdapterFactory{
 const launcher=options.launcher;
 const fixture=options.mode==='local-http-mock',command=options.command??options.launcher?.command??(protocol==='claude-code-cli/v1'?'claude':'codex');
 return {
  protocol,authMethods:['cli-login'],capabilities:['text-output'],evidenceClass:fixture?'fixture':'real-provider',
  validate(p){const errors:ConnectionDiagnostic[]=[];
   if(fixture&&!options.runner)errors.push({code:'cli_fixture_runner_missing',message:'Fixture mode never launches a real subscription CLI.'});
   if(p.auth.secretRef!==undefined)errors.push({code:'auth_invalid',message:'Subscription CLIs use their own login; no secret reference is accepted.'});
   if(!CLI_MODEL_ID_PATTERN.test(p.model))errors.push({code:'profile_invalid','message':'Exact model ID required.'});
   return errors;},
  create(p){if(fixture&&!options.runner)throw new Error('Fixture CLI runner required');return new CliTextAdapter(protocol,p,options.runner??(launcher?(call=>launcher.launch(call.invocationId!,call)):async()=>({spawned:false,exitCode:null,stdout:'',stderr:'',timedOut:false,aborted:false,overflow:false})),command,fixture,options.searchPath,options.account);},
 };
}
