# Configured bounded-text execution

This increment makes the provider path executable through `ProductService.run` and an explicitly configured `POST /missions/:id/run`. It does not configure an account, enable a live service by default, read credentials, call a CLI agent or execute generated code.

## Configuration boundary

`ConfiguredTextRuntime` requires explicit enabled configuration, separate executor/verifier identities, exact provider/model/configuration bindings, a scope-matching authorization record, an output-token cap and a bounded text artifact store. The default workbench supplies none of this and retains its unavailable gate. A programmatic configuration is a trusted local-owner integration boundary, not production authentication or proof that permission was obtained from a real account holder.

Only `bounded-text-review/v1` Work is supported. An existing `manual-review/v1` criterion is not silently converted into model approval. Previously admitted Work without a pinned Mission input snapshot cannot run without a new Work or future explicit rebind. The Mission snapshot, criteria and current owner instructions are hashed at run admission; a later Mission revision cannot rewrite those inputs.

The HTTP provider adapter implements an explicitly named OpenAI-compatible Chat Completions protocol. See [its contract](http-provider.md). Endpoints, models, bounds and transport are supplied explicitly. No endpoint discovery, credential harvesting, environment secret reads, implicit external allowlist or persistent access grant is performed.

## Product-owned sequence

1. Atomically admit a run identity, criteria/input binding and output-token budget unit. An already admitted run is observed, never restarted by another request.
2. Persist independent executor/verifier assignments and child tasks.
3. Persist executor effect intent, then perform exactly one bounded provider POST. Persist output, hash and usage as an untrusted data receipt before writing an artifact.
4. Persist a separate artifact-write intent, then write bounded UTF-8 text to an owned, content-addressed, read-only file. Model output is never executed.
5. Persist verifier intent. Send a fresh independent request with exact artifact bytes/hash and pinned criteria, not the executor's self-assessment.
6. Require returned artifact hash, criteria version/hash, consistent verdict/checks and nonempty verbatim artifact quotations. Invalid JSON, a forged binding or ungrounded quotation is failed assurance, not a pass.
7. Re-read the content-addressed bytes, settle the separate tasks and construct Records only after the independent pass and settled effects.

A separate assigned call plus mechanical binding checks establish process independence and evidence identity. They do **not** establish model judgment quality or factual truth. Actual live-provider quality remains a separate integration/evaluation gate.

## Bounds, usage and uncertainty

- Admission reserves both configured output-token caps before any provider call can start. Each call consumes one reservation; there are no automatic provider retries.
- `max_completion_tokens` is sent to the provider; the adapter separately caps complete request bytes, response bytes and timeout. Reported usage must be finite nonnegative integer data and within the configured output cap.
- Work budget measurements here are **output-token units**, not dollars or total input-plus-output billing. Input usage is retained in receipts. A live account still needs approved use/spend controls; these local protocol bounds are not a guaranteed provider-side monetary cap.
- Unknown usage remains null. A timeout, abort after dispatch, malformed response or HTTP error may follow remote execution and therefore cannot prove zero usage or no side effect.
- Correlation headers identify an invocation; they are not a provider-side idempotency guarantee.
- Cancellation prevents future admissions and aborts the local request when possible. It cannot undo remote execution. In-flight receipts remain visible after ordinary cancellation. Explicit owner quarantine permanently closes the Work: later provider responses are rejected, and unresolved external outcomes stay unknown.
- Steering is atomically checked at effect admission and task progression, so a race cannot erase waiting state and write another artifact.
- A failure after run admission is reported as `admitted-unsettled`, never as a blanket rolled-back/retryable run. The latest state is returned when readable. Recovery requires inspecting durable run/effect identity; no implicit replay or automatic owner takeover is implemented. The [owner quarantine protocol](owner-quarantine.md) supplies an explicit permanent handling decision for pending/unknown effects, not continuation or completion.

## Verification and live gate

All development provider traffic uses an injected local HTTP server or mock transport. Mock descriptors and accepted Records remain fixture-class. Tests exercise actual file writes and, when enabled, actual SurrealDB persistence, but none invokes an external model or verifies a live account.

Before a live test: choose and authorize the provider/account, input scope and use/spend limits; supply a safe caller-owned transport; verify the exact returned model/version and provider contract; and evaluate independent judgment on representative work. Credential creation/access expansion, production authentication, deployment and OS/VM isolation are not part of this increment.
