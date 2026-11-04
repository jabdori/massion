# Configured HTTP provider adapter

`OpenAICompatibleChatAdapter` is an opt-in adapter for the **OpenAI-compatible Chat Completions HTTP protocol**, not a generic or invented model protocol. It implements the existing `ProviderAdapter` interface and returns bounded plain-text output. The default application does not discover or activate it automatically.

## Construction and authorization

The constructor accepts `OpenAICompatibleChatConfig`:

- Explicit `provider`, pinned `model`, `configVersion`, and the complete canonical `endpoint`, ending in `/chat/completions`.
- Explicit `transportMode`: `https` or `local-http-mock`.
- `bounds`: positive safe-integer `maxInputBytes`, `maxOutputTokens`, `maxResponseBytes`, and `timeoutMs` (no greater than the platform timer limit).
- A caller-injected `transport(url, init): Promise<Response>` with Fetch semantics. There is no implicit global-fetch fallback.
- `enabled: true` and an explicit `authorization` matching provider, model, configuration version, and exact endpoint. Its input-byte and output-token allowances must cover the configured bounds. Missing or mismatched authorization disables the adapter.

Authorization is an application-owned record of permission, **not** a credential, identity check, authenticated consent workflow, or proof that the caller obtained appropriate permission. This library does not create authorization records or maintain an automatic endpoint allowlist. Configuration is copied and public descriptors are frozen; modifying the caller's objects cannot increase an existing adapter's permissions. Create a new versioned adapter configuration to change permission or disable a previously configured instance.

HTTPS is required outside the mock route. `local-http-mock` accepts only a canonical `http://127.0.0.1:<nonzero-port>/…/chat/completions` endpoint. It rejects `localhost`, shortened IP representations, other loopback addresses, and remote hosts. User-info credentials, all URL queries and fragments (including empty markers), whitespace, backslashes, and noncanonical URLs are rejected. There is no hostname, provider account, model, or base-URL discovery. The exact endpoint and pinned model must be deliberately supplied.

Authentication remains caller-owned. This module reads no credential, filesystem, environment variable, account, browser session, or secret store. There is no token, API-key, arbitrary-header, or plaintext-secret configuration option. It emits no Authorization or Cookie header and requests `credentials: 'omit'`. An eventual approved server-side credential integration belongs in the injected transport, outside this adapter. Do not place secrets in configuration, endpoint paths, authorization records, or logs.

The transport is a **trusted integration boundary**, not an isolation sandbox. It must honor the supplied endpoint/body/signal, reject redirects, make only one request, and avoid hidden retries or fallback endpoints. An arbitrary malicious transport can ignore these instructions; the adapter cannot prove its network behavior. None is installed or selected by the library.

## Wire contract and limits

Each invocation makes at most one transport call:

- `POST` to the exact authorized endpoint, with JSON and a JSON Accept header
- One `user` message containing the instruction; optional input references are appended as literal identifiers, explicitly marked as not loaded. The adapter never dereferences them.
- Exact pinned `model`, `n: 1`, `stream: false`, `store: false`
- `max_completion_tokens` set to the configured output cap, or a positive request-level `maxOutputTokens` that can only tighten it
- `X-Client-Request-Id: massion-<SHA-256(invocationId)>`, a deterministic ASCII correlation identifier
- `redirect: 'error'`, `credentials: 'omit'`, and a combined caller-cancellation/deadline signal

The request ID supports correlation only. It is **not** an idempotency key or a remote exactly-once guarantee. The adapter does not retry, recover, reconcile, or issue cancellation requests. A durable caller must prevent repeated dispatch under the same persisted invocation identity and reconcile uncertain outcomes before deciding on any further work.

`maxInputBytes` counts UTF-8 bytes of the entire serialized request, including JSON/message overhead. It is not a tokenizer or an input-token billing limit. `maxOutputTokens` bounds the requested completion-token count, including any reasoning tokens reported by the provider. The adapter checks the returned count against the effective cap, but cannot enforce a dishonest provider's billing. These are not currency guarantees. `maxResponseBytes` independently caps decoded response bytes while streaming the body. The deadline covers headers and body; even a transport that ignores abort cannot indefinitely delay the adapter's returned outcome, although its underlying operation may remain in progress.

## Outcomes and accounting

`HttpProviderOutcome` extends `ProviderOutcome` with frozen adapter `evidence` metadata. `output` is a string only when the status is `completed`; it is otherwise `null`. Reasons are bounded, adapter-owned codes, never copied server bodies, error messages, instructions, or credentials.

- **completed**: HTTP 200; unredirected response from the expected endpoint; JSON content type and valid UTF-8; bounded JSON; `chat.completion` object with valid identity/timestamp; exact pinned model; exactly one index-zero assistant choice; `finish_reason: 'stop'`; nonempty string content; no refusal or tool/function request; fully validated usage.
- **failed**: an input/configuration check prevents dispatch, or a valid measured response reports refusal, truncation, filtering, unsupported tool output, or empty text. An after-dispatch failure still consumed provider work; it is not authorization to retry.
- **cancelled**: the caller's signal was already aborted before dispatch. No transport call was made. Usage is left unknown rather than inventing a measurement.
- **unknown**: anything uncertain after the transport call boundary, including synchronous transport errors, caller cancellation, timeout, redirect errors, all non-200 HTTP statuses, interrupted or invalid bodies, mismatched model, malformed schema, and missing/invalid/over-cap usage. No safe-retry or no-side-effect claim is made.

A proxy can return an HTTP error after a model request has been processed. Consequently even 400, 401, 403, 408, or 429 does not establish zero remote effects in this adapter. Non-200 response bodies and transport error messages are not surfaced.

Measured usage requires nonnegative safe-integer `prompt_tokens`, `completion_tokens`, and `total_tokens`; the total must equal the safe sum of both components. The completion count cannot exceed the effective request cap. These map to `inputTokens`/`outputTokens`. Unknown usage is `{ inputTokens: null, outputTokens: null }`, never fabricated zero. A valid provider-reported zero remains zero. The adapter does not estimate usage from text or bytes.

Strict exact response-model matching intentionally rejects alias-to-snapshot substitution. Configure the actual returned model snapshot explicitly. Endpoints that implement a looser/different compatibility dialect, omit usage, support only deprecated `max_tokens`, stream responses, or emit tool calls are not silently adapted or accepted.

## Evidence and tests

The `local-http-mock` descriptor is always `evidenceClass: 'fixture'`, so the normal real-provider registry selection does not promote it. Both the descriptor and adapter/outcome evidence preserve that classification. A configured HTTPS route is labeled `real-provider` for selection, but its additional metadata states `executionEvidence: 'unverified-provider-transport'` and `realProviderVerified: false`. Configuration and a parseable response do not constitute independent real-provider verification, quality assurance, or a live-provider test result.

Tests use an in-process loopback HTTP mock and injected transports. They cover authorization and endpoint validation, request structure and limits, deterministic correlation, redirects, HTTP errors, cancellation before/after dispatch, body interruptions/timeouts, bounded decoding, schema/model/usage checks, and unusable output. No test contacts a real model or loads credentials. The configured HTTPS example in the tests is constructed without invocation. Mock passing results prove only these local contracts.

## Protocol references

Read-only reference review, 2026-10-03:

- [OpenAI: Create chat completion](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) documents request fields and `max_completion_tokens`.
- [OpenAI: Chat completion response](https://developers.openai.com/api/reference/resources/chat) documents choice finish reasons, assistant messages, and usage.
- [OpenAI: API overview and request IDs](https://developers.openai.com/api/reference/overview) documents `X-Client-Request-Id` as a request correlation header.
