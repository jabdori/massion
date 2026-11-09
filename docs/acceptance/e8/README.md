# E8: monthly budget, usage and the budget decision

Monthly limits now belong to a durable owner aggregate, separate from each Work's existing output cap. A calendar month uses the owner's persisted IANA timezone. Recorded provider dispatch claims and conversation turn starts supply call times; original runtime start is the fallback for older Work receipts. Only recorded tokens are summed. Monetary cost and provider quota percentages remain unknown; no prices are invented.

Fresh Work reserves the existing maximum executor/verifier/team output bound before activation. Insufficient capacity preserves it as `budget-waiting`, with no runtime activation or provider send. One period decision gathers waiting titles and projects the current and proposed output-token limits. Only a fresh explicit owner increase releases that decision's unchanged fresh Works through the normal runtime. Deferral, reopening, settings edits and a new month do not approve or start paused Work. Startup/first-read recovery may continue a previously accepted owner decision, after checking for a fresh unchanged Work with no admitted runtime or effects. Replayed or unknown decisions do not invoke anything. Unknown usage stays unknown and fences admission conservatively; its original reservation survives restart. Definite rejection before activation releases only that unused reservation. The journal records the owner actor and host time and validates on portable replay.

`GET/POST /assistant/usage` and the existing `POST /assistant/decisions` use feed identity, aggregate CAS, idempotent readback and the drain-aware owner store. The normal Representative read supplies the card. Settings offers an actual read on Refresh and a revision-bound Change form. The cycle card follows the artboard with utilization and reset time only; recorded monthly totals remain in the usage API. Unknown writes keep their original browser marker and cannot be resent from a stale read. Newer generations and database changes fence stale usage responses.

Design: [monthly-budget.md](../../architecture/monthly-budget.md). The B26 entries in [E3e's ledger](../E3e/residuals.md) describe the earlier missing producer; this increment supplies that producer and its owner answers. Payment and external-device decisions remain outside this increment. Main `17742d2` (including PR #115) was merged without rewriting history; its room/date fixes are retained. B26 fixtures were regenerated from the production budget service rather than retaining the old B2 overlay.

## Verification

Initial implementation (before the visual-gate correction): Node **24.21.0**, physical `TMPDIR=/private/tmp/e8-monthly-tests`: **298 passed, 30 environment-gated skips, one documented macOS failure** across 329 related tests. The failure is `portable inventory order is stable across English and Turkish process locales`: the case-insensitive filesystem collides on `I`/`i`, raising `directory realpath mismatch`. This is the local-only failure already named by the owner's CODEX-BRIEF. It was not suppressed or rerun as a success. Actual database checks require their existing environment and were skipped. Full tests and all screen contracts remain CI-owned.

The related command was `node --test` over monthly-budget, monthly-budget-panel, configured-runtime, selectable-runtime, runtime-lifetime, assistant-conversation, assistant-conversation-storage, settings-surface, conversation-cards, surface-shell, owner-work-budget, owner-budget-history, owner-budget-panel, owner-budget-history-panel, backup-lineage, portable-backup, backup-storage, host-drain, members, work-inbox and ui-contract-fixtures under `tests/*.test.ts`. After the final scoped Usage spacing adjustment, the two affected panel files passed **23/23**; the strengthened original lost-provider-response check passed **1/1**, retaining unknown usage and 128 reserved output tokens. Typecheck, copy lint (zero findings) and `git diff --check` passed. [Machine-readable counts](verification.json); [tested source content hashes](source-sha256.json).

The tests cover timezone/month boundaries, simultaneous identical reservations and decisions, a durable response lost after reservation, multiple paused Works, defer/reopen/raise and restart, no resume on month/settings changes, pause CAS conflicts, actual HTTP mock runtime acceptance exactly once, known activation refusal cleanup, unknown original provider outcomes, exact member attribution, journal replay/tampering, a budget write held across host drain, out-of-order reads and database replacement. Provider HTTP in these tests is a loopback fixture, never a real provider.

Headless agent-browser checked B26, B26-later and B14-usage in **both themes** at 1440×900: **176/176 required occurrences, zero contract/geometry/infrastructure failures**. Commands: `node scripts/ui-contracts/run.mjs B26 B26-later B14-usage`; all three states were captured again after the blocking visual-gate correction below. [Six-row report](report.json), [accessibility snapshots](snapshots), [raw checks](checks). Source fixtures reproduce with `node scripts/ui-contracts/monthly-budget-fixtures.ts`; they use the production reducer, admissions, owner deferral and read projection. The Usage artboard intentionally shows an unset budget; configured values and Change are exercised separately.

Native browser interaction also walked **Later → Ask again → Raise → Settings Change to 256 → Refresh** against the production HTTP server and an isolated in-memory fixture. Saved Work reads prove deferral kept `budget-waiting`, explicit increase made it queued, and there were zero effects with this fixture's disabled runtime. [Native deferred Work](native/deferred-work.json), [raised Work](native/raised-work.json), [saved Usage](native/usage-saved.json) and [final accessibility snapshot](native/usage-saved.snapshot.txt). This supporting browser flow used `7c3d16b` before main integration; final-source mock-runtime tests and the pairs below verify the integrated candidate. It does not establish real-database durability, live-provider billing or production accessibility certification.

## Blocking visual-gate correction

The follow-up above `92e512a` removes the unapproved `사용한 출력 토큰` cycle row, including its period/timezone and count. Both themes now show only `사용률` and `초기화 시각` in that card. B26's current/proposed slots use human-readable locale-formatted numbers without the raw `출력 토큰` suffix; the paused slot retains actual Work titles. The usage API still records the accounting unit and numeric owner-decision payload.

The four related test files passed **48/48**. Typecheck, copy lint (zero findings) and whitespace passed. All six pairs, snapshots, visual records and contract checks were regenerated: **176/176 required occurrences, zero contract/geometry/infrastructure failures**. Both B14 snapshots were additionally checked for absence of the added label, period and timezone; both B26 snapshots contain no output-token suffix. Full-suite checks remain CI-owned and The subsequent Codex/GLM correction is documented below.

## Combined Codex and GLM correction

The [review-fix ledger](review-fixes.md) maps all eight live Codex findings and the GLM findings to their implementation and regression tests. Main `395193e` (PR #116) was integrated, including room-version accounting for challenge/answer caps. The related 22-file run passed **387 tests**, with **21 environment-gated skips**, **zero failures** (408 tests). After the final cancelled-Work guard, the two affected files passed **41 tests**, with **three skips**, **zero failures** (44 tests). Typecheck and copy lint passed. These results supersede the initial implementation counts for this correction; the full suite remains CI-owned.

All six normal-state artboard/application pairs were refreshed from integration commit `8d0f9fc`: **176/176 required occurrences**, zero contract/geometry/infrastructure failures. The final cancelled-Work check was verified separately; the [source hashes](source-sha256.json) describe the final tested implementation. Actual headless browser interaction against production HTTP with in-memory fixtures confirmed that offline decision/save actions created no single-send keys, retained the `256` edit and saved it after reconnect. [Offline decision](review-native/offline-decision.snapshot.txt), [offline edit](review-native/offline-edit.snapshot.txt), [online edit](review-native/online-edit.snapshot.txt), [stored usage](review-native/online-usage.json). No real provider or database was used.

**Unknown outcomes:** an unchanged revision is not proof that a command in flight cannot still commit. Offline and protocol failures before command transport release their key; explicit pre-commit server refusals are marked rejected. An already dispatched request with no confirmed outcome retains its key and shows `확인 중…`. Reads and restart reconcile the previously accepted budget grant without replaying an admitted runtime/effect.

## GLM round 2: interrupted queued recovery

The HIGH on `f0e0957` is addressed in [round-2 recovery evidence](round2-recovery.md). Recovery now includes the exact pristine queued Work as well as budget-paused Work under its done decision, using the deterministic run identity. It fences an older activation before releasing a stale reservation, binds cleanup to its original Work revision and revalidates runtime readiness. Initial or recovered work waits while the host is busy. Admitted runtime/effect evidence remains a no-replay boundary.

Main `ab5c145` was integrated. Fifteen related files passed **329 tests**, with **12 environment-gated skips**, **zero failures** (341 tests). The final active-conversation test-context adjustment passed **5/5**; typecheck, copy lint and whitespace passed. All six pairs were refreshed from `f72f4bc`: **176/176 required occurrences**, zero contract/geometry/infrastructure failures. Full tests and actual-database checks remain CI/environment-owned.

**This is not a whole-PR approval.** Separate newer findings on discriminator accounting, input changes before the pause, owner-expired accounting and restored-journal authorization remain open; see the explicit list in [round2-recovery.md](round2-recovery.md). The last issue is a reported restore-security blocker. Do not merge while those findings remain unresolved.

## Blocking gate follow-up

Blocking-gate main `ac99f1d` (#118) was merged after the `a95c079` recovery push. A fresh E8 capture again passes **176/176 required occurrences** across exactly six screen/theme rows. The [scoped gate evidence](blocking-scope.json) uses the official `readCapture`, `copyDiagnostics` and `evaluateGate` functions: **zero new diagnostics, zero stale exceptions and zero infrastructure errors**, exit 0 after removing **20 E8 exceptions**, with no additions and no changes to foreign exceptions or baseline provenance. The focused gate/fixture/copy harness passed **40/40** and typecheck passed.

The full CLI was invoked with blocking enabled and correctly rejected the six-row capture as incomplete: it requires all 150 rows. That global pass is not claimed. E8's scoped validation enforces exact coverage/counts and the same bidirectional diagnostic comparison; the full candidate capture remains CI-owned. Rebaseline PR #125 subsequently merged as main `c045c97` and was integrated; the final scoped check passed again against that baseline. Its 958-entry list becomes 938 entries here, differing only by the 20 E8 removals. No gate/checker thresholds or shared coverage rules were weakened, and no addition/justification flag was used.

## Artboard / application pairs

The artboard is on the left, the application on the right. Known B26 amounts fill the artboard's slots with locale-formatted numbers without unit text; unknown values and provider quota percentages stay as `—`. Increase and Change use their recorded owner commands.

| State | Dark | Light |
| --- | --- | --- |
| B26 | [PNG](pairs/dark/B26.png) | [PNG](pairs/light/B26.png) |
| B26-later | [PNG](pairs/dark/B26-later.png) | [PNG](pairs/light/B26-later.png) |
| B14-usage | [PNG](pairs/dark/B14-usage.png) | [PNG](pairs/light/B14-usage.png) |

## Limits

Output tokens are an application admission bound, not a monetary bill cap. The retained feed is scanned for usage, with a 10,000-reservation aggregate bound; a durable usage index/pruning needs its own workload evidence. Accounting timezone is pinned at first configuration. A lost or unknown admission/decision does not authorize effect replay; a durably accepted decision permits fresh-Work reconciliation as described above. No new provider authorization, real provider calls, payment, remote delegation, deployment or PR merge was performed. The lead's independent review and `@codex review` remain separate from this fixture evidence.


## Invariant recovery redesign (supersedes path-specific recovery above)

One pure `reconcileMonthly(snapshot)` derives release, pause, prepare, dispatch and settlement from current Work facts. Its only executor refreshes snapshots after CAS. Startup, usage/conversation reads, owner answers and failed/completed runtime paths invoke it. Runtime/effect evidence never authorizes dispatch or unused-allocation cleanup; only recorded terminal usage settles it. A pristine abandoned claim is fenced against its original activation before release. A done decision reuses the stored original run ID and exact executor/verifier/authorization/cap, never the host default. Reservation and activation share the Work revision. A changed database feed or missing legacy selection cannot grant automatic execution.

The fault matrix interrupts **all 28 commits**, both before and after commit, with both one-shot throws and a simulated dead process: **112 boundary cases**. Fault-free restart checks no stale fresh allocation or stranded done-decision Work, preserved explicit selection, at most one call per provider role, no calls after existing runtime/effect evidence, a stable reconciler fixed point and valid journal lineage. A separate planner table spans evidence, terminal state, reservation state, decision state and feed replacement. The reported reordered-sequence identity case now rejects before any reservation/journal mutation.

Main `1180dc6` (#114) was merged, preserving app connection controls, app-document isolation, drain participants and feed checks. The E8 blocking gate again passes six rows and **176/176** required occurrences. Exactly **20 E8 allowances** are removed relative to main, with **zero additions, new diagnostics or stale entries**. The full CLI still requires all 150 rows; scoped success uses the unmodified official gate functions. Screenshots and snapshots above were refreshed on the integrated implementation.

The redesign additionally records known discriminator usage and holds pending/unknown moderation caps; this does **not** resolve the separate pre-dispatch discriminator admission-bound finding. Destination restore reauthorization and full live-provider/database behavior are not claimed verified by these fixtures. Historical open-finding lists above remain historical evidence, not a current whole-PR approval. CI and a Codex receipt must name the final pushed head.


## Self-driven review loop 1

Head `49ac8ea` passed every CI check after retrying GitHub internal-server errors: **1,951 static/unit passes** (351 skips), **2,266 actual-database passes** (36 skips), zero failures, E2E, desktop and clean installation. The full 150-row blocking screen gate reported 784 existing allowances, zero new/stale diagnostics and zero infrastructure errors. [CI](https://github.com/jabdori/massion/actions/runs/42672639648), [screens](https://github.com/jabdori/massion/actions/runs/42672639720), [code receipt](https://github.com/jabdori/massion/pull/117#issuecomment-6747916624).

Code review found no major issue. Security finding [4516387667](https://github.com/jabdori/massion/pull/117#discussion_r4516387667) exposed a read mixing a frozen usage cursor and newer terminal Work facts. Reads now retry unless reservations, usage and Work facts share one unchanged feed/cursor. Both the older-reservation/newer-cursor interleave and the exact terminal-receipt interleave failed with 0 instead of 80 before the fix and pass after it. Four affected files pass **180 tests**, with four environment skips and zero failures; typecheck passes. Main `08b5f23` (#126) is integrated. A fresh scoped six-row capture and official blocking comparison again pass 176/176 with exactly 20 E8 removals and no additions. The next pushed head requires its own CI and Codex receipts.


## Self-driven review loop 2

Head `f0d5ea1` received a [no-major-issues code receipt](https://github.com/jabdori/massion/pull/117#issuecomment-6748248315), passed the complete screen gate again, clean installation and both desktop jobs. CI exposed two test synchronization failures. The acceptance-boundary test could exhaust its 500ms budget before reaching acceptance under parallel full-suite load. It now freezes `Date` and advances it beyond the persisted deadline only at the target boundary, retaining both the rejected late acceptance and preserved committed Record assertions. Runtime-lifetime/drain tests pass **31/31**, with nine environment skips; typecheck passes.

The new main E2E's first attempt raced app iframe initialization; its retry passed that journey but captured the drain chat before its owner message rendered. The existing iframe resize check now precedes capture, and the existing browser wait checks the owner message before the drain snapshot. No assertion, single-send check, isolation check, deadline rule, network restriction or production code was removed/changed. E2E syntax passes; the full browser/database run remains CI-owned for the next head. This records failures and fixes, not a successful loop-2 CI claim.


## Live admission follow-up (GLM final LOW)

The host now passes admission activity as a callback; snapshot construction samples it after loading authoritative facts, including every refresh in a reconciliation pass. A separate run starting during cleanup therefore retains its fresh reservation until activation. The pure planner continues to consume a captured boolean, and admitted runtime/effect evidence retains its existing no-resend boundary.

The regression starts an actual configured loopback run during another Mission's reservation cleanup, holds its activation commit, then lets reconciliation refresh. Before the fix the live claim became released; after the fix it stays reserved, activation accepts, exactly two provider-role calls occur and known settlement clears the exposure. Eight affected files pass **238 tests**, with 36 environment skips and zero failures; typecheck passes. Main `156305d` (#132 E2E browser-context stabilization) is integrated. The official scoped blocking gate passes with the retained unchanged screen capture, 20 E8 removals, no additions and no new/stale/infrastructure diagnostics. No additional GLM round was requested; the new head requires CI and Codex receipts.


## Admission-owned cleanup review follow-up

The first live-admission head `fe64457` passed all CI, including **2,269 actual-DB tests**, 36 environment skips and zero failures. Codex found [4517005238](https://github.com/jabdori/massion/pull/117#discussion_r4517005238): runtime-owned cleanup could still fence another configured runtime instance's pending activation. Completion and failed-admission cleanup now execute only the central reconciler's plans matching their own Mission, Work, run ID and reservation revision. Host startup/read recovery continues to use the live-admission observer and the same pure policy.

Both paths were reproduced failing with an unrelated live claim released before activation. The fix preserves its reservation and Work revision, then the original activation accepts without duplicate provider calls. Eight related files pass **240 tests**, with 36 environment skips and zero failures; typecheck and the official scoped screen gate pass. No extra GLM round, live-model call or PR merge was performed. The follow-up head requires fresh CI/Codex results.


## Owner-expiry replay synchronization

Head `f4e5735` received no-new-issues code/security receipts and passed E2E, desktop, install and all screen contracts. Actual-DB CI exposed a test ordering race: zero-usage reservation settlement could commit after the owner-closure test captured its journal baseline. The test now waits for that confirmed settlement before comparing the complete journal across exact replay. It retains full-journal equality, conflict and zero-provider-call assertions. No production code or safety condition changed. Three related files pass **38 tests**, with 16 environment skips and zero failures; typecheck passes. The following head needs final CI/Codex receipts.
