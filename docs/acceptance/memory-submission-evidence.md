# Exact owner memory submission

Issue [#19](https://github.com/jabdori/massion/issues/19) and MEM-01 require exact immutable submitted versions and historical Work inputs. [Draft PR25](https://github.com/jabdori/massion/pull/25) addresses an asynchronous caller-mutation gap above PR24 `dd9ca2e91b9f247b0ccbb89c03ac0df18839ec84`. Scope was recorded before implementation in [issue19](https://github.com/jabdori/massion/issues/19#issuecomment-6016484088).

## Behavior and evidence

Source candidate `a406b410649f4c387aabc9a9478398b0a50aefaf` copies command identity, expected revision and memory scalar fields before the asynchronous Mission scope lookup. Scope, explicit authority and effective state remain server-bound. It does not change memory retirement or add a UI.

The regression pauses the scope lookup, mutates all caller fields and releases the lookup. The original source failed; the fix stores the original v2/content/provenance, retains old Work and v1, pins v2 for future Work, and replays the original command without changing the journal. The pause is a labeled test scheduling fixture; actual SurrealDB persists the resulting command. This is a ProductService caller boundary test, not evidence that an HTTP client can mutate the host's parsed request object.

Affected checks on Node24.19.0 and owned disposable SurrealDB3.3.0 passed12/12, fail/skip0. Strict TypeScript, runtime syntax and whitespace checks passed. [Exact-source push CI](https://github.com/jabdori/massion/actions/runs/37465211272) and [PR CI](https://github.com/jabdori/massion/actions/runs/37465216273) succeeded: actual-store aggregate437/437 with zero failures/skips; ordinary381 passed with56 conditional skips. These counts are separate runs and must not be added. Independent read-only source/log review found no finding and directly checked capture-before-await and replay assertions; it did not rerun tests or GUI.

## Remaining gates

The subsequent evidence commit changes documentation only; final publication CI is reported in the PR. Source/tests are identical to the named source candidate. No GUI was used or is required for this caller-boundary fix. General retrieval, authority lifecycle and complete MEM-01 remain open. [Live-provider issue5](https://github.com/jabdori/massion/issues/5) remains blocked on selected authorized provider/account, input scope and usage/spend limits. No live requests, correction experiment, quota review retry, merge, deployment, account changes or paid resources occurred.
