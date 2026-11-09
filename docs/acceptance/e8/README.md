# E8: monthly budget, usage and the budget decision

Monthly limits now belong to a durable owner aggregate, separate from each Work's existing output cap. A calendar month uses the owner's persisted IANA timezone. Recorded provider dispatch claims and conversation turn starts supply call times; original runtime start is the fallback for older Work receipts. Only recorded tokens are summed. Monetary cost and provider quota percentages remain unknown; no prices are invented.

Fresh Work reserves the existing maximum executor/verifier/team output bound before activation. Insufficient capacity preserves it as `budget-waiting`, with no runtime activation or provider send. One period decision gathers waiting titles and projects the current and proposed output-token limits. Only a fresh explicit owner increase releases that decision's unchanged fresh Works through the normal runtime. Deferral, reopening, settings edits, a new month, process restart and reads do not start them. Replayed or unknown decisions do not invoke anything. Unknown usage stays unknown and fences admission conservatively; its original reservation survives restart. Definite rejection before activation releases only that unused reservation. The journal records the owner actor and host time and validates on portable replay.

`GET/POST /assistant/usage` and the existing `POST /assistant/decisions` use feed identity, aggregate CAS, idempotent readback and the drain-aware owner store. The normal Representative read supplies the card. Settings offers an actual read on Refresh, a revision-bound Change form and period/member token totals. Unknown writes keep their original browser marker and cannot be resent from a stale read. Newer generations and database changes fence stale usage responses.

Design: [monthly-budget.md](../../architecture/monthly-budget.md). The B26 entries in [E3e's ledger](../E3e/residuals.md) describe the earlier missing producer; this increment supplies that producer and its owner answers. Payment and external-device decisions remain outside this increment. Main `17742d2` (including PR #115) was merged without rewriting history; its room/date fixes are retained. B26 fixtures were regenerated from the production budget service rather than retaining the old B2 overlay.

## Verification

Node **24.21.0**, physical `TMPDIR=/private/tmp/e8-monthly-tests`: **298 passed, 30 environment-gated skips, one documented macOS failure** across 329 related tests. The failure is `portable inventory order is stable across English and Turkish process locales`: the case-insensitive filesystem collides on `I`/`i`, raising `directory realpath mismatch`. This is the local-only failure already named by the owner's CODEX-BRIEF. It was not suppressed or rerun as a success. Actual database checks require their existing environment and were skipped. Full tests and all screen contracts remain CI-owned.

The related command was `node --test` over monthly-budget, monthly-budget-panel, configured-runtime, selectable-runtime, runtime-lifetime, assistant-conversation, assistant-conversation-storage, settings-surface, conversation-cards, surface-shell, owner-work-budget, owner-budget-history, owner-budget-panel, owner-budget-history-panel, backup-lineage, portable-backup, backup-storage, host-drain, members, work-inbox and ui-contract-fixtures under `tests/*.test.ts`. After the final scoped Usage spacing adjustment, the two affected panel files passed **23/23**; the strengthened original lost-provider-response check passed **1/1**, retaining unknown usage and 128 reserved output tokens. Typecheck, copy lint (zero findings) and `git diff --check` passed. [Machine-readable counts](verification.json); [tested source content hashes](source-sha256.json).

The tests cover timezone/month boundaries, simultaneous identical reservations and decisions, a durable response lost after reservation, multiple paused Works, defer/reopen/raise and restart, no resume on month/settings changes, pause CAS conflicts, actual HTTP mock runtime acceptance exactly once, known activation refusal cleanup, unknown original provider outcomes, exact member attribution, journal replay/tampering, a budget write held across host drain, out-of-order reads and database replacement. Provider HTTP in these tests is a loopback fixture, never a real provider.

Headless agent-browser checked B26, B26-later and B14-usage in **both themes** at 1440×900: **176/176 required occurrences, zero contract/geometry/infrastructure failures**. Commands: `node scripts/ui-contracts/run.mjs B26 B26-later B14-usage`; only B14-usage was captured again after its scoped spacing adjustment. [Six-row report](report.json), [accessibility snapshots](snapshots), [raw checks](checks). Source fixtures reproduce with `node scripts/ui-contracts/monthly-budget-fixtures.ts`; they use the production reducer, admissions, owner deferral and read projection. The Usage artboard intentionally shows an unset budget; configured values and Change are exercised separately.

Native browser interaction also walked **Later → Ask again → Raise → Settings Change to 256 → Refresh** against the production HTTP server and an isolated in-memory fixture. Saved Work reads prove deferral kept `budget-waiting`, explicit increase made it queued, and there were zero effects with this fixture's disabled runtime. [Native deferred Work](native/deferred-work.json), [raised Work](native/raised-work.json), [saved Usage](native/usage-saved.json) and [final accessibility snapshot](native/usage-saved.snapshot.txt). This supporting browser flow used `7c3d16b` before main integration; final-source mock-runtime tests and the pairs below verify the integrated candidate. It does not establish real-database durability, live-provider billing or production accessibility certification.

## Artboard / application pairs

The artboard is on the left, the application on the right. Numeric token counts and the working increase/change actions replace the prototype's unknown examples; the original per-member provider quota percentages stay unknown.

| State | Dark | Light |
| --- | --- | --- |
| B26 | [PNG](pairs/dark/B26.png) | [PNG](pairs/light/B26.png) |
| B26-later | [PNG](pairs/dark/B26-later.png) | [PNG](pairs/light/B26-later.png) |
| B14-usage | [PNG](pairs/dark/B14-usage.png) | [PNG](pairs/light/B14-usage.png) |

## Limits

Output tokens are an application admission bound, not a monetary bill cap. The retained feed is scanned for usage, with a 10,000-reservation aggregate bound; a durable usage index/pruning needs its own workload evidence. Accounting timezone is pinned at first configuration. A lost or unknown admission/decision does not authorize automatic resumption. No new provider authorization, real provider calls, payment, remote delegation, deployment or PR merge was performed. The lead's independent review and `@codex review` remain separate from this fixture evidence.
