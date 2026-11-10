# Token expiry and connection repair evidence

Local, controlled fixtures only; no real credential/provider/keychain access.

- `tests/http-provider.test.ts`: typed OpenAI rejection and Z.ai expiry (1003)
  versus invalid authentication (1000); generic/permission/proxy errors remain
  unknown, raw provider diagnostics never enter outcomes.
- `tests/token-expiry-repair.test.ts`: exact slot replacement, duplicate retry,
  original command replay, old replacement receipt after a later recheck, unknown
  key write, drain-aware owner-store rejection and transport uncertainty.
- `tests/configured-runtime.test.ts`: a verifier rejection resumes only checking;
  the executor and artifact remain original, and the journal strictly replays.
- `tests/conversation-cards.test.ts`: one bound retry and late reads after the
  owner leaves the conversation. Existing lifecycle tests cover replacement
  feeds, stale generations and lost secret-write receipts.
- `tests/app-lifecycle.test.ts`: a real bundled handler's GitHub 401 response
  records invalid credentials for the original slot identity, not inferred expiry.
- `scripts/ui-contracts/verify-credential-repair.mjs`: normal host, browser-driven
  owner message, expiry, masked replacement, retry and accepted result; 2 producing
  calls (one rejected), 1 checking call, 1 Representative call. GitHub invalid
  state, reconnect decision, masked form and successful slot replacement also pass.
  Actual screenshots and accessibility snapshots are in `.runtime/credential-repair/`:
  `work-expired`, `key-replaced`, `work-accepted`, `github-invalid`, `github-reconnected`.
- Dark/light B14-expired and B23-github-expired each pass every required element.
  B6-token passes 24/28; its four remaining failures are unrelated captured
  sidebar Work statuses. Its typed expiry, repair, retry, Close and composer are
  present. PNG pairs: `.runtime/credential-contracts/pairs/{dark,light}/`.

Local final focused run: 110 passed, 3 durable-store tests skipped, no failures;
additional adapter/lifecycle/app suites: 70 passed. Typecheck passes. Full suite,
actual disposable database, complete contracts and desktop checks belong to CI.
Local Node is 26.13.0; CI uses the repository's Node 24.19.0.

## Residuals

Only the original host's live stage continuation can retry, once per stage and
within its original deadline. Host restart preserves the blocker/receipts and
allows credential replacement, but does not reconstruct or replay execution.
Concurrent unsettled stages do not enter the repair retry path. Custom compatible
providers, OpenRouter and subscription CLIs without a documented structured
credential code keep their existing conservative failure/unknown path. API keys
bound to environment variables remain host-managed rather than editable secrets.
No token refresh, OAuth or automatic retry is claimed. Nullable provider usage is
preserved; the original stage reservation covers its replacement invocation.

The B6 screenshot retains unrelated recorded conversation/sidebar data. Removing
that history or inventing active background Works to match the sparse artboard
would hide the remaining fixture difference rather than demonstrate this repair.
