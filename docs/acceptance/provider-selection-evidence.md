# Explicit connection selection evidence

This increment is stacked locally on owner-quarantine commit
`fdec0d5ec5fc62e296ff18fbd38841128c52e12d` (the metadata-equivalent public parent
is recorded separately when publication is authorized). It adds no live account,
credential, native provider claim, or ACP process.

## Verified candidate

- Node 24.19.0, TypeScript 7.0.2, SurrealDB 3.3.0.
- Strict typecheck, runtime syntax checks and default aggregate: 217 passed,
  17 intentionally skipped actual-store tests, 0 failed.
- Disposable actual SurrealDB/restart aggregate: **234 passed, 0 failed,
  0 skipped**. Counts cover the complete candidate, including prior slices.
- Three configured profiles choose different exact models and two actual loopback
  HTTP destinations independently for executor/verifier. Provider receipts,
  immutable config hashes, independent artifact review and fixture Record persist.
- Side-effect-free preflight rejects missing choice, changed profile digest,
  incorrect authorization/role, missing protocol/auth/capability and invalid caps.
  Credential resolution is lazy, injected, endpoint-bound and tested with synthetic
  strings only. No environment credential or login is discovered.
- Unknown transport/model outcomes do not retry, switch profiles, or replay after
  runtime restart. A selected run's accepted backup round-trip retains its role
  bindings; changing a binding while retaining assignments rejects.
- Reusable adapter conformance tests cover exact-model completion, unknown outcome,
  wrong model, single-send and cancellation before dispatch. These tests do not
  establish compatibility with an actual external service.
- The inline client is exercised through DOM doubles for explicit selection,
  duplicate submission lock, durable-admission event catch-up, in-flight cancel,
  stale completion, navigation during a run, and known rollback after navigation.
  Unsafe dynamic HTML is prohibited. This is interaction evidence, not visual or
  comprehensive accessibility validation.
- Independent source review findings were fixed and retested: rejected/nested
  configuration redaction, backup assignment/config cross-binding, long-run owner
  controls, late-error navigation and off-Mission known rollback cleanup. Reviewer
  reported no remaining blockers within the reviewed scope.

## Reproduce

```sh
npm run check
MASSION_SURREAL_BINARY=/absolute/path/to/surreal \
  python3 scripts/with-surreal.py -- \
  env MASSION_TEST_SURREAL_RESTART=1 \
  node --test --test-concurrency=1 tests/*.test.ts
```

## Not established

No real inference, real credential resolution, new persistent access, paid resource,
CLI agent, live ACP transport, native Anthropic/Codex/Responses integration, merge
or deployment occurred. Monetary cost remains unknown; bounded output tokens are
not a guarantee of provider billing. Real independent judgment quality is untested.

A dot-cloud browser visit to the actual disposable loopback preview was attempted,
but opening `http://127.0.0.1:8766` returned `ERR_BLOCKED_BY_CLIENT`. No alternate
route around that restriction was used. Browser visual/responsive/accessibility QA
therefore remains unverified. The default host still exposes no configured account;
connection creation, model discovery and account setup UX remain future work.
