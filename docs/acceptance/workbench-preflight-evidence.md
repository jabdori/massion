# Work-aware selection and preflight evidence

## Customer outcome and acceptance

Before explicitly running bounded Work, the owner can inspect executor/verifier
choices, two-call output reservations and an authoritative check of that exact
Work revision. Invalid or obsolete selection feedback must not look current.
Checking must not write state, resolve credentials, admit effects or invoke a
provider. Explicit Run must recheck admission; a successful check is not a lease.

This increment follows PR #7 head `58aa399294bfd53eac77061a52334278ab8e3b6e`.
It preserves its owner quarantine and immutable connection-binding contracts.
No account setup, real inference, new permission, paid resource, merge or
deployment is included.

## Implemented and tested

- `ProductService.preflight` loads the authoritative snapshot. The runtime check
  binds Mission, Work, authoritative revision and expected revision. HTTP 409
  reports stale revision; ineligible Work returns `ready: false` diagnostics.
- Check and Run share pure Work-admission checks for missing pinned inputs,
  insufficient remaining budget, closed Work, already admitted execution evidence
  and non-fresh task progress. A cancelled or unknown/admitted run cannot be
  replayed by changing a profile. Work-pinned review criteria stay authoritative
  after Mission revision. Fresh owner steering is included by a deliberate run.
- The UI preserves empty explicit selections and shows the two-call token
  reservation against available Work budget. Output units are not dollars or
  total input-plus-output billing. A profile selection is not new authorization.
- Check feedback is local to the exact rendered Work/revision/selection. Duplicate
  pending checks are suppressed; input changes, navigation, newer render, catalog refresh/reconnect and Run
  invalidate earlier results. Detached forms cannot submit against another Mission. A failed catalog refresh
  removes stale execution choices; same-revision reconnect preserves explicit
  drafts while invalidating prior check results and keeping current controls usable.
- `tests/client-workbench.test.ts` runs the actual inline client through a small
  DOM double against the real HTTP host, separate executor/reviewer model choices
  and an actual loopback mock provider. Mission/Work creation and Check make zero
  provider calls. Explicit Run makes the selected two calls and accepts a
  fixture-class Record. A new HTTP host and reloaded client reconstruct the same
  state and journal without provider replay. The durable variant uses actual
  SurrealDB and a fresh store adapter.
- The new shared DOM helper is `tests/support/workbench-client.ts`. It models
  client logic only. Native browser constraints, layout, focus behavior and assistive
  technology are not simulated or claimed.

## Candidate verification

Node 24.19.0, pinned TypeScript 7.0.2, actual SurrealDB 3.3.0/SurrealKV:

- `npm run check`: strict types and runtime syntax passed; **239 passed,
  18 intentionally skipped actual-store tests, 0 failed**.
- Complete disposable actual-store/restart aggregate: **257 passed, 0 skipped,
  0 failed**. Counts describe this complete candidate, not a sum of increments.
- `git diff --check`: passed.
- Exact published source identity, independent review and remote CI are recorded
  in the PR after publication; do not infer those from these local counts.

```sh
npm run check
MASSION_SURREAL_BINARY=/absolute/path/to/surreal \
  python3 scripts/with-surreal.py -- \
  env MASSION_TEST_SURREAL_RESTART=1 \
  node --test --test-concurrency=1 tests/*.test.ts
```

The client integration test file runs before `storage.test.ts`: that final
actual-store fault-injection test kills its disposable database and closes its
replacement. Keep live-store checks before that destructive boundary.

## Limits

On 2026-10-04 the dot-cloud browser was again asked to open the running disposable
loopback host at `http://127.0.0.1:8766`. It returned `ERR_BLOCKED_BY_CLIENT`.
No alternate route around that restriction was used. Actual browser visual,
responsive and accessibility QA remains unverified.

Local HTTP fixtures and actual database persistence do not establish external
provider compatibility, live credentials, real independent judgment quality,
production authentication or complete product readiness. A positive preflight
also does not predict remote availability or prove final request-size acceptance.
Live provider evidence remains subject to its separate authorized integration gate.
