# Portable Work backup increment

## Customer outcome and acceptance (before implementation)

An owner can export durable Mission/Work history together with sealed bounded text
artifacts, move the bundle to a fresh disposable SurrealDB and artifact directory,
and resolve an accepted Record to exactly the accepted bytes without running a
provider, effect, verifier process, or application command dispatch again.
Pure domain reducers are re-evaluated only to validate retained state/event
consistency; this has no store, provider or filesystem side effects. A synthetic
role superset enables structural validation and does not prove historical authority.

The versioned bundle contains the complete database operation journal (including
Mission, Work, Memory/Growth and typed relations), original immutable evidence,
content-addressed UTF-8 blobs, size/hash inventory and canonical manifest checksum.
All historical artifact versions in the journal are included. Original Record
checksums and original paths remain unchanged; an explicit location resolver maps
those original descriptors into a newly marked artifact store. Restore must reject
unknown versions, unsafe paths, missing/extra/tampered data and inconsistent lineage
before writing database state. Restoration requires a fresh empty database and a
new artifact directory; restored outbox rows are held, never automatically replayed.

Acceptance requires actual SurrealDB clean restoration, fresh-process artifact
resolution, unchanged Record and journal checksums, rejection tests, source review,
and final-candidate aggregate checks. Fixture/model-mock evidence remains labeled.

## Boundaries

Version 1 supports the configured runtime's bounded text artifact store. Controlled
code/document fixture workspaces, arbitrary files, remote object storage, incremental
backup, encryption, signatures, multi-writer online snapshots, production recovery
leases and general outbox dispatch are outside this increment. Unsupported artifacts
fail closed. A checksum detects corruption, not a malicious author who rewrites all
checksums. Historical actor IDs are retained; absent historical authority snapshots
cannot be manufactured or claimed as authorization proof.

No environment, provider configuration, credentials, authentication files or service
secrets are read/exported. User-authored content and provider receipts can contain
sensitive data: the backup is private data and is not uploaded by this workflow.
Whole-database export requires a quiescent owner-controlled source; filesystem and
DB cannot be made one atomic transaction. Referenced bytes are revalidated and the
journal head is checked again before returning a bundle. Restore stages sealed
artifacts first, then atomically imports the journal; failed/unknown DB completion
leaves that disposable artifact root for inspection rather than replay or overwrite.

## Local-owner CLI

Provision an empty destination namespace/database on a disposable loopback service
first. The CLI has no authentication or remote-service credential options.

```sh
node scripts/backup.ts export http://127.0.0.1:8000/rpc source_ns source_db /absolute/source-text-root /absolute/private-backup.json
node scripts/backup.ts restore http://127.0.0.1:8001/rpc restore_ns restore_db /absolute/new-text-root /absolute/private-backup.json
```

Export refuses to replace an existing bundle. Restore refuses an existing artifact
root or occupied Massion store; it never merges. Keep the bundle private (created
0600) and retain it as the relocation manifest. Reopen accepted bytes with
`openRestoredArtifacts(bundleText, newRoot).read(record.artifact)`. This verifies
current physical bytes while preserving the original descriptor/checksum. A plain
store constructed without that explicit manifest cannot resolve an old path.
The normal UI reads exact accepted/rejected text through product-owned evidence queries.
Relocated original descriptors require an explicit normal-host [restored read binding](restored-artifact-reader.md); the default host never guesses another root.

The envelope is bounded to 64 MiB, 10,000 journal operations, 4,096 artifact
references and 32,768 bytes per text artifact. These development limits are not
streaming production backup support. No archive extraction paths are used: UTF-8
blobs are keyed by SHA-256, with original descriptors separately validated.

Database import is atomic; filesystem/database publication is not one transaction.
The destination must be offline and exclusively owned for restore. If import fails,
do not reuse the partial root. Inspect the reported result and retry only into a
new disposable destination once the previous outcome is established. An ambiguous
DB response is read back once using that restore attempt identity; no write retry
occurs. The error retains restore ID/checksum/head for diagnosis. Existing durable
pending/unknown effects remain pending/unknown and do not authorize a rerun.

To back up a restored database again, use the API with
`exportPortableBackup(store, openRestoredArtifacts(originalBundleText, newRoot))`.
The basic CLI export only handles a native, unrelocated root; retain the original
manifest to resolve relocated descriptors. Export validates the operation journal
as the authoritative append-only history and reconstructs derived state/audit/event
projections. It does not independently detect privileged corruption of source
projection tables. Checksums are not cryptographic signatures or authenticity proof.
