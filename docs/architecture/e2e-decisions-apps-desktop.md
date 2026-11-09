# Decision, app and desktop journeys (E9a2)

Extend the existing E9a suite with real daemon/SurrealDB state and accessibility
snapshots. Production code is unchanged. Test controls stage assigned Work through
the existing application commands and effect proposal service; the normal owner
route and UI decide it. Payment and remote delivery adapters are deterministic
fixtures, never real accounts. A receipt is not independent Work acceptance.

Implementation and checks:

- [x] Write payment assertions first, including later/ask, overlapping receipt replay,
  one receipt, lost reply and restart without resend; add fixture controls.
- [x] Exercise external admission, in-flight sent state, arrival and missing
  receipt, with pending Work acceptance and durable identity assertions.
- [x] Offer an MCP package, approve in the UI, time out a pinned write, refuse a
  later write, reconcile with owner evidence in the UI and admit a new write.
  Verify its script runs in an opaque isolated frame and cannot reach the host.
- [x] Reuse the payment assertions through the actual Electron shell, its normal
  authenticated supervisor and bridge, under Linux Xvfb only. No native Mac UI.
- [x] Bound CI to twelve minutes, retain snapshots/screenshots and call records,
  run typecheck and affected tests, and check #117 before publishing the PR.

Only scripts/e2e, the E2E workflow, and this documentation are owned by this change.
Reuse existing daemon lifecycle/storage tools and desktop build; no new public
API, retry, dependency, model call or production behavior. Tests first means the
new journey must fail for absent fixture staging before the staging is added.
CI owns aggregate checks and all screen contracts per the owner's budget.

Monthly budget is included only if #117 has merged by completion. Fixture
execution does not establish payment competence, remote delivery or model quality.

## Verification

Final local Linux arm64 run: Node 24.19.0, SurrealDB 3.3.0, Electron 45.2.3,
agent-browser 0.41.2 and Xvfb on an internal Docker network without external routing.
All 13 tests passed, none skipped, in 36.7 seconds. The inventory records 29 model
fixture calls and 8 effect fixture calls, including both Electron payment outcomes;
no live calls. Related effect-decision and MCP tests: 38 passed, none skipped.
Typecheck, runtime syntax/copy lint and diff whitespace checks passed. Full-suite
and all-screen checks remain CI-owned. The local container needed SYS_ADMIN and
an unconfined seccomp profile for Electron's Linux namespaces; the renderer sandbox
was retained. CI uses the existing desktop smoke's sandbox helper setup.

PR #117 was still open and unmerged after journeys 1–4 passed, so monthly budget
is deliberately excluded. The run retains AX snapshots, PNGs, separate desktop
call records and daemon logs under `.runtime/e2e/`. No production source changed.

The first CI run exposed agent-browser's opaque-iframe network-control setup
with automatically downloaded Chrome for Testing 157. The initial workaround
selected runner-provided Chrome 156.0.8078.79; R-C reproduced the same missing
execution-context failure on that build in two CI attempts. The tool replaced
its tab with about:blank while a separate CDP inspection still found the original
application root healthy. This is not an application top-level navigation.

R-C pins Playwright 1.64.0's Chromium build 1248 (156.0.8078.4), using its installer
only as CI tooling. Two narrow actual-host runs with agent-browser 0.41.2 reached
the scripted iframe's 617px height, retained the application root, and observed
parent access blocked with sandbox/credentialless and the domain filter unchanged.
The [official browser map](https://github.com/microsoft/playwright/blob/v1.64.0/packages/playwright-core/browsers.json)
fixes the executable path used in CI. No browser or app security control is removed.
Related upstream investigation:
https://github.com/vercel-labs/agent-browser/pull/2193.
