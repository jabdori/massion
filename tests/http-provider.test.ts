import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { OpenAICompatibleChatAdapter, providerRequestId } from '../src/http-provider.ts';
import type { OpenAICompatibleChatConfig, HttpProviderTransport } from '../src/http-provider.ts';
import { ProviderRegistry } from '../src/providers.ts';
import type { ProviderRequest } from '../src/providers.ts';

const bounds = { maxInputBytes: 4096, maxOutputTokens: 32, maxResponseBytes: 4096, timeoutMs: 1000 };
const emptyUsage = { inputTokens: null, outputTokens: null };
const request = (overrides: Partial<ProviderRequest> = {}): ProviderRequest => ({
  invocationId: 'invocation-one', workId: 'work-one', instruction: 'Write a short answer.', inputReferences: [], signal: new AbortController().signal, ...overrides,
});
const config = (endpoint = 'http://127.0.0.1:1/v1/chat/completions', transport: HttpProviderTransport = async () => { throw new Error('Unexpected transport dispatch'); }): OpenAICompatibleChatConfig => ({
  provider: 'local-test', model: 'pinned-model-2026-10-03', configVersion: 'test-v1', endpoint,
  enabled: true, transportMode: 'local-http-mock', bounds: { ...bounds }, transport,
  authorization: { provider: 'local-test', model: 'pinned-model-2026-10-03', configVersion: 'test-v1', endpoint, maxInputBytes: bounds.maxInputBytes, maxOutputTokens: bounds.maxOutputTokens },
});
const completion = () => ({
  id: 'chatcmpl-test', object: 'chat.completion', created: 1, model: 'pinned-model-2026-10-03',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'A bounded answer.', refusal: null } }],
  usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
});
function sendJson(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}
async function server(t: TestContext, handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const instance = createServer(handler);
  await new Promise<void>((resolve, reject) => { instance.once('error', reject); instance.listen(0, '127.0.0.1', resolve); });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => { instance.close(error => error ? reject(error) : resolve()); instance.closeAllConnections(); });
  });
  const address = instance.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}/v1/chat/completions`;
}

test('loopback mock performs one bounded Chat Completions POST with a deterministic correlation header', async t => {
  let calls = 0;
  let captured: { method?: string; path?: string; headers: IncomingMessage['headers']; body: unknown } | undefined;
  const endpoint = await server(t, (incoming, response) => {
    calls++;
    let body = '';
    incoming.on('data', chunk => { body += String(chunk); });
    incoming.on('end', () => { captured = { method: incoming.method, path: incoming.url, headers: incoming.headers, body: JSON.parse(body) }; sendJson(response, completion()); });
  });
  const adapter = new OpenAICompatibleChatAdapter(config(endpoint, fetch));
  const result = await adapter.invoke(request({ maxOutputTokens: 8, inputReferences: ['source://one'] }));
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'A bounded answer.');
  assert.deepEqual(result.usage, { inputTokens: 5, outputTokens: 4 });
  assert.equal(calls, 1);
  assert.ok(captured);
  assert.equal(captured.method, 'POST');
  assert.equal(captured.path, '/v1/chat/completions');
  assert.equal(captured.headers['x-client-request-id'], providerRequestId('invocation-one'));
  assert.equal(captured.headers.authorization, undefined);
  assert.equal(captured.headers.cookie, undefined);
  assert.deepEqual(captured.body, {
    model: 'pinned-model-2026-10-03', messages: [{ role: 'user', content: 'Write a short answer.\n\nInput references (identifiers only; their contents have not been loaded):\n["source://one"]' }],
    max_completion_tokens: 8, n: 1, stream: false, store: false,
  });
  assert.equal(adapter.descriptor.evidenceClass, 'fixture');
  assert.equal(result.evidence.executionEvidence, 'local-http-mock');
  assert.equal(result.evidence.realProviderVerified, false);
  assert.equal(new ProviderRegistry([adapter]).select(['text-output']).status, 'unavailable');
});

test('disabled, missing or mismatched authorization cannot dispatch', async t => {
  for (const variant of ['enabled-omitted', 'disabled', 'missing', 'provider', 'model', 'configVersion', 'endpoint', 'input-cap', 'output-cap']) {
    await t.test(variant, async () => {
      let calls = 0;
      const c = config(undefined, async () => { calls++; throw new Error('must not run'); });
      if (variant === 'enabled-omitted') delete c.enabled;
      else if (variant === 'disabled') c.enabled = false;
      else if (variant === 'missing') delete c.authorization;
      else if (variant === 'input-cap') c.authorization!.maxInputBytes--;
      else if (variant === 'output-cap') c.authorization!.maxOutputTokens--;
      else c.authorization![variant as 'provider' | 'model' | 'configVersion' | 'endpoint'] = 'mismatch';
      const adapter = new OpenAICompatibleChatAdapter(c);
      assert.equal(adapter.descriptor.enabled, false);
      assert.equal((await adapter.invoke(request())).status, 'failed');
      assert.equal(calls, 0);
    });
  }
});

test('remote route is HTTPS-only, pinned and opt-in; constructing it never makes a live call', () => {
  const c = config('https://provider.example/v1/chat/completions');
  c.transportMode = 'https';
  const adapter = new OpenAICompatibleChatAdapter(c);
  assert.equal(adapter.descriptor.enabled, true);
  assert.equal(adapter.descriptor.evidenceClass, 'real-provider');
  assert.equal(adapter.evidence.executionEvidence, 'unverified-provider-transport');
  assert.equal(adapter.evidence.realProviderVerified, false);
  c.authorization!.model = 'changed';
  c.bounds.maxOutputTokens = 999;
  c.endpoint = 'https://changed.example/v1/chat/completions';
  assert.equal(adapter.descriptor.model, 'pinned-model-2026-10-03');
  assert.ok(Object.isFrozen(adapter));
  assert.ok(Object.isFrozen(adapter.descriptor));
  assert.ok(Object.isFrozen(adapter.descriptor.capabilities));
  assert.ok(Object.isFrozen(adapter.evidence));
});

test('invalid endpoint forms and bounds are rejected without transport or credential lookup', () => {
  const invalidEndpoints = [
    'http://provider.example/v1/chat/completions', 'https://user:secret@provider.example/v1/chat/completions',
    'https://provider.example/v1/chat/completions?token=secret', 'https://provider.example/v1/chat/completions?',
    'https://provider.example/v1/chat/completions#secret', 'https://provider.example/v1/chat/completions#',
    'https://provider.example/v1/chat/completions\n', 'https://provider.example/v1/../chat/completions',
    'https://provider.example/v1/responses', 'https://provider.example\\v1/chat/completions',
  ];
  for (const endpoint of invalidEndpoints) assert.throws(() => new OpenAICompatibleChatAdapter({ ...config(endpoint), transportMode: 'https' }));
  for (const endpoint of ['http://localhost:1234/v1/chat/completions', 'http://127.0.0.2:1234/v1/chat/completions', 'http://127.1:1234/v1/chat/completions', 'http://127.0.0.1/v1/chat/completions', 'http://127.0.0.1:0/v1/chat/completions', 'https://127.0.0.1:1234/v1/chat/completions']) {
    assert.throws(() => new OpenAICompatibleChatAdapter(config(endpoint)));
  }
  for (const key of Object.keys(bounds) as (keyof typeof bounds)[]) {
    for (const value of [0, -1, Infinity, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => new OpenAICompatibleChatAdapter({ ...config(), bounds: { ...bounds, [key]: value } }));
    }
  }
  assert.throws(() => new OpenAICompatibleChatAdapter({ ...config(), bounds: { ...bounds, timeoutMs: 2_147_483_648 } }));
});

test('input cap counts UTF-8 request bytes and request output limits may only tighten', async () => {
  let calls = 0;
  const adapter = new OpenAICompatibleChatAdapter(config(undefined, async () => { calls++; throw new Error('must not run'); }));
  for (const override of [{ instruction: 'é'.repeat(2100) }, { maxOutputTokens: 33 }, { maxOutputTokens: 0 }, { maxOutputTokens: 1.5 }, { instruction: ' ' }, { invocationId: '' }]) {
    const result = await adapter.invoke(request(override));
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.usage, emptyUsage);
  }
  assert.equal(calls, 0);
});

test('a pre-dispatch abort is cancelled with no HTTP request and unknown usage', async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const adapter = new OpenAICompatibleChatAdapter(config(undefined, async () => { calls++; throw new Error('must not run'); }));
  const result = await adapter.invoke(request({ signal: controller.signal }));
  assert.equal(result.status, 'cancelled');
  assert.equal(result.reason, 'cancelled_before_dispatch');
  assert.deepEqual(result.usage, emptyUsage);
  assert.equal(calls, 0);
});

test('abort after the mock receives the request is unknown, never a safe cancellation or retry', async t => {
  const controller = new AbortController();
  let calls = 0;
  const endpoint = await server(t, (incoming, _response) => { calls++; incoming.resume(); controller.abort(); });
  const result = await new OpenAICompatibleChatAdapter(config(endpoint, fetch)).invoke(request({ signal: controller.signal }));
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'cancelled_after_dispatch');
  assert.deepEqual(result.usage, emptyUsage);
  assert.equal(calls, 1);
});

test('timeout bounds even an injected transport that ignores abort; no auto retries', async () => {
  let calls = 0;
  let passedSignal: AbortSignal | null | undefined;
  const c = config(undefined, async (_url, init) => { calls++; passedSignal = init.signal; return new Promise<Response>(() => {}); });
  c.bounds.timeoutMs = 15;
  const result = await new OpenAICompatibleChatAdapter(c).invoke(request());
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'timeout_after_dispatch');
  assert.deepEqual(result.usage, emptyUsage);
  assert.equal(calls, 1);
  assert.equal(passedSignal?.aborted, true);
});

test('synchronous transport errors are unknown and never expose error messages or secrets', async () => {
  let calls = 0;
  const c = config(undefined, () => { calls++; throw new Error('private transport credentials'); });
  const result = await new OpenAICompatibleChatAdapter(c).invoke(request());
  assert.equal(result.status, 'unknown');
  assert.deepEqual(result.usage, emptyUsage);
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(result).includes('private transport credentials'));
});

test('all HTTP error classes retain unknown remote outcome and do not retry', async t => {
  let status = 400;
  let calls = 0;
  const endpoint = await server(t, (_incoming, response) => { calls++; sendJson(response, { error: { message: 'private provider error' } }, status); });
  const adapter = new OpenAICompatibleChatAdapter(config(endpoint, fetch));
  for (const code of [400, 401, 403, 408, 429, 500, 502, 503]) {
    status = code;
    const result = await adapter.invoke(request({ invocationId: `http-${code}` }));
    assert.equal(result.status, 'unknown');
    assert.deepEqual(result.usage, emptyUsage);
    assert.equal(result.reason, `http_${code}_remote_outcome_unknown`);
    assert.ok(!JSON.stringify(result).includes('private provider error'));
  }
  assert.equal(calls, 8);
});

test('redirects are rejected without dispatching to the redirect target', async t => {
  let targetCalls = 0;
  const target = await server(t, (_incoming, response) => { targetCalls++; sendJson(response, completion()); });
  let sourceCalls = 0;
  const endpoint = await server(t, (_incoming, response) => { sourceCalls++; response.writeHead(307, { location: target }); response.end(); });
  const result = await new OpenAICompatibleChatAdapter(config(endpoint, fetch)).invoke(request());
  assert.equal(result.status, 'unknown');
  assert.equal(sourceCalls, 1);
  assert.equal(targetCalls, 0);
  assert.deepEqual(result.usage, emptyUsage);
});

test('invalid content type, JSON, UTF-8 and oversized bodies never become completed output', async t => {
  let mode = 'html';
  const endpoint = await server(t, (_incoming, response) => {
    response.setHeader('content-type', mode === 'html' ? 'text/html' : 'application/json');
    if (mode === 'html') response.end('<html>not JSON</html>');
    else if (mode === 'json') response.end('{');
    else if (mode === 'utf8') response.end(Buffer.from([0xff]));
    else if (mode === 'content-length') { response.setHeader('content-length', '10000'); response.end('x'); }
    else { response.write(' '.repeat(3000)); response.end(' '.repeat(3000)); }
  });
  for (const current of ['html', 'json', 'utf8', 'content-length', 'stream-limit']) {
    mode = current;
    const result = await new OpenAICompatibleChatAdapter(config(endpoint, fetch)).invoke(request({ invocationId: `invalid-${current}` }));
    assert.equal(result.status, 'unknown', current);
    assert.deepEqual(result.usage, emptyUsage);
  }
});

test('malformed completion/usage/schema is unknown with nullable accounting', async t => {
  const cases: [string, (value: ReturnType<typeof completion>) => unknown][] = [
    ['array', () => []], ['missing-id', v => ({ ...v, id: undefined })], ['object-type', v => ({ ...v, object: 'chat.completion.chunk' })],
    ['wrong-model', v => ({ ...v, model: 'unapproved-model' })], ['created', v => ({ ...v, created: -1 })],
    ['no-choice', v => ({ ...v, choices: [] })], ['two-choices', v => ({ ...v, choices: [v.choices[0], v.choices[0]] })],
    ['wrong-role', v => ({ ...v, choices: [{ ...v.choices[0], message: { role: 'user', content: 'hello' } }] })],
    ['choice-index', v => ({ ...v, choices: [{ ...v.choices[0], index: 1 }] })],
    ['missing-finish', v => ({ ...v, choices: [{ ...v.choices[0], finish_reason: null }] })],
    ['content-object', v => ({ ...v, choices: [{ ...v.choices[0], message: { role: 'assistant', content: {} } }] })],
    ['no-usage', v => ({ ...v, usage: undefined })], ['string-count', v => ({ ...v, usage: { ...v.usage, completion_tokens: '4' } })],
    ['negative-count', v => ({ ...v, usage: { ...v.usage, prompt_tokens: -1 } })], ['fractional-count', v => ({ ...v, usage: { ...v.usage, completion_tokens: 1.5 } })],
    ['total-mismatch', v => ({ ...v, usage: { ...v.usage, total_tokens: 100 } })],
    ['unsafe-count', v => ({ ...v, usage: { ...v.usage, prompt_tokens: Number.MAX_SAFE_INTEGER + 1 } })],
    ['output-over-cap', v => ({ ...v, usage: { prompt_tokens: 1, completion_tokens: 33, total_tokens: 34 } })],
  ];
  let payload: unknown = {};
  const endpoint = await server(t, (_incoming, response) => sendJson(response, payload));
  const adapter = new OpenAICompatibleChatAdapter(config(endpoint, fetch));
  for (const [name, transform] of cases) {
    payload = transform(completion());
    const result = await adapter.invoke(request({ invocationId: name }));
    assert.equal(result.status, 'unknown', name);
    assert.equal(result.output, null, name);
    assert.deepEqual(result.usage, emptyUsage, name);
  }
});

test('refused, truncated, filtered, tool and empty outputs fail with validated measured usage', async t => {
  const cases: [string, string, unknown, unknown, string][] = [
    ['refusal', 'stop', null, 'Cannot do this.', 'provider_refusal'],
    ['truncation', 'length', 'Partial text', null, 'output_truncated'],
    ['filtered', 'content_filter', null, null, 'output_filtered'],
    ['tools', 'tool_calls', null, null, 'unsupported_tool_output'],
    ['empty', 'stop', '', null, 'empty_output'], ['whitespace', 'stop', '   ', null, 'empty_output'],
  ];
  let payload: unknown = {};
  const endpoint = await server(t, (_incoming, response) => sendJson(response, payload));
  const adapter = new OpenAICompatibleChatAdapter(config(endpoint, fetch));
  for (const [name, finish, content, refusal, expected] of cases) {
    const value = completion();
    payload = { ...value, choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content, refusal } }] };
    const result = await adapter.invoke(request({ invocationId: name }));
    assert.equal(result.status, 'failed', name);
    assert.equal(result.reason, expected, name);
    assert.equal(result.output, null);
    assert.deepEqual(result.usage, { inputTokens: 5, outputTokens: 4 });
  }
});

test('response-body interruption and timeout after headers remain unknown', async t => {
  let mode = 'disconnect';
  const endpoint = await server(t, (_incoming, response) => {
    response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"id":');
    if (mode === 'disconnect') response.destroy();
  });
  const c = config(endpoint, fetch); c.bounds.timeoutMs = 30;
  const adapter = new OpenAICompatibleChatAdapter(c);
  for (const current of ['disconnect', 'timeout']) {
    mode = current;
    const result = await adapter.invoke(request({ invocationId: current }));
    assert.equal(result.status, 'unknown');
    assert.deepEqual(result.usage, emptyUsage);
  }
});

test('request ID is deterministic, bounded ASCII and does not expose invocation identity', () => {
  assert.match(providerRequestId('private-invocation'), /^massion-[a-f0-9]{64}$/);
  assert.equal(providerRequestId('private-invocation'), providerRequestId('private-invocation'));
  assert.notEqual(providerRequestId('private-invocation'), providerRequestId('different-invocation'));
  assert.throws(() => providerRequestId('bad\nheader'));
});

test('untyped null caps, sparse reference lists and malformed authorization cannot broaden dispatch', async () => {
  let calls = 0;
  const c = config(undefined, async () => { calls++; throw new Error('must not run'); });
  const adapter = new OpenAICompatibleChatAdapter(c);
  assert.equal((await adapter.invoke(request({ maxOutputTokens: null as unknown as number }))).status, 'failed');
  assert.equal((await adapter.invoke(request({ inputReferences: new Array<string>(1) }))).status, 'failed');
  c.authorization = null as unknown as OpenAICompatibleChatConfig['authorization'];
  const disabled = new OpenAICompatibleChatAdapter(c);
  assert.equal(disabled.descriptor.enabled, false);
  assert.equal((await disabled.invoke(request())).status, 'failed');
  assert.equal(calls, 0);
});

test('the exact full serialized UTF-8 byte cap is inclusive and configuration is snapshotted', async () => {
  let calls = 0;
  const body = JSON.stringify({ model: 'pinned-model-2026-10-03', messages: [{ role: 'user', content: 'é' }], max_completion_tokens: 32, n: 1, stream: false, store: false });
  const expectedBytes = Buffer.byteLength(body, 'utf8');
  const c = config(undefined, async (_url, init) => {
    calls++;
    assert.equal(init.body, body);
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    return new Response(JSON.stringify(completion()), { status: 200, headers: { 'content-type': 'application/json; charset="UTF-8"' } });
  });
  c.bounds.maxInputBytes = expectedBytes;
  const adapter = new OpenAICompatibleChatAdapter(c);
  c.bounds.maxOutputTokens = 999;
  c.transport = async () => { throw new Error('mutated caller config must not be used'); };
  assert.equal((await adapter.invoke(request({ instruction: 'é' }))).status, 'completed');
  assert.equal((await adapter.invoke(request({ instruction: 'éa' }))).reason, 'input_byte_limit');
  assert.equal((await adapter.invoke(request({ instruction: 'é', maxOutputTokens: 33 }))).status, 'failed');
  assert.equal(calls, 1);
});

test('non-null refusal and hidden tool output cannot become a stop success', async t => {
  let message: unknown;
  const endpoint = await server(t, (_incoming, response) => {
    const body = completion();
    sendJson(response, { ...body, choices: [{ index: 0, finish_reason: 'stop', message }] });
  });
  const adapter = new OpenAICompatibleChatAdapter(config(endpoint, fetch));
  for (const details of [{ refusal: '' }, { tool_calls: [{ id: 'tool-one' }] }, { function_call: { name: 'tool' } }]) {
    message = { role: 'assistant', content: 'Not a valid plain answer', ...details };
    assert.equal((await adapter.invoke(request())).status, 'failed');
  }
});

test('valid reported zero usage is preserved rather than confused with missing usage', async () => {
  const c = config(undefined, async () => {
    const body = completion();
    return new Response(JSON.stringify({ ...body, choices: [{ index: 0, finish_reason: 'content_filter', message: { role: 'assistant', content: null } }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }), { headers: { 'content-type': 'application/json' } });
  });
  const result = await new OpenAICompatibleChatAdapter(c).invoke(request());
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0 });
});
