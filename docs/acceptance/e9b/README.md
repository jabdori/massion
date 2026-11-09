# E9b acceptance evidence

## Current v3 result and product correction

The owner requested a production fix after the initial v2 timeout. The 2-second
constant came from `POLICY_V1` and was inherited by v2; `ConfiguredTextRuntime`
also awaited the complete moderation call before the next room turn. New v3
reservations default to 60 seconds and pin the trusted host's optional
`discriminatorTimeoutMs` override (positive whole milliseconds up to 60,000).
Historical v1/v2 deadlines and records are unchanged. New timeouts/cancellations
record `unconfirmed`, never a relaxed rule or applied outcome.

Room model calls now run as tracked background jobs. Only journal writes join
the shared runtime write queue, including across subsequent Work in the same
connection manager. One pending shadow call skips later moments; it does not
queue more model calls or block a challenge, answer or independent check. Late
answers record against the original reservation after acceptance without
rewriting its Record. Host drain also aborts shadow calls whose room has already
finished. Feed replacement and the drain-aware store still fence late writes.

The real rerun used the original 20 cases and model pair, with the same 120-call
cap: **20 valid answers, 12/20 agreement (60%), zero false relaxations, 50 calls,
891,504 reported input tokens and 3,126 output tokens**. It took 289,883 ms;
discriminator replies took 3,660–9,711 ms. No missing usage, timeout, unknown
call or retry occurred. Eight cases missed a stricter proposal; there were zero
spurious stricter proposals. This is execution completion, not an accuracy gate
pass: keep moderation shadow-only. It is a small controlled moment-2/3 set,
not per-language calibration or a four-arm quality study. Monetary cost remains
unknown. The eight misses are listed in the generated report.

Current evidence: [v3 evaluation](evaluation-v3.md) and
[fixed labels, typed answers and calls](evaluation-v3.json). The real rerun uses
the changed service/policy and the same evaluation path. The earlier release
smoke below remains evidence for the main baseline; it was not rerun after this
runtime correction. Updated runtime behavior is covered by the fixture checks.

Final local verification on Node 24.21.0: typecheck passed; the related
discriminator/evaluation/smoke/member/runtime/host/backup/selection batch passed
173 tests, skipped six environment-gated tests and failed none (179 total).
Slow fake tests prove acceptance before a held answer, immutable accepted
Records after late recording, cancellation after room completion, and successful
progress of a next room while the prior shadow answer is recorded. Historical
two-second policies still replay without another call. The final Markdown-only
wording correction was regenerated from the script template and recorded JSON,
without another model invocation. Full suite and screen contracts remain CI-owned.

## Historical v2 run and baseline release smoke

Run on 2026-11-10 KST (2026-11-09 UTC), using Node 24.21.0, SurrealDB 3.3.0,
the existing owner-provided OpenCodeX router at `http://127.0.0.1:10100/v1`,
and the existing Codex CLI. Baseline main: `3ffdf51eb63188ee05d2f64e5198f565b90a7bad`
(also the remote main observed immediately before and after the runs).
Production source is unchanged from that baseline. The smoke harness has the
reviewable E9b changes for reuse, with its original eight-call default and flow.
The final reporting-only change replaces the Markdown denominator with the
report's selected cap; the observed smoke denominator remains eight.

## Observed results

| Run | Result | Calls | Reported input / output tokens | Unknown calls |
| --- | --- | --- | --- | --- |
| Controlled discriminator evaluation | Incomplete: first discriminator timed out | 2 / 120 | 15,983 / 26 (partial) | 1 |
| Release smoke | Passed | 4 / 8 | 75,438 / 240 | 0 |

The evaluation attempted one of twenty fixed cases. The member reproduced its
prescribed text, then the real CLI-backed discriminator exceeded the unchanged
2,000 ms host deadline and was aborted. The original reservation and timeout
were recorded by `DiscriminatorService`; the CLI result was unknown and fenced
every later evaluation dispatch. No retry, substitute connection or deadline
increase was attempted. Nineteen cases were not run; there were zero valid
discriminator answers. Accuracy among valid answers is **unavailable**, not 0%.
All-case agreement is 0/20, counting unanswered cases as no agreement.

No host restriction was removed and no result was applied. Zero observed false
relaxations with zero valid answers does **not** establish accuracy, calibration,
injection resistance or readiness to enable moderation. The cases cover moments
2 and 3 only; this is not ADR 0004's full per-language, per-moment calibration or
equal-cost four-arm study. Controlled member reproduction is not a quality
evaluation of freely generated member debate. Evaluation state is in memory;
it is not durable room acceptance evidence.

The separate release smoke used durable disposable SurrealDB and the public
conversation path: direct answer, Work admission/execution, different-family
independent checking, accepted real-provider Record, exact eight-byte `SMOKE_OK`
readback and drained shutdown. The database was removed by the smoke script.
This run did not use a member room and does not fill the evaluation coverage gap.

## Reports

- [Evaluation](evaluation.md), [fixed labels, typed observations and calls](evaluation.json).
- [Release smoke](release-smoke.md), [call accounting and readback hash](release-smoke.json).

Reports are copied from generated output without modifying failed observations.
They contain only synthetic cases, typed results and allowlisted call metadata;
no raw CLI stdout/stderr, environment values, provider error bodies or credentials.
Requested model IDs are not independent attestation. Tokens for the aborted
discriminator are unknown; monetary cost and service-internal attempts are unknown.

## Local checks

`npm run typecheck` passed. The discriminator/room/evaluation/smoke fixture batch
passed 41/41; after adding an explicit unchanged-timeout regression and label
isolation assertions, the affected evaluation/smoke batch passed 10/10 and
typecheck passed again. All ran with Node 24.21.0. The initial broader invocation
had one existing artifact-directory failure from macOS's symlinked default temp
path; the same batch passed with the brief's canonical `TMPDIR`.

Full suite and screen contracts were left to CI under the owner's verification
budget; no UI changes. No deployment, production moderation enablement or merge.

## Reproduction

```sh
export PATH=/Users/code/.local/share/mise/installs/node/24.21.0/bin:$PATH
export MASSION_SURREAL_BINARY=/Users/code/.local/share/massion/surreal-3.3.0/surreal
export MASSION_SMOKE_ROUTER_URL=http://127.0.0.1:10100/v1
export TMPDIR=/private/tmp/claude-501/-Users-code-massion/dc2d9a0d-e0f8-420f-84fc-beec74d770c3/scratchpad/tmpdir
node scripts/eval-room-discriminator.ts
node scripts/smoke-real-model.ts
```

These are manual owner-authorized live scripts, never CI tests. Future runs
incur new calls; do not replay the aborted call as recovery. A future accuracy
run needs a separately authorized discriminator connection that satisfies the
existing latency boundary, or an explicit policy decision before a wider study.
