# End-to-end journeys (E9a)

## Outcome and scope

One opt-in suite drives the actual workbench in headless agent-browser against a
separate daemon process, real SurrealDB and deterministic, credential-free model
adapters. It checks accessibility snapshots and durable state together. CI must
execute it without skips, within ten minutes, and retain failure evidence.
No production behavior, provider authority or UI copy changes are needed.

Use the existing disposable database launcher, host connection manager, conversation
and member services, correction admission, app decisions, drain and portable backup.
Only model replies and local login detection are fixtures. HTTP/protocol routes,
reducers, event feeds, artifact verification and storage remain real. Fixtures
must refuse unrecognized model requests. Browser traffic is loopback-only; no
user credential, login process or real account is used.

## Sequence

1. Write the journey assertions, run with missing prerequisites and verify a hard
   failure; then compose the fixture daemon and wire the opt-in command.
2. Check empty first run without/found login; conversation, Work handoff, accepted
   Record, known rejection and explicit correction; member admission, team steps,
   challenge and separate checking; app install; unknown response and drain/restart
   without replay; fresh database restore and relocated accepted bytes.
3. Add the Linux `e2e` job, timeout and retained snapshots/screenshots/report.
4. Write the English owner guide and link it from README. Run typecheck and related
   checks only, per the brief's verification budget; CI owns the aggregate suite.

## Explicit capability gaps

Payment execution, external-member delegation, monthly budget decisions and MCP
reconciliation have no current producers/routes. Existing server tests and E3e
fixtures explicitly refuse invented decisions. Assert rejection and unchanged
storage for the unsupported decision kinds; MCP has no route to exercise. Do not
manufacture successful journeys or implement these products here.
The desktop smoke currently uses a separate canned daemon; this suite uses the
brief's workbench fallback. Running these journeys through the authenticated
Electron bridge remains follow-up, not evidence supplied by the separate smoke.

## Evidence and delivery

Keep run artifacts under `.runtime/e2e/`, upload in CI on success or failure.
Guide images, when retained, come from this run and are labeled fixture evidence.
Commit to `test/e2e-journeys`, open the requested PR, request `@codex review`, and
leave merging to the owner. No release, signing, publication or deployment.

## Run and inspect

Install `agent-browser@0.41.2` and its headless browser (`agent-browser install
--with-deps` on Linux), then from the checkout:

```sh
MASSION_SURREAL_BINARY=/absolute/path/to/surreal \
  python3 scripts/with-surreal.py --timeout 480 -- npm run e2e
```

This suite requires Linux process-ownership evidence and fails, rather than skips,
when prerequisites are missing. `MASSION_E2E_BROWSER` can select an already
installed Chromium executable. In a container, keep a network interface so
Chromium reports online; an internal Docker network blocks external routing
without making the UI's offline guard refuse local commands. Browser domains
are restricted to loopback and the model transport never opens a network socket.

Backup/restore uses a separate real installation with one accepted and one
unknown Work. The full scenario journal exceeds the default RPC request-size
limit; the suite does not widen that limit or retry an uncertain restore. It
verifies a new destination, exact journal identity, removed original artifact
files, normal accepted-text reads and zero additional provider calls.
