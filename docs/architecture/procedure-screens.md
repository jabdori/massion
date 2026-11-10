# Procedure-backed Work screens (R-G)

The conversation card must show the same pinned worker roles and progress as the
Work pane before that pane is opened. Project bounded worker labels, status and
observations from the authoritative Work into both existing conversation reads
and the global Work list. Do not ship worker instructions or result bodies in
that summary. A newer list replaces older card facts; feed and request-generation
guards remain unchanged.

Use existing procedure pinning, validated team plans, assigned effects and task
settlement to generate the churn and pricing scenarios. Worker instruction and
result messages retain their direction and host times; copying uses the existing
clipboard handler. A failed check retains its procedure and never creates a Record.
Expanded flow events retain their own observations; missing Record events remain residuals.

Tests first cover summary reads without a selected Mission, newer-list replacement,
worker copying and command-produced procedure failure. Regenerate fixture files
from their source, capture affected contracts in both themes, and shrink only
resolved diagnostic identities. Retain browser/payment, typed business-result,
steering-continuation and unsupported business-predicate limitations explicitly.

Run related tests and typecheck locally; CI owns the full suite and screen gate.
Publish one PR on `feat/procedure-screens`, follow CI and current-head Codex review,
and do not merge. Connection/member/app lifecycle and browser runtime are outside
this branch. PR #136 owns skipped-step glyph/time presentation.

## Lead review corrections

Admission and runtime start are separate observations even when their formatted
minute is equal. Label them "Work admitted" and "Run started" in the expanded
flow. Do not emit a start event from the admission-time fallback; old Work with
only admission evidence has no observed run start. Add one regression covering
both equal-minute observations and the absence of a real start.

The telemetry generator owns only B7-churn, B7-fail, B18-room-b and B22-room-steps.
Its command must not rewrite B5 or the printer/payment B7 variants, nor sweep
unrelated fixture readers. Keep the new main table parser and check observation
times when resolving the merge, and recapture the affected contracts before push.
