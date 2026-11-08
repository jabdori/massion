# Q15: Discriminator slot

Implements [ADR 0004 §6](decisions/0004-member-rooms-mutual-challenge-and-discriminator.md#6-the-discriminator-moderates-between-turns-owner-role-and-slot-proposal), without rooms. All evidence in this increment is fixture or loopback mock evidence.

## Boundary

The host assembles a versioned question for one of six moments. Agent prose occurs only in bounded `quotes` carrying author and message ordinal, unchanged in language. Speaker and stall moments accept host features only. Typed answers have exactly `kind`, `options`, `distribution`, `confidence`; they cannot produce messages, verdicts, permissions or acceptance. The initial threshold version is shadow-only for every moment and language. There is no enable setting or caller-supplied calibration certificate. Real held-out accuracy, applied-side precision, calibration error and injection measurements are prerequisites for a later change.

Work owns the question identity `(workId, turnOrdinal, moment, questionVersion)`, input hash, model pin, threshold version and result. A host-only reservation precedes the call; a host-only result command commits the raw bounded output, latency, host time and decision through the existing atomic Mission/journal transaction. Replay reads the committed entry and never calls an adapter. Interrupted reservations may be asked again under their original identity; only the first committed result counts. Uncertain commits never authorize a call or application. Per-Work serialization and durable reservations protect overlapping questions and the 60-call cap. Three failures permanently select fixed rules. The existing output-token budget reserves a bounded amount before dispatch; missing usage retains that reservation. Reservations are cumulative, matching existing Work budgeting. Input token usage is recorded; monetary accounting remains unavailable just as for existing providers.

Every returned result explicitly carries `applied: false`; consumers continue using fixed rules. Shadow proposals describe only additive restrictions (or selection from host candidates); they cannot clear a host restriction or create an owner card. No room scheduler or production runtime calls this slot yet.

## HTTP and settings

The adapter uses the native `model`, `state`, `questions` request and `model`, `answers`, `usage` response of [System One](https://docs.typesafe.ai/api/system-one) (checked 2026-11-08). Choice and score distributions are normalized to the internal exact contract. Native noul has no separate confidence: the adapter records confidence as zero, not a fabricated calibrated value. Probabilities are model reports, not proof of calibration. Transport, endpoint validation, bounded JSON reads and credential resolution reuse the existing host facilities. Credentials and remote error bodies are never journalled. Bounded malformed answer objects and valid usage are retained as invalid results. Input and raw output are each limited to 32 KiB; the enclosing record permits 96 KiB so accepted inputs can always retain their bounded result.

An optional model-group `role: 'discriminator'` preserves old settings. A dedicated resolver accepts only this role and compatible HTTP connections, honors the existing live-execution gate, pins the selected profile and holds settings during a call. Discriminator-only groups are excluded from checking-family availability. Settings > Connections adds only a model picker for the slot, retaining the existing B14 rows and B20 immediate-save behavior.

## Implementation and checks

- [x] Add failing contract, mock HTTP, journal/restart, concurrency, failure/cap, authority and shadow tests in `tests/discriminator.test.ts`.
- [x] Implement `src/discriminator.ts`, `src/discriminator-adapters.ts`, `src/discriminator-service.ts`; connect host commands in `domain.ts` and portable lineage validation/replay in `backup-lineage.ts`.
- [x] Extend model-group role persistence and resolution in `connection-workbench.ts`, existing family-map tests, and the Connections picker in `settings-panel.ts` with its existing surface harness.
- [x] Verify duplicate commands after state reads, drain fencing, stale state/deadline checks, and late responses without new room APIs.
- [x] Run focused tests, static type checking, runtime syntax checks, then the full suite with the brief's macOS TMPDIR; review the final diff.

Delivery: commit, push and open the PR without merging.

Out of scope: rooms, room messages/boards/issues, automatic invocation, real models, calibration datasets or passing accuracy claims, fine-tuning, active application, money budgets and a general model-group editor.

## Review and evidence

The independent review identified and regression-tested four corrected cases: maximum Korean input overflowing the result record, invalid model labels blocking failure records, the missing exact System One credential binding, and malformed HTTP answers losing raw evidence/usage. Host commands also replay after state loading and read back idempotency conflicts. Database replacement is fenced with the existing admission feed; uncertain writes never authorize a call or expose an uncommitted result.

No real model call, calibration run, real database restore, room integration, or automatic application was performed. The adapter tests use a loopback mock server and injected HTTP responses, including the HTTPS credential path. The initial threshold numbers are provisional shadow defaults, identical across moments/languages; they are not calibrated operating thresholds.

Final local verification (Node 24.21.0, physical scratchpad TMPDIR): `npm run typecheck` and `node scripts/check.mjs` passed. `npm test`: 1,135 passed, 335 skipped, one failed. The sole failure is the brief's known macOS-only `portable inventory order is stable across English and Turkish process locales` (`Text artifact boundary: directory realpath mismatch`); its code was not changed. Optional database/browser integrations were not enabled.
