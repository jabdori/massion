# Same-host database replacement read recovery

This increment addresses issue [#4](https://github.com/jabdori/massion/issues/4)'s
second-client/interruption criterion and SUR-01. It is a bounded read recovery
result, not completion of that issue or production recovery.

## Reproduction and acceptance

The fixed baseline is `4200735b6538d68e6b16a883200f71393ea00883`. A separate
archive of that source was tested against isolated SurrealDB 3.3.0 databases,
holding the actual HTTP host/socket open and switching only its test store
binding. Both databases contain the same Mission/Work IDs and revision 2 but
different state; their heads are either equal or the old head is 3/new head 2.
No existing user database was deleted, initialized or restored.

- Both same-number replacements leave the original display on the baseline,
  with and without an unknown command. Numeric cursors cannot distinguish them.
- A lower head without a pending command also leaves the original display when
  the newly read snapshot has the same Mission revision. The lower-head case
  with a pending command already passes on the baseline; it is not a new defect.
- The implementation distinguishes newly initialized database feeds, obtains
  snapshot/head/identity in one read transaction and refreshes changed content
  even at an equal Mission revision.
- Replacement reads preserve private Work/instruction drafts and command/fixture
  recovery identities. Missing command receipts remain unknown; only a later
  exact receipt clears the command marker. No client POST or model invocation is
  caused by recovery. Separate client storage reads the current database.
- Held snapshot reads, failed permission reads and a newer offline notification
  keep writes locked until a fresh matching boundary is obtained.
- A delayed acknowledgement from the previous database cannot replace recovered
  state or settle its unknown marker; the current feed must supply the receipt.
  This failure was reproduced separately before adding the response fence.
- Concurrent storage reads/writes check snapshot revision/value against its
  cursor. Subsequent catch-up contains the commits after that boundary. Fresh
  portable-journal restore keeps a distinct database feed identity.

`tests/cursor-recovery.test.ts` supplies five actual DB/HTTP tests;
`tests/workbench.test.ts` supplies two held-read/write-barrier regressions and a late-command-response regression.
Existing provider setup fixtures now wait for the complete synchronization barrier
and inject their active Work into the new atomic read endpoint. The baseline's
two setup tests pass; the initial aggregate after this change was 321 passed,
2 failed, 0 skipped (323 total). Those failures and the intermediate active-state
fixture failures are not successful completion evidence.

## Browser evidence and reproduction

Actual Chrome 154, controlled by agent-browser 0.38.2, used two independent task
sessions against a disposable actual DB host. At the same Mission revision and
numeric cursor 2, changing the store binding refreshes both displays. The first
session retains its instruction draft and preseeded unknown-command/fixture
markers and stays write-locked. The second retains its user-entered Work draft
and has independent empty recovery storage. Instrumented recovery observes zero
POSTs in either client. This browser checkpoint precedes the later command-acknowledgement fence, which is verified by its named regression; both isolated journals remain at their two seeded
operations. This is a focused recovery check; prior full keyboard/axe coverage is
not reclassified or rerun. Task evidence includes the source scripts, before/after
JSON, raw test logs and a 390px screenshot.

```sh
MASSION_SURREAL_BINARY=/path/to/official/surreal \
  python3 scripts/with-surreal.py -- \
  node --test --test-concurrency=1 tests/cursor-recovery.test.ts \
    tests/workbench.test.ts tests/client-workbench.test.ts \
    tests/provider-setup.test.ts tests/server.test.ts tests/storage.test.ts
```

Exact published SHA, final aggregate counts, remote CI and independent review are
recorded in the linked Draft PR and issue #4 follow-up. Earlier candidate totals
must not be added. Raw DB copies preserving feed identity, journal tampering or
arbitrary rollback within one identity are outside this contract. Retention,
remote identity/authentication, general conversation design, live-provider quality,
merge and deployment remain separate gates.
