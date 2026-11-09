# Internal teams per Work

- Scope: Q13, ADR 0003 §2 and ADR 0004 §2; stacked on member Work (#96).
- Screens: B7, B7-churn, B22-room. Rooms and mutual challenge remain Q14.

## Contract

Member Work pins the active adopted/owner procedures at admission (identity, version,
body hash and body), or a versioned host default when none exists. Only procedures
of that member are eligible; archived/off candidates are excluded and load checks
run again. Up to twelve procedure steps fit this bounded text runtime; exceeding
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
4. Run typecheck, syntax checks, full tests with the brief's physical TMPDIR, then
   the required agent-desktop fixture screen and interaction checks. Fetch/merge
   feat/member-work again before push; PR base is feat/member-work.

## Limits

Text-only authorized providers; no outside tools, rooms, mutual challenge or new
persistent members. Fixtures establish behavior, not real-provider quality.
