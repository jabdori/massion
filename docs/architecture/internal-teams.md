# Internal teams per Work

- Scope: Q13, ADR 0003 §2 and ADR 0004 §2; rebased onto main after member Work (#96) and E3c (#108).
- Screens: B7/B8, B7-churn, B22-room. Rooms and mutual challenge remain Q14.

## Contract

Member Work pins the active adopted/owner procedures at admission (identity, version,
body hash, body and the skills aggregate revision), or a versioned host default when none exists. Only procedures
of that member are eligible; archived/off candidates are excluded and load checks
run again. The existing host `use-skill` command records use through the drain-aware
store so an in-use procedure is not silently archived. Its read revision remains
pinned even if a concurrent edit commits before the Work. Up to twelve procedure steps fit this bounded text runtime; exceeding
that bound refuses admission, never silently drops steps. Historical Works stay intact.

A fresh team-lead call expands every pinned step into one worker role, a task title,
earlier-step dependencies and optionally a skip reason. The host validates the
whole plan before delegating. The tree is root → producing/lead task → worker steps;
the checking task is a separate root child. Skips settle with `Skipped · reason`.
The producing model is the member's authorized model; each call has fresh context.
Workers get exact Work/input/Record pointers and only their required task data.
The lead assembles worker results into the artifact. The existing independent checker
checks its bytes and the family relation includes every producer assignment.

Ready workers run concurrently. Command commits are serialized locally; provider
calls are not. Only distinct ready team tasks may overlap pending effects; unknown
effects block new admissions. Claims, deadlines, cancellation, grants and output
reservations retain the existing no-replay contract. Reserve the full bounded
plan (planning + one call per step + assembly + check) before starting.
No member/worker acquires memory, checking, policy or other members' authority.

## Implementation and checks

1. Tests first: procedure selection/pinning, invalid plans, nested tasks, dependency
   and skip behavior, independent checking, parallel dispatch and unknown outcomes.
2. Reuse skills validation and application dispatch; extend domain tasks and backup
   validation, assistant admission and configured runtime. Test duplicate commands
   and drain-aware owner writes using existing paths.
3. Show real member, role chips, Check last and a semantic progress list, with step
   results attributed to the member. Test changed feeds, timer refresh and late
   responses using the existing shell generation guards.
4. Run typecheck and related tests with the brief's physical TMPDIR, then
   scoped headless agent-browser fixture screen and interaction checks. CI owns
   the full suite and all screen contracts; PR base is main.

## Limits

Text-only authorized providers; no outside tools, rooms, mutual challenge or new
persistent members. Fixtures establish behavior, not real-provider quality.

## Revised integration (2026-11-09)

Keep main's B7/B8 rendering, Korean copy and tokens. Feed named task labels,
role chips, dependencies, skip reasons and worker results through the existing
Mission/Work reads; no new write API. Worker results appear under the member's
identity, not as room conversation. Q14 still owns room messages and challenges.
Update the E3c residual ledger only for capabilities exercised by Q13 evidence;
retain payment, steering continuation, timestamp and business predicate gaps.


## Verification (2026-11-09)

Related core tests: 176 total, 166 passed, 10 environment-gated skips, zero failures.
Command: `TMPDIR=<physical scratchpad/tmpdir> node --test tests/internal-teams.test.ts tests/member-work.test.ts tests/configured-runtime.test.ts tests/domain.test.ts tests/application.test.ts tests/backup-lineage.test.ts tests/family-map.test.ts tests/provider-dispatch.test.ts tests/runtime-lifetime.test.ts tests/skills.test.ts`.
Tests cover immutable procedure reads across concurrent edits, live usage bookkeeping,
overlapping delegates, separate worker authority, dependency-driven concurrency,
skips, invalid plans and unknown outcomes without replay. Existing legacy Work,
independent family-check and durable-journal regressions remain passing.

Scope limits: at most twelve pinned procedure steps, one authorized producing model
for the lead and workers, and 16,000 characters per worker result. The complete
budget reserves planning, every possible worker call, assembly and the independent
check. No arbitrary tools, real-model quality measurement or global multi-Work
scheduler is added; the existing host admission limit remains.

Final integration checks: `npm run typecheck` passed. The related integration batch
(`internal-teams`, `member-work`, `internal-teams-surface`, `work-room-visual`,
`member-work-surface`, `surface-shell`, `owner-record-artifact`) passed 202 tests
with four environment-gated skips and no failures. The separate UI fixture-catalog
suite passed all 13 tests; Q13 examples live outside the fixed 75-screen catalog.
`node scripts/ui-contracts/verify-internal-teams.mjs` passed three headless interaction
runs. Both B7-churn theme checks match 49/74 required elements with zero new copy
or visible-budget failures; the 25 remaining required failures per theme are
retained as scoped capability gaps, not a passing contract. B8 was checked for
layout and interaction, not against the printer-specific fixture contract.
[Screen evidence](../acceptance/q13-ui/README.md) and the
[six resolved E3c occurrences](../acceptance/e3c/q13-resolved.json) retain exact scope.
The complete suite and all screen contracts are left to CI per the revised brief.
