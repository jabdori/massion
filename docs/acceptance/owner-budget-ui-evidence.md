# Fresh Work owner budget panel

GOV-01/product budgets and issue4 visible-blocker criteria connect PR27's existing budget contract to the Work panel. [Scope was recorded before implementation](https://github.com/jabdori/massion/issues/4#issuecomment-6019036604), above PR27 `a7d530a95fbda4fef6f9114c0713b37a69840f9f`. Its initial CI ordering failure and recovery remain preserved; this UI does not change backend/domain/storage.

Owners deliberately select exact fresh Work, enter a changed finite nonnegative limit and a reason, and inspect current unit/reservation/measurement and draft revision. Absent unit is explicitly unpinned, unknown usage stays unknown, and output tokens do not promise monetary/total-token limits. No run, permission grant or active-run bound change occurs. Recent observed reason events are literal text, limited to eight browser observations and explicitly not complete history.

Private drafts are keyed by Mission and Work, keep their original CAS/feed across refresh/rejection/conflict, and require deliberate current-state review after changes. No other Work replaces a stale target. Pending/unknown writes lock duplicate submissions/review/cancel. Exact confirmed operation plus a newer authoritative snapshot settles only unchanged submitted values, preserving later private edits. The same operation registration/receipt/write-barrier path remains authoritative; snapshots alone cannot establish confirmation.

## Bounded verification

Node24.19.0 and owned disposable SurrealDB3.3.0 with normal HTTP plus supporting DOM client: initial seven panel checks passed; final eight panel cases are included in the affected71/71, fail/skip0 run. Actual database cases cover exact normal change/history/input preservation and committed response loss followed by actual durable receipt without replay. Other panel cases use real HTTP with in-memory fixture store for deterministic held response/conflict, validation/body bounds, definite rejection/unknown, exact Work eligibility, private Mission/Work drafts and original/moved focus. Artificial edits to disabled DOM input are labeled supporting evidence, not keyboard actions. Existing budget domain/HTTP and workbench regressions are included. Strict TypeScript, runtime syntax and whitespace passed. Candidate SHA, final CI and independent review are linked from the successor Draft PR.

## Unverified gates

No actual browser keyboard/rendering/accessibility journey was run. Read-only process lookup found no named agent-browser session; it does not establish shared desktop ownership. Coordinated GUI handoff is required before input. General approvals/policy lifecycle, comprehensive history presentation and broader GOV-01 remain open. Live issue5 remains blocked on authorized account/input/usage limits. No live provider, correction experiment, quota review retry, account permission/credential changes, paid resources, merge or deployment.
