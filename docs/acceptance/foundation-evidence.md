# Foundation candidate verification — 2026-10-03

This checkpoint is a controlled durable fixture and development workbench. It is not the complete product.

- Runtime: Node 24.19.0.
- Store: official SurrealDB 3.3.0, separate loopback service, fresh SurrealKV data.
- Provider: deterministic built-in fixture; no external model was invoked.
- Independent aggregate review: **60 passed, 0 failed, 0 skipped**, including actual Surreal transactions, crash/reopen and clean restore. Source/test/script hashes were unchanged before and after the run.
- `npm run check`: runtime syntax succeeded; **57 passed, 0 failed, 3 actual-store tests skipped** without the opt-in service. This does not perform static TypeScript checking.
- Additional real-store HTTP checks: simultaneous fixture starts produce one 201 and one 409; sequential repeat creates another Mission; invalid/missing IDs produce 400/404; stopping and restarting the application with a fresh transport returns the same revision-44 snapshot containing three Work items.
- Visual browser verification: **blocked** by the browser environment for the loopback address (`ERR_BLOCKED_BY_CLIENT`). HTML/API/source checks do not establish visual correctness or accessibility.
- Static TypeScript checking: **not run**, pending the permitted local development compiler/type installation.
- Remote CI: configured, but local evidence alone does not establish a successful GitHub run.

Reproduction:

```sh
MASSION_SURREAL_BINARY=/absolute/path/to/surreal \
  python3 scripts/with-surreal.py -- \
  env MASSION_TEST_SURREAL_RESTART=1 \
  node --test --test-concurrency=1 tests/*.test.ts
```

Independent review found and verified repairs for canonical Record hashes after store serialization, overlapping Growth reverts, multiple effective memory versions, effect receipt assignment, retry task-result contamination, changed bytes at acceptance, and replay after file write before receipt. The last regression proves pending/unknown effects block another admission; it does not establish automated distributed recovery or lease ownership.

Known development-workbench follow-ups: a failed manual refresh leaves the prior JSON visible; a manually refreshed Mission ID is not retained on reload. These are tracked for the next interface increment. The existing interface is a labeled fixture runner/JSON inspection surface, not a general Mission/Work editor.

## Reviewed source manifest

```text
fc1560e91c73debe90642c985c6bd7711df21811af57949c9ce29de02cbd89fc  scripts/check.mjs
14c8845f76a02c282d9a0087cae0e9eb911b8be355fe7ea9d228a9f0f8123251  scripts/demo.ts
c1459a48db5f9446e6cb975628a1b80c5d51c0440e3917ec638a4d6dedc64068  scripts/with-surreal.py
cfd64ca745708d7010737ed15f196426130daabff795696f2bf7a3cf3c80af9d  src/application.ts
23c7ad3cd18edcb0a0f9991952a6bde80a5b8c5df82d374d7fbf03898e5d2597  src/domain.ts
65fc4d6a9bba53bf2ef4d15b5fd6067b4225ca179c61d705eed1bdee659ddbae  src/execution.ts
ee6f5cce07b0bd636c1b5eb542f73ad5276f01a76a865bd273c6d8ca42b5e9fc  src/scenario.ts
568f9ac1a8924c1b1b6f97f4a173b6504117b524a838872730282926f00cba9c  src/server.ts
51a988243c2c955c9f22bae36c920b8f7dde02ead202a16599532d7a71b4e526  src/storage.ts
90d62f35f3f362d797e0cf53aff327669fa47e61c24279d94a844fbc43f321a3  tests/application.test.ts
8525886069e22242eee42f1733c37e2830eb328ede3ac0e26932ad32b090049b  tests/domain.test.ts
6e4e27de61dfcee7318917c50dc8ea8adb21ce2bf9d6a53cfb996e0b38e176e8  tests/execution.test.ts
295858044ed21ab8a232f55abef2e21d16b8d85bf08bdd5b3f0568c5ed622f9f  tests/scenario.test.ts
88b74f1ec75e76d89223f7fd9c6fe5544b74fba8f6c36f10f88b3af7be4171d6  tests/server.test.ts
45e556388c6a88efee08707ccbcddb4c79b32b7f298064211142ea4ea0446be2  tests/storage.test.ts
```
