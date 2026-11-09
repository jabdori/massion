# E9b: bounded real-model discriminator evaluation

Run `scripts/eval-room-discriminator.ts` manually with Node 24.19+ (24.x) and
the same explicit loopback router as `smoke-real-model.ts`. No CI wiring,
credential discovery, retries, calibration changes or production enablement.

Twenty fixed, labelled synthetic rooms cover defect detection (moment 2) and
specificity of quote-grounded challenges (moment 3), in English, Korean and
mixed text, including prompt injection. Labels identify the wrong claim and
the expected additive proposal; labels never enter the discriminator request.
Small real members reproduce prescribed case text so the labels stay fixed.
This measures moderation on controlled transcripts, not free-form member quality.

Use the application commands for Work, assignments, effect intent/receipt,
artifact publication and room transitions, then `roomModerationInput` and the
unchanged `DiscriminatorService`. Evaluation state is disposable in-memory
state, not evidence of durable acceptance. The separate unchanged release smoke
proves the full durable host/independent-check/readback path on the main baseline.
The CLI-backed typed discriminator adapter exists only in the evaluation script;
production's System One integration and two-second deadline stay unchanged.

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
partial report with unrun cases. Never change the deadline to make results pass.

## Execution plan

- Add failing tests for the 20-case labels, real application/room-to-shadow path,
  incorrect member reproduction, metrics and the extended dispatch cap.
- Implement the evaluation script and the bounded smoke-runner reuse; run scoped
  fixture tests and typecheck using the existing Node 24 installation.
- Run evaluation once and release smoke once on the current main source; commit
  sanitized reports under `docs/acceptance/e9b/`, including incomplete evidence.
- Commit and push `eval/discriminator`, open the requested PR, request `@codex
  review`, and leave it unmerged. No UI, new dependencies or production changes.
