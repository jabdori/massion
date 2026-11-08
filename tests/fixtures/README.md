# Pre-migration storage fixture

`schema-v0.surql` is the exact initializer from Q17 base `3eb36c3d613b01d21cbe718aff6271cd446793ea` (before
`storageVersion`). `portable-v0.json` was generated before the storage change with
that revision's Application, InMemoryStore, TextArtifactStore and portable exporter.
It retains an accepted text Record, pending and unknown effects, reservations and
the full 17-operation history, using a fixed `2026-11-08T00:00:00.000Z` clock.
The original artifact directory `/private/tmp/massion-q17-legacy` was removed
after export; it is a synthetic fixture path, not user data.

Do not regenerate this fixture with the current implementation. Its unchanged
checksums and bytes are the backwards-compatibility oracle. The upgrade contract
imports it under the frozen initializer, opens it with the new initializer and
exports/restores it again, comparing the complete journal, materialized rows,
Record checksum, every artifact, unknown outcomes and original command replays.
The separate schema contract checks host settings and feed identity, which the
portable bundle intentionally does not export.
