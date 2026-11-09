# E9b: bounded real-model discriminator evaluation

Run `scripts/eval-room-discriminator.ts` manually with Node 24.19+ (24.x) and
the same explicit loopback router as `smoke-real-model.ts`. No CI wiring,
credential discovery, retries, calibration-threshold changes or applied moderation.

Twenty fixed, labelled synthetic rooms cover defect detection (moment 2) and
specificity of quote-grounded challenges (moment 3), in English, Korean and
mixed text, including prompt injection. Labels identify the wrong claim and
the expected additive proposal; labels never enter the discriminator request.
Small real members reproduce prescribed case text so the labels stay fixed.
This measures moderation on controlled transcripts, not free-form member quality.

Use the application commands for Work, assignments, effect intent/receipt,
artifact publication and room transitions, then `roomModerationInput` and the
versioned `DiscriminatorService`. Evaluation state is disposable in-memory
state, not evidence of durable acceptance. The separate unchanged release smoke
proves the full durable host/independent-check/readback path on the main baseline.
The CLI-backed typed discriminator adapter exists only in the evaluation script;
production's System One wire format stays unchanged. The owner-authorized v3
correction below replaces the initial two-second host deadline for new Work.

Reuse the smoke runner's router isolation, tool-free CLI adapter, usage logging,
private checkpoint reports and unknown-outcome fence. Permit an explicitly
selected evaluation cap of 120, keeping the smoke default at eight. Use the
existing approved pair: gpt-6.1-terra and zai/glm-5.3 (different host-map families).
Calls count single-shot CLI invocations; upstream attempts and money are unknown.

Report valid-answer and all-case agreement, missed stricter proposals, spurious
proposals, invalid/timeouts, coverage, calls and reported tokens. False relaxation
means removal of an existing host restriction; compare host state before/after
moderation and require every recorded result to remain `applied: false`.
Zero false relaxation alone is not an accuracy or calibration claim. Stop on an
unknown CLI outcome, call cap, cancellation or missing connection, retaining a
partial report with unrun cases. Deadline changes require an explicit owner decision, as recorded below.

## Execution plan

- Add failing tests for the 20-case labels, real application/room-to-shadow path,
  incorrect member reproduction, metrics and the extended dispatch cap.
- Implement the evaluation script and the bounded smoke-runner reuse; run scoped
  fixture tests and typecheck using the existing Node 24 installation.
- Run evaluation once and release smoke once on the current main source; commit
  sanitized reports under `docs/acceptance/e9b/`, including incomplete evidence.
- Commit and push `eval/discriminator`, open the requested PR, request `@codex
  review`, and leave it unmerged. No UI or new dependencies. The owner-authorized correction
  below adds the production shadow-runtime fix to the same PR.

## Owner-authorized timeout correction (2026-11-10)

The initial run exposed two production issues: the v1/v2 policy's 2,000 ms
constant also limits general model adapters, and the room awaits the complete
moderation call. New v3 reservations default to 60,000 ms, with a bounded host
`discriminatorTimeoutMs` override pinned in each new reservation. Historical
v1/v2 records retain their deadlines and decisions. New timeouts/cancellations
record `unconfirmed`, never a relaxed rule or accepted result.

Room moderation starts as tracked background work; only storage mutations join
the runtime's existing write queue, so a late moderation write cannot cause a
room CAS failure. A pending shadow call skips later moments instead of creating
an unbounded queue or reserving the remaining execution budget. Original input,
feed and model pins remain bound even when the room settles before the answer.
Host drain aborts and waits for owned shadow jobs; the drain-aware store still
fences writes. A successfully accepted Record is never rewritten by late shadow
evidence. The evaluation may await shadow answers to measure them; live rooms
never await the model. Repeat the original fixed set and retain the failed run
as historical evidence beside the new generated report.
