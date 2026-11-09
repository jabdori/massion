# E9a end-to-end evidence

The suite runs the actual HTTP/protocol daemon in a separate owned process,
headless agent-browser and SurrealDB 3.3.0. Only model responses and login detection
are fixtures. No production source or UI behavior changed.

## Final local candidate

Linux arm64 container, Node 24.19.0, SurrealDB 3.3.0, agent-browser 0.41.2 and
system Chromium. An internal Docker network supplies a network interface but no
external route; browser traffic is restricted to 127.0.0.1. No paid/provider calls,
real login, secret lookup or external app handler ran.

- `python3 scripts/with-surreal.py --timeout 480 -- npm run e2e`: **8 passed,
  0 failed, 0 skipped**, including seven journeys and their parent, **22.4 s**.
- **29 fixture model invocations**, zero live calls; restart and restored reads
  add zero invocations.
- **15 accessibility snapshots and screenshots** under `.runtime/e2e/`, plus
  `report.json`, `calls.json` and the final daemon log. CI uploads that directory
  as `e2e-journeys` even on failure.
- Node 24.21.0/macOS `npm run typecheck`: passed.
- `node scripts/check.mjs`: runtime syntax and copy lint passed, zero findings.
- Related tests (`server`, `first-experience`, `apps`) with physical
  `TMPDIR=/private/tmp`: **36 passed, 0 failed, 1 skipped**. The skipped existing
  HTTP-restart test requires a disposable database; the new E2E restart uses one
  and cannot skip. An earlier run without physical TMPDIR failed the existing
  fixture route's canonical path check; the documented physical path resolved it.
- Guide file/image links and `git diff --check`: passed.

The final suite strengthens the first passing candidate by waiting for each
Work's completed/failed sidebar status before capturing its accessibility state.
The [guide screenshots](../../guide/images/) are unchanged PNGs from that run.

## Covered journeys

| Journey | Durable and visible evidence |
| --- | --- |
| First launch, no login / login found | Sign-in / suggestions; no model calls or journal writes |
| Conversation and Work handoff | Direct reply creates no Work; accepted fixture Record binds distinct producing/checking identities and exact text |
| Member admission and team room | Owner uses the name/look form; steps settle; challenge/concession survive in the Record; separate verifier accepts |
| Rejected result and correction | Owner reviews and admits new Work; explicit execution accepts a correction Record; original failure stays byte-for-byte unchanged |
| App installation | Actual catalog, permission decision and installed app; invented payment/delegation/monthly-budget answers are rejected without writes |
| Unknown result, drain and restart | Unknown effect and no Record; drain interrupts another Work; reopened history and fixture invocation count stay unchanged |
| Portable backup and fresh restore | Separate two-Work installation; full journal equals destination; unknown stays unknown; original text folder deleted; normal host reads relocated accepted text without calls |

Backup uses a small separate source because the entire multi-journey aggregate
journal exceeds the server's default RPC body size. An earlier full-source restore
was refused with HTTP 413/unknown outcome; it was not resent into that destination.
The suite changes no server limit and makes no large-journal capacity claim.

## Remaining scope

Payment execution, external-member delegation, monthly-budget wait/raise decisions
and MCP reconciliation have no current product producers/routes. No successful
journey is fabricated. The browser fallback is covered; authenticated Electron
journeys remain follow-up. The existing desktop smoke is independent fixture-shell
evidence, not this suite against the real database.

CI owns the full repository suite and all screen contracts, per the brief's
verification budget. These results do not establish live model competence,
production readiness, real external integrations or a signed release.
