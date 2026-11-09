# Browser runtime (R-B)

The host now retains sanitized Work browser sessions, observed addresses, form values and structured page snapshots. Page counts come from committed observations, including before a Work is selected. B4 displays observed checkout amounts; B15 displays three observed pages and read-only form fields; B7 displays page-read activity; B5 retains page counts and its original unknown-outcome controls.

## Verification

- Node 24.21.0 with the canonical `/private/tmp` TMPDIR: 278 related core, storage-lineage, UI, effect and fixture tests passed. The additional Work projection test and 18 updated fixture tests passed. Member-work integration tests passed; the separate surface regression found during development was fixed and all 113 combined client tests subsequently passed.
- `npm run typecheck` passed. Copy lint reported zero findings. Full-suite and all 75 screen contracts run in CI, per the owner's local verification budget.
- `node scripts/ui-contracts/run.mjs B4 B5 B15 B7`: all eight screen/theme runs captured with zero infrastructure or geometry errors. B4 passes 35/35 required elements; B5 16/17, B15 34/35 and B7 39/40. Remaining requirements are below.
- `node scripts/ui-contracts/verify-browser.mjs`: eight observed page/theme states, keyboard tab selection, readonly inputs, no form/iframe/script element, no product commands, mobile overflow and close. Screenshots are under [interactions](interactions/). Masked field values are also asserted in the UI/unit tests.
- [Contract report](report.md), [targeted gate](gate.json), [dark B4](screenshots/dark/B4.png), [dark B15](screenshots/dark/B15.png), [dark B7](screenshots/dark/B7.png), [light B15](screenshots/light/B15.png). Prototype/workbench comparisons are in [pairs](pairs/).

The scoped gate removes 52 obsolete diagnostic identities and adds two narrower B7 gap descriptions (net 50 fewer exceptions). The narrower gap preserves missing business-step producers while removing the resolved browser telemetry claim. No contract requirement was relaxed.

## Remaining contracts

- B5 order-history inspection still needs its connector and exact remote order identity. Unknown payment is never retried.
- B15's generic library submission decision still lacks a typed effect binding to the Work. The read-only page does not grant submission authority; its sidebar therefore does not claim decision-pending.
- B7 still lacks its named order-history step, individual business-step timestamps and the previously recorded payment/receipt and source-handoff facts. Browser observation timestamps do not stand in for those facts.

## Provenance and limits

Browser fixture pages use the production `BrowserSessions` producer and sanitizer, with exact adapter read shapes and Work input hashes. B4 and the added B15 Work validate their complete generated journals. B5 retains its recorded expired/unknown Work fixture and attaches earlier production-captured reads with the same Work input hash. B7 starts from the existing recorded Mission fixture and commits observations through the normal service. Background histories remain the recorded screen fixtures.

All tests use fixtures and mocks; no remote browsing, real model call, payment or submission occurred. The optional headless CLI launch/cleanup was checked against a fake executable, not a live third-party site. The opt-in adapter uses a fresh session with scripts disabled and no imported login state. This slice does not implement autonomous browser planning, interactive form filling, authenticated profiles, order-history reconciliation or a form-submission adapter.

## Review correction 1

Codex identified three reproducible issues on `74c25ca`: numeric `one-time-code` values were not masked, old browser tabs could not rebind after Mission/revision changes, and a read could become obsolete while Application lookup was awaiting storage. Added failing regressions for all three, then masked the standard autocomplete token, refreshed tab bindings only after a current authoritative Mission read, and fenced generation at the drain-aware commit admission boundary. The 60 affected tests and typecheck pass. The headless interaction check also reselects existing tabs after revision invalidation in both themes.

CI's initial attempt hit the GitHub Actions/Checks API incident (https://www.githubstatus.com/incidents/tp8cghg7tlc4). On rerun, all 150 screen/theme contracts, e2e, install smoke and desktop jobs passed on `74c25ca`; that result does not replace final-head CI after these corrections.

## Review correction 2

Codex found two additional admission/context cases on `8bcab38`. A checkout open must not inherit the revision of an unrelated selected Mission; its revision check is now scoped to the checkout's Mission while the selection/feed fence still rejects stale responses. The commit-admission guard also checks the current runtime deadline, not only the observation timestamp. Both regression tests failed before the corrections; all 62 affected tests and typecheck pass afterward.
