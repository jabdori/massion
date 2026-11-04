# Client reconnect synchronization evidence

Existing issue #4, SUR-01/GOV-01/WRK-01 and ADR 0001 require one authoritative
host, revision-checked commands, client continuation and truthful unknown outcomes.
PR #11 adds a read-only Mission link but the earlier client could still submit a
new action while its durable event connection was disconnected. Its local cached
runtime choices could also survive host restart despite session grants being lost.

## Selected increment and acceptance

Pause new actions during startup/disconnect until current durable events, host
runtime metadata and selected Mission are refreshed. Keep reads and drafts, preserve
separate unknown-operation locks and never replay a command. Refresh failure and
newer offline notifications must fail closed. Existing server CAS/idempotency,
fixed owner, scoped Run grants and admission remain authoritative.

This advances a multi-client user flow without choosing a new authentication
scheme or exposing a network listener. Remote PC authentication, shared conversation
identity, persistent approvals and flexible agent collaboration remain separate
product/security decisions. No new issue, board or Project authorization is needed.

## Local observed checks

Pinned Node 24.19.0/TypeScript strict checking passes. Affected actual SurrealDB
3.3.0 and inline-client/HTTP suite: 59 passed, 0 failed, 0 skipped.
The earlier fixture-only correction candidate a890efe passed the ordinary runtime
regression 278/299, with 21 conditional DB skips and 0 failures. Those counts do
not establish completion for subsequent setup-cache/callback changes; final-head
actual DB CI is recorded separately.

- Event transport failure pauses Mission/Work actions and fixture execution before
  a marker or POST is sent; read/refresh stays available and drafts remain.
- Current permission-read and selected-Mission-read failures cannot unlock writes.
  Valid reconnection refreshes the Mission revision, removes stale runtime UI and
  invalidates prior execution selection checks without starting Work.
- An offline notification arriving during a held refresh prevents that response
  from reopening the barrier. A later fresh synchronization can recover.
- Successful synchronization does not clear an unrelated pending command marker;
  an absent receipt remains unknown and no command is resent.
- Actual host shutdown makes a separate client pause new writes. After restart,
  another client records owner steering at revision 5; the original reconnects,
  reads revision 5 and retains its draft without POST. Only its subsequent explicit
  Work admission produces one new durable operation at revision 6. Effects stay empty.
- Existing two-client conflict and accepted fixture restart/link flows still pass.
  Fixture acceptance establishes orchestration only, not model competence.

Initial verification exposed a previous UI test returning `head` instead of the
actual event protocol's `cursor`. Published-head CI exposed two more provider UI fixtures with the same invalid
field; both failures were reproduced locally. They now return the real cursor
contract and permit only cursor storage, retaining the no-credential assertion.
The fixtures were corrected; the synchronization
requirement was not relaxed. An existing stale runtime-UI regression also led to
removing prior execution controls when current provider metadata cannot be read.

```sh
MASSION_SURREAL_BINARY=/path/to/official/surreal \
  python3 scripts/with-surreal.py -- \
  node --test tests/workbench.test.ts tests/client-workbench.test.ts \
    tests/host-connections.test.ts tests/provider-setup.test.ts
```

An additional source audit reproduced a failed connection-setup read leaving old
mutation controls enabled after runtime synchronization. Failed setup now discards
the cached catalog/forms, fences discovery callbacks and rejects stale programmatic
mutation handlers until valid setup metadata is received. Reconnect also cancels
old metadata discovery and fences setup mutation acknowledgements by connection
epoch; an acknowledged late mutation never installs an older catalog or retries.
Codex then identified that discarding a late acknowledgement alone could leave
the client writable after that mutation committed behind a reconnect read. The
regression reproduced the missing refresh. Late/uncertain setup outcomes now close
the barrier again and read current state; a held GET proves no unlock before the
committed setup is observed and exactly one POST remains.

Final published-head CI and independent review are separate evidence in the Draft
PR. CodeRabbit is optional and no repeated/paid review is requested. No real browser
visual/accessibility certification, actual remote-PC login, provider key/account
access, paid API call, merge or deployment is claimed.
