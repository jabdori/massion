# Same-host Mission continuation evidence

Related: existing outcome issue #4, SUR-01, WRK-01 and ADR 0001. This small
successor to PR #10 exposes one authoritative Mission in a second client without
copying browser storage or changing host security/network settings.

## Goal comparison and selected boundary

| Preserved goal | Current evidence | Remaining boundary |
| --- | --- | --- |
| One authoritative central host | ADR 0001; application commands/queries, separate SurrealDB; HTTP restart and sealed restore tests | Production hosting, authentication, supervision and operations |
| Same state from multiple PCs | Current durable snapshots/cursor; this slice adds a same-host Mission reference and independent client storage | Actual PCs, authorized remote transport, shared conversation/session identity |
| Flexible agent collaboration | Product-owned assignments and distinct fixture executor/verifier; causal child delegation checks | Durable organization changes, real agent communication/questions/shared context and coordination |
| Real model outcome quality | PR #10 removes explicit host setup barrier; native synthetic/loopback tests | Issue #5 requires account, input scope and spend authorization plus semantic judgment evidence |

The existing #4 second-client continuation gate is the smallest increment that
can advance without a new authentication/deployment decision or any account/key
access. A Mission link is a reference to existing state, not a shared conversation
or an authority grant. #4 and #5 remain open. No new issue or Project is created.
Project inspection was blocked by missing `read:project`; no token scope changed.

## Local verification

Strict pinned Node 24.19.0 / TypeScript checking passes. The affected workbench and
client-to-HTTP suite with disposable SurrealDB 3.3.0 passes 37/37, 0 failures,
0 skips. Counts belong to this candidate, not a sum of earlier runs.

- Fresh storage opens a validated fragment with GET only; changing the fragment
  reads another snapshot. Malformed, over-limit and path-like references produce
  no Mission path or write; failed reads expose no link.
- Initial pending recovery identity takes precedence, remains retained during
  later link navigation and keeps mutations locked.
- Two separate storage/lock identities read one actual durable Mission. A stale
  second-client steering command conflicts once; it is never automatically retried.
  Later committed steering becomes visible through durable event catch-up.
- A fresh HTTP host and third client reopen the link with no POST. Snapshot and
  journal are unchanged; blocked Work has no admitted effects.
- Existing configured fixture flow now reopens an accepted Record through the
  link in fresh client storage after host restart, with no extra provider sends.
  Its local mock outcome remains fixture evidence.

Initial new-test failures were test setup errors: checking a button instead of
its disabled fieldset, and omitting creation of the unique disposable database.
Both were corrected; no product guard was relaxed.

```sh
MASSION_SURREAL_BINARY=/path/to/official/surreal \
  python3 scripts/with-surreal.py -- \
  node --test tests/workbench.test.ts tests/client-workbench.test.ts
```

Independent review and final published-head CI are recorded in the Draft PR.
CodeRabbit has not reviewed PR #10 due to its free OSS limit; no duplicate request
or paid transition is made for this follow-up. Latest PR #10 Codex review completed
at `6a3ad5315621647df7d5e30d5ee1b2a3de9ae205` after three reproduced fixes, with
no additional major findings. That review does not substitute for reviewing this
new slice.

No actual browser visual/accessibility review, remote PC connection, live account
or credential lookup, paid inference, shared conversation, full AgentOS,
merge or deployment is claimed.
