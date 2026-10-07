# Bounded owner organization responsibility revisions

ORG-01 requires durable responsibilities and staffing history across model/UI lifetimes. Existing Assignment records name actual executor/verifier actors and model/extension versions but do not retain a versioned organization definition. This increment adds two owner-declared role requirements, not departments, general membership, measured capability or production identity grants.

`POST /missions/:id/organization` accepts exactly `{commandId, expectedRevision, version, reason, responsibilities}`. `version` starts at1 and advances by1 independently of the Mission purpose/criteria version. `reason` is required and at most2000 well-formed Unicode code units. `responsibilities` contains exactly one executor and one verifier, each with only `{role, responsibility, capability}`. Responsibility text is required and at most2000 code units. Executor capability must be `text-output`; verifier capability must be `independent-text-review`. These are declared requirements: selecting either value proves neither capability quality nor authorization. Body limits, loopback/Origin admission and database feed binding remain the normal server gates.

Example payload, after reading the current authoritative aggregate revision:

```json
{
  "commandId": "owner-org-v1",
  "expectedRevision": 1,
  "version": 1,
  "reason": "Separate artifact production from acceptance review",
  "responsibilities": [
    {"role":"executor","responsibility":"Produce the bounded artifact for the original Work criteria","capability":"text-output"},
    {"role":"verifier","responsibility":"Independently inspect the original artifact and cite evidence","capability":"independent-text-review"}
  ]
}
```

The trusted local-owner actor supplies the retained revision author. Caller actors, staffing choices, models, scopes, authority/grants and extra fields reject. A successful `revise-organization` command appends one immutable revision and one atomic operation/event, without running Work. CAS/idempotency and durable receipts are the existing Application/Store protocol: same original command replays its original accepted value after later changes; changed payload or competing revision conflicts. On unknown response read the exact durable receipt; do not infer rejection from missing events or replay provider work.

Mission snapshots retain `organizationRevisions`; new Work copies the last revision into `organizationSnapshot` at admission. Existing Work with no organization pin remains unbound; an owner revision does not retroactively change it. Earlier Work pinned to v1 stays v1 after v2, even when execution starts later. Actual Assignment.actorId/model/extension and independent executor/verifier guards remain authoritative; the domain derives `organizationVersion` from that Work's exact retained history, never latest Mission state. A supplied mismatched assignment version rejects. Owner responsibility text remains task data, not executable code or a permission grant.

Configured bounded text execution validates original pin/history before run admission. Both executor and independent verifier receive the original organization task data; run input hashes include it. Organization-bound assignments use built-in text input contract `massion.builtin.bounded-text@3`; legacy unbound inputs/hashes and assignments remain @2. This is a built-in contract version, not installation of an external extension. The accepted Record includes the original organization snapshot in its canonical checksum, with exact assignment versions. Accepted-text reads check these same bindings both before and after artifact reading. Recomputed checksums cannot substitute a different role definition or missing history.

Portable backup structure and semantic journal replay validate sequential organization history, original Work/Record pins and Assignment versions. Restore remains inert: it never recreates actor grants, provider calls, runtime authority or organizational staffing. No storage table/migration is added; organization data uses the existing Mission aggregate.

The [acceptance evidence](../acceptance/organization-revisions-evidence.md) distinguishes normal HTTP/CLI/store evidence from controlled adapter/Record fixtures. No UI editor is added in this increment. Persistent departments, semantic staffing/reuse, organization Growth, broader role/capability strategies, multi-client identity/production authentication and general organization lifecycle remain open. No actual model quality or full ORG-01 completion is claimed.
