# Inspect exact original source uses

The document panel can find stored Work and Record uses of one retained document ID, version and SHA-256. This completes a bounded KNW-01/REC-01/SUR-01 inspection path after explicit [source selection](work-sources.md), consistent with ADR0001's fixed input and evidence responsibilities.

`GET /missions/:id/document-usage?id=...&version=...&sha256=...` uses one authoritative Mission snapshot. It returns the full exact original, UTF-8 byte length, feed/revision/cursor, total use count and at most 20 exact Work pins in snapshot order. Each use includes Work status, criteria version and original owner's selection actor/reason; accepted Record metadata includes its checksum, evidence class and exact artifact descriptor. A valid unused original returns zero. Relation edges do not count as source uses. Original/source/Record binding corruption fails closed; a changed hash or feed never selects a newer original.

The shared document read controller validates original metadata, bytes/hash and the complete bounded use projection against the loaded snapshot. Selection, Mission, revision or reconnect changes discard a held response. Cancellation preserves private capture text and restores keyboard focus. Results render literal text. Inspect Work opens its evidence; direct Inspect Record opens both enclosing details and focuses the exact text read control. Navigation alone does not read an artifact.

This query creates no relationship, replaces no Work input, executes nothing and issues no new quality verdict. Broad retrieval, automatic invalidation, graph projection and live model validation remain separate work.
