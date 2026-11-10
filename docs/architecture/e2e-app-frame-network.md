# E2E app-frame network controls

The remaining 617px timeout is a harness failure. Run 42724203537, attempt 2,
ends on `about:blank`; the catch diagnostic prints null for both settings globals
because that document has never loaded the workbench. Attempt 1 failed later,
after the frame journey passed, so its artifact must not be used for attempt 2.

In pinned agent-browser 0.41.2 (`d52a5e90`), `apply_drained_events` installs
network controls on newly attached cross-process iframes with
`paused_before_document=false`. Its runtime injection requires a default
execution context, which need not exist yet. Failure closes the browser through
`close_after_network_control_failure`. The background tick can do the same
between commands. Our command helper's retry can then launch a blank browser,
which has neither the workbench globals nor the frame. Waiting longer cannot
recover the lost document.

A local minimal reproduction uses the production document host, CSP, frame
client and the E2E probe's fetch/resize ordering. Domain filtering reproduced
the blank-page failure; Chromium proxy controls passed ten consecutive opens.

Keep this change in the E2E harness and this note. Replace agent-browser's
context-dependent domain injection with Chromium's native proxy configuration:
a fixture-owned loopback HTTP server rejects every proxy request and CONNECT;
only the exact 127.0.0.1 hostname bypasses it. Disable Chromium's implicit
loopback bypass and non-proxied WebRTC UDP. Do not retry failed commands.
Retain the production sandbox/CSP and the probe's rejected fetch before its
617px resize. No product protocol, timeout, dependency or effect retry changes.

Add a focused real-browser regression covering the separate document, blocked
parent access, CSP-blocked local network request and app-originated resize,
plus a loopback sink proving disallowed browser requests reach only the denying
proxy. Run it alongside the command tests in E2E CI. Run related unit tests and
typecheck locally; CI owns aggregate checks and the full Linux/Electron journey.
Require green checks, a current-head Codex receipt and at least six additional
E2E workflow runs on the final head before delivery. Do not merge.

Upstream evidence: [iframe setup and fail-closed cleanup](https://github.com/vercel-labs/agent-browser/blob/d52a5e90c372ec4710c69adc3837ac14bbd852aa/cli/src/native/actions.rs),
[runtime injection](https://github.com/vercel-labs/agent-browser/blob/d52a5e90c372ec4710c69adc3837ac14bbd852aa/cli/src/native/network.rs),
[background tick](https://github.com/vercel-labs/agent-browser/blob/d52a5e90c372ec4710c69adc3837ac14bbd852aa/cli/src/native/daemon.rs).
Chromium's [proxy specification](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md)
documents the native proxy and `<-loopback>` bypass rule.
