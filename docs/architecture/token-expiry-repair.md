# Typed credential rejection and bounded repair

The provider response, never an error message or a clock guess, identifies an
expired or invalid credential. Bounded JSON error codes are allow-listed. Generic
HTTP errors, permission failures, transport failures and ambiguous responses keep
the existing unknown outcome and never authorize retry. Raw response diagnostics
and credentials are not persisted. GitHub's documented 401 `Bad credentials`
means invalid credentials, not proof of expiry.

A configured Work journals the rejected invocation before pausing. The blocker
binds the exact connection/configuration, effect and credential fact. An owner
replaces only that connection's existing host secret slot through ConnectionLifecycle.
A separate explicit Retry names the original effect and the completed replacement
command. The original live runtime resumes only that stage, with a new effect and
dispatch claim; completed stages and artifact writes are not repeated. At most one
repair retry per stage is admitted. Unknown effects never enter this path.
The rejected stage's original reservation covers its one replacement invocation;
nullable provider usage remains unknown rather than inventing measured zero usage.

All owner mutations use the server's drain-aware store and existing feed admission.
Admission rechecks command identity after state loads. The replacement receipt
must postdate the failure, match the exact connection/configuration, and be known
completed. Settings changes, stale selections, feed replacement, cancellation,
deadlines, unknown key writes and host restart cannot resume a call. Restart keeps
the durable blocker and receipts but has no live continuation; it offers repair
only, not a retry promise. No request text is retained in a separate queue.

The bundled GitHub connector records invalid credentials for the exact slot-write
identity used by its read. Late responses cannot invalidate a newer credential.
Its existing reconnect decision and masked secret form remain the replacement
path. Retrying its page/item is a deliberate read, never a write replay.

Scope: provider adapters, connection lifecycle/runtime, Work exception and settings
surfaces, GitHub credential observation, their tests and the B6-token/B14-expired/
B23-github-expired fixture family. Member and device lifecycle are excluded.
No new dependencies, automatic retries, token refresh daemon or OAuth flow.

Validation: tests first for structured rejection versus uncertainty, exact-slot
repair/retry and concurrency, stale/feed/cancellation boundaries, sentinel secret
redaction and journal replay. Local focused tests, typecheck and headless browser
flows; full tests and all contracts in CI. Final head must pass CI and receive a
Codex review receipt without P1/P2 findings. No merge or deployment.

Source checked 2026-11-10: GitHub REST authentication documentation via Context7:
https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api

## Implemented protocol evidence and limits

- OpenAI `401 / invalid_api_key`, Anthropic `401 / authentication_error`, and
  Gemini `400 / google.rpc.ErrorInfo(API_KEY_INVALID)` identify authentication
  rejection; none alone establishes expiry.
- Z.ai `401 / 1003` explicitly identifies expiry; `1000` and `1001` identify
  invalid/missing authentication. Source: https://docs.z.ai/api-reference/api-code
  (official Markdown fetched 2026-11-10).
- Additional official sources checked:
  https://developers.openai.com/api/docs/guides/error-codes and
  https://platform.claude.com/docs/en/api/errors.
- Undocumented compatible/OpenRouter responses and subscription CLI diagnostics
  remain unknown rather than guessing. Concurrent unsettled stages cannot pause
  into this bounded one-stage continuation. Environment-backed keys are not
  editable through the keychain path.

`retry-credential` is exposed only through the validated connection lifecycle
route. It preserves the original stage reservation and creates a distinct effect
and dispatch claim without claiming measured zero usage. Retry admission and key
replacement exclude each other. A lost admission response never releases a second
continuation. Portable lineage validates and replays the exact blocker and owner
retry command. Browser evidence and residual contract reasons are recorded in
`docs/acceptance/token-expiry-repair/README.md`.
