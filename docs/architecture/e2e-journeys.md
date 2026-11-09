# End-to-end journeys (E9a, E9a2)

## Outcome and scope

One opt-in suite drives the actual workbench in headless agent-browser against a
separate daemon process, real SurrealDB and deterministic, credential-free model
adapters. It checks accessibility snapshots and durable state together. CI must
execute it without skips, within twelve minutes, and retain failure evidence.
No production behavior, provider authority or UI copy changes are needed.

Use the existing disposable database launcher, host connection manager, conversation
and member services, correction admission, app decisions, drain and portable backup.
Model replies, local login detection, payment/remote delivery and MCP adapters
are fixtures. Test-only IPC stages effect proposals through real application
commands and the host effect service; it does not add a public producer route. HTTP/protocol routes,
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

## Decisions, apps and desktop coverage (E9a2)

The same suite now checks payment checkout, Later, Ask again and approval with
one stored dispatch/receipt; a lost payment reply stays unknown. Remote admission
shows the in-flight sent state and arrival receipt without accepting the Work.
Lost payment and remote receipts survive daemon restart and replay without a new
adapter call. Every state has an accessibility snapshot and screenshot.

An MCP app waits for install approval. Its write timeout persists unknown; a
replayed call and a distinct next write cannot resend it. The existing app page
requires owner evidence to reconcile that exact call before a new write succeeds.
The page script executes in a separate document with an opaque sandbox origin,
resizes through the existing bridge, and cannot mutate the parent DOM.

Linux Xvfb runs the actual Electron shell against a fresh real database and the
same fixture daemon, through the production private supervisor, authentication
handshake and protocol bridge. The unchanged payment journey runs there too,
including Later/Ask/approval, persisted receipt and a lost reply that stays unknown
without resend after reload. Explicit quit must drain the
supervisor. Missing Electron, Xvfb, database or browser fails rather than skips;
never launch a visible desktop window on the owner's Mac.

Monthly budget remains excluded until #117 merges. No real money, remote device,
MCP network server, provider inference or release is exercised. The fixtures stage
effect-ready Work because there is no general checkout/handoff producer in the
runtime. They do not establish autonomous shopping or remote execution quality.

## Evidence and delivery

Keep run artifacts under `.runtime/e2e/`, upload in CI on success or failure.
Guide images, when retained, come from this run and are labeled fixture evidence.
Commit E9a2 to `test/e2e-journeys-2`, open the requested PR, request `@codex review`, and
leave merging to the owner. No release, signing, publication or deployment.

## Run and inspect

Install `agent-browser@0.41.2`, its headless browser (`agent-browser install
--with-deps` on Linux), Xvfb and xauth. Build the existing desktop shell from the
checkout (CI also enables Electron's existing sandbox helper):

```sh
npm ci --prefix desktop --ignore-scripts --no-audit --no-fund
npm run install:electron --prefix desktop
npm run build --prefix desktop
MASSION_SURREAL_BINARY=/absolute/path/to/surreal \
  xvfb-run -a python3 scripts/with-surreal.py --timeout 480 -- npm run e2e
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
