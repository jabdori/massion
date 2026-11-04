import test from 'node:test';
import assert from 'node:assert/strict';
import { renderChatCompletionsBody } from '../src/chat-request-renderer.ts';
import { OpenAICompatibleChatAdapter } from '../src/http-provider.ts';
import type { OpenAICompatibleChatConfig, HttpProviderTransport } from '../src/http-provider.ts';
import { chatProfileFactory } from '../src/chat-profile-factory.ts';
import type { ModelConnectionProfile } from '../src/provider-profiles.ts';
import { parseHostManifest } from '../src/host-connections.ts';
import { MODEL_PROVIDER_TYPES } from '../src/connection-workbench.ts';

const endpoint = 'http://127.0.0.1:9/v4/chat/completions';
const bounds = { maxInputBytes: 4096, maxOutputTokens: 64, maxResponseBytes: 4096, timeoutMs: 1000 };
const request = { invocationId: 'zai-one', workId: 'work-one', instruction: 'Answer.', inputReferences: [], signal: new AbortController().signal, maxOutputTokens: 64 };
// Shape observed from the Z.ai Coding Plan endpoint on 2026-11-04 (reasoning_content is ignored).
const zaiCompletion = (completionTokens = 34) => ({
  choices: [{ finish_reason: 'stop', index: 0, message: { content: 'OK', reasoning_content: 'private reasoning', role: 'assistant' } }],
  created: 1793786160, id: 'zai-response', model: 'glm-5.3', object: 'chat.completion', request_id: 'zai-response',
  usage: { completion_tokens: completionTokens, completion_tokens_details: { reasoning_tokens: 0 }, prompt_tokens: 17, prompt_tokens_details: { cached_tokens: 0 }, total_tokens: 17 + completionTokens },
});
function capture(body: unknown): { transport: HttpProviderTransport; sent: () => unknown } {
  let sent: unknown;
  return { sent: () => sent, transport: async (_url, init) => { sent = JSON.parse(String(init.body)); return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json; charset=UTF-8' } }); } };
}
const config = (transport: HttpProviderTransport, dialect?: OpenAICompatibleChatConfig['dialect']): OpenAICompatibleChatConfig => ({
  provider: 'zai', model: 'glm-5.3', configVersion: 'v1', endpoint, enabled: true, transportMode: 'local-http-mock', bounds, transport,
  authorization: { provider: 'zai', model: 'glm-5.3', configVersion: 'v1', endpoint, maxInputBytes: bounds.maxInputBytes, maxOutputTokens: bounds.maxOutputTokens },
  ...(dialect ? { dialect } : {}),
});

test('zai dialect bounds output with max_tokens and low reasoning; openai bytes are unchanged', () => {
  assert.equal(renderChatCompletionsBody('glm-5.3', 'literal', [], 8, 'zai'),
    '{"model":"glm-5.3","messages":[{"role":"user","content":"literal"}],"max_tokens":8,"reasoning_effort":"low","n":1,"stream":false}');
  assert.equal(renderChatCompletionsBody('exact', 'literal', [], 8),
    '{"model":"exact","messages":[{"role":"user","content":"literal"}],"max_completion_tokens":8,"n":1,"stream":false,"store":false}');
});

test('zai dialect completes the observed response shape under the existing strict parser', async () => {
  const c = capture(zaiCompletion());
  const result = await new OpenAICompatibleChatAdapter(config(c.transport, 'zai')).invoke(request);
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'OK');
  assert.deepEqual(result.usage, { inputTokens: 17, outputTokens: 34 });
  assert.deepEqual(c.sent(), { model: 'glm-5.3', messages: [{ role: 'user', content: 'Answer.' }], max_tokens: 64, reasoning_effort: 'low', n: 1, stream: false });
});

test('zai usage above the cap stays an unknown outcome with no measured usage', async () => {
  const result = await new OpenAICompatibleChatAdapter(config(capture(zaiCompletion(1042)).transport, 'zai')).invoke(request);
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'invalid_or_unbounded_usage');
  assert.deepEqual(result.usage, { inputTokens: null, outputTokens: null });
});

test('unknown dialect is rejected at construction', () => {
  assert.throws(() => new OpenAICompatibleChatAdapter(config(capture({}).transport, 'other' as never)));
});

test('only the zai preset profile selects the zai dialect', async () => {
  const profile = (providerKind: string): ModelConnectionProfile => ({
    id: 'profile-' + providerKind, label: 'GLM', backend: 'model-provider', providerKind, protocol: 'openai-chat-completions/v1', model: 'glm-5.3', endpoint,
    revision: 'v1', enabled: true, auth: { method: 'none' }, capabilities: ['text-output'], usage: { inputTokens: 'reported', outputTokens: 'reported', cost: 'unknown' }, limits: bounds,
  });
  for (const [kind, key] of [['zai', 'max_tokens'], ['compatible', 'max_completion_tokens']] as const) {
    const c = capture(zaiCompletion());
    const factory = chatProfileFactory({ mode: 'local-http-mock', transport: c.transport });
    assert.deepEqual(factory.validate(profile(kind)), []);
    assert.equal((await factory.create(profile(kind)).invoke(request)).status, 'completed');
    assert.ok(Object.hasOwn(c.sent() as object, key), kind + ' sends ' + key);
  }
});

test('host manifest pins the zai preset to its official Coding Plan base URL', () => {
  const preset = MODEL_PROVIDER_TYPES.find(p => p.id === 'zai')!;
  assert.equal(preset.baseUrl, 'https://api.z.ai/api/coding/paas/v4/');
  const manifest = (baseUrl: string) => ({ version: 1, revision: 'r1', mode: 'https', connections: [{
    id: 'zai', label: 'GLM', providerType: 'zai', baseUrl, models: ['glm-5.3'], credential: { ref: 'zai-ref', environment: 'Z_AI_API_KEY' } }] });
  assert.equal(parseHostManifest(manifest(preset.baseUrl)).connections[0]!.providerType, 'zai');
  assert.throws(() => parseHostManifest(manifest('https://api.z.ai/api/paas/v4/')));
});
