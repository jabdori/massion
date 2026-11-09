# PR 114 desktop headless CI correction

Base: `9a7a332`, including main through `1d0d1e3`. Local verification: 2026-11-09.

## Root cause

`desktop/build.mjs` inserted the focus bridge at the first literal `</body>` in
`workbenchPage`. E5b's embedded iframe client (`src/app-frame.ts`) contains that
literal inside its `frame.srcdoc` JavaScript string. The build inserted a script
inside that string, and its closing script tag terminated the workbench script.
The emitted renderer failed JavaScript parsing (`Invalid or unexpected token`),
so connection initialization never ran. The smoke's later protocol evaluation
reported only Electron's generic `Script failed to execute` error.

The build now anchors insertion to the outer document's closing body/html suffix.
No shared source or security policy changes are needed. A build regression runs
the actual builder, checks both emitted scripts parse, and verifies that the
workbench script and separate focus bridge are preserved. It failed before the
fix (one script instead of two) and passes afterward.

The first corrected Linux smoke exposed a separate test synchronization race:
`shellOpenWork` opens the pane before `openChatWork` finishes loading the Mission
and focuses its heading. The smoke previously stopped polling on pane visibility
alone. It now waits for the existing required heading focus as well, within the
same 100 iterations / 100 ms polling bound. Both original final assertions remain;
no acceptance, sandbox, CSP, permission or connection check was removed.

## Evidence

All artifacts remain local under `.runtime/desktop-ci/`:

- `regression-before.log`: regression failed against the original builder.
- `regression-after.log`: regression passed with the corrected builder.
- `linux-before.log`: original builder reproduced CI's generic renderer execution
  failure using Linux x86-64 Node 24.19.0 / Electron 45.2.3 under Docker Xvfb.
- `linux-smoke.log`: initial corrected build passed 17 desktop tests and reached
  the existing keyboard-focus assertion, exposing the polling race.
- `linux-smoke-final.log`: final Linux x86-64 build, desktop typecheck, all 17
  desktop tests and complete Xvfb smoke passed; container exit code 0.
- `typecheck-root.log`: root typecheck passed on the host.
- `window.png`, `focused-work.png`, `accessibility.json`: final smoke artifacts;
  942 accessibility nodes, composer present, notification Work and keyboard
  focus, dark/light theme, close/reopen and explicit quit checked by the smoke.

The existing `massion-e4-auth-amd64` Docker image supplied Linux dependencies;
current checkout sources, fixture scripts, desktop tests, builder, bridge and
TypeScript configurations were mounted into it. The smoke kept Chromium sandbox
settings enabled and used the existing Docker capability/seccomp configuration.
The absent system D-Bus produced diagnostics but no failed assertions.

Host desktop typecheck initially failed because local Electron dependencies were
missing. The final container run used its installed Electron types and passed.
An intermediate container command lacked the desktop tsconfig; the final run
mounted both checkout tsconfigs and passed. No dependency installation was needed.

No visible Electron/Chrome launch, real credentials, model calls, full repository
test suite, screen contracts, package build, commit, push or PR comment was made.
Independent review and remote CI remain with the lead. This evidence covers the
bundled desktop shell; it does not claim MCP owner reconciliation acceptance.


## Final integrated follow-up

The main implementer reran the desktop tests/typecheck with the final reconciliation client, then rebuilt and reran Linux Xvfb smoke after the offline-initialization correction. Both container commands exited 0. Current desktop screenshots, AX tree and logs are committed under [desktop-ci/](desktop-ci/). Root typecheck passed on the host; the container image has desktop dependencies only, so a preliminary root `tsc` attempt inside it was replaced with that already-passing host check. Desktop tests passed 17/17; the final smoke retained every security and focus assertion.
