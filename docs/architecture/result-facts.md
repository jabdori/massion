# Typed business-result facts (R-M)

Workers and final assembly may return an explicit `massion-facts/v1` JSON result.
The bounded discriminated union contains pricing counts (plans, tables), churn
counts (reasons, business, other), or cause counts (causes, evidence). Exact keys,
nonnegative safe integers up to one billion, and consistent churn totals are
required. Ordinary prose has no count semantics. Like `massion-table/v1`, the
original bytes remain the task result and, for final assembly, the immutable
artifact checked by the separate verifier. Facts are producer observations,
never acceptance, permissions, effect receipts or a business oracle.

Validate marked results before worker settlement and artifact writes; the task
command also rejects malformed marked envelopes. No command, storage field,
backup format or dependency is added. Project only settled, non-skipped results
into existing Work-list and conversation reads. Validated table rows also supply
pricing metadata. Prefer final assembly facts over worker facts without adding
duplicate counts. Share the host projection with activity rows and cards before
any pane opens. Existing revision, feed and request-generation fences replace
or discard summaries with the rest of each row. Exception status takes priority.

Derive named-step progress only from the pinned plan and actual settled/active
tasks. Produce B7-done and the owned activity/card family through existing owner
procedures, validated plans, effects, receipts and task settlement; regenerate
fixtures from source. Preserve independent checks and accepted Record lineage.

Tests first cover malformed and oversized envelopes, immutable checking bytes,
no acceptance from a worker, headless list rendering, newer/late/feed replacement,
and command-produced steps. Run related tests and typecheck locally, then scoped
screen contracts and dark/light desktop/mobile interactions. CI owns the full
suite; continue the current-head Codex loop until green and clean (four rounds
maximum). Do not merge.

Browser pages/payments, token repair, file-read telemetry, procedure editing,
Record events and steering/restart continuation belong to parallel slices.
Missing page/file observations and unsupported business predicates retain narrow
allow-list reasons; fixture business counts are controlled inputs, never evidence
of real customer data or market research.
