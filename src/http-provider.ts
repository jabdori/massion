/** A deliberately narrow, opt-in OpenAI-compatible Chat Completions adapter. */
import { createHash } from 'node:crypto';
import type { ProviderAdapter, ProviderDescriptor, ProviderOutcome, ProviderRequest } from './providers.ts';

export interface HttpProviderBounds {
  /** UTF-8 bytes of the entire serialized request body, including protocol overhead. */
  maxInputBytes: number;
  maxOutputTokens: number;
  /** Decoded HTTP response bytes; distinct from model output tokens. */
  maxResponseBytes: number;
  timeoutMs: number;
}
/** An application-supplied authorization record, never a credential. */
export interface HttpProviderAuthorization {
  provider: string;
  model: string;
  configVersion: string;
  endpoint: string;
  maxInputBytes: number;
  maxOutputTokens: number;
}
/** Trusted caller integration: honor redirect/error, abort, endpoint and single-send semantics. */
export type HttpProviderTransport = (url: string, init: RequestInit) => Promise<Response>;
export interface OpenAICompatibleChatConfig {
  provider: string;
  model: string;
  configVersion: string;
  /** Full, canonical Chat Completions endpoint; no base-URL discovery or suffix insertion. */
  endpoint: string;
  enabled?: boolean;
  transportMode: 'https' | 'local-http-mock';
  bounds: HttpProviderBounds;
  authorization?: HttpProviderAuthorization;
  transport: HttpProviderTransport;
}
export interface HttpProviderEvidence {
  protocol: 'openai-chat-completions';
  transportMode: 'https' | 'local-http-mock';
  evidenceClass: 'fixture' | 'real-provider';
  executionEvidence: 'local-http-mock' | 'unverified-provider-transport';
  /** Configuration and protocol parsing never constitute independent live-provider verification. */
  realProviderVerified: false;
}
export interface HttpProviderOutcome extends ProviderOutcome {
  evidence: Readonly<HttpProviderEvidence>;
}
const unknownUsage = () => ({ inputTokens: null, outputTokens: null });
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const positive = (value: unknown): value is number => integer(value) && value > 0;
const label = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);

class ProtocolFailure extends Error {
  constructor(code: string) { super(code); }
}
function validateEndpoint(endpoint: string, mode: OpenAICompatibleChatConfig['transportMode']): void {
  if (typeof endpoint !== 'string' || endpoint.length > 2048 || /[?#\\\s]/.test(endpoint)) {
    throw new Error('Invalid provider endpoint: queries, fragments, whitespace and backslashes are forbidden.');
  }
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error('Invalid provider endpoint.'); }
  if (url.href !== endpoint || url.username || url.password || !url.pathname.endsWith('/chat/completions')) {
    throw new Error('Provider endpoint must be canonical, credential-free and end with /chat/completions.');
  }
  if (mode === 'https' && url.protocol === 'https:') return;
  if (mode === 'local-http-mock' && url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && Number(url.port) > 0) return;
  throw new Error('Provider endpoint requires HTTPS, or explicit local-http-mock mode at 127.0.0.1 with a port.');
}
function authorized(config: OpenAICompatibleChatConfig): boolean {
  const a = config.authorization;
  return config.enabled === true && isRecord(a) &&
    a.provider === config.provider && a.model === config.model && a.configVersion === config.configVersion && a.endpoint === config.endpoint &&
    positive(a.maxInputBytes) && positive(a.maxOutputTokens) &&
    config.bounds.maxInputBytes <= a.maxInputBytes && config.bounds.maxOutputTokens <= a.maxOutputTokens;
}
/** Correlation only: the protocol does NOT guarantee provider-side idempotency. */
export function providerRequestId(invocationId: string): string {
  if (!label(invocationId)) throw new Error('Invalid invocation ID.');
  return `massion-${createHash('sha256').update(invocationId, 'utf8').digest('hex')}`;
}
async function readBoundedJson(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || !integer(Number(length)) || Number(length) > maxBytes)) {
    throw new ProtocolFailure('invalid_or_oversized_content_length');
  }
  if (!response.body) throw new ProtocolFailure('missing_response_body');
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new ProtocolFailure('response_byte_limit');
      chunks.push(chunk.value);
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))); }
    catch { throw new ProtocolFailure('invalid_response_json'); }
  } finally {
    signal.removeEventListener('abort', cancel);
    // Do not wait indefinitely for an uncooperative transport while cancelling a read.
    cancel();
    reader.releaseLock();
  }
}
function parseCompletion(body: unknown, model: string, maxTokens: number): ProviderOutcome {
  if (!isRecord(body) || body.object !== 'chat.completion' || !label(body.id) || !integer(body.created) || body.model !== model ||
      body.error !== undefined || !Array.isArray(body.choices) || body.choices.length !== 1) {
    throw new ProtocolFailure('invalid_completion_schema');
  }
  const choice: unknown = body.choices[0];
  if (!isRecord(choice) || choice.index !== 0 || !isRecord(choice.message) || choice.message.role !== 'assistant' ||
      !['stop', 'length', 'content_filter', 'tool_calls', 'function_call'].includes(String(choice.finish_reason))) {
    throw new ProtocolFailure('invalid_choice_schema');
  }
  const message = choice.message;
  if ((message.content !== null && typeof message.content !== 'string') ||
      (message.refusal !== undefined && message.refusal !== null && typeof message.refusal !== 'string') ||
      (message.tool_calls !== undefined && !Array.isArray(message.tool_calls))) {
    throw new ProtocolFailure('invalid_message_schema');
  }
  const usage = body.usage;
  if (!isRecord(usage) || !integer(usage.prompt_tokens) || !integer(usage.completion_tokens) || !integer(usage.total_tokens) ||
      !Number.isSafeInteger(usage.prompt_tokens + usage.completion_tokens) || usage.total_tokens !== usage.prompt_tokens + usage.completion_tokens ||
      usage.completion_tokens > maxTokens) {
    throw new ProtocolFailure('invalid_or_unbounded_usage');
  }
  const measured = { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens };
  const failure = (reason: string): ProviderOutcome => ({ status: 'failed', output: null, usage: measured, reason });
  if (typeof message.refusal === 'string') return failure('provider_refusal');
  if (choice.finish_reason === 'length') return failure('output_truncated');
  if (choice.finish_reason === 'content_filter') return failure('output_filtered');
  if (choice.finish_reason !== 'stop' || message.function_call != null || (Array.isArray(message.tool_calls) && message.tool_calls.length > 0)) return failure('unsupported_tool_output');
  if (typeof message.content !== 'string' || message.content.trim().length === 0) return failure('empty_output');
  return { status: 'completed', output: message.content, usage: measured, reason: 'bounded_text_completion' };
}

export class OpenAICompatibleChatAdapter implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  readonly evidence: Readonly<HttpProviderEvidence>;
  readonly #endpoint: string;
  readonly #model: string;
  readonly #bounds: Readonly<HttpProviderBounds>;
  readonly #transport: HttpProviderTransport;
  readonly #enabled: boolean;

  constructor(config: OpenAICompatibleChatConfig) {
    if (!config || !label(config.provider) || !label(config.model) || !label(config.configVersion) || typeof config.transport !== 'function' ||
        (config.enabled !== undefined && typeof config.enabled !== 'boolean') || !config.bounds ||
        !positive(config.bounds.maxInputBytes) || !positive(config.bounds.maxOutputTokens) || !positive(config.bounds.maxResponseBytes) ||
        !positive(config.bounds.timeoutMs) || config.bounds.timeoutMs > 2_147_483_647) throw new Error('Invalid provider configuration or bounds.');
    validateEndpoint(config.endpoint, config.transportMode);
    this.#endpoint = config.endpoint;
    this.#model = config.model;
    this.#bounds = Object.freeze({ ...config.bounds });
    this.#transport = config.transport;
    this.#enabled = authorized(config);
    const fixture = config.transportMode === 'local-http-mock';
    this.descriptor = Object.freeze({
      provider: config.provider, model: config.model, configVersion: config.configVersion, enabled: this.#enabled,
      capabilities: Object.freeze(['text-output']), evidenceClass: fixture ? 'fixture' : 'real-provider',
    });
    this.evidence = Object.freeze({ protocol: 'openai-chat-completions', transportMode: config.transportMode,
      evidenceClass: fixture ? 'fixture' : 'real-provider', executionEvidence: fixture ? 'local-http-mock' : 'unverified-provider-transport', realProviderVerified: false });
    Object.freeze(this);
  }

  async invoke(request: ProviderRequest): Promise<HttpProviderOutcome> {
    const outcome = (status: ProviderOutcome['status'], reason: string): HttpProviderOutcome =>
      ({ status, output: null, usage: unknownUsage(), reason, evidence: this.evidence });
    if (!request || !(request.signal instanceof AbortSignal)) return outcome('failed', 'invalid_request');
    if (request.signal.aborted) return outcome('cancelled', 'cancelled_before_dispatch');
    if (!this.#enabled) return outcome('failed', 'provider_not_explicitly_authorized');
    const maxTokens = request.maxOutputTokens === undefined ? this.#bounds.maxOutputTokens : request.maxOutputTokens;
    if (!label(request.invocationId) || !label(request.workId) || typeof request.instruction !== 'string' || !request.instruction.trim() ||
        !Array.isArray(request.inputReferences) || ![...request.inputReferences].every(reference => typeof reference === 'string') ||
        !positive(maxTokens) || maxTokens > this.#bounds.maxOutputTokens) return outcome('failed', 'invalid_request_or_output_bound');
    // References are transmitted only as literal identifiers. No URL, filesystem or account lookup occurs.
    const content = request.inputReferences.length === 0 ? request.instruction :
      `${request.instruction}\n\nInput references (identifiers only; their contents have not been loaded):\n${JSON.stringify(request.inputReferences)}`;
    const body = JSON.stringify({ model: this.#model, messages: [{ role: 'user', content }], max_completion_tokens: maxTokens, n: 1, stream: false, store: false });
    if (Buffer.byteLength(body, 'utf8') > this.#bounds.maxInputBytes) return outcome('failed', 'input_byte_limit');
    if (request.signal.aborted) return outcome('cancelled', 'cancelled_before_dispatch');

    const controller = new AbortController();
    let abortReason = 'cancelled_after_dispatch';
    const cancel = () => controller.abort();
    request.signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => { abortReason = 'timeout_after_dispatch'; controller.abort(); }, this.#bounds.timeoutMs);
    let rejectAborted: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = () => reject(new ProtocolFailure(abortReason)); });
    controller.signal.addEventListener('abort', rejectAborted, { once: true });
    try {
      // The call boundary is conservatively the dispatch boundary, even if transport throws synchronously.
      const operation = (async (): Promise<HttpProviderOutcome> => {
        const response = await this.#transport(this.#endpoint, {
          method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal,
          headers: { 'content-type': 'application/json', accept: 'application/json', 'x-client-request-id': providerRequestId(request.invocationId) }, body,
        });
        controller.signal.throwIfAborted();
        if (!(response instanceof Response)) throw new ProtocolFailure('invalid_http_response');
        if (response.redirected || (response.url && response.url !== this.#endpoint)) throw new ProtocolFailure('redirect_or_endpoint_mismatch');
        if (response.status !== 200) {
          // HTTP errors may be produced by a proxy after remote execution; they prove neither no effect nor zero usage.
          void response.body?.cancel().catch(() => {});
          throw new ProtocolFailure(`http_${response.status}_remote_outcome_unknown`);
        }
        if (!/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?\s*$/i.test(response.headers.get('content-type') ?? '')) throw new ProtocolFailure('invalid_response_content_type');
        const parsed = await readBoundedJson(response, this.#bounds.maxResponseBytes, controller.signal);
        controller.signal.throwIfAborted();
        return { ...parseCompletion(parsed, this.#model, maxTokens), evidence: this.evidence };
      })();
      return await Promise.race([operation, aborted]);
    } catch (error) {
      return outcome('unknown', controller.signal.aborted ? abortReason : error instanceof ProtocolFailure ? error.message : 'transport_or_body_failure_remote_outcome_unknown');
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', cancel);
      controller.signal.removeEventListener('abort', rejectAborted);
      controller.abort();
    }
  }
}
