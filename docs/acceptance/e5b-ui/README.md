# E5b connection client evidence

The connection decision reuses the existing decision renderer, question, rows, identity and state. Its Connect action opens a separate host-owned password panel; it does not change the Work pane. Submission uses the existing client port and logical `POST /assistant/apps/connect` with `{commandId, decisionId, token}` and the conversation feed. Only decision identity and outcome enter client state. Password input clears synchronously on submission, close, thread/segment change and feed invalidation. Pending requests are aborted on invalidation; abort is not evidence that a submitted command did not commit.

Committed and replayed replies trigger a fresh read. Unknown outcomes remain fenced against resubmission. A proven conflict requires a deliberate new entry. Panel identity, thread, feed, connection epoch and secret-slot metadata fence late responses. Ordinary B24/B25 decisions retain their existing actions and fixtures.

## Commands and results

Run from the repository root:

```sh
mkdir -p .runtime/e5b-ui
TMPDIR=/private/tmp node --test tests/app-connect-surface.test.ts tests/conversation-cards.test.ts tests/apps-surface.test.ts tests/ui-contract-fixtures.test.ts tests/protocol-workbench.test.ts tests/client-workbench.test.ts tests/members-surface.test.ts tests/surface-shell.test.ts > .runtime/e5b-ui/tests.txt
npm run typecheck
UI_CONTRACTS_OUTPUT=.runtime/e5b-ui/contracts node scripts/ui-contracts/run.mjs B24-connect B24-connect-token B24-connect-connected B24-connect-later B24-connect-mail
node docs/acceptance/e5b-ui/verify.mjs
git diff --check
```

- Related tests: 146 total, 143 passed, 3 skipped (actual SurrealDB not configured), zero failed. The 15 new connection tests include initial failing tests before implementation. An earlier run without the prescribed TMPDIR failed the existing executor/reviewer integration expectation; the final run with `/private/tmp` passed.
- Typecheck and whitespace check passed.
- All five connection screens in dark and light: 238/238 required elements, zero contract failures, zero measured token/region failures, zero infrastructure errors. This is not pixel equality. Connected and Later each retain three text-budget warnings per theme because the shared renderer preserves the owner message and complete question.
- The standard contract host rejects writes, so connected/deferred fixtures declare one transition gap each. The separate acceptance overlay supplies fixture command responses and proves real clicks through Later, Ask again, password entry, one submission and the connected read in both themes. It does not claim a real account connection.
- The actual `appsViewNodes` iframe renderer was exercised in both themes: parent document access threw `SecurityError`, fetch rejected with `TypeError`, sandbox was `allow-scripts`, referrer policy was `no-referrer`, valid resize reached 240px, and invalid/extra-field resize and unknown effects were ignored. The probe uses the current production development-page CSP because the shared read-only fixture CSP forbids all frames.

## Local artifacts

Generated screenshots, browser configuration, clock scripts, snapshots and reports stay under ignored `.runtime/e5b-ui/`; no generated browser files are kept in this acceptance directory.

- `contracts/report.md` and `contracts/report.json`: all ten screen/theme results.
- `contracts/pairs/{dark,light}/B24-connect*.png`: prototype on the left, real client on the right, including mail and token entry. Token panel pairs were visually inspected in both themes; the mail pair was inspected in light. Shared date/time/version presentation remains visible and differs from the prototype examples.
- `actions/report.json`: actual transition counts and iframe isolation observations.
- `actions/{dark,light}-B24-connect{,-later,-token,-connected}.png` and matching `-pair.png`: state transitions driven by real UI actions, not DOM state injection.
- `tests.txt`: final related test output.

## Limits

Fixture evidence only. Native transport, real keychain storage, live MCP accounts and Work-tool execution wiring were not verified. The command overlay never persists or returns its fake credential. The full suite and all-screen contracts remain CI work. No commits, push or review were performed.

## Final integrated E5b candidate

The main implementer ran typecheck and ten affected test files after integrating the MCP backend, source-Work link and all fixture changes: **125 passed, one actual-SurrealDB test skipped, zero failed**. The exact test command and all 22 screen/theme rows are retained in [results.json](results.json). The earlier macOS fixture-path failure passed with the real scratchpad TMPDIR specified in CODEX-BRIEF.

B24/B25 coverage is also recorded in `.runtime/e5b-ui/install-contracts/`: **296/304 required elements, eight ordering failures, eight warnings, zero visual/infrastructure failures**. Combined with connection cards, that is 534/542 required elements, eight failures and twenty warnings. The remaining failures are the Copy button after the done/later decision in B24-done, B24-later, B25-done and B25-later, in each theme. Their fixture-only follow-up replies have no admitted conversation turn (`turnId: null`); the production conversation has no app-install follow-up turn or message timestamp with which to place them. The existing renderer orders decision extras around timestamped owner turns. No fabricated turn, extra owner message, contract relaxation or generic chronology change was added. Unused fixture message timestamps were removed because production does not expose that field. This is a retained product gap, not a fully passing screen claim.

B24/B25 fixtures now include their actual background Work shapes, follow-up-copy examples and a source identity. The B25 source link reads the exact existing Work using the existing navigation; no Work-pane implementation changed. Screenshot paths are `install-contracts/pairs/{dark,light}/B24*.png` and `B25*.png`.

Native stdio/local-HTTP protocol negotiation and OS secret storage still require the injected host adapters; PR #111 was still open at final verification. MCP tool calls are a host service boundary, not yet wired into model Work execution or its exception projection. The core retains at most 256 call claims in this increment. Those integrations, full-suite CI and the eight pre-existing app-continuation ordering gaps remain follow-up work.
