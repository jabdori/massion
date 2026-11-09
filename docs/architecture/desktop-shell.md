# Electron development shell (E4)

Implements the E4 brief against ADR 0005 using the existing loopback development
daemon and protocol client. This is an unsigned development app, not the later
authenticated socket transport or signed release. No screen or core write path
changes. Build the existing workbench into the app; serve it at `massion://app/`.
Only the three existing protocol endpoints cross from main to loopback HTTP.
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
   app quit requests bounded drain through the supervisor; an externally started
   host remains externally owned. Never retry a command on reconnect.
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
