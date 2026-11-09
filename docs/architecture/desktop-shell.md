# Electron development shell (E4)

Implements the E4 brief against ADR 0005 using the existing loopback development
daemon and protocol client. This is an unsigned development app, not the later
authenticated socket transport or signed release. No screen or core write path
changes. Build the existing workbench into the app; serve it at `massion://app/`.
Only the three existing protocol endpoints carry application data from main to
loopback HTTP; a private main-process handshake authenticates each connection.
The renderer never receives a daemon address, filesystem API or arbitrary IPC.

## Boundaries and implementation plan

1. Test security policy, negotiated incompatibility and single-send transport
   against fixture hosts before implementing them. Hash the bundled inline
   scripts/styles for CSP; preserve existing dynamic style attributes. Deny
   navigation outside the app, windows, permissions, downloads and webviews.
2. Add `desktop/` with a sandboxed window, one receive-only typed focus bridge
   plus a ready acknowledgement, OS-native theme and single-instance lock.
   A generated host adapter calls the existing Work/decision opening functions;
   it does not edit `src/` or add a screen-specific transport path.
3. Start or attach to the existing daemon. A detached Node 24 supervisor owns
   a private control socket and PID record under app user data. The kernel's
   socket lock is authoritative (unlike a reusable PID). Only the single-instance
   launcher reclaims a refused stale socket. A live holder is never replaced.
   Closing windows keeps the daemon and notification observer alive. Explicit
   app quit requests bounded drain through the supervisor; unauthenticated
   external hosts are refused. Never retry a command on reconnect.
4. Read the existing protocol for exception notifications only: unknown Work
   outcomes, failed/stale/blocked Work, and open owner decisions. Deduplicate
   by feed, identity and exception, never ordinary revision/progress. Invalidate
   old targets on feed replacement; notification clicks reopen/focus the existing
   Work or decision. A failed read produces no notification or command.
5. Add fixture-only unit/lifecycle checks and a Linux Xvfb Electron smoke which
   asserts actual negotiated connection, title, accessibility, CSP, window
   settings, theme changes and focus delivery. Never launch Electron visibly on
   the owner's Mac. Package an unsigned macOS app with hardened fuses; signing
   and notarization belong to E9.

Review focus: redirects and hostile origins; navigation or child frames reaching
IPC; incompatible daemon admitting a write; stale notification targets after
database replacement; window close killing the daemon; packaged core paths.
No storage, provider, model or UI redesign is in scope. Independent review is
owned by the lead, once per PR. Locally run affected tests and typecheck; CI owns
the full suite and screen contracts, per the brief's verification budget.

Security follows [Electron security](https://www.electronjs.org/docs/latest/tutorial/security)
and headless validation follows [Electron's Xvfb guidance](https://www.electronjs.org/docs/latest/tutorial/testing-on-headless-ci).

## Verification (2026-11-09)

- Root and desktop typechecks passed. The focused desktop/client/protocol run
  passed 27 tests; the desktop's 10 tests also passed on Node 24.19.0 in Linux.
- Electron 45.2.3 under Linux Xvfb passed actual connection, title `Massion`,
  a 928-node accessibility tree, disabled renderer Node, restricted preload,
  sandbox/isolation, script injection and external network/navigation denial,
  denied media permission, dark/light media queries, Work pane/keyboard focus,
  window close/reopen and external-daemon survival after explicit app quit.
- macOS arm64 packaging passed without a signing identity. All seven required
  fuse values were read back from the resulting binary. The core was imported
  from the actual app resource directory without relying on checkout resources.
- Regressions cover missing packaged copy resources, a delayed member decision
  read, an older notification click completing last, and quitting while attached
  to a different daemon origin. Unknown command responses are never resent.
- Local screenshots and accessibility evidence:
  `/private/tmp/massion-e4-evidence/{window.png,focused-work.png,accessibility.json}`.
  CI uploads equivalent `desktop-headless-evidence` artifacts.

No visible window was opened on the owner's Mac. Real model calls, real macOS
notification delivery, signed distribution and the full repository suite were
not run locally. Full checks and screen contracts remain CI-owned per budget.
Headless Linux logs report the absent system D-Bus; all smoke assertions pass.

## PR 112 packaging and CI correction

The first CI headless run failed with `UnknownVizError`; local ARM Linux evidence
did not establish the CI graphics path. The smoke launcher now disables hardware
acceleration before readiness and asserts that setting alongside the unchanged
sandbox, isolation and permission checks. Production rendering is unchanged.

Review also found two gaps in the original packaging evidence: external Node
cannot execute the supervisor from `app.asar`, and the TypeScript-only resource
filter omitted `app-runner.mjs`. The shared launch-path resolver now points to a
physical `extraResources` supervisor; the app worker is explicitly included.
Both omissions failed the strengthened regression before the fix. Resource tests
honor the copy filters, and every macOS packaging command also runs them against
the actual `.app` using external Node, without opening a window.

Correction verification: desktop typecheck and all 12 desktop test cases passed;
the macOS arm64 build and its three actual-resource checks passed. Linux x86-64
Node 24.19.0 / Electron 45.2.3 passed the full Xvfb smoke with GPU acceleration
disabled, including both screenshots and all existing security assertions.
Evidence: `/private/tmp/massion-e4-review-evidence/`.

## PR 112 daemon authentication

The security review found that a v1 response on a loopback port did not prove
ownership: another OS user could occupy the port. The supervisor now creates a
fresh 256-bit key in memory per launch, sends it to the core through anonymous
descriptor 3 (closed and its environment marker removed immediately), and makes
it available to main only over its owner's 0600 socket in the private app-data
directory. Status, PID records and logs never contain the key. Missing or unsafe
credentials fail closed; bare development hosts can no longer be attached.

Each request opens a dedicated connection and asks for a fresh HMAC-SHA256 server
proof. Both nonces, the server's actual loopback port and the role are bound to
the proof. Main verifies it before sending application headers/body and pins the
next request to the same physical TCP socket; connection replacement fails before
write. A different client-role proof authenticates every request on that socket.
The key itself never crosses HTTP. This blocks captured-proof replay, reflection,
cross-port relaying and post-handshake port takeover without command retries.
Normal protocol version/generation/feed checks remain in place after authentication.

The core guard precedes all product reads/writes, including legacy routes and SSE.
The standalone browser development host remains explicitly unauthenticated when
not launched by the supervisor; the desktop refuses it. This is per-OS-user local
authentication, not remote TLS or protection from another process of the same OS
user. The fixture smoke now uses the real supervisor and authenticated server guard.

Verification targets: v1-speaking impostor receives no owner payload/key; wrong
key and unauthenticated requests are rejected; closed/changed socket and a proof
relayed from another port are refused; fresh launches rotate keys; socket mode,
log secrecy, authenticated SSE and existing incompatibility states remain intact.

After merging `origin/main`, both typechecks passed. Focused desktop, protocol,
server and fixture tests passed 38 cases, with the one opt-in SurrealDB restart
case skipped. The macOS package and all three actual-resource checks passed.
The initial server-fixture run rejected macOS's symlinked temporary path; rerunning
with the required physical `TMPDIR=/private/tmp` passed without a code change.
Linux x86-64 Node 24.19.0 / Electron 45.2.3 passed the complete headless smoke
against the real supervisor and authenticated fixture daemon, including SSE,
window close/reopen, focus, security checks and explicit-quit drain.
