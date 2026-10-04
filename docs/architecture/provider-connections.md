# Provider connection setup and native model APIs

This local development workbench now has a real connection setup path rather than
requiring every model profile to be prebuilt in trusted code. The CLI enables
ConnectionWorkbench and its dedicated loopback routes. Explicitly configured hosts
can inject the same manager into createWorkbench. Ordinary Work still uses the
existing domain, Store<Mission>, CAS, durable effects, budget reservations,
text artifact store and independent verifier. This provider-only change preserves
the remote Mission/Work domain and adds no correction decision or consumption API.

## Implemented choices

| User choice | Wire protocol | Host-owned authentication | Model discovery |
| --- | --- | --- | --- |
| OpenAI API | Chat Completions | bearer via opaque ref/resolver | GET /v1/models |
| OpenRouter API | Chat Completions | bearer via opaque ref/resolver | GET /api/v1/models |
| Anthropic API | Native Messages | x-api-key and anthropic-version | GET /v1/models |
| Gemini Developer API | Native generateContent | x-goog-api-key | GET /v1beta/models |
| Custom API | Chat Completions contract | bearer; no auth only in explicit local fixture mode | GET models under chosen canonical base URL |

API presets supply canonical official base URLs. Custom endpoint support is one
compatible protocol, not a claim that every named service supports it. Native
Anthropic and Gemini have separate renderers, authentication and response parsers.
ACP and CLI/subscription agents appear as unsupported distinct backends; there is
no OAuth/login or subprocess launcher.

## User path

Save connection metadata with its API type, canonical base URL, name and optional
host credential reference. Explore models, or enter an exact model ID manually
when discovery fails, has additional pages or does not support listing. Discovery
is a bounded single metadata read, not an inference test or model-quality claim.
The first page is bounded at 1,000 entries/512 KiB; additional pages are disclosed,
and exact manual entry remains available. Gemini filters out models without
generateContent support. No popular/default model or fallback is silently chosen.

Selecting a model creates an immutable full connection profile. Permit explicit
executor/verifier profiles for a Mission scope and per-call output cap, then use
the existing Work selection/check/run controls. Connection/profile permission
changes are rejected while a Work run is active. Replacing a saved connection
retires its old selected profiles and matching permissions; stale asynchronous
model results are discarded. The client invalidates previous selection checks and
drafts after a catalog change. Admitted runs and unknown effects are never replayed
by selecting another model or connection.

## Credentials, evidence and lifetime

No API key is accepted by these JSON setup routes, logged or stored in browser
localStorage. The default has no environment/credential-file lookup; the opt-in CLI
host manifest allows only individually declared environment value sources, read
lazily after exact reference/identity/destination checks. The optional secretRef
is an opaque host reference. Actual authentication uses the existing injected
CredentialResolver with profile ID, exact destination and abort signal. Public
configuration redacts secretRef. Synthetic credentials exist only in tests.

The unconfigured CLI has no resolver and no live-execution permission. An explicitly selected [host manifest](cli-host-connections.md) can now supply destination-bound references and separately enabled live capability. It reports
credential-required, permits configuration/manual model entry, and cannot activate
live execution. An authorized host integration must provide its resolver and
explicitly enable live execution before live scoped permission can be granted.
No actual credential connection, OAuth session or paid provider call is established
by this code change. Even a configured resolver is shown as configured-unverified;
model metadata and accepted fixture Records never set liveVerified=true.

Connections, discovered metadata, model profiles and scoped permissions are scoped
to the host session and are lost on restart; this is disclosed in the UI. Existing
Mission/Work evidence remains durable and inspectable. Restart does not recreate
permissions or resume remote effects. Persistent secure account enrollment is a
separate future integration, not a hidden file containing an API key.

Native calls are stateless, non-streaming, bounded and single-send. Completion
requires exact returned model identity, reported token usage and text-only output.
Aliases with a different returned version fail closed rather than remapping the
approved model. Anthropic input accounting includes reported cache-read/create
usage; Gemini output accounting includes reported thought tokens. Tool/code/file
payloads, malformed Unicode, truncation and filtered output cannot satisfy text
completion. Unknown remote outcomes preserve null usage; monetary cost remains
unknown. Output-token limits do not guarantee total-token or billing caps.

## Sources and licensing

Design reference: Hermes provider selection and distinct model-provider/ACP
extension architecture at pinned commit
[f5a9361dcc66b0b972fd488b83129561509b3486](https://github.com/NousResearch/hermes-agent/tree/f5a9361dcc66b0b972fd488b83129561509b3486),
including its [Copilot ACP plugin](https://github.com/NousResearch/hermes-agent/blob/f5a9361dcc66b0b972fd488b83129561509b3486/plugins/model-providers/copilot-acp/__init__.py).
The [license](https://github.com/NousResearch/hermes-agent/blob/f5a9361dcc66b0b972fd488b83129561509b3486/LICENSE)
is MIT, copyright 2025 Nous Research. No Hermes source was copied, and its login,
credential handling, agent authority or subprocess implementation was not imported.

API contracts checked against primary documentation:
[OpenAI models](https://developers.openai.com/api/reference/resources/models/methods/list),
[OpenRouter models](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties),
[Anthropic models](https://platform.claude.com/docs/en/api/models/list),
[Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create),
[Gemini models](https://ai.google.dev/api/models),
[Gemini generateContent](https://ai.google.dev/api/generate-content),
and [Gemini key headers](https://ai.google.dev/gemini-api/docs/api-key).
These references establish wire expectations, not actual account compatibility or
live-service validation.
