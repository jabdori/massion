import test from 'node:test';
import assert from 'node:assert/strict';
import {stat,mkdtemp,readFile,rm} from 'node:fs/promises';
import {tempRoot} from './support/temp-root.ts';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {cliProfileFactory,codexArgs,parseClaudeResult,parseCodexEvents} from '../src/cli-agent-providers.ts';
import type {CliInvocation,CliResult,CliRunner} from '../src/cli-agent-providers.ts';
import type {ModelConnectionProfile} from '../src/provider-profiles.ts';
import {parseHostManifest} from '../src/host-connections.ts';
import {ConnectionWorkbench} from '../src/connection-workbench.ts';
import {lifetimeFixture} from './support/runtime-lifetime-fixture.ts';

const signal = () => new AbortController().signal;
const request = (overrides = {}) => ({invocationId: 'cli-one', workId: 'work-one', instruction: 'Answer.', inputReferences: [], signal: signal(), maxOutputTokens: 64, ...overrides});
const ok = (stdout: string): CliResult => ({spawned: true, exitCode: 0, stdout, stderr: '', timedOut: false, aborted: false, overflow: false});
// Shapes observed from the local subscription CLIs on 2026-11-04.
const claude = (over: Record<string, unknown> = {}, model = 'claude-sonnet-5-5', output = 4) => JSON.stringify({type: 'result', subtype: 'success', is_error: false, result: 'OK', num_turns: 1,
  usage: {input_tokens: 2, cache_creation_input_tokens: 972, cache_read_input_tokens: 0, output_tokens: output}, modelUsage: {[model]: {}}, ...over});
const codex = (items: unknown[] = [{type: 'agent_message', text: 'OK'}], usage: unknown = {input_tokens: 20224, cached_input_tokens: 8064, output_tokens: 5, reasoning_output_tokens: 0}) =>
  [{type: 'thread.started', thread_id: 't'}, ...items.map((item, i) => ({type: 'item.completed', item: {id: 'item_' + i, ...(item as object)}})), {type: 'turn.completed', usage}].map(e => JSON.stringify(e)).join('\n');
const codexTurnFailed = (message: string) => [{type: 'thread.started', thread_id: 't'}, {type: 'turn.failed', error: {message}}].map(e => JSON.stringify(e)).join('\n');
const profile = (providerKind: string, protocol: string, model: string): ModelConnectionProfile => ({
  id: 'profile-' + providerKind, label: model, backend: 'model-provider', providerKind, protocol, model, endpoint: 'cli://x/run', revision: 'v1', enabled: true,
  auth: {method: 'cli-login'}, capabilities: ['text-output'], usage: {inputTokens: 'reported', outputTokens: 'reported', cost: 'unknown'},
  limits: {maxInputBytes: 65536, maxOutputTokens: 64, maxResponseBytes: 65536, timeoutMs: 1000},
});
const runCodex = (result: Partial<CliResult>) => cliProfileFactory('codex-cli/v1', {mode: 'https', runner: async () => ({...ok(''), ...result})}).create(profile('codex-cli', 'codex-cli/v1', 'gpt-6.1-terra')).invoke(request());

test('Claude result requires the exact pinned model, measured usage and one tool-free turn', () => {
  assert.deepEqual(parseClaudeResult(claude(), 'claude-sonnet-5-5', 64), {status: 'completed', output: 'OK', usage: {inputTokens: 974, outputTokens: 4}, reason: 'bounded_text_completion'});
  assert.equal(parseClaudeResult(claude({}, 'claude-opus-5-5'), 'claude-sonnet-5-5', 64).reason, 'cli_model_identity_mismatch');
  assert.equal(parseClaudeResult(claude({modelUsage: {'claude-sonnet-5-5': {}, 'claude-haiku-5-5': {}}}), 'claude-sonnet-5-5', 64).status, 'unknown');
  assert.deepEqual(parseClaudeResult(claude({}, 'claude-sonnet-5-5', 65), 'claude-sonnet-5-5', 64), {status: 'unknown', output: null, usage: {inputTokens: null, outputTokens: null}, reason: 'invalid_or_unbounded_usage'});
  assert.equal(parseClaudeResult(claude({is_error: true, subtype: 'error_during_execution'}), 'claude-sonnet-5-5', 64).reason, 'cli_reported_error');
  assert.equal(parseClaudeResult(claude({num_turns: 2}), 'claude-sonnet-5-5', 64).reason, 'unsupported_tool_output');
  assert.equal(parseClaudeResult('not json', 'claude-sonnet-5-5', 64).status, 'unknown');
});

test('Codex events require one agent message, no tool items and one completed turn', () => {
 assert.deepEqual(parseCodexEvents(codex(), 64), {status: 'completed', output: 'OK', usage: {inputTokens: 20224, outputTokens: 5}, reason: 'bounded_text_completion', errorItems: 0});
 assert.equal(parseCodexEvents(codex([{type: 'error', message: 'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed'}, {type: 'agent_message', text: 'OK'}]), 64).status, 'completed');
 assert.equal(parseCodexEvents(codex().replace('{"type":"turn.completed"', '{"type":"error","message":"Reconnecting... 1/5"}\n{"type":"turn.completed"'), 64).reason, 'cli_error_event_remote_outcome_unknown');
  assert.equal(parseCodexEvents(codex([{type: 'agent_message', text: '\ud800'}]), 64).reason, 'empty_output');
  assert.equal(parseCodexEvents(codex([{type: 'command_execution', command: 'ls'}, {type: 'agent_message', text: 'OK'}]), 64).reason, 'unsupported_tool_output');
  assert.equal(parseCodexEvents(codex([{type: 'agent_message', text: 'a'}, {type: 'agent_message', text: 'b'}]), 64).reason, 'unsupported_tool_output');
  assert.equal(parseCodexEvents(codex(undefined, {input_tokens: 1, output_tokens: 65}), 64).reason, 'invalid_or_unbounded_usage');
  assert.equal(parseCodexEvents('{"type":"thread.started"}\n{"type":"turn.failed"}', 64).status, 'unknown');
  assert.equal(parseCodexEvents('{"type":"thread.started"}', 64).status, 'unknown');
});

test('Codex messages that merely resemble a limit keep today\'s classification', () => {
  // API rate limit (error.rs:125), retry limit (error.rs:715-719) and server overload (error.rs:174) are not the
  // subscription's usage limit, so a turn.failed carrying them stays cli_turn_not_completed_remote_outcome_unknown.
  assert.equal(parseCodexEvents(codexTurnFailed('rate limit exceeded: 429'), 64).reason, 'cli_turn_not_completed_remote_outcome_unknown');
  assert.equal(parseCodexEvents(codexTurnFailed('exceeded retry limit, last status: 429'), 64).reason, 'cli_turn_not_completed_remote_outcome_unknown');
  assert.equal(parseCodexEvents(codexTurnFailed('Selected model is at capacity. Please try a different model.'), 64).reason, 'cli_turn_not_completed_remote_outcome_unknown');
});

for (const exitCode of [0, 1]) {
  test(`Codex exit ${exitCode} preserves the whole outcome for errors that quote the limit or miss its boundary`, async () => {
    const quote = '"You’ve hit your usage limit. Try again at 1:45 AM."';
    for (const message of [`Rate limit exceeded: ${quote}`, `exceeded retry limit, last status: 429, request id: ${quote}`, `Selected model is at capacity. (${quote})`, 'You’ve hit your usage limits. Try again at 1:45 AM.']) {
      assert.deepEqual(await runCodex({exitCode, stdout: codexTurnFailed(message)}), {
        status: 'unknown', output: null, usage: {inputTokens: null, outputTokens: null},
        ...(exitCode === 0 ? {reason: 'cli_turn_not_completed_remote_outcome_unknown', errorItems: 0} : {reason: 'cli_exit_1_remote_outcome_unknown'}),
      }, message);
    }
  });
}

// Hand-written from Codex rust-v0.167.1, error.rs:755, 765-783, 795-841, 849-877.
const limitForms = [
  ['You’ve hit your usage limit.', 'Try again'],
  ['You’ve hit your usage limit for GPT-5.1 Codex. Switch to another model now,', 'or try again'],
  ['You’ve hit your usage limit. Promo says try again at 8:05 AM.,', 'or try again'],
  ['You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits', 'or try again'],
  ['You’ve hit your usage limit. To get more access now, send a request to your admin', 'or try again'],
  ['You’ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus),', 'or try again'],
  ['You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits', 'or try again'],
  ['Your workspace is out of credits. Add credits to continue.', null],
  ['Your workspace is out of credits. Ask your workspace owner to refill in order to continue.', null],
  ['You hit your spend cap set in your workspace. Increase your spend cap to continue.', null],
  ['You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.', null],
] as const;
const unknownTurn = {status:'unknown', output:null, usage:{inputTokens:null,outputTokens:null}} as const;
const ordinaryFailure = {...unknownTurn, reason:'cli_turn_not_completed_remote_outcome_unknown', errorItems:0};
const numericExit = {...unknownTurn, reason:'cli_exit_1_remote_outcome_unknown'};
const refusalMessage = 'You’ve hit your usage limit. Try again at 1:45 AM.';
const refusalEvent = JSON.stringify({type:'turn.failed',error:{message:refusalMessage}});

test('each complete Codex limit form stays unknown, with or without the remote compact prefix', () => {
  const times = ['1:45 AM', 'Nov 21st, 2026 12:00 PM'];
  for (const [stem, retry] of limitForms) {
    for (const time of retry ? [undefined, ...times] : [undefined]) {
      const body = retry ? stem+' '+retry+(time===undefined?' later.':' at '+time+'.') : stem;
      for (const prefix of ['', 'Error running remote compact task: ']) {
        const message = prefix+body;
        assert.deepEqual(parseCodexEvents(codexTurnFailed(message),64), {
          ...unknownTurn, reason:'cli_usage_limit_reached', errorItems:0,
        }, message);
        assert.deepEqual(parseCodexEvents(codexTurnFailed(message+(retry?' (extra details)':' Try again at 1:45 AM.')),64), ordinaryFailure, message);
        assert.deepEqual(parseCodexEvents(codexTurnFailed('Error: '+message),64), ordinaryFailure, message);
      }
    }
  }
  assert.deepEqual(parseCodexEvents(codexTurnFailed('You’ve hit your usage limit. Try again at Feb 31st, 2026 1:45 AM.'),64), {
    ...unknownTurn, reason:'cli_usage_limit_reached', errorItems:0,
  });
});

test('Codex keeps the legacy result for near matches and out-of-format retry text', () => {
  for (const message of [
    'You’ve hit your usage limit.',
    'You’ve hit your usage limit. This is the text your prompt must replace.',
    'You’ve hit your usage limit for GPT-5.1 Codex. Switch to another model now, try again later.',
    'You’ve hit your usage limit for CoDeX. Switch to another model now, or try again later.',
    'You’ve hit your usage limit for GPT-Reserve. Switch to another model now, or try again later.',
    'You’ve hit your usage limit. , or try again later.',
    'Error running remote compact task: Error running remote compact task: '+refusalMessage,
    refusalMessage+'\n',
    ...['Alice Kim', 'Alice Kim 1:45 AM', '1:45 AM UTC', ' 1:45 AM', '1:45 AM ', '1:45 AM!!', '13:45 AM', '1:60 AM', 'Nov 21th, 2026 1:45 AM']
      .map(time => 'You’ve hit your usage limit. Try again at '+time+'.'),
  ]) {
    assert.deepEqual(parseCodexEvents(codexTurnFailed(message),64), ordinaryFailure, message);
  }
});

test('a Claude result with is_error and api_error_status 429 is not the subscription usage limit', () => {
  // The SDKResultMessage reference lists api_error_status on the success arm. This synthetic error arm pins
  // the existing parser's treatment of an extra HTTP status field; it is not a captured subscription refusal.
  const limited = JSON.stringify({type: 'result', subtype: 'error_during_execution', is_error: true, api_error_status: 429, result: '', num_turns: 1, usage: {input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0}, modelUsage: {'claude-sonnet-5-5': {}}});
  const outcome = parseClaudeResult(limited, 'claude-sonnet-5-5', 64);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.reason, 'cli_reported_error');
});

test('a numeric nonzero Codex exit uses the same terminal limit rule and preserves other exit results', async () => {
  const message = 'Error running remote compact task: '+refusalMessage;
  assert.deepEqual(await runCodex({exitCode:1,stdout:codexTurnFailed(message)}), {
    ...unknownTurn, reason:'cli_usage_limit_reached',
  });
  for (const miss of ['API rate limit: '+message, message+' (details)']) {
    assert.deepEqual(await runCodex({exitCode:1,stdout:codexTurnFailed(miss)}), numericExit, miss);
  }
  assert.deepEqual(await runCodex({exitCode:1,stdout:'some unrelated failure'}), numericExit);
  assert.deepEqual(await runCodex({exitCode:1,stdout:'{"terminal_reason":"runner_error"}'}), {
    ...unknownTurn, reason:'cli_exit_1_runner_error_remote_outcome_unknown',
  });
});

test('a signal-terminated Codex process retains the null-exit outcome even with a refusal in stdout', async () => {
  assert.deepEqual(await runCodex({exitCode:null,stdout:refusalEvent}), {
    ...unknownTurn, reason:'cli_exit_null_remote_outcome_unknown',
  });
});

test('Codex recognises only a single final turn.failed in valid JSONL on either exit', async () => {
  const otherFailure = JSON.stringify({type:'turn.failed',error:{message:'Selected model is at capacity.'}});
  const completed = JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}});
  for (const [stdout, zeroReason] of [
    [otherFailure+'\n'+refusalEvent, 'cli_turn_not_completed_remote_outcome_unknown'],
    [refusalEvent+'\n'+otherFailure, 'cli_turn_not_completed_remote_outcome_unknown'],
    [refusalEvent+'\n'+completed, 'cli_turn_not_completed_remote_outcome_unknown'],
    [refusalEvent+'\n'+'broken JSON', 'cli_invalid_json_remote_outcome_unknown'],
    ['broken JSON'+'\n'+refusalEvent, 'cli_invalid_json_remote_outcome_unknown'],
  ] as const) {
    assert.deepEqual(await runCodex({exitCode:0,stdout}), {...ordinaryFailure, reason:zeroReason}, stdout);
    assert.deepEqual(await runCodex({exitCode:1,stdout}), numericExit, stdout);
  }
});

test('a single final Codex refusal keeps the warning count on either exit', async () => {
  const warning = JSON.stringify({type:'item.completed',item:{type:'error',message:'Configuration warning'}});
  const notice = JSON.stringify({type:'error',message:refusalMessage});
  const stdout = [warning,notice,refusalEvent].join('\n')+'\n';
  for (const exitCode of [0,1]) {
    assert.deepEqual(await runCodex({exitCode,stdout}), {
      ...unknownTurn,reason:'cli_usage_limit_reached',errorItems:1,
    });
  }
});

test('non-fatal error items are counted, never decide the verdict, and no turn.completed means never completed', () => {
 // A config-warning error item before a normal answer: completed with the count (before this change this was cli_error_event_remote_outcome_unknown).
 const warning = parseCodexEvents(codex([{type: 'error', message: 'Under-development features enabled'}, {type: 'agent_message', text: 'OK'}]), 64);
 assert.deepEqual(warning, {status: 'completed', output: 'OK', usage: {inputTokens: 20224, outputTokens: 5}, reason: 'bounded_text_completion', errorItems: 1});
 assert.equal(parseCodexEvents(codex([{type: 'error', message: 'w1'}, {type: 'error', message: 'w2'}, {type: 'error', message: 'w3'}, {type: 'agent_message', text: 'OK'}]), 64).errorItems, 3);
 assert.equal(parseCodexEvents(codex([{type: 'error', message: 'w1'}, {type: 'error', message: 'w2'}, {type: 'error', message: 'w3'}, {type: 'agent_message', text: 'OK'}]), 64).status, 'completed');
 // Error items and an answer but no turn.completed: exact status and reason (before this change the reason was cli_error_event_remote_outcome_unknown).
 const unfinished = [{type: 'thread.started', thread_id: 't'}, {type: 'item.completed', item: {id: 'i0', type: 'error', message: 'Under-development features enabled'}}, {type: 'item.completed', item: {id: 'i1', type: 'agent_message', text: 'OK'}}].map(e => JSON.stringify(e)).join('\n');
 assert.deepEqual(parseCodexEvents(unfinished, 64), {status: 'unknown', output: null, usage: {inputTokens: null, outputTokens: null}, reason: 'cli_turn_not_completed_remote_outcome_unknown', errorItems: 1});
 // turn.failed after an answer, and a top-level error event: unchanged verdicts.
 const failedAfterAnswer = [{type: 'thread.started', thread_id: 't'}, {type: 'item.completed', item: {id: 'i0', type: 'agent_message', text: 'OK'}}, {type: 'turn.failed', error: {message: 'boom'}}].map(e => JSON.stringify(e)).join('\n');
 assert.deepEqual(parseCodexEvents(failedAfterAnswer, 64), {status: 'unknown', output: null, usage: {inputTokens: null, outputTokens: null}, reason: 'cli_turn_not_completed_remote_outcome_unknown', errorItems: 0});
 assert.deepEqual(parseCodexEvents(codex().replace('{"type":"turn.completed"', '{"type":"error","message":"Reconnecting... 1/5"}\n{"type":"turn.completed"'), 64), {status: 'unknown', output: null, usage: {inputTokens: null, outputTokens: null}, reason: 'cli_error_event_remote_outcome_unknown', errorItems: 0});
});

test("the lead's three real 0.167.1 streams complete where the rules allow; the tool-using one fails", () => {
 // Recorded 2026-11-17 with CLI 0.167.1 (reviews/tools-off-real-cli-2026-11-17), JSONL events only.
 // Checked for secrets and account identifiers: the streams hold ephemeral thread ids and a model name only.
 const realStream = (events: unknown[]) => events.map(e => JSON.stringify(e)).join('\n');
 const codeModeWarning = 'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.';
 const exact = realStream([
  {type: 'thread.started', thread_id: '01a1e54a-0458-7552-b852-2f4a7e0da35d'},
  {type: 'item.completed', item: {id: 'item_0', type: 'error', message: codeModeWarning}},
  {type: 'turn.started'},
  {type: 'item.completed', item: {id: 'item_1', type: 'agent_message', text: '1. IMPOSSIBLE\n2. IMPOSSIBLE\n3. IMPOSSIBLE'}},
  {type: 'turn.completed', usage: {input_tokens: 16006, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 21, reasoning_output_tokens: 0}}]);
 assert.deepEqual(parseCodexEvents(exact, 2048), {status: 'completed', output: '1. IMPOSSIBLE\n2. IMPOSSIBLE\n3. IMPOSSIBLE', usage: {inputTokens: 16006, outputTokens: 21}, reason: 'bounded_text_completion', errorItems: 1});
 const push = realStream([
  {type: 'thread.started', thread_id: '01a1e54a-1d15-7f12-8835-a5e96d7d6ab0'},
  {type: 'item.completed', item: {id: 'item_0', type: 'error', message: codeModeWarning}},
  {type: 'turn.started'},
  {type: 'item.completed', item: {id: 'item_1', type: 'agent_message', text: '1. **IMPOSSIBLE** — 현재 파일을 읽을 수 있는 실행 도구가 비활성화되어 있어 `marker.txt`의 내용을 확인할 수 없습니다.\n2. **IMPOSSIBLE** — 파일 시스템이 읽기 전용이며 셸 실행 도구도 비활성화되어 있습니다.'}},
  {type: 'turn.completed', usage: {input_tokens: 32063, cached_input_tokens: 15872, cache_write_input_tokens: 0, output_tokens: 282, reasoning_output_tokens: 48}}]);
 assert.deepEqual(parseCodexEvents(push, 2048).status, 'completed');
 assert.equal(parseCodexEvents(push, 2048).errorItems, 1);
 const collab = {id: 'item_1', type: 'collab_tool_call', tool: 'wait', sender_thread_id: '01a1e54a-6ed4-7500-9f8e-32d29fa3317c', receiver_thread_ids: [], prompt: null, agents_states: {}, status: 'in_progress'};
 const force = realStream([
  {type: 'thread.started', thread_id: '01a1e54a-6ed4-7500-9f8e-32d29fa3317c'},
  {type: 'item.completed', item: {id: 'item_0', type: 'error', message: codeModeWarning}},
  {type: 'turn.started'},
  {type: 'item.started', item: collab},
  {type: 'item.completed', item: {...collab, status: 'completed'}},
  {type: 'item.completed', item: {id: 'item_2', type: 'agent_message', text: '요청하신 작업을 완료하지 못했습니다.'}},
  {type: 'turn.completed', usage: {input_tokens: 80253, cached_input_tokens: 47488, cache_write_input_tokens: 0, output_tokens: 378, reasoning_output_tokens: 14}}]);
 assert.deepEqual(parseCodexEvents(force, 2048), {status: 'failed', output: null, usage: {inputTokens: 80253, outputTokens: 378}, reason: 'unsupported_tool_output', errorItems: 1});
});

test('codexArgs is one fixed tool-off argument list: exact, with the collaboration switch, without ignored keys', () => {
  const systemPrompt = 'You produce bounded plain-text answers for an independent review workflow. Follow the user instruction exactly. Do not use tools.';
  const overrides = ['agents.enabled=false','cloud.skills.enabled=false','features.apps=false','features.browser_use=false','features.browser_use_external=false','features.code_mode=false','features.code_mode_host=false','features.code_mode_only=false','features.computer_use=false','features.context_management=false','features.current_time_reminder=false','features.daemon_auto_start=false','features.deferred_executor=false','features.goals=false','features.hooks=false','features.image_generation=false','features.in_app_browser=false','features.memories=false','features.multi_agent=false','features.multi_agent_v2=false','features.plugins=false','features.remote_plugin=false','features.request_permissions_tool=false','features.shell_snapshot=false','features.shell_tool=false','features.skill_mcp_dependency_install=false','features.skill_search=false','features.sleep_tool=false','features.standalone_web_search=false','features.token_budget=false','features.tool_suggest=false','features.view_image=false','skills.include_instructions=false','tools.experimental_request_user_input.enabled=false','tools.update_plan.enabled=false','web_search="disabled"'];
  assert.deepEqual(codexArgs('gpt-6.1-terra'), ['exec','--json','--skip-git-repo-check','--sandbox','read-only','--ephemeral','--ignore-user-config','--ignore-rules','-m','gpt-6.1-terra','-c','model_reasoning_effort="low"','-c',`instructions=${JSON.stringify(systemPrompt)}`,...overrides.flatMap(k => ['-c', k]),'-']);
  assert.ok(codexArgs('m').includes('agents.enabled=false'));
  assert.ok(!codexArgs('m').some(a => a.startsWith('features.unified_exec')));
});

test('a tool item in item.started or item.updated, or an unknown item kind, fails the Codex run', () => {
  const stream = (phase: 'item.started' | 'item.updated', item: Record<string, unknown>) =>
    [{type: 'thread.started', thread_id: 't'}, {type: phase, item: {id: 'i0', ...item}}, {type: 'item.completed', item: {id: 'i1', type: 'agent_message', text: 'OK'}}, {type: 'turn.completed', usage: {input_tokens: 1, output_tokens: 1}}].map(e => JSON.stringify(e)).join('\n');
 assert.deepEqual(parseCodexEvents(stream('item.started', {type: 'collab_tool_call', tool: 'spawn_agent'}), 64), {status: 'failed', output: null, usage: {inputTokens: 1, outputTokens: 1}, reason: 'unsupported_tool_output', errorItems: 0});
  for (const kind of ['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'todo_list'])
    assert.equal(parseCodexEvents(stream('item.updated', {type: kind}), 64).reason, 'unsupported_tool_output', kind);
  assert.equal(parseCodexEvents(stream('item.started', {type: 'brand_new_kind'}), 64).reason, 'unsupported_tool_output');
});

test('a normal single-message stream with the full item lifecycle still completes', () => {
  const item = {id: 'm1', type: 'agent_message', text: 'OK'};
  const stream = [{type: 'thread.started', thread_id: 't'}, {type: 'item.started', item}, {type: 'item.updated', item}, {type: 'item.completed', item}, {type: 'turn.completed', usage: {input_tokens: 20224, output_tokens: 5}}].map(e => JSON.stringify(e)).join('\n');
 assert.deepEqual(parseCodexEvents(stream, 64), {status: 'completed', output: 'OK', usage: {inputTokens: 20224, outputTokens: 5}, reason: 'bounded_text_completion', errorItems: 0});
});

test('adapter launches one argv-only, tool-free, subscription-only process in an owned empty cwd', async () => {
  const seen: CliInvocation[] = [];
  const runner: CliRunner = async inv => { seen.push(inv); assert.deepEqual((await stat(inv.cwd)).isDirectory(), true); return ok(inv.command === 'claude' ? claude() : codex()); };
  const leaked = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'MASSION_UNRELATED_SECRET'];
  const saved = Object.fromEntries(leaked.map(k => [k, process.env[k]]));
  for (const k of leaked) process.env[k] = 'must-not-leak';
  try {
    for (const [kind, protocol, model] of [['claude-code-cli', 'claude-code-cli/v1', 'claude-sonnet-5-5'], ['codex-cli', 'codex-cli/v1', 'gpt-6.1-terra']] as const) {
      const adapter = cliProfileFactory(protocol, {mode: 'https', runner}).create(profile(kind, protocol, model));
      assert.equal(adapter.descriptor.evidenceClass, 'real-provider');
      assert.equal((await adapter.invoke(request({instruction: 'literal prompt'}))).status, 'completed');
    }
  } finally { for (const k of leaked) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
  const [c, x] = seen as [CliInvocation, CliInvocation];
  assert.equal(c.stdin, 'literal prompt'); assert.equal(x.stdin, 'literal prompt');
  for (const inv of seen) { for (const k of leaked) assert.equal(inv.env[k], undefined, k); assert.equal(inv.env.PATH, process.env.PATH); await assert.rejects(stat(inv.cwd)); }
  assert.deepEqual(c.args.slice(c.args.indexOf('--tools'), c.args.indexOf('--tools') + 2), ['--tools', '']);
  assert.ok(c.args.includes('--no-session-persistence') && c.args.includes('--strict-mcp-config') && c.args[c.args.indexOf('--model') + 1] === 'claude-sonnet-5-5');
  assert.equal(c.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '64');
  assert.deepEqual(x.args, codexArgs('gpt-6.1-terra'));
});

test('the model-call child takes USER and LOGNAME from the OS account lookup, never from the core environment', async t => {
  const originals = ['USER', 'LOGNAME'].map(name => [name, process.env[name]] as [string, string | undefined]);
  t.after(() => { for (const [name, value] of originals) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const seen: Record<string, string>[] = [];
  const adapter = (account?: () => string) => cliProfileFactory('claude-code-cli/v1', {mode: 'https', runner: async call => { seen.push({...call.env}); return ok(claude()); }, account}).create(profile('claude-code-cli', 'claude-code-cli/v1', 'claude-sonnet-5-5'));
  // A packaged start: the core environment has neither name, and the account lookup fills both.
  delete process.env.USER; delete process.env.LOGNAME;
  assert.equal((await adapter(() => 'fixture-account').invoke(request())).status, 'completed');
  assert.equal(seen[0]!.USER, 'fixture-account');
  assert.equal(seen[0]!.LOGNAME, 'fixture-account');
  // A development start with different inherited values: the OS account wins over both.
  process.env.USER = 'fixture-inherited-user'; process.env.LOGNAME = 'fixture-inherited-logname';
  assert.equal((await adapter(() => 'fixture-account').invoke(request())).status, 'completed');
  assert.equal(seen[1]!.USER, 'fixture-account', 'the account name overrides the inherited USER');
  assert.equal(seen[1]!.LOGNAME, 'fixture-account', 'the account name overrides the inherited LOGNAME');
  // A failed lookup leaves the two names as inherited (absent here: the core environment has neither; exactly main) and the child still starts and completes.
  delete process.env.USER; delete process.env.LOGNAME;
  assert.equal((await adapter(() => { throw new Error('account lookup failed'); }).invoke(request())).status, 'completed');
  assert.equal(seen[2]!.USER, undefined);
  assert.equal(seen[2]!.LOGNAME, undefined);
});

test('process failures stay unknown once started; a never-started CLI cannot have sent anything', async () => {
  const run = async (result: Partial<CliResult>) => cliProfileFactory('claude-code-cli/v1', {mode: 'https', runner: async () => ({...ok(''), ...result})})
    .create(profile('claude-code-cli', 'claude-code-cli/v1', 'claude-sonnet-5-5')).invoke(request());
  assert.deepEqual(await run({spawned: false}), {status: 'failed', output: null, usage: {inputTokens: null, outputTokens: null}, reason: 'cli_unavailable_not_started'});
  assert.equal((await run({timedOut: true, exitCode: null})).reason, 'timeout_after_dispatch');
  assert.equal((await run({aborted: true, exitCode: null})).reason, 'cancelled_after_dispatch');
  assert.equal((await run({overflow: true})).status, 'unknown');
  assert.equal((await run({exitCode: 1})).reason, 'cli_exit_1_remote_outcome_unknown');
  let calls = 0;
  const adapter = cliProfileFactory('codex-cli/v1', {mode: 'https', runner: async () => { calls++; return ok(codex()); }}).create(profile('codex-cli', 'codex-cli/v1', 'm'));
  assert.equal((await adapter.invoke(request({maxOutputTokens: 65}))).reason, 'invalid_request_or_output_bound');
  const aborted = new AbortController(); aborted.abort();
  assert.equal((await adapter.invoke(request({signal: aborted.signal}))).status, 'cancelled');
  assert.equal(calls, 0);
});

test('fixture mode never launches a real CLI and credentials are never accepted', () => {
  const fixture = cliProfileFactory('claude-code-cli/v1', {mode: 'local-http-mock'});
  assert.equal(fixture.evidenceClass, 'fixture');
  assert.deepEqual(fixture.validate(profile('claude-code-cli', 'claude-code-cli/v1', 'm')).map(d => d.code), ['cli_fixture_runner_missing']);
  assert.throws(() => fixture.create(profile('claude-code-cli', 'claude-code-cli/v1', 'm')));
  const live = cliProfileFactory('codex-cli/v1', {mode: 'https'});
  assert.deepEqual(live.validate({...profile('codex-cli', 'codex-cli/v1', 'm'), auth: {method: 'cli-login', secretRef: 'ref'}}).map(d => d.code), ['auth_invalid']);
});

test('host manifest accepts subscription CLIs only at their fixed identity and without credential bindings', () => {
  const manifest = (entry: Record<string, unknown>) => ({version: 1, revision: 'r1', mode: 'https', connections: [{id: 'cli', label: 'CLI', models: ['claude-sonnet-5-5'], ...entry}]});
  assert.equal(parseHostManifest(manifest({providerType: 'claude-code-cli', baseUrl: 'cli://claude-code/'})).connections[0]!.providerType, 'claude-code-cli');
  assert.equal(parseHostManifest(manifest({providerType: 'codex-cli', baseUrl: 'cli://codex/'})).connections[0]!.providerType, 'codex-cli');
  assert.throws(() => parseHostManifest(manifest({providerType: 'claude-code-cli', baseUrl: 'cli://codex/'})));
  assert.throws(() => parseHostManifest(manifest({providerType: 'claude-code-cli', baseUrl: 'cli://claude-code/', credential: {ref: 'r', environment: 'X'}})));
  assert.throws(() => parseHostManifest({...manifest({providerType: 'claude-code-cli', baseUrl: 'cli://claude-code/'}), mode: 'local-http-mock'}));
  const live = new ConnectionWorkbench(undefined as never, undefined as never, {transport: async () => { throw new Error('no HTTP'); }});
  assert.throws(() => live.connect({id: 'c', label: 'c', providerType: 'claude-code-cli', baseUrl: 'cli://claude-code/', mode: 'https', secretRef: 'ref'}));
  assert.throws(() => live.connect({id: 'c', label: 'c', providerType: 'codex-cli', baseUrl: 'https://api.openai.com/v1/', mode: 'https'}));
  live.connect({id: 'c', label: 'c', providerType: 'codex-cli', baseUrl: 'cli://codex/', mode: 'https'});
  assert.equal(live.list().connections[0]!.connectionStatus, 'cli-login-unverified');
});

test('CLI executor and independent CLI verifier reach an accepted Record through the normal selectable runtime', async t => {
  const f = await lifetimeFixture(t);
  const prompts: {command: string; input: any}[] = [];
  const runner: CliRunner = async inv => {
    const input = JSON.parse(inv.stdin); prompts.push({command: inv.command, input});
    if (!input.artifact) return ok(claude({result: 'Original bounded lifetime fixture'}, 'claude-sonnet-5-5', 1));
    const verdict = JSON.stringify({artifactSha256: input.binding.artifactSha256, criteriaVersion: input.criteria.version, criteriaHash: input.binding.criteriaHash, verdict: 'passed',
      checks: [{criterion: input.criteria.description, passed: true, quote: 'Original bounded', reason: 'CLI fixture verifier'}]});
    return ok(codex([{type: 'agent_message', text: verdict}], {input_tokens: 10, output_tokens: 1}));
  };
  const manager = new ConnectionWorkbench(f.store, f.artifacts, {allowFixture: true, cliRunner: runner, transport: async () => { throw new Error('no HTTP'); }});
  for (const [id, providerType, baseUrl] of [['claude', 'claude-code-cli', 'cli://claude-code/'], ['codex', 'codex-cli', 'cli://codex/']] as const)
    manager.connect({id, label: id, providerType, baseUrl, mode: 'local-http-mock'});
  const byId = (id: string) => manager.list().connections.find(c => c.id === id)!;
  assert.equal(byId('claude').credentialConfigured, true);
  assert.equal((await manager.discover('claude', byId('claude').configHash)).status, 'unavailable');
  const executor = manager.selectModel('claude', {model: 'claude-sonnet-5-5', label: 'Claude', expectedConfigHash: byId('claude').configHash});
  const verifier = manager.selectModel('codex', {model: 'gpt-6.1-terra', label: 'Codex', expectedConfigHash: byId('codex').configHash});
  manager.authorize({id: 'cli-grant', scope: 'local', executorProfileId: executor.profileId, verifierProfileId: verifier.profileId, maxOutputTokensPerCall: 4, expectedConfigHash: manager.list().configHash});
  const choice = {executorProfileId: executor.profileId, verifierProfileId: verifier.profileId, authorizationId: 'cli-grant', outputTokenCap: 4};
  const before = await f.current();
  assert.equal(manager.preflight(before, 'fresh', before.revision, choice).ready, true);
  const result = await manager.run('mission', 'fresh', 'cli-run', before.revision, choice);
  assert.equal(result.status, 'settled');
  const work = (await f.current()).value.works.find(w => w.id === 'fresh')!;
  assert.equal(work.acceptance, 'accepted');
  assert.ok(work.record);
  assert.deepEqual(prompts.map(p => p.command), ['claude', 'codex']);
  assert.ok(work.effects.length >= 2 && work.effects.every(e => e.status === 'succeeded'));
});

test('default runner: argv-only stdin/stdout, SIGKILL on timeout and output overflow, not-started on missing binary', async () => {
  const {spawnCliRunner} = await import('../src/cli-agent-providers.ts');
  const base = {stdin: 'echo me', cwd: process.cwd(), env: {PATH: process.env.PATH ?? ''}, timeoutMs: 5000, maxOutputBytes: 1024, signal: signal()};
  const echoed = await spawnCliRunner({...base, command: process.execPath, args: ['-e', 'process.stdin.pipe(process.stdout)']});
  assert.deepEqual({spawned: echoed.spawned, exitCode: echoed.exitCode, stdout: echoed.stdout, timedOut: echoed.timedOut}, {spawned: true, exitCode: 0, stdout: 'echo me', timedOut: false});
  const slow = await spawnCliRunner({...base, timeoutMs: 200, command: process.execPath, args: ['-e', 'setTimeout(()=>{},60000)']});
  assert.equal(slow.timedOut, true); assert.equal(slow.spawned, true);
  const loud = await spawnCliRunner({...base, command: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(5000))']});
  assert.equal(loud.overflow, true);
  const t0 = Date.now(), grandchild = await spawnCliRunner({...base, timeoutMs: 300, command: '/bin/sh', args: ['-c', 'sleep 5 & wait']});
  assert.equal(grandchild.timedOut, true); assert.ok(Date.now() - t0 < 2500, 'process group kill bounds the run');
  const split = await spawnCliRunner({...base, command: process.execPath, args: ['-e', 'const b=Buffer.from("한글");process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),50)']});
  assert.equal(split.stdout, '한글');
  const invalid = await spawnCliRunner({...base, command: process.execPath, args: ['-e', 'process.stdout.write(Buffer.from([0xff,0xfe]))']});
  assert.equal(invalid.overflow, true);
  const pre = new AbortController(); pre.abort();
  assert.deepEqual((({spawned, aborted}) => ({spawned, aborted}))(await spawnCliRunner({...base, signal: pre.signal, command: process.execPath, args: ['-e', '']})), {spawned: false, aborted: true});
  const missing = await spawnCliRunner({...base, command: '/nonexistent/massion-cli', args: []});
  assert.equal(missing.spawned, false);
  const controller = new AbortController(), pending = spawnCliRunner({...base, signal: controller.signal, command: process.execPath, args: ['-e', 'setTimeout(()=>{},60000)']});
  setTimeout(() => controller.abort(), 100);
  assert.equal((await pending).aborted, true);
});

test('overlapping identical provider invocations share one launch and the original outcome',async()=>{
 let sends=0;const adapter=cliProfileFactory('codex-cli/v1',{mode:'local-http-mock',runner:async()=>{sends++;await new Promise(r=>setTimeout(r,20));return ok(codex());}}).create(profile('codex-cli','codex-cli/v1','m'));
 const input=request(),[a,b]=await Promise.all([adapter.invoke(input),adapter.invoke(input)]);assert.equal(sends,1);assert.deepEqual(a,b);
 assert.deepEqual(await adapter.invoke(input),a);assert.equal(sends,1);
 const changed=await adapter.invoke({...input,instruction:'Different request'});assert.equal(changed.status,'failed');assert.equal(sends,1);
});

test('process timeout offers bounded cleanup before forced termination',async()=>{
 const {spawnCliRunner}=await import('../src/cli-agent-providers.ts');
 const result=await spawnCliRunner({command:process.execPath,args:['-e','process.on("SIGTERM",()=>{process.stdout.write("cleaned");process.exit(0)});setInterval(()=>{},1000)'],stdin:'',cwd:process.cwd(),env:{},timeoutMs:300,maxOutputBytes:1024,signal:signal()});
 assert.equal(result.timedOut,true);assert.equal(result.stdout,'cleaned');
});


test('group escalation kills a SIGTERM-ignoring descendant after the direct child closes', {skip:process.platform==='win32'},async t=>{
 const {spawnCliRunner}=await import('../src/cli-agent-providers.ts'),root=await mkdtemp(join(tempRoot(),'massion-descendant-')),ready=join(root,'ready');
 const controller=new AbortController();let descendant:number|undefined;
 const grandchild='process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)';
 const script='const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e",'+JSON.stringify(grandchild)+',process.argv[1]],{stdio:"ignore"});process.stdout.write(String(child.pid));setInterval(()=>{},1000)';
 const pending=spawnCliRunner({command:process.execPath,args:['-e',script,ready],stdin:'',cwd:process.cwd(),env:{},timeoutMs:5000,maxOutputBytes:1024,signal:controller.signal});
 t.after(async()=>{controller.abort();const result=await pending;const pid=descendant??Number(result.stdout);if(Number.isSafeInteger(pid)&&pid>0){try{process.kill(pid,'SIGKILL');}catch{}}await rm(root,{recursive:true,force:true});});
 const deadline=Date.now()+4000;
 while(descendant===undefined){try{descendant=Number(await readFile(ready,'utf8'));}catch{assert.ok(Date.now()<deadline,'descendant installed its SIGTERM handler');await new Promise(r=>setTimeout(r,10));}}
 assert.ok(Number.isSafeInteger(descendant)&&descendant>0);controller.abort();
 const result=await pending;assert.equal(result.aborted,true);assert.equal(Number(result.stdout),descendant);
 const running=()=>{try{return !execFileSync('/bin/ps',['-o','stat=','-p',String(descendant)],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim().startsWith('Z');}catch{return false;}};
 const stoppedBy=Date.now()+1500;while(running()&&Date.now()<stoppedBy)await new Promise(r=>setTimeout(r,20));
 assert.equal(running(),false,'process-group SIGKILL survives the direct child close');
});

test('launcher refusals before dispatch remain known failures through the CLI provider',async()=>{
 const {CliLauncher}=await import('../src/cli-launcher.ts'),{InMemorySecretSlots}=await import('../src/secret-slots.ts');
 for(const stage of ['prepare','recheck']){
  const sentinel='private-'+crypto.randomUUID();let starts=0;
  const adapter=cliProfileFactory('codex-cli/v1',{mode:'https',runner:async call=>{
   const launcher=new CliLauncher({command:process.execPath,args:call.args,environment:[],secrets:{},readOnly:true,signature:{teamId:'FIXTURE123',identifier:'test.fixture'}},new InMemorySecretSlots(),{
    prepare:async()=>{if(stage==='prepare')throw Error(sentinel);return ()=>{if(stage==='recheck')throw Error(sentinel);};},runner:async()=>{starts++;return ok(codex());}
   });
   return launcher.launch(call.invocationId!,{...call,command:process.execPath});
  }}).create(profile('codex-cli','codex-cli/v1','m'));
  const input=request(),outcome=await adapter.invoke(input);assert.equal(starts,0);assert.equal(outcome.status,'failed',stage);assert.equal(outcome.reason,'cli_unavailable_not_started');assert.equal(outcome.output,null);assert.ok(!JSON.stringify(outcome).includes(sentinel));
  assert.deepEqual(await adapter.invoke(input),outcome);assert.equal(starts,0);
 }
});
