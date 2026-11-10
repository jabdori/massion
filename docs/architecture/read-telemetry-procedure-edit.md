# File delivery, active procedure notes and Record flow (R-N)

Extend the existing Work commands, immutable source pins and host observations.
A file is read only when its exact bounded text is delivered to an assigned step;
filenames, progress and model claims are not evidence. Retain source identity,
content hash, provider effect identity and host delivery time. A dispatched call
is `reading`; a successful provider receipt is `read`. Unknown calls retain their
original observation without replay or a completed-read claim.

Owner step notes remain durable proposals. The assigned worker acknowledges an
exact note before its step starts. Store the acknowledgement separately from the
admission-pinned procedure and original plan. Only the effective title and worker
instruction change; dependencies, criteria, assignments, permissions and prior
steps never change. Runtime refresh and CAS fence the effective input before an
effect is admitted. Acknowledgements are visible in the same Work conversation.

Record creation has its own host time in the checksum-bound accepted bundle.
Expanded flow shows that event, or a skipped Record after a failed independent
check. Unknown Work remains unchecked, without invented check/Record times.
Historical observations and journals retain their original shape.

Implementation: write failing boundary/runtime/surface tests, extend existing
commands and backup validation, then regenerate only owned fixtures. Verify
related tests and typecheck locally, affected browser contracts in both themes,
and all CI checks plus a current-head Codex receipt before handing back the PR.
No real model/provider calls, browser/payment changes, token repair,
business-result summary or steering/restart continuation are included.

## Evidence and bounds

Use the existing GitHub item handler and binding action to capture selected
UTF-8 contents at the exact head SHA, under the existing sandbox and document
limits. `github-review/v2` carries those literal file bytes; v1 identity-only
sources remain supported without file-read claims. Plans may select exact
`sourceFiles`. A worker receives only those file fragments, with the original
source-document hash retained as provenance, rather than a forged filtered pin.
Dispatch claims bind file IDs, paths and hashes to the original effect and run.

Record acceptance checksums include the creation observation and acknowledged
procedure edits. Exact artifact readers compare those edits with the accepted
bundle. The PR pane derives file badges from the selected Work's original head,
source pins and receipts; feed replacement and deadline refresh keep cached
facts from becoming another Work's status.

See [acceptance evidence](../acceptance/read-telemetry-procedure-edit/README.md).

## Lead visual corrections

Identify file delivery effects by their retained repository-relative paths in the
expanded effects card. Keep long paths to one ellipsized line, with their full
value available on inspection. A step note displays pending state until the exact
assigned-worker acknowledgement exists; then display the owning member's name
and acknowledgement state on that same line. Capture both command-produced states.

Capture the end of the expanded flow for accepted and failed-check Work at desktop
and mobile widths in both themes. Check that the Record card and creation/skipping
events can be scrolled fully above the sticky checking bar. Keep scenario names,
example members and example step-title interpretation out of product code; fixtures
remain the only source of example scenarios. Merge latest main after these fixes,
then require all six CI jobs, clean current-head Codex and mergeability before the
owner-authorized merge of PR #147.
