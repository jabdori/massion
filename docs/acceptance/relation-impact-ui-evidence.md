# Read-only relation impact UI evidence

This increment adds a small workbench panel above the bounded native query from PR17 (`b836e2df6608ad8b0199cac2aec974e790a598f8`). It does not complete KNW-01 graph storage, ingestion/search or automatic invalidation.

## Risk and regression coverage

`tests/impact-panel.test.ts` covers exact Mission/target/version/revision/feed identity, original provenance/inferred evidence, text-only rendering, empty and malformed results, HTTP errors, target/version/Mission/revision/feed/disconnect changes, late success and error responses, retained private drafts and pending-command barriers. Supporting in-memory and actual SurrealDB inline-client/HTTP tests both prove unchanged snapshot/journal and zero POST/provider effects. The focused actual run passed 14/14, zero skips.

A keyboard browser check found Mission and Work admission disabled their focused fieldsets and left focus on BODY. Their handlers now restore the original submitted control in the same current Mission if focus has not moved elsewhere. Existing creation tests assert button focus for both acceptance methods; existing intervention focus regression remains covered.

## Actual browser route

CachyOS, pinned Node 24.19.0, SurrealDB 3.3.0 and an isolated agent-browser Chrome session exercised the normal `src/server.ts` entry with a fresh owned database. Seeded calculation/Record and relation data are explicitly deterministic fixtures. No live model or external account was used.

Keyboard-only Tab/Enter/type checks covered Mission creation/native required validation, bounded Work admission, owner instruction recording, cancellation, evidence expansion and accepted fixture Record bundle PRE focus. New-panel checks covered exact source v1 multi-hop dependencies, provenance/inferred flags, result-region focus outline, v2 empty output, native invalid version without a GET, a held v1 response after v2 completed, Mission selection clearing old results and an actual 1001-relation HTTP422 with no partial output and restored Read focus. Read-only query batches preserved the actual full operation journal. Screens were inspected at a 390px viewport; screen-reader operation and exhaustive accessibility certification were not performed.

Raw commands, DOM snapshots, screens, supervisor/host logs and journals are retained outside the repository under `task-11/relation-impact-ui-b836e2d/browser/`. `final-source.json` identifies the exact executed workbench SHA256 and screen hashes. Browser and owned normal CLI/supervisor/database were closed before reporting GUI release. Initial source head `1a237ad3ca26b5270a20400681d7890eeecd3c10` exposed the admission focus issue; final source SHA256 is `ffe496dad1283e07567e8333d9f8f485347a0036571aa7f584f841f883c2172b`.

The earlier test-driver failure incorrectly called an in-memory adapter's nonexistent exportJournal; it remains in `focused-first.log`. The correction uses inspect for that fixture and exportJournal for SurrealDB, retaining identical unchanged-journal assertions. The initial browser launch redirection missed the log directory and started no process; creating its private evidence directory enabled normal launch.

Aggregate validation and exact-head CI/review are recorded in the Draft PR and local `evidence-final.json`; fixture or integration evidence is not live-provider evidence. No merge, deployment, account change or recurring report activation is part of this increment.
