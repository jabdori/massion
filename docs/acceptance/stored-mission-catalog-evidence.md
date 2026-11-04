# Stored Mission discovery from a fresh client

Base: Draft PR61 `5d39dbddf4f644acd6b448f915e0da717a292cf9`. [Preimplementation scope](../architecture/stored-mission-catalog.md) connects MIS-01/SUR-01, ADR0001 durable responsibility and issue #4 client/host interruption without introducing an execution contract.

Local final acceptance and affected continuation checks: **25 passed, 0 failed, 0 skipped** on Node 24.21.0, SurrealDB 3.3.0 and headless Chrome. Fifteen new tests cover native one-transaction bounded metadata paging, exact original identity/order, no full bodies, frozen input, empty database, changed cursor/feed, clean portable product/artifact restore, explicit fresh-client list/read/Load, literal rendering, closed/disconnected/late queries, same-ID database replacement, a newer authoritative Mission after listing and preservation of an original unknown receipt/write barrier. Ten affected client/feed continuation tests passed on the same product source.

Normal CLI is started as an owned child against the disposable actual database, stopped and restarted. Two isolated Chrome contexts have no remembered Mission ID. Keyboard reads the first 20 stored Missions, explicitly selects Next, then loads the original Mission. Stored owner discussion → distinct Work, exact document source, unresolved owner question and accepted historical Work/Record remain unchanged; journal equality and zero POST/provider calls are asserted. 390/1280 layouts do not overflow. The catalog adds no automatic query, page advance, execution or continuation.

Independent read-only source review found zero confirmed issues at initial and final review. Strict types, runtime syntax and whitespace pass. An initial browser fixture used `doc` instead of the existing required `document:doc` identity; that test-only setup was corrected and its failing output retained locally. Type-only annotations were corrected before final static checking. Local results are not CI counts.

Reproduce after installing the locked development tools and providing the existing owned SurrealDB/Playwright/Chrome environment:

```sh
MASSION_SURREAL_BINARY=/path/to/surreal MASSION_PLAYWRIGHT_PATH=/path/to/playwright/index.mjs PLAYWRIGHT_BROWSERS_PATH=/path/to/browser-cache python3 scripts/with-surreal.py --timeout 180 -- node --test --test-reporter=tap tests/mission-catalog.test.ts tests/mission-catalog-panel.test.ts tests/mission-catalog-cli-browser.test.ts tests/client-workbench.test.ts tests/cursor-recovery.test.ts
```

The catalog is local-owner metadata discovery, not authenticated remote access, task readiness, complete inbox, full accessibility/platform coverage or a complete product. Whole MIS-01/SUR-01 and issue #4 remain partial. No model, new grants, paid resource, account change, merge or deployment occurs.
