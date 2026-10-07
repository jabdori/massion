# Exact expired owner UI increment above PR53

Base: PR53 `2f13139c72e4acc88dbee3a5bbe43f0a3fd56113`. Purpose: RUN-01/WRK-01/GOV-01 and issue #4 interruption inspection through the normal owner UI. This exposes the existing `close-expired-runtime` command; no new execution/recovery authority, retry, scheduler, refund or external cessation proof.

Private Work/reason/uncertainty selection → exact original ownership read at current revision/feed → Review → optional Cancel → explicit local Close. Server returns a single observation used for both elapsed-deadline evidence and the frozen command. Changes invalidate review; Cancel aborts/invalidate reads. Lost replies use existing durable command receipt reconciliation without resubmission. Original run/host/dispatch/deadline, claims, receipts, reservations and unrelated accepted Work/Record/conversations remain evidence.

Local validation, Node 24.21.0, TypeScript 7.0.2, disposable SurrealDB 3.3.0, headless Chromium 151.0.7922.34:

- Types and runtime syntax pass; diff whitespace check passes.
- Actual DB affected gate: 79/79, 0 fail, 0 skip (`owner-expired-panel`, `expired-owner-cli-browser`, `expired-run`, `runtime-lifetime`, `owner-correction-panel`, `owner-run-sequence-panel`). Final checkbox layout plus two additional no-commit/late-read cases: separate final panel/browser gate 21/21, 0 fail, 0 skip. Counts overlap; they are not added.
- Existing normal CLI owned SIGKILL pending-dispatch proof passed after its real 120-second original deadline, fixture HTTP invocation 1, restored grants/replay 0. It is a distinct proof from the Chrome activation-only journey. First combined gate timed out at 240 seconds because it initially duplicated this real deadline wait in a browser copy; raw timeout/failure evidence is retained. No deadline/claims were rewritten to speed that proof.
- Final actual normal CLI/Chrome journey uses committed activation-only ACK-loss fixture with its existing 1500ms ownership deadline, reads it on a fresh host, exercises native keyboard Review/Cancel/Close, literal text, focus, widths 390/1280, reload and host restart. Fixture/live execution calls 0, restored grants 0, automatic calls 0; original Work/Record/journal preserved.
- Independent source review and independent memory regression 13 pass/0 fail/5 conditional actual DB skip. One P2 evidence wording issue fixed and rereviewed; no remaining findings. Reviewer did not execute the actual DB/Chrome gate.

Representative actual command: `MASSION_SURREAL_BINARY=... MASSION_PLAYWRIGHT_PATH=... PLAYWRIGHT_BROWSERS_PATH=... TMPDIR=<owned workspace temp> python3 scripts/with-surreal.py --port 18080 --timeout 180 -- node --test --test-concurrency=1 tests/owner-expired-panel.test.ts tests/expired-owner-cli-browser.test.ts`. The gate owns its DB/processes and uses credential-free fixtures only. CI raw logs and exact-head totals are retained outside the checkout and linked in the Draft PR so recording the result does not create another head.

Preservation: original task11 sequence UI's five dirty/untracked entries, provider-only/task4 and prior PR50–53 work/evidence untouched. Original git `objects/maintenance.lock` was read and retained; isolated no-hardlinks clone avoids writing that repository. No reset/delete, merge, deployment, live provider call, paid resource or account permission change.

Remaining product gates are unchanged: authorized real-provider independent quality/usefulness evaluation, remote authentication, broader accessibility assurance and any unknown-effect recovery authority. This bounded closure UI does not close issue #4 or declare uncertain effects completed.
