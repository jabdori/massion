# Versioned Relation impact query

This KNW-01 increment is linked to [issue #4](https://github.com/jabdori/massion/issues/4).
It preserves accepted [ADR 0001](../architecture/decisions/0001-product-owned-core.md)
and the existing `Relation` / `affectedBy` contract. The headless normal CLI host
now exposes a read-only query:

```text
GET /missions/:id/impact?entity=<URL-encoded exact entity ID>&version=<positive integer>
```

The result contains `missionId`, snapshot `revision`, database `feedId`/`cursor`,
the exact `changed` identity/version, sorted `affected` entity-version keys, and
original supporting `relations`. IDs and provenance remain opaque strings;
provenance is not parsed into authority or a quality verdict. The existing domain
transition remains the only Relation admission path under representative/verifier
roles. This query adds no browser mutation route or relation-writing authority.

## Existing meaning and storage boundary

All three existing types (`depends-on`, `evidenced-by`, `contains`) participate in
the existing inverse impact traversal. A relation is followed only when its
`to` ID and `toVersion` both match the reached version. Its `from` and
`fromVersion` become another reached version. No latest-version substitution,
inferred-edge exclusion, provenance authority assumption or cross-Mission
expansion is introduced. A cycle may include the initially changed version in
the result, exactly as `affectedBy` does. Impact keys are distinct; original
duplicate relations and their provenance/inferred flags remain in the evidence.

The existing Mission snapshot Relation array remains the authoritative persisted
representation. SurrealQL reads it with feed metadata in one explicit read
transaction. Its `array::fold` computes reachability inside SurrealDB, with at
most one pass per stored relation; all supporting edges are then selected in
original array order. The adapter does not load a graph and traverse it in JS.
All query values use the existing lossless JSON RPC variable codec. No state,
journal, event, outbox, feed or independent projection is written. Consequently
existing journal restore needs no new graph migration or rebuilt copy.

This is a bounded native query over existing document data, **not** a native
`RELATE` edge schema, indexed graph traversal, ingestion/search implementation or
efficient large-graph benchmark. Query work is bounded to 1,000 stored relations;
larger Missions return HTTP 422 without partial results or truncation. This bound
does not limit Relation admission or alter stored data. Missing Mission returns
404, invalid input 400, and a host without the reader 503 with no in-memory
fallback. Returned relations/entities and boundary identities are validated.

## Reproduction and evidence

Use the pinned Node 24.19.0 and actual SurrealDB 3.3.0 in a fresh disposable
launcher; the integration verifies ownership before accessing any database:

```sh
MASSION_SURREAL_BINARY=/path/to/official/surreal \
  python3 scripts/with-surreal.py -- \
  node --test --test-concurrency=1 tests/relation-impact.test.ts
```

Invalid-input/protocol/HTTP availability tests run ordinarily. The actual database
case explicitly skips without Linux and launcher ownership proof. It admits
relations through the real application/store, including reverse insertion order,
mixed types, distinct provenance, inferred edges, duplicate/cyclic paths, version
mismatches and Unicode/quote/colon entity strings. One actual read query matches
`affectedBy` while retaining original evidence and excluding another Mission.
Fresh adapter and restored-journal reads preserve the same impact and relations;
the fresh restore has its own feed identity. HTTP reads leave the complete journal
unchanged. Oversized queries reject without mutation or truncation.

Exact base/head, test counts, CI and independent review are recorded in the
successor Draft PR. Test data is fixture-labelled; no model/provider call,
browser input, user database, merge or deployment is involved. Typed/indexed graph
storage, document/code ingestion, search quality, product UI and automatic
invalidation remain open. This query reports dependencies, not invalidated Work,
accepted results or permission to rerun effects.

SurrealQL mechanisms were checked against official
[array/closure documentation](https://surrealdb.com/docs/reference/query-language/functions/database-functions/array)
and [transactions](https://surrealdb.com/docs/learn/querying/concepts-and-guides/transactions),
then tested against the pinned binary. The first query attempt used the newer
`type::is::array` spelling and failed parsing; the preserved RPC diagnostic showed
3.3.0 requires `type::is_array`. Assertions and relation semantics were unchanged.
