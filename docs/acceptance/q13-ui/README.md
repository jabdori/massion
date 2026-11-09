# Q13 UI evidence

Captured on 2026-11-09 in the shared Q13 worktree. This report supersedes the earlier unfrozen screenshots and raw-text budget results. The lead updated the E3c ledger for the six independently identified occurrences linked below.

## Focused correction

B7 retains the existing compact procedure rows: marker, task title, and optional skip reason or unfinished dependency. Non-skipped worker results appear below the procedure, under the real member name and role chip. B8 retains attributed results in its expanded flow. Participants remain member → worker roles → Check. Stored `Skipped · reason` output is displayed as `건너뜀 · reason` from `Task.step.skipReason` without duplicating the reason.

The existing exact Work read, revision refresh, request generation, feed replacement and deadline safeguards remain in use. No room messages, challenge flow or new write API were added.

Changed production and test sources:

- `src/work-room-panel.ts`
- `tests/internal-teams-surface.test.ts`
- `docs/product/screens/copy.ko.json` (the two Q13 copy entries from the initial implementation)

## Focused tests

The corrected assertions first failed in six of ten tests against the verbose rows. After the correction, all ten tests passed:

```sh
TMPDIR=/private/tmp node --test tests/internal-teams-surface.test.ts
```

The tests cover flat procedure rows, results after the procedure, member/role attribution, literal text handling, non-worker result exclusion, existing Works without steps, unresolved member identity, tab/read failures, out-of-order reads, dependencies, feed replacement, and minute/deadline refresh. `git diff --check` also passed for the changed UI and test files.

No full suite or duplicate core/typecheck run was performed during this correction; the lead owns the concurrent core checks. Earlier 120-test results belong to the initial implementation, not this final correction.

## Reproducible capture

The installed `agent-browser` core guide and init-script command documentation were read. The isolated headless session is `massion-q13-154e55a01c9b`; no visible desktop windows were opened. The scoped runner is `scripts/ui-contracts/verify-internal-teams.mjs`; it derives its own session from the worktree. Run it from the repository root with `node scripts/ui-contracts/verify-internal-teams.mjs`.

The runner freezes both `new Date()` and `Date.now()` before navigation to the fixture's `now` value, `1793855520000`. Both B7 screenshots show `4분`. The 1440×900 viewport comes from the matching B7-churn contract. Light and dark color preferences are asserted.

Source fixtures (kept outside the fixed 75-screen catalog; the existing fixture host accepts their explicit read-model data):

- `tests/fixtures/internal-teams/B7-teams.json` inherits B7-churn and overrides the two exact Mission/Work read responses with pinned `TeamProcedure` data, including required `skillsRevision`, nested worker steps, dependency IDs and task results.
- `tests/fixtures/internal-teams/B8-teams.json` uses the same data and widens the pane.

`validateTeamProcedure` passes for the fixture pin. These are synthetic read-model examples, not real-provider execution or verified business facts.

For each capture, the runner evaluates `visibleTextBudgetExpression` from `scripts/ui-contracts/report.ts`, maps the measured regions with `visibleBudgets`, and saves `{data:{snapshot},visibleTextBudget}`. Contract checking uses that JSON, never the raw TXT snapshot. The previous header budget error was a raw accessibility-text measurement artifact and is not an accepted UI defect.

## Matching B7-churn contract results

| Theme | Passed / required | Remaining failures | Warnings | Visible-budget failures | Forbidden-copy failures |
| --- | ---: | ---: | ---: | ---: | ---: |
| Dark | 49 / 74 | 25 | 2 | 0 | 0 |
| Light | 49 / 74 | 25 | 2 | 0 | 0 |

Exact artifacts, relative to this directory:

| Theme | Screenshot | Measured snapshot JSON | Full checker output |
| --- | --- | --- | --- |
| Dark | [B7-teams-dark.png](B7-teams-dark.png) | [B7-teams-dark.snapshot.json](B7-teams-dark.snapshot.json) | [B7-teams-dark.contract.txt](B7-teams-dark.contract.txt) |
| Light | [B7-teams-light.png](B7-teams-light.png) | [B7-teams-light.snapshot.json](B7-teams-light.snapshot.json) | [B7-teams-light.contract.txt](B7-teams-light.contract.txt) |

```sh
node scripts/ui-contracts/contract-check.mjs docs/acceptance/q13-ui/B7-teams-dark.snapshot.json docs/product/screens/contracts/B7-churn.json
node scripts/ui-contracts/contract-check.mjs docs/acceptance/q13-ui/B7-teams-light.snapshot.json docs/product/screens/contracts/B7-churn.json
```

Both commands exit 1 because the unsupported required elements remain. Neither contracts nor thresholds were relaxed. The two warnings are inherited conversation text: six sentences versus five, and a longest string of 36 versus the allowed 34. They are not new worker-result budget failures. Measured header text is one character; pane text is 163 characters, two sentences, with a longest string of 22 characters.

[Exact occurrence observations](business-procedure-occurrences.json) identify independent successful matches, with contract order, snapshot line and checker line in each theme:

- `pane`, order 10, `text "요약"`: the participant role text.
- `pane`, order 12, `text "절차"`: the compact procedure heading.
- `pane`, order 13, `text "{progress}"`: the visible `2/4` count.

These are evidence for the lead to evaluate the corresponding business-procedure diagnostics (including dark R012/R013/R014). They do not close similarly worded later occurrences. In particular, accessible list-item names can satisfy generic member/role patterns; those matches are not evidence of Q14 messages or per-step timestamps.

Remaining failures are preserved verbatim in each checker output: three conversation links for business progress/steering, Save/Discard memory controls, eight time occurrences, five room Copy controls, repeated member/role ordering, and the specific check-pending predicate. The original five-message Q14 sequence is not supplied by a task result block. Payment, steering continuation, per-step timestamps and business-predicate evidence remain outside this capture.

## B8 and interaction evidence

[B8-teams-dark.png](B8-teams-dark.png) and its `.snapshot.json`/`.snapshot.txt` capture the expanded churn flow. This is a structural/rendering and interaction check only. It is not compared against the printer B8 contract and provides no evidence for closing B8 E3c diagnostics. The earlier mismatched printer-contract output was removed.

[interactions.json](interactions.json) records all three scoped runs. Each asserts participant order, flat B7 rows, results after the procedure, translated skips, dependencies, frozen duration, no horizontal overflow, opening the existing inspection area, width toggle, mobile width (390×844), closing the pane, and zero product write commands. B8 additionally asserts the attributed result in its flow. The three runs passed without assertion failures.

Each run has `-inspection.png` and `-mobile.png` evidence. Mobile captures occur after the width toggle, so B7 runs show expanded mobile layout and B8 shows compact mobile layout. Screenshots were inspected directly; no pixel-exact or full-contract conformance claim is made.
