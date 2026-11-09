# Browser session and page snapshots (R-B)

A Work retains bounded, sanitized browser observations: a session identity, first-read time, page count, current address, text blocks and read-only form fields. These are observations, not accepted evidence or effect receipts. The host adapter can only read; submission, payment and sending remain on the existing decision and single-send paths.

The browser service reads through an injected adapter, then records a host-only command through the drain-aware store and the existing Application CAS/idempotency boundary. Reads are pinned to the original feed, Work input and revision. Overlapping identical requests share one read; a newer request supersedes a late response. Unknown commits are reconciled by operation identity and are never retried as effects. A stopped Work, expired run or host drain refuses late writes. Restore validates the additive observation and journal replay.

Only bounded structured text is retained, never HTML, cookies, storage, raw screenshots or executable markup. Password, hidden, payment and authentication fields are masked; their observed values are removed from other retained strings. Addresses omit credentials, queries and fragments. The real headless adapter is opt-in local configuration and uses a fresh isolated browser session. Tests use injected read shapes and no external network or payments.

The browser pane renders the retained observation, including B15 form and B4 checkout. Existing copy.ko.json supplies interface labels. B7 activity and the conversation fold count committed reads. Client generation/feed/selection guards discard late results and remove stale pages. A page never supplies a second submit/payment button.

## Implementation and verification

1. Add failing sanitizer, admission/idempotency, drain and response-order tests; implement the adapter/service and journal validation.
2. Connect the host query and existing pane, with UI tests for feed replacement, deadlines and thread changes.
3. Produce B4/B15/B7 fixtures through the actual service; verify the affected contracts headlessly in both themes and remove only resolved allow-list entries.
4. Run related tests and typecheck; push feat/browser-runtime and open the requested PR. Follow CI and head-specific Codex review for at most four correction rounds. Do not merge.

General automation, form submission, order-history connectors, real payment adapters and acceptance of browser content are out of scope.

## Local adapter and retained bounds

The normal host leaves the adapter off. Local opt-in requires `MASSION_BROWSER_READS=1` and `MASSION_BROWSER_ORIGINS` containing comma-separated exact HTTPS origins. An installed `agent-browser` CLI is required only for that opt-in. It launches a fresh headless session with an explicit empty config, scrubbed environment, domain restriction and page scripts disabled; it never loads the owner's profile. Each invocation closes its session. The logical Work session retains at most 32 observations, each bounded to 24,000 serialized characters, 64 text blocks and 64 fields. This is a structured, read-only snapshot, not a visual screenshot or remote interactive embed.

The host-owned `server.browserSessions.capture({missionId,workId,readId,address})` is the adapter seam, analogous to the existing effect producer. It is not a public browser command route. The UI reads `/missions/:mission/works/:work/browser`; conversation and Work-list queries carry only the retained count and first observation time. Automatic model-to-browser planning is a follow-up. Existing owner decisions remain the sole effect-admission path.

Verification and remaining screen contracts: [R-B evidence](../acceptance/browser-runtime/README.md).
