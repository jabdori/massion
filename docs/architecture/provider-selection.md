# Explicit execution connections and model selection

## User outcome

One Work can use an explicitly chosen executor connection/model and a separately
chosen verifier connection/model. Multiple profiles can name different services,
endpoints, accounts (opaque secret references), or models. Selection follows the
actual invocation path, rather than changing a label while execution stays fixed.
The host still starts with **no connections or live authorization by default**.
The current workbench selects host-configured profiles; it does not yet create
connections, discover account models, or provide credential setup UI.

The owner chooses bounded-text model review explicitly when creating a Mission.
Each unstarted Work then has labeled executor/verifier selectors, an authorized-use
selector, an output-token cap, and a side-effect-free Check selection action.
No option is automatically chosen. Protocol/authentication, endpoint, usage
reporting and limits are shown; unavailable profiles show diagnostics. Run uses
that exact selection. An admitted run displays its pinned profile IDs and hashes.
Changes after admission never reroute, retry, or resume a run.

The execution plan shows both calls' required output reservation and remaining
Work budget before submission. With selectable connections, Work admission labels
budget as output tokens and explains the two-call minimum. All choices remain
explicit; a check does not start a run. The client binds check feedback to the
same rendered Work, snapshot revision and selected values. Selection changes,
newer snapshots, navigation and a run request invalidate earlier feedback. No
positive check is required to submit an explicit Run; the host rechecks admission
regardless of whether the client previously checked.

## Headless composition

- `ConnectionCatalog` accepts immutable `ExecutionConnectionProfile` values and
  explicitly registered `ModelAdapterFactory` implementations. Provider kind is a
  label; protocol factories supply behavior. There is no provider-name switch in
  the product domain and no environment-based provider guessing.
- A model profile declares `id`, `label`, `backend`, `providerKind`, `protocol`,
  `endpoint`, exact `model`, `revision`, `enabled`, `auth`, `capabilities`, `usage`,
  and four `limits` (input bytes, output tokens, response bytes, timeout).
- Authentication contains only an implemented method and optional opaque
  `secretRef`. No raw secret, arbitrary headers, executable command, OAuth grant,
  inherited login, or general secret-entry form is accepted.
- `SelectableTextRuntime(store, catalog, authorizations, artifacts)` supplies the
  existing `WorkRuntime` interface. Inject it into `createWorkbench` or
  `ProductService`; the default host does not instantiate it.
- `ExecutionAuthorization` names the exact Mission scope, mock/live mode,
  allowed `(profileId, configHash)` pairs for each role, and maximum output cap.
  Configuration is not proof that a real account holder granted permission. The
  embedding owner must establish authorized input/use/spend separately.
- `ExecutionChoice` names executorProfileId, verifierProfileId, authorizationId,
  and outputTokenCap. Pass it to `ProductService.run` or POST `/missions/:id/run`
  alongside workId, commandId and expectedRevision. `/preflight` accepts the same
  envelope but does not admit Work, resolve credentials or send inference. It
  loads authoritative Work through `ProductService.preflight(missionId, workId,
  expectedRevision, choice)`. The result binds `missionId`, `workId`, `revision`
  and `expectedRevision`; a stale revision returns HTTP 409 and `ready: false`.
- The runtime port is now `preflight(snapshot, workId, expectedRevision, choice)`.
  It checks Work-pinned criteria, pinned input, open/unstarted state, prior
  execution evidence, task progress and the remaining two-call output budget as
  well as profile/authorization compatibility. Run uses the same admission checks
  and still performs CAS at dispatch. A successful check does not reserve budget,
  guarantee later admission, authorize new spending, or prove provider quality.
- The profile's full canonical hash includes endpoint/model/auth reference,
  capabilities, bounds and revision. That hash becomes the actual adapter
  descriptor's configVersion; role bindings are committed with run admission.
  Runtime assignments and portable backup validation enforce the same hash.

The selected adapters instantiate separate executor/verifier roles. Choosing the
same stateless connection for both is permitted; context and calls remain separate.
No model self-report establishes independent acceptance. Existing artifact hash,
criteria/input pinning, verifier quotation and current-byte checks remain required.

## First protocol and authentication

`chatProfileFactory` implements **OpenAI-compatible Chat Completions**, using the
existing strict HTTP parser. This is not a native Anthropic, Responses, Codex, or
ACP implementation, and compatible endpoints must actually satisfy this wire
contract. The HTTPS factory supports bearer authentication using an injected
`CredentialResolver` and `HttpProviderTransport`. The resolver receives the
opaque reference, profile ID, exact endpoint and abort signal only when invoked.
No environment or credential file is read; no secret is returned by `/providers`,
placed in a descriptor/receipt, or retained in configuration. Resolver error text
is never propagated. Mock HTTP requires loopback plus `none` auth and remains
fixture-class. No real credential or external model was used to test this code.

Bearer semantics were checked against the [official API authentication
reference](https://developers.openai.com/api/reference/overview#authentication).
That documents the method, not compatibility or authorization of every endpoint.
The HTTPS transport remains unverified-provider evidence until a separately
approved live-service test establishes it.

Only exact returned model identity and valid reported input/output token counts
can complete this adapter. Unknown usage stays null. Costs remain unknown, not
zero; output-token reservation is not a monetary billing cap. Unknown remote
outcome never permits fallback or replay. Runtime failure after admission keeps
its existing admitted-unsettled classification.

## Developer extension seam

Implement `ModelAdapterFactory` with a unique protocol, implemented auth methods,
capabilities, evidence class, pure validate(profile), and side-effect-free
create(profile). The factory returns `ProviderAdapter`; actual effects occur only
inside invoke after durable runtime admission. Register the factory in the catalog
without editing the generic domain, runtime router or UI. Descriptor identity must
match the chosen profile. Factories are trusted host code, not an untrusted plugin
sandbox, and must not perform hidden discovery, fallbacks, retries, stateful context
reuse or unapproved tool operations.

Add protocol-specific fixtures and use
`tests/support/provider-conformance.ts` for completed, unknown, wrong-model and
pre-dispatch-cancellation semantics. Add auth/redirect/bounds/usage parsing cases
for the protocol and an end-to-end role-routing/backup test. A conformance pass
proves those fixture contracts, not the live service or model's judgment quality.

## ACP and the Hermes reference

A single connection-selection UX can cover different transports. Hermes uses
[ProviderProfile.create_client](https://github.com/NousResearch/hermes-agent/blob/f5a9361dcc66b0b972fd488b83129561509b3486/providers/base.py)
and a [Copilot ACP profile](https://github.com/NousResearch/hermes-agent/blob/f5a9361dcc66b0b972fd488b83129561509b3486/plugins/model-providers/copilot-acp/__init__.py)
to expose an ACP subprocess behind a model-like facade. This is a useful extension
pattern: ACP does not force a separate product or require handing Work truth to
an external agent. Massion did not copy Hermes source or authentication behavior.

Massion currently recognizes an `acp-agent` configuration discriminant only to
report that its session adapter is not implemented. No nonfunctional ACP entry is
added to the picker. A future adapter may expose a model-like facade if it preserves
the actual negotiated session semantics and Massion's authority boundaries.

That adapter must target the [stable ACP v1 protocol](https://agentclientprotocol.com/protocol/v1/initialization),
not assume draft/v2 capabilities. It needs capability/version negotiation,
agent-advertised [authentication](https://agentclientprotocol.com/protocol/v1/authentication),
[configOptions model selection](https://agentclientprotocol.com/protocol/v1/session-config-options),
separate executor/verifier session contexts, bounded session updates, explicit
permission decisions, cancellation and disconnect/unknown-effect handling.
A successful cancel is not proof that remote effects were undone. Agent-provided
model and usage evidence must be retained as such, without assuming the HTTP
runtime's token cap or exact-model guarantees apply universally.

In particular, the inspected Hermes shim's zero usage placeholder, requested-model
facade label and continue-on-model-selection-failure behavior cannot be adopted as
Massion evidence. Unsupported model selection or unprovable bounds must surface
as a clear restriction rather than silently using a default. Before any actual ACP
connection, build injected-session conformance fixtures and an explicit authorized
process/session/permission boundary. No CLI agent or ambient account is launched
by this increment.
