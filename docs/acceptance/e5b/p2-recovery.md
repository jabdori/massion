# Codex P2: abandoned pending call recovery

On the reviewed head, a persisted `pending` call without a settlement was only
reported as unknown to replay callers. Its stored status remained pending, so
owner reconciliation was impossible. This round adds an idempotent host recovery
command that persists unknown without invoking the transport.

## Rules

- Active attempts are tracked process-wide by database feed and original command
  identity. Concurrent identical calls share their promise; changed inputs
  conflict. A fresh read or another service instance in the same daemon cannot
  mistake that live attempt for an abandoned claim.
- A lost claim acknowledgement never authorizes dispatch. The catch path attempts
  to persist unknown. A settlement failure does the same; if storage is still
  unavailable, the durable pending claim survives and recovery is attempted by
  the next app read, replay, or owner reconciliation after restart.
- Recovery changes only pending to unknown. A concurrent successful receipt or
  owner reconciliation is preserved. Original IDs, argument hash and version
  remain; the recovery event is host-authored and journal replay validates its
  deterministic command identity.
- Unknown still blocks later writes until the owner records evidence against the
  exact call. Recovery is not a retry, completion, cancellation acknowledgement,
  or automatic clearing. It does not prove the remote effect stopped.

## Tests

`tests/mcp-apps.test.ts` reproduces lost claim receipts and a host unable to settle
before exit, verifies persisted unknown after read/replay, then exercises the
existing owner reconciliation without a resend. It also covers overlapping
recovery, active-call replay across service instances, changed-input conflicts,
and preservation of a settlement whose receipt was lost. Journal lineage is
validated for recovered calls. A process restart is represented by a new service
with no live attempt registry entry; no external provider is called.

This is the existing single-daemon architecture, not a distributed lease protocol.
Multiple independent live processes against one database are not supported by
this in-process ownership check. Database failure still blocks recovery rather
than granting execution or reporting a false durable transition.

For the separate app-origin/CSP finding and real browser/desktop evidence, see
[frame-origin-design.md](frame-origin-design.md).
