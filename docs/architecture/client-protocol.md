# Client protocol and feed push (E2)

Implements ADR 0005 §2 / AR7 for the loopback development workbench. The UI uses
one client for commands, queries and feed hints. No panel owns an HTTP call.
The existing product handlers, application fingerprints, operation lookup,
feed admission and drain-aware owner store remain the only write path.

## Contract

Protocol v1 has a supported range `[1, 1]` on both sides. Connect exchanges ranges
and feature flags (`commands`, `queries`, `feedPush`); each feature is gated once
in the client. Every protocol request, reply and feed hint carries `version`,
`requestId` and `generation`. Unknown versions are refused before admission.
The connection query reports `ready`, `update-needed` or `restart-needed`; the
last requires an explicitly supplied installed-core range. No new UI copy.
Additive optional fields may preserve v1; incompatible changes require a new
version. No silent downgrade or fallback when a feature is unavailable.

The HTTP adapter maps protocol requests to the existing route dispatcher, not
another service path. Legacy loopback development routes remain for existing
headless tools; they are not another UI submission path. They do not claim to
speak the versioned protocol. Correlation and generation never enter application
fingerprints. Command payloads keep their original command identity, expected
revision and feed identity. Settings and app-view operations keep their existing
contracts; wrapping them does not invent durable receipts or retry semantics.

The client owns request IDs, timeouts, cancellation and generations per read
scope. Selection changes invalidate the relevant scope. A stale reply or error
cannot replace a newer read. Command replies are correlated, never retried;
existing private drafts and pending-operation journals remain at their current
owners. Evidence-specific pin checks remain in the panels.

## Feed

The SSE adapter composes HTTP command/query delivery with an SSE subscription.
The HTTP-only adapter supports explicit catch-up queries and refuses push; the
workbench selects SSE at bootstrap, with no screen-level transport branches.
SSE IDs bind feed identity and the last durable global cursor, not timestamps or
per-Mission revisions. Hints include the changed aggregate revision when known.
Opening a socket never settles a command or opens the write barrier. Reconnect,
gap or feed replacement requests an authoritative read; retained event pages
are read through completion for exact pending-command reconciliation.

The store currently has no live subscription port. A shared, bounded host-side
observer reads the durable head every second only while SSE clients exist; HTTP
mutations also wake it immediately. This observes runtime and external-store
writes and database replacement without changing storage commits. Browser
polling is removed. Slow clients are disconnected instead of accumulating an
unbounded queue; reconnect recovers by query. Drain closes streams before waiting
for HTTP closure. A connection notification is transport presence, never delivery evidence.

Existing bounded JSON/artifact reads need no chunk assembly now. A typed transfer
contract records transfer identity, sequence, final marker and acknowledgement;
no chunk feature is negotiated or sent in v1.

## Implementation and verification plan

- [x] Add failing HTTP protocol tests: range/feature negotiation, correlation,
  replay and conflicting identity, overlapping identical writes, drain refusal.
- [x] Add the typed protocol contract and adapter around the existing dispatcher;
  prove unsupported messages cannot mutate state.
- [x] Add client/transport tests for stale replies and errors, one command send,
  incompatible replies, reconnect gaps, stale feed replacement and unknown
  receipts; implement the client and migrate every direct panel fetch.
- [x] Add bounded SSE observer and tests for resume, replacement, backpressure
  cleanup and drain; replace the workbench polling timer with subscribed recovery.
- [x] Run focused regression tests, typecheck, syntax checks and the full fixture
  suite. Check the unchanged workbench headlessly. Review final diff, commit,
  push and create the PR without merging it.

Review focus: reconnect during a pending write; a feed change at equal numeric
revision; more than one catch-up page; old thread responses and failures after
selection changes; idle streams preventing shutdown. No real model calls.

Pattern provenance: owner-provided Paseo research (`report.md` and
`for-massion.md` items 1–4), learned without copying source. SSE framing and resume
follow the [WHATWG standard](https://html.spec.whatwg.org/dev/server-sent-events.html).
Desktop IPC/socket transports, production authentication, installer discovery,
storage live-query optimization and actual chunk transfers are out of scope.


## Verification and review

Node 24.21.0 on macOS with the brief's physical TMPDIR. After integration with
main at `cd16119`, the full fixture suite passed 1405 tests, skipped 340 opt-in tests and
reproduced the documented baseline failure `portable inventory order is stable
across English and Turkish process locales` (case-insensitive artifact paths).
Typecheck, runtime syntax checks and diff whitespace checks passed.

Independent review reproduced deferred reconnect while a command response is
outstanding, a stale reflection-read error replacing newer content, and protocol
metadata consuming the existing 32 KiB body budget. Each now has a failing-then-
passing regression. Logical payloads keep 32 KiB; the bounded envelope has a
separate allowance. Generation checks apply to failures as well as successes.
An overlapping catch-up/push regression also proves the event loop remains live.

Headless Chrome used the real loopback host with an in-memory fixture and no
providers: push updates, disconnect/reconnect recovery and unsent draft retention
passed; no JavaScript errors. Idle protocol request count remained 26 over 4.2 s.
Rendered HTML/CSS outside the script is byte-for-byte equal to the original head.
Artifacts live in the owner's scratchpad `ui/`: `e2-protocol.png`,
`e2-protocol-push.png`, `e2-protocol-reconnect.png` and matching snapshots.
No real provider, persistent DB, desktop transport or release was exercised.


The new main-branch UI contract fixture host now wraps its existing read-only
responses in protocol v1 and keeps an idle SSE subscription. Product commands
remain refused; only its explicitly declared bounded app-view fixtures accept
POST. A regression verifies negotiation, query framing, command refusal, app
view reads, incompatible versions and stream shutdown through fixture cleanup.

Six contract states (`B1`, `B2`, `B7-done`, `B13`, `B17`, `B22`) were captured
headlessly both on this branch and on isolated `origin/main` source. All six
completed with zero infrastructure errors and identical contract/visual failure
counts. Those existing report-only mismatches are not fixed by this transport PR.
Five screenshots have zero changed pixels; `B7-done` differs by 14 pixels out of
1,296,000. Current and baseline reports, screenshots and prototype comparison
pairs are retained in `/private/tmp/e2-ui-contracts` and
`/private/tmp/e2-ui-contracts-baseline`. The other contract states are left to CI.
`node scripts/check.mjs` passes; its new advisory copy lint reports 907 existing
findings. No UI text was rewritten to satisfy a design contract.
