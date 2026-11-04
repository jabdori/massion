/** Subscription CLIs (Claude Code, Codex) as bounded single-shot text providers. No tools, sessions or retries. */
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ProviderAdapter,ProviderDescriptor,ProviderOutcome,ProviderRequest} from './providers.ts';
import type {ConnectionDiagnostic,ModelAdapterFactory,ModelConnectionProfile} from './provider-profiles.ts';

export type CliProtocol='claude-code-cli/v1'|'codex-cli/v1';
export interface CliInvocation {command:string;args:readonly string[];stdin:string;cwd:string;env:Readonly<Record<string,string>>;timeoutMs:number;maxOutputBytes:number;signal:AbortSignal}
/** `spawned:false` means the process never started, so no remote request can have been made. */
export interface CliResult {spawned:boolean;exitCode:number|null;stdout:string;stderr:string;timedOut:boolean;aborted:boolean;overflow:boolean}
export type CliRunner=(invocation:CliInvocation)=>Promise<CliResult>;
export interface CliEvidence {executionEvidence:'subscription-cli'|'local-cli-fixture';modelIdentity:'reported'|'requested';realProviderVerified:false}

const SYSTEM_PROMPT='You produce bounded plain-text answers for an independent review workflow. Follow the user instruction exactly. Do not use tools.';
const label=(v:unknown)=>typeof v==='string'&&v.length>0&&v.length<=512&&v.trim()===v&&!/[\u0000-\u001f\u007f]/.test(v);
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const unknownUsage={inputTokens:null,outputTokens:null};
const CHILD_ENV=/^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TERM|LANG|LC_[A-Z]+|TZ|XDG_(CONFIG|DATA|CACHE|STATE)_HOME|CODEX_HOME|CLAUDE_CONFIG_DIR|__CF_USER_TEXT_ENCODING)$/;

/** Default runner: argv only (no shell), own process group, bounded raw bytes, group SIGKILL on timeout/abort/overflow. */
export const spawnCliRunner:CliRunner=invocation=>new Promise(resolve=>{
 const empty={exitCode:null,stdout:'',stderr:'',timedOut:false,aborted:true,overflow:false};
 if(invocation.signal.aborted){resolve({spawned:false,...empty});return;}
 const out:Buffer[]=[],err:Buffer[]=[];let outBytes=0,errBytes=0,overflow=false,timedOut=false,aborted=false,settled=false,grace:ReturnType<typeof setTimeout>|undefined;
 const child=spawn(invocation.command,[...invocation.args],{cwd:invocation.cwd,env:{...invocation.env},stdio:['pipe','pipe','pipe'],shell:false,detached:true});
 const decode=(chunks:Buffer[])=>{try{return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));}catch{return null;}};
 const finish=(spawned:boolean,exitCode:number|null)=>{if(settled)return;settled=true;clearTimeout(timer);if(grace)clearTimeout(grace);invocation.signal.removeEventListener('abort',onAbort);
  const stdout=decode(out),stderr=decode(err)??'';
  // Invalid UTF-8 after a started process is reported as an overflow-class unknown, never as text.
  resolve({spawned,exitCode,stdout:stdout??'',stderr:stderr.slice(0,8192),timedOut,aborted,overflow:overflow||stdout===null});};
 const kill=()=>{if(child.pid!==undefined){try{process.kill(-child.pid,'SIGKILL');}catch{try{child.kill('SIGKILL');}catch{}}}
  // A descendant may still hold the pipes open; settle shortly after the kill instead of waiting for it.
  if(!grace)grace=setTimeout(()=>{child.stdout.destroy();child.stderr.destroy();finish(true,null);},1000);};
 const onAbort=()=>{aborted=true;kill();};
 const timer=setTimeout(()=>{timedOut=true;kill();},invocation.timeoutMs);
 invocation.signal.addEventListener('abort',onAbort,{once:true});
 child.stdout.on('data',(chunk:Buffer)=>{if(overflow)return;outBytes+=chunk.length;if(outBytes>invocation.maxOutputBytes){overflow=true;kill();return;}out.push(chunk);});
 child.stderr.on('data',(chunk:Buffer)=>{if(errBytes<8192){err.push(chunk.subarray(0,8192-errBytes));errBytes+=chunk.length;}});
 // ENOENT/EACCES arrive here before any request could be sent.
 child.on('error',()=>finish(child.pid!==undefined,null));
 child.on('close',code=>finish(true,code));
 child.stdin.on('error',()=>{});child.stdin.end(invocation.stdin);
});

function claudeArgs(model:string){return ['-p','--output-format','json','--model',model,'--tools','','--no-session-persistence','--max-turns','1','--effort','low','--setting-sources','','--strict-mcp-config','--disable-slash-commands','--system-prompt',SYSTEM_PROMPT];}
// Codex has no tool-free mode; disable every tool feature at invocation so attempts fail closed in its router
// (observed 2026-11-04: shell/exec off, code-mode host off -> "NO TOOLS", nothing executed). Feature names are Codex 0.166.
const CODEX_DISABLED_FEATURES=['shell_tool','unified_exec','unified_exec_tty','code_mode_host','apps','browser_use','browser_use_external','computer_use','image_generation','in_app_browser','view_image','sleep_tool','skill_search','tool_suggest','shell_snapshot'];
const CODEX_EXPECTED_WARNING=/^Code Mode is unavailable because code-mode host is disabled/;
function codexArgs(model:string){return ['exec','--json','--skip-git-repo-check','--sandbox','read-only','--ephemeral','--ignore-user-config','--ignore-rules','-m',model,'-c','model_reasoning_effort="low"','-c','web_search="disabled"','-c',`instructions=${JSON.stringify(SYSTEM_PROMPT)}`,...CODEX_DISABLED_FEATURES.flatMap(f=>['-c',`features.${f}=false`]),'-'];}

/** Claude Code JSON result: one success result, exactly the pinned model, measured usage. */
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
export function parseCodexEvents(stdout:string,cap:number):ProviderOutcome{
 const events:any[]=[];for(const line of stdout.split('\n')){if(!line.trim())continue;try{events.push(JSON.parse(line));}catch{return {status:'unknown',output:null,usage:unknownUsage,reason:'cli_invalid_json_remote_outcome_unknown'};}}
 const turns=events.filter(e=>e?.type==='turn.completed'),failed=events.some(e=>e?.type==='turn.failed');
 const items=events.filter(e=>e?.type==='item.completed').map(e=>e.item);
 // Top-level error events (stream reconnects) or unexpected error items mean extra or partial upstream requests.
 const errors=events.filter(e=>e?.type==='error').length+items.filter(i=>i?.type==='error'&&!(typeof i.message==='string'&&CODEX_EXPECTED_WARNING.test(i.message))).length;
 const messages=items.filter(i=>i?.type==='agent_message'),tools=items.filter(i=>i&&!['agent_message','reasoning','error'].includes(i.type));
 if(errors)return {status:'unknown',output:null,usage:unknownUsage,reason:'cli_error_event_remote_outcome_unknown'};
 if(failed||turns.length!==1)return {status:'unknown',output:null,usage:unknownUsage,reason:'cli_turn_not_completed_remote_outcome_unknown'};
 const u=turns[0].usage;
 if(!u||![u.input_tokens,u.output_tokens].every(integer))return {status:'unknown',output:null,usage:unknownUsage,reason:'cli_invalid_result_schema'};
 const usage={inputTokens:u.input_tokens,outputTokens:u.output_tokens};
 if(usage.outputTokens>cap)return {status:'unknown',output:null,usage:unknownUsage,reason:'invalid_or_unbounded_usage'};
 if(tools.length)return {status:'failed',output:null,usage,reason:'unsupported_tool_output'};
 if(messages.length>1)return {status:'failed',output:null,usage,reason:'unsupported_tool_output'};
 if(messages.length!==1||typeof messages[0].text!=='string'||!messages[0].text.trim()||!messages[0].text.isWellFormed())return {status:'failed',output:null,usage,reason:'empty_output'};
 return {status:'completed',output:messages[0].text,usage,reason:'bounded_text_completion'};
}

class CliTextAdapter implements ProviderAdapter {
 readonly descriptor:ProviderDescriptor;readonly evidence:Readonly<CliEvidence>;
 readonly #protocol:CliProtocol;readonly #profile:Readonly<ModelConnectionProfile>;readonly #runner:CliRunner;readonly #command:string;
 constructor(protocol:CliProtocol,profile:Readonly<ModelConnectionProfile>,runner:CliRunner,command:string,fixture:boolean){
  this.#protocol=protocol;this.#profile=Object.freeze(structuredClone(profile));this.#runner=runner;this.#command=command;
  this.descriptor=Object.freeze({provider:profile.providerKind,model:profile.model,configVersion:profile.revision,enabled:profile.enabled,capabilities:Object.freeze(['text-output']),evidenceClass:fixture?'fixture':'real-provider'});
  this.evidence=Object.freeze({executionEvidence:fixture?'local-cli-fixture':'subscription-cli',modelIdentity:protocol==='claude-code-cli/v1'?'reported':'requested',realProviderVerified:false});
 }
 async invoke(request:ProviderRequest):Promise<ProviderOutcome>{
  const limits=this.#profile.limits,cap=request.maxOutputTokens??limits.maxOutputTokens;
  if(!request||!(request.signal instanceof AbortSignal))return {status:'failed',output:null,usage:unknownUsage,reason:'invalid_request'};
  if(request.signal.aborted)return {status:'cancelled',output:null,usage:unknownUsage,reason:'cancelled_before_dispatch'};
  if(!this.#profile.enabled)return {status:'failed',output:null,usage:unknownUsage,reason:'provider_not_explicitly_authorized'};
  if(!label(request.invocationId)||typeof request.instruction!=='string'||!request.instruction.trim()||!Number.isSafeInteger(cap)||cap<=0||cap>limits.maxOutputTokens)return {status:'failed',output:null,usage:unknownUsage,reason:'invalid_request_or_output_bound'};
  const prompt=request.inputReferences.length===0?request.instruction:`${request.instruction}\n\nInput references (identifiers only; their contents have not been loaded):\n${JSON.stringify(request.inputReferences)}`;
  if(Buffer.byteLength(prompt,'utf8')>limits.maxInputBytes)return {status:'failed',output:null,usage:unknownUsage,reason:'input_byte_limit'};
  // Allowlist: subscription login only. API keys, base-URL/provider overrides and unrelated host secrets never reach the CLI.
  const env:Record<string,string>={};for(const [k,v] of Object.entries(process.env))if(v!==undefined&&CHILD_ENV.test(k))env[k]=v;
  if(this.#protocol==='claude-code-cli/v1')env.CLAUDE_CODE_MAX_OUTPUT_TOKENS=String(cap);
  const cwd=await mkdtemp(join(tmpdir(),'massion-cli-'));
  try{
   if(request.signal.aborted)return {status:'cancelled',output:null,usage:unknownUsage,reason:'cancelled_before_dispatch'};
   const result=await this.#runner({command:this.#command,args:this.#protocol==='claude-code-cli/v1'?claudeArgs(this.#profile.model):codexArgs(this.#profile.model),stdin:prompt,cwd,env,timeoutMs:limits.timeoutMs,maxOutputBytes:limits.maxResponseBytes,signal:request.signal});
   if(!result.spawned)return result.aborted?{status:'cancelled',output:null,usage:unknownUsage,reason:'cancelled_before_dispatch'}:{status:'failed',output:null,usage:unknownUsage,reason:'cli_unavailable_not_started'};
   if(result.aborted)return {status:'unknown',output:null,usage:unknownUsage,reason:'cancelled_after_dispatch'};
   if(result.timedOut)return {status:'unknown',output:null,usage:unknownUsage,reason:'timeout_after_dispatch'};
   if(result.overflow)return {status:'unknown',output:null,usage:unknownUsage,reason:'cli_output_limit_remote_outcome_unknown'};
   // Observed: Claude Code continues internally after hitting its output cap (num_turns 4, 4x cap) and then exits 1.
   if(result.exitCode!==0){let terminal='';try{const body=JSON.parse(result.stdout);if(typeof body?.terminal_reason==='string'&&/^[a-z_]{1,64}$/.test(body.terminal_reason))terminal='_'+body.terminal_reason;}catch{}
    return {status:'unknown',output:null,usage:unknownUsage,reason:`cli_exit_${result.exitCode}${terminal}_remote_outcome_unknown`};}
   return this.#protocol==='claude-code-cli/v1'?parseClaudeResult(result.stdout,this.#profile.model,cap):parseCodexEvents(result.stdout,cap);
  }finally{await rm(cwd,{recursive:true,force:true}).catch(()=>{});}
 }
}

export function cliProfileFactory(protocol:CliProtocol,options:{mode:'https'|'local-http-mock';runner?:CliRunner;command?:string}):ModelAdapterFactory{
 const fixture=options.mode==='local-http-mock',command=options.command??(protocol==='claude-code-cli/v1'?'claude':'codex');
 return {
  protocol,authMethods:['cli-login'],capabilities:['text-output'],evidenceClass:fixture?'fixture':'real-provider',
  validate(p){const errors:ConnectionDiagnostic[]=[];
   if(fixture&&!options.runner)errors.push({code:'cli_fixture_runner_missing',message:'Fixture mode never launches a real subscription CLI.'});
   if(p.auth.secretRef!==undefined)errors.push({code:'auth_invalid',message:'Subscription CLIs use their own login; no secret reference is accepted.'});
   if(!/^[a-zA-Z0-9._:/-]{1,128}$/.test(p.model))errors.push({code:'profile_invalid','message':'Exact model ID required.'});
   return errors;},
  create(p){if(fixture&&!options.runner)throw new Error('Fixture CLI runner required');return new CliTextAdapter(protocol,p,options.runner??spawnCliRunner,command,fixture);},
 };
}
