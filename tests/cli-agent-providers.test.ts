import test from 'node:test';
import assert from 'node:assert/strict';
import {stat} from 'node:fs/promises';
import {cliProfileFactory,parseClaudeResult,parseCodexEvents} from '../src/cli-agent-providers.ts';
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
const profile = (providerKind: string, protocol: string, model: string): ModelConnectionProfile => ({
  id: 'profile-' + providerKind, label: model, backend: 'model-provider', providerKind, protocol, model, endpoint: 'cli://x/run', revision: 'v1', enabled: true,
  auth: {method: 'cli-login'}, capabilities: ['text-output'], usage: {inputTokens: 'reported', outputTokens: 'reported', cost: 'unknown'},
  limits: {maxInputBytes: 65536, maxOutputTokens: 64, maxResponseBytes: 65536, timeoutMs: 1000},
});

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
  assert.deepEqual(parseCodexEvents(codex(), 64), {status: 'completed', output: 'OK', usage: {inputTokens: 20224, outputTokens: 5}, reason: 'bounded_text_completion'});
  assert.equal(parseCodexEvents(codex([{type: 'error', message: 'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed'}, {type: 'agent_message', text: 'OK'}]), 64).status, 'completed');
  assert.equal(parseCodexEvents(codex([{type: 'error', message: 'Under-development features enabled'}, {type: 'agent_message', text: 'OK'}]), 64).reason, 'cli_error_event_remote_outcome_unknown');
  assert.equal(parseCodexEvents(codex().replace('{"type":"turn.completed"', '{"type":"error","message":"Reconnecting... 1/5"}\n{"type":"turn.completed"'), 64).status, 'unknown');
  assert.equal(parseCodexEvents(codex([{type: 'agent_message', text: '\ud800'}]), 64).reason, 'empty_output');
  assert.equal(parseCodexEvents(codex([{type: 'command_execution', command: 'ls'}, {type: 'agent_message', text: 'OK'}]), 64).reason, 'unsupported_tool_output');
  assert.equal(parseCodexEvents(codex([{type: 'agent_message', text: 'a'}, {type: 'agent_message', text: 'b'}]), 64).reason, 'unsupported_tool_output');
  assert.equal(parseCodexEvents(codex(undefined, {input_tokens: 1, output_tokens: 65}), 64).reason, 'invalid_or_unbounded_usage');
  assert.equal(parseCodexEvents('{"type":"thread.started"}\n{"type":"turn.failed"}', 64).status, 'unknown');
  assert.equal(parseCodexEvents('{"type":"thread.started"}', 64).status, 'unknown');
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
  assert.ok(x.args.includes('read-only') && x.args.includes('--ephemeral') && x.args.includes('--ignore-user-config') && x.args[x.args.indexOf('-m') + 1] === 'gpt-6.1-terra');
  for (const f of ['shell_tool', 'unified_exec', 'code_mode_host', 'browser_use', 'computer_use']) assert.ok(x.args.includes(`features.${f}=false`), f);
  assert.ok(x.args.includes('web_search="disabled"') && x.args.at(-1) === '-');
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
