# Literal-content explicit memory retrieval evidence

Candidate above Draft PR72 `22cbf56fdc9dee29c7e650679588008079014e34`; [contract](../architecture/memory-content-search.md), MEM-01/ADR0001, issue #4 and issue #19. Owners can find stored explicit originals without knowing their IDs, then deliberately select an exact reference for a separate usage read. This does not complete general retrieval, learned memory lifecycle or live-model acceptance.

## Cloud verification

The preserved implementation was restored to an isolated branch at the exact PR72 tree. The imported patch and source files were kept separately and unchanged. Cloud verification uses Node 24.19.0, locked TypeScript 7.0.2, and official SurrealDB 3.3.0 (archive SHA256 `44aeab565f7e7e39d2d0bf0583c8aae648babc91373c70b2658288d95bbbcd55`).

- Feature API and panel checks: **21 passed, 0 failed, 0 skipped** against the owned actual database. Run `python3 scripts/with-surreal.py --timeout 180 -- node --test --test-concurrency=1 --test-reporter=tap tests/memory-content-search.test.ts tests/memory-content-search-panel.test.ts` with `MASSION_SURREAL_BINARY` set to the verified binary.
- Final `npm run check`: **1,202 total; 876 passed, 326 environment skips, 0 failed**. This includes TypeScript static checks and runtime syntax checks. Skips are not evidence of durable-store or browser execution.
- The full actual-database aggregate and exact-head review/remote CI results are reported separately on the published Draft. Results from different environments or repeated runs are not additive.

The new cloud regressions deliberately hold each discovery request while a result in the other panel is chosen. ID selection invalidates a held content continuation; content selection invalidates a held ID read. They choose distinct exact references, release the late reply, click retained stale button references, and require the selected reference and invalidated status to remain unchanged. A later explicit search still works. Both directions run in memory and against the actual database; there are no usage reads, POSTs or snapshot/journal changes.

Other feature evidence covers 22 explicit matches across IDs as 20 + 2; original inactive versions and hashes; learned/other-Mission/ID-only/source-only exclusions; literal case, spaces, CRLF/LF and NFC/NFD; 512/513-unit bounds; malformed/duplicate/extra queries; frozen caller input; invalid Record lineage; forged hash, offset and repeated pages; Cancel/input/usage selection/Mission/revision/offline/old-feed invalidation; duplicate-click guards; and a separate deliberate usage read. Existing Work/Record, unknown effects, memory pins and retained journal remain unchanged.

## Browser boundary

The included normal CLI/headless browser test exercises keyboard search and choice, 20 + 2 pages, inactive original usage, Cancel, an owned host restart with a fresh browser context, and narrow/wide layout. Its earlier source-environment result is historical evidence only.

Cloud automated browser verification remains **blocked before UI assertions**: the preinstalled Chromium launch fails creating its process-singleton IPC socket (`Operation not permitted`). A policy-reviewed elevated launch hit the same environment restriction. The optional Playwright headless-shell archive download failed through the CDN gateway. Product assertions were not weakened, security settings were not changed, and neither event is reported as a product regression or a browser pass. This gate stays distinct from successful API/panel/aggregate tests and any future supported cloud-browser smoke check.

No credential transfer, paid resources, live provider/model calls, merge, release or deployment was performed. Fixture/mock calls elsewhere in the aggregate do not establish real-provider acceptance.

## Review correction: private inspection cancellation

[Codex review on PR73](https://github.com/jabdori/massion/pull/73#discussion_r4231708130) identified that the usage Cancel button clears selection programmatically, so the selection `change` listeners alone did not invalidate discovery. Both discovery panels now listen to that explicit Cancel action and discard completed pages, held responses and retained choice buttons without issuing reads or writes.

Before the fix, four new in-memory reproductions failed (the four corresponding actual-DB variants were environment-skipped in that reproduction). Eight regression cases cover held initial content, held content continuation, held initial ID discovery, and both completed pages in memory and against the actual database. They verify the cleared selection survives late responses and stale button clicks, an explicit later search still works, and snapshot/journal/usage-request/write counts remain unchanged. Final correction checks and exact published head are recorded on the Draft; earlier counts above belong to the initial candidate. Browser verification remains blocked separately.
